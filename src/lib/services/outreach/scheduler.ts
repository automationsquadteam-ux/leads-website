import 'server-only';

import { createServiceClient } from '@/lib/supabase/service-client';
import type { EmailType } from '@/lib/supabase/database.types';
import { dayBoundsUtc, DISPLAY_TIME_ZONE } from '@/lib/utils';
import { getIntegrationConfig, type IntegrationConfig } from '../config';
import { recordActivity } from '../activity';
import { createEmailVersion } from '../email-versions';
import { generateEmail } from '../ai';
import { sendLeadEmail } from '../email/send-lead-email';

/**
 * The automatic sender.
 *
 * One pure-ish function of (database, settings, clock) with no scheduling of
 * its own. Something outside the app calls it —
 * `/api/cron/outreach`, hit by a platform cron, a Windows scheduled task or
 * cron-job.org. **The website never runs a scheduler in-process**: a Next.js
 * server can be scaled to zero, restarted or duplicated at any moment, and a
 * setInterval living inside one of those instances is not a schedule, it is a
 * coin flip.
 *
 * What it will and will not do:
 *
 *   * Follow-ups that are DUE are sent. They go to people who already received
 *     one message, which is why they may fire unattended.
 *   * The INITIAL email is only sent when `outreach.auto_send_initial` is
 *     explicitly on. It is off by default. A first touch leaving without any
 *     human ever reading it is the difference between outreach and spam.
 *   * Nothing is sent to a lead that replied or was closed. That check is a
 *     query filter AND re-checked per lead, because a reply can land between
 *     the query and the send.
 *   * `sending.paused` stops everything, unconditionally.
 *
 * Advancing the pipeline is not done here the email_logs trigger does it, so
 * a send from this loop and a send from the Send button move the lifecycle the
 * same way.
 */

export interface OutreachRunSummary {
  ok: boolean;
  message: string;
  considered: number;
  sent: number;
  generated: number;
  failed: number;
  skipped: number;
  /** Leads whose sequence ran out and were closed by this run (0037). */
  closed: number;
  /** Reasons the run did nothing, so a quiet cron is explainable. */
  notes: string[];
  durationMs: number;
}

interface DueRow {
  lead_id: string;
  type: EmailType;
}

/** Local wall-clock hour and ISO weekday in the configured timezone. */
function localClock(timezone: string, now: Date): { minutes: number; weekday: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(now);
  } catch {
    // An invalid IANA name must not stop sending; fall back to the host clock.
    return { minutes: now.getHours() * 60 + now.getMinutes(), weekday: ((now.getDay() + 6) % 7) + 1 };
  }

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weekday = weekdayNames.indexOf(get('weekday')) + 1;

  return {
    minutes: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
    weekday: weekday > 0 ? weekday : ((now.getDay() + 6) % 7) + 1,
  };
}

function withinWorkingHours(config: IntegrationConfig, now: Date): boolean {
  const { timezone, start, end, days } = config.sending.workingHours;
  const { minutes, weekday } = localClock(timezone, now);

  if (!days.includes(weekday)) return false;

  const toMinutes = (value: string) => {
    const [h, m] = value.split(':');
    return Number(h) * 60 + Number(m);
  };

  return minutes >= toMinutes(start) && minutes <= toMinutes(end);
}

/**
 * How long until the minimum gap has elapsed since the last email left.
 *
 * Measured against `email_logs`, not against a timer inside this loop, which is
 * the only way the gap survives:
 *
 *   * a run that sends two emails and stops at its time budget, with the next
 *     run starting seconds later;
 *   * someone pressing "Run now" while the scheduled run is still going;
 *   * two cron invocations overlapping.
 *
 * A loop-local `sleep` between iterations honours the gap within one run and
 * nowhere else, which is exactly the case that produces a burst.
 *
 * Returns 0 when nothing has been sent yet, or the gap has already passed.
 */
async function gapRemainingMs(minGapSeconds: number): Promise<number> {
  if (minGapSeconds <= 0) return 0;

  const admin = createServiceClient();
  const { data } = await admin
    .from('email_logs')
    .select('sent_at')
    .not('sent_at', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(1);

  const last = data?.[0]?.sent_at;
  if (!last) return 0;

  const elapsed = Date.now() - new Date(last).getTime();
  return Math.max(0, minGapSeconds * 1000 - elapsed);
}

async function sendsToday(): Promise<number> {
  const admin = createServiceClient();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { count } = await admin
    .from('email_logs')
    .select('*', { count: 'exact', head: true })
    .in('status', ['sent', 'delivered', 'opened', 'clicked'])
    .gte('sent_at', startOfDay.toISOString());

  return count ?? 0;
}

/**
 * Close leads whose sequence is exhausted.
 *
 * A lead that got follow-up 2 and never answered has nothing left to do —
 * `compute_next_step()` already says `close_workflow` — but nothing ever
 * performed the close, so they accumulated at stage `followup2_sent` inside
 * every figure describing live prospects.
 *
 * ONE atomic UPDATE, not a select-then-close loop. A reply can land between a
 * read and a write, and closing a lead that has just answered is the single
 * outcome here that actually costs a conversation. `replied is null` belongs
 * in the WHERE clause, where Postgres evaluates it against the row it is
 * about to lock.
 *
 * `auto_followups` is the other load-bearing condition. Pause means "not right
 * now, try me next quarter"; close means the sequence is over. A timer must
 * not turn one into the other — see "Pause versus close" in GUIDE.md.
 *
 * Returns the ids closed so the caller can write the audit trail. Never
 * throws: housekeeping failing must not take a sending run down with it.
 */
async function closeExhaustedSequences(config: IntegrationConfig): Promise<string[]> {
  const days = config.outreach.closeAfterFollowup2Days;
  if (days <= 0) return [];

  const admin = createServiceClient();
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data, error } = await admin
    .from('lead_pipeline')
    .update({
      closed: new Date().toISOString(),
      closed_reason: `No reply ${days} days after follow-up 2. Closed automatically.`,
    })
    .lt('followup2_sent', cutoff)
    .is('replied', null)
    .is('closed', null)
    .eq('auto_followups', true)
    .select('lead_id');

  if (error) return [];
  return (data ?? []).map((row) => row.lead_id);
}

/**
 * Everything due right now, oldest backlog first.
 *
 * Four-part order: follow-up 2 overdue from before today, follow-up 1
 * overdue from before today, follow-up 2 due today, follow-up 1 due today —
 * then initial sends. Two axes, not one: a lead already a day or more late
 * for ANY step always outranks one that only just became due today,
 * regardless of step; within the same age tier, follow-up 2 still outranks
 * follow-up 1, so a lead closer to the end of its sequence is not stuck
 * behind a flood of same-day first follow-ups when the per-run ceiling
 * bites. Plain type-only ordering (all of step 2, then all of step 1, no
 * age split) had a starvation hole: a healthy day's fresh follow-up-2 batch
 * would fully drain the daily cap before a single OVERDUE follow-up-1 was
 * even attempted, so a backlog could get pushed out again, and again, by
 * every new day's crop of the "higher priority" step.
 */
async function findDueWork(config: IntegrationConfig, limit: number): Promise<DueRow[]> {
  const admin = createServiceClient();
  const nowIso = new Date().toISOString();
  const work: DueRow[] = [];

  /*
   * `lead_send_queue`, not `lead_pipeline` and NOT `pipeline_board` (0035).
   *
   * pipeline_board's body ends in `where public.is_admin()`. Service-role
   * bypasses RLS on a TABLE but satisfies no predicate written into a VIEW, so
   * that view returns zero rows here — which is exactly how every automatic
   * initial send silently stopped after 0028. lead_send_queue is protected by
   * grants instead, carries the computed send_priority, and already excludes
   * archived leads.
   */
  const base = () =>
    admin
      .from('lead_send_queue')
      .select('lead_id')
      .is('replied', null)
      .is('closed', null)
      .eq('auto_followups', true);

  if (config.outreach.autoFollowups) {
    /*
     * Backlog before batch, within each step (asked for directly: "the ones
     * that were due yesterday or 2 days ago go out first then the new ones").
     *
     * Plain type priority (all of follow-up 2, then all of follow-up 1) has a
     * starvation hole: a healthy day's crop of NEW follow-up-2s finishes
     * draining the cap before a single OVERDUE follow-up-1 is even attempted,
     * because type order does not know or care how old anything is. A lead
     * whose follow-up 1 has been sitting unsent for two days is worse off
     * than one just now becoming due, and the type-only order treats them
     * identically. Splitting "already overdue before today" from "newly due
     * today" and interleaving them (F2 overdue, F1 overdue, F2 today, F1
     * today) fixes that without giving up type priority — follow-up 2 still
     * outranks follow-up 1 at matching age, it just no longer outranks a
     * follow-up 1 that has been waiting since before today started.
     *
     * "Today" is a calendar day in DISPLAY_TIME_ZONE, not the server's own
     * clock — `dayBoundsUtc` is the same helper the Email Logs date filter
     * uses, for the same reason: the server may run in UTC while "today"
     * means Asia/Karachi's midnight to anyone reading this list.
     */
    const todayDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: DISPLAY_TIME_ZONE }).format(new Date());
    const startOfToday = dayBoundsUtc(todayDateStr)?.start ?? nowIso;

    const followup2Overdue = base()
      .not('followup1_sent', 'is', null)
      .is('followup2_sent', null)
      .not('followup2_due', 'is', null)
      .lt('followup2_due', startOfToday)
      .order('followup2_due', { ascending: true })
      .limit(limit);

    const followup1Overdue = base()
      .not('first_email_sent', 'is', null)
      .is('followup1_sent', null)
      .not('followup1_due', 'is', null)
      .lt('followup1_due', startOfToday)
      .order('followup1_due', { ascending: true })
      .limit(limit);

    const followup2Today = base()
      .not('followup1_sent', 'is', null)
      .is('followup2_sent', null)
      .not('followup2_due', 'is', null)
      .gte('followup2_due', startOfToday)
      .lte('followup2_due', nowIso)
      .order('followup2_due', { ascending: true })
      .limit(limit);

    const followup1Today = base()
      .not('first_email_sent', 'is', null)
      .is('followup1_sent', null)
      .not('followup1_due', 'is', null)
      .gte('followup1_due', startOfToday)
      .lte('followup1_due', nowIso)
      .order('followup1_due', { ascending: true })
      .limit(limit);

    const [second, first, secondToday, firstToday] = await Promise.all([
      followup2Overdue,
      followup1Overdue,
      followup2Today,
      followup1Today,
    ]);

    /*
     * No archived filter needed here any more: lead_send_queue excludes them.
     * It matters — archiving never touches the pipeline row (it is "a
     * visibility choice"), so a follow-up due before the archive stays due
     * after it, and a `leads:duplicates --merge` loser shares the SURVIVOR's
     * exact address. That was an unattended second send to the same inbox.
     */
    for (const row of second.data ?? []) work.push({ lead_id: row.lead_id, type: 'followup2' });
    for (const row of first.data ?? []) work.push({ lead_id: row.lead_id, type: 'followup1' });
    for (const row of secondToday.data ?? []) work.push({ lead_id: row.lead_id, type: 'followup2' });
    for (const row of firstToday.data ?? []) work.push({ lead_id: row.lead_id, type: 'followup1' });
  }

  if (config.outreach.autoSendInitial) {
    /*
     * Ordered by SEND PRIORITY first, approved_at second.
     *
     *   1  a verifier proved the address, or a real email was already delivered
     *   2  a human confirmed it and no machine had said anything negative
     *   3  a human confirmed it after the verifier tried and gave up
     *
     * So every tier-1 lead goes before any tier-2, and within a tier the
     * longest-approved goes first. Ordering only, never a gate: an address
     * confirmed from the company's own website is worth mailing, it just waits
     * behind the ones a verifier proved. `compute_send_priority()` is the one
     * definition — do not re-derive it here.
     *
     * Read from lead_send_queue: it computes the priority AND is readable by
     * the service-role key. `pipeline_board` computes the same priority but is
     * gated `where public.is_admin()`, which a service-role connection never
     * satisfies — see 0035. Using it here returned zero rows on every run.
     */
    const admin = createServiceClient();
    let query = admin
      .from('lead_send_queue')
      .select('lead_id, send_priority')
      .is('replied', null)
      .is('closed', null)
      .eq('auto_followups', true)
      .eq('approved', true)
      .is('first_email_sent', null)
      .order('send_priority', { ascending: true })
      .order('approved_at', { ascending: true })
      .limit(limit);

    if (config.outreach.requireVerifiedEmail) query = query.eq('email_verified', true);

    const { data } = await query;
    const candidates = (data ?? [])
      // 9 means not sendable at all. It cannot reach here while
      // requireVerifiedEmail is on, but the sender must not depend on a setting
      // to avoid mailing an address a verifier called dead.
      .filter((row) => row.send_priority < 9)
      .map((row) => row.lead_id);

    /*
     * An initial email also needs its ACTIVE VERSION approved, which is the
     * condition checked immediately before sending. Filtering on
     * lead_pipeline.approved alone put leads in the queue that the very next
     * step then rejected, producing runs that read "6 due, 6 skipped" forever
     * with no clue as to why.
     *
     * The two flags can disagree because lead_pipeline.approved is derived from
     * leads.status, which older bulk actions set on its own. Requiring both
     * here makes the queue mean what it says.
     */
    if (candidates.length > 0) {
      const admin = createServiceClient();
      const { data: versions } = await admin
        .from('email_versions')
        .select('lead_id')
        .in('lead_id', candidates)
        .eq('type', 'initial')
        .eq('active', true)
        .eq('status', 'approved');

      const signedOff = new Set((versions ?? []).map((v) => v.lead_id));
      for (const leadId of candidates) {
        if (signedOff.has(leadId)) work.push({ lead_id: leadId, type: 'initial' });
      }
    }
  }

  return work.slice(0, limit);
}

/**
 * Make sure an active draft exists for this step, generating one if not.
 *
 * A follow-up nobody has written is the normal case the lead-gen process
 * produces the initial email only. Generating on demand is what makes the
 * sequence actually automatic; `outreach.followup_requires_approval` turns it
 * into "prepare, then wait for a human" instead.
 */
async function ensureDraft(
  leadId: string,
  type: EmailType,
): Promise<{ ok: boolean; generated: boolean; message: string; approved: boolean }> {
  const admin = createServiceClient();

  const { data: existing } = await admin
    .from('email_versions')
    .select('id, status')
    .eq('lead_id', leadId)
    .eq('type', type)
    .eq('active', true)
    .maybeSingle();

  if (existing) {
    return { ok: true, generated: false, message: 'Draft already present.', approved: existing.status === 'approved' };
  }

  const generation = await generateEmail(leadId, type);
  if (!generation.ok || !generation.email) {
    return { ok: false, generated: false, message: generation.message, approved: false };
  }

  const created = await createEmailVersion({
    leadId,
    type,
    subject: generation.email.subject,
    content: generation.email.content,
    generatedBy: generation.email.generatedBy,
    // No user session in a cron run; the provenance is on generated_by.
    createdBy: null,
    activate: true,
  });

  if (!created.ok) return { ok: false, generated: false, message: created.message, approved: false };

  await recordActivity({
    leadId,
    kind: 'draft_regenerated',
    summary: `${type === 'followup1' ? 'Follow-up 1' : type === 'followup2' ? 'Follow-up 2' : 'Initial'} draft generated automatically`,
    detail: `Generated by ${generation.email.generatedBy} while the scheduled sender was preparing this step.`,
  });

  return { ok: true, generated: true, message: created.message, approved: false };
}

export interface OutreachRunOptions {
  /** Report what would happen without sending anything. */
  dryRun?: boolean;
  /** Send even outside the configured working hours. Used by the manual trigger. */
  ignoreWorkingHours?: boolean;
  /**
   * Stop the loop once this much wall time has passed, leaving the rest for the
   * next run. Serverless platforms kill a request at 60–300s, and a partially
   * completed run that recorded every send is fine; a killed one mid-send is not.
   */
  maxRuntimeMs?: number;
}

export async function runOutreachCycle(
  options: OutreachRunOptions = {},
): Promise<OutreachRunSummary> {
  const started = Date.now();
  const dryRun = options.dryRun ?? false;

  const summary: OutreachRunSummary = {
    ok: true,
    message: '',
    considered: 0,
    sent: 0,
    generated: 0,
    failed: 0,
    skipped: 0,
    closed: 0,
    notes: [],
    durationMs: 0,
  };

  const config = await getIntegrationConfig();

  /*
   * How long this run may spend, including time asleep waiting out the gap.
   *
   * Configurable because the ceiling is the hosting platform's, not ours: a
   * Vercel Hobby function is killed at 60s, Pro allows up to 300. With a 90s
   * gap and a 50s budget exactly one email goes per run, so the CRON FREQUENCY
   * is what paces bulk sending — see the note in the cron route.
   */
  const maxRuntimeMs = options.maxRuntimeMs ?? config.outreach.maxRuntimeSeconds * 1000;

  /*
   * Every return path goes through here, which is what makes the close sweep
   * reportable. It runs before most of the guards, so a run that then bails on
   * "Nothing is due" may still have closed leads — and a housekeeping action
   * nobody is told about is indistinguishable from a bug when 56 leads quietly
   * leave the dashboard.
   */
  const finish = (message: string): OutreachRunSummary => {
    summary.message =
      summary.closed > 0
        ? `${message} Closed ${summary.closed} exhausted sequence${summary.closed === 1 ? '' : 's'}.`
        : message;
    summary.durationMs = Date.now() - started;
    return summary;
  };

  if (config.sending.paused) {
    return finish('Sending is paused (sending.paused). Nothing was sent.');
  }

  /*
   * Housekeeping first, and deliberately ABOVE the working-hours and
   * daily-limit guards (0037).
   *
   * Closing an exhausted sequence sends nothing, so neither guard has any
   * bearing on it: the sending window exists so mail does not arrive at 3am,
   * and the daily limit caps messages. Placing the sweep below them would mean
   * an operator who narrows the window to two hours a day also, silently,
   * narrows when leads can be closed.
   *
   * It IS below `sending.paused`, because that switch is documented as a
   * global kill switch — an operator who pauses expects the whole machine to
   * stop, not just the part that sends.
   *
   * Skipped on a dry run: a dry run reports what WOULD happen and must not
   * write.
   */
  if (!dryRun) {
    const closedIds = await closeExhaustedSequences(config);
    summary.closed = closedIds.length;
    for (const leadId of closedIds) {
      await recordActivity({
        leadId,
        kind: 'stage_completed',
        summary: 'Workflow closed automatically',
        detail: `No reply ${config.outreach.closeAfterFollowup2Days} days after follow-up 2. Reopen from the lead page if this was wrong.`,
      });
    }
  }

  if (!config.outreach.autoFollowups && !config.outreach.autoSendInitial) {
    return finish('Automatic sending is switched off for both follow-ups and initial emails.');
  }
  if (!options.ignoreWorkingHours && !withinWorkingHours(config, new Date())) {
    const { start, end, timezone } = config.sending.workingHours;
    return finish(`Outside the sending window (${start}–${end} ${timezone}). Nothing was sent.`);
  }

  const alreadySent = await sendsToday();
  const dailyRemaining = Math.max(0, config.sending.dailyLimit - alreadySent);
  if (dailyRemaining === 0) {
    return finish(`Daily limit reached (${alreadySent}/${config.sending.dailyLimit}). Nothing was sent.`);
  }

  const ceiling = Math.min(dailyRemaining, Math.max(1, config.outreach.maxSendsPerRun));
  const due = await findDueWork(config, ceiling);
  summary.considered = due.length;

  if (due.length === 0) return finish('Nothing is due.');
  if (dryRun) {
    return finish(
      `Dry run: ${due.length} email(s) are due ` +
        `${due.filter((d) => d.type === 'initial').length} initial, ` +
        `${due.filter((d) => d.type === 'followup1').length} follow-up 1, ` +
        `${due.filter((d) => d.type === 'followup2').length} follow-up 2. Nothing was sent.`,
    );
  }

  const admin = createServiceClient();

  for (const item of due) {
    if (Date.now() - started > maxRuntimeMs) {
      summary.notes.push('Run time budget reached; the remainder is left for the next run.');
      break;
    }

    /*
     * Honour the minimum gap BEFORE sending, not after.
     *
     * Checked ahead of every send including the first of a run, and measured
     * against the last email that actually left (see gapRemainingMs). Doing it
     * afterwards only paces sends within one run, so two runs back to back —
     * or a "Run now" during a scheduled run — would fire two emails seconds
     * apart however large the setting.
     *
     * The queue mixes initial emails and follow-ups, so the gap applies between
     * any two messages regardless of type. That is the point: the recipient's
     * mail server sees one sending pattern, not two interleaved ones.
     */
    const waitMs = await gapRemainingMs(config.sending.minGapSeconds);
    if (waitMs > 0) {
      const budgetLeft = maxRuntimeMs - (Date.now() - started);
      if (waitMs > budgetLeft) {
        // Waiting would outlive the request. Stop cleanly and let the next run
        // pick it up — the gap is measured from the database, so nothing is
        // lost by stopping here.
        summary.notes.push(
          `Next send is ${Math.ceil(waitMs / 1000)}s away (minimum gap of ${config.sending.minGapSeconds}s). Left for the next run.`,
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    // Re-check: a reply or a manual send can land between the query and here.
    const { data: pipeline } = await admin
      .from('lead_pipeline')
      .select('replied, closed, first_email_sent, followup1_sent, followup2_sent, auto_followups')
      .eq('lead_id', item.lead_id)
      .maybeSingle();

    if (!pipeline || pipeline.replied || pipeline.closed || !pipeline.auto_followups) {
      summary.skipped += 1;
      continue;
    }
    const alreadyDone =
      (item.type === 'initial' && pipeline.first_email_sent) ||
      (item.type === 'followup1' && pipeline.followup1_sent) ||
      (item.type === 'followup2' && pipeline.followup2_sent);
    if (alreadyDone) {
      summary.skipped += 1;
      continue;
    }

    const draft = await ensureDraft(item.lead_id, item.type);
    if (draft.generated) summary.generated += 1;
    if (!draft.ok) {
      summary.failed += 1;
      summary.notes.push(`${item.lead_id}: ${draft.message}`);
      continue;
    }

    // An initial email must always be approved; a follow-up only when the
    // setting demands it.
    const needsApproval =
      item.type === 'initial' || config.outreach.followupRequiresApproval;
    if (needsApproval && !draft.approved) {
      summary.skipped += 1;
      summary.notes.push(`${item.lead_id}: ${item.type} draft is waiting for approval.`);
      continue;
    }

    const result = await sendLeadEmail(item.lead_id, null, item.type);
    if (result.ok) {
      summary.sent += 1;
      await recordActivity({
        leadId: item.lead_id,
        kind: 'email_sent',
        summary: `${item.type} sent automatically`,
        detail: result.messageId ? `Provider message id: ${result.messageId}` : null,
      });
    } else {
      summary.failed += 1;
      summary.notes.push(`${item.lead_id}: ${result.message}`);
    }

    // No trailing sleep: the gap is enforced at the TOP of the next iteration,
    // against the send that was just recorded. The previous version slept here
    // and capped the wait at 10 seconds, so a 90-second setting waited 10 —
    // the UI promised one thing and the sender did another.
  }

  summary.ok = summary.failed === 0;

  /*
   * The failure reason goes IN THE MESSAGE, not just in `summary.notes`.
   *
   * Every one of `summary.notes` was already computed above — `ensureDraft()`
   * and `sendLeadEmail()` both return a specific, human-readable reason, and
   * this loop dutifully pushes `${leadId}: ${reason}` for every failure. But
   * only one caller (the Settings "Run now" button) ever read that array back
   * out; the cron route passed `summary.message` straight to `finishRun()` and
   * the reason was gone the moment this function returned. The result: three
   * leads failed on EVERY 3-minute tick for hours, `integration_runs` recorded
   * nothing but "1 failed" next to a run id, and finding out why required
   * reading the database by hand.
   *
   * Put here instead of in each caller, because "the cron and the button must
   * behave identically" is the same argument section 8 already makes for the
   * draft sweep. A caller that wants brevity can still take `summary.message`
   * alone; nobody has to remember to ask for the reason.
   */
  const detail = summary.failed > 0 && summary.notes.length > 0 ? ` ${summary.notes[0]}` : '';
  return finish(
    `${summary.sent} sent, ${summary.generated} draft(s) generated, ` +
      `${summary.skipped} skipped, ${summary.failed} failed (of ${summary.considered} due).${detail}`,
  );
}
