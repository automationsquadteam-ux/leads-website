import 'server-only';

import { createServiceClient } from '@/lib/supabase/service-client';
import type { EmailType } from '@/lib/supabase/database.types';
import { getIntegrationConfig, type IntegrationConfig } from '../config';
import { recordActivity } from '../activity';
import { createEmailVersion } from '../email-versions';
import { generateEmail } from '../ai';
import { sendLeadEmail } from '../email/send-lead-email';
import { syncLeadChange } from '../sync';

/**
 * The automatic sender.
 *
 * One pure-ish function of (database, settings, clock) with no scheduling of
 * its own, exactly like sheet-sync.ts. Something outside the app calls it —
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
 * Advancing the pipeline is not done here — the email_logs trigger does it, so
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
 * Everything due right now, oldest first.
 *
 * Follow-up 2 is queried before follow-up 1 so a lead that has been waiting
 * longest in the sequence is not starved by a flood of newer first follow-ups
 * when the per-run ceiling bites.
 */
async function findDueWork(config: IntegrationConfig, limit: number): Promise<DueRow[]> {
  const admin = createServiceClient();
  const nowIso = new Date().toISOString();
  const work: DueRow[] = [];

  const base = () =>
    admin
      .from('lead_pipeline')
      .select('lead_id')
      .is('replied', null)
      .is('closed', null)
      .eq('auto_followups', true);

  if (config.outreach.autoFollowups) {
    const followup2 = base()
      .not('followup1_sent', 'is', null)
      .is('followup2_sent', null)
      .not('followup2_due', 'is', null)
      .lte('followup2_due', nowIso)
      .order('followup2_due', { ascending: true })
      .limit(limit);

    const followup1 = base()
      .not('first_email_sent', 'is', null)
      .is('followup1_sent', null)
      .not('followup1_due', 'is', null)
      .lte('followup1_due', nowIso)
      .order('followup1_due', { ascending: true })
      .limit(limit);

    const [second, first] = await Promise.all([followup2, followup1]);
    for (const row of second.data ?? []) work.push({ lead_id: row.lead_id, type: 'followup2' });
    for (const row of first.data ?? []) work.push({ lead_id: row.lead_id, type: 'followup1' });
  }

  if (config.outreach.autoSendInitial) {
    let query = base()
      .eq('approved', true)
      .is('first_email_sent', null)
      .order('approved_at', { ascending: true })
      .limit(limit);

    if (config.outreach.requireVerifiedEmail) query = query.eq('email_verified', true);

    const { data } = await query;
    for (const row of data ?? []) work.push({ lead_id: row.lead_id, type: 'initial' });
  }

  return work.slice(0, limit);
}

/**
 * Make sure an active draft exists for this step, generating one if not.
 *
 * A follow-up nobody has written is the normal case — the lead-gen process
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
  const maxRuntimeMs = options.maxRuntimeMs ?? 45_000;

  const summary: OutreachRunSummary = {
    ok: true,
    message: '',
    considered: 0,
    sent: 0,
    generated: 0,
    failed: 0,
    skipped: 0,
    notes: [],
    durationMs: 0,
  };

  const config = await getIntegrationConfig();

  const finish = (message: string): OutreachRunSummary => {
    summary.message = message;
    summary.durationMs = Date.now() - started;
    return summary;
  };

  if (config.sending.paused) {
    return finish('Sending is paused (sending.paused). Nothing was sent.');
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
      `Dry run: ${due.length} email(s) are due — ` +
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
      // Push the new state outward (status, stage, next step) best-effort.
      await syncLeadChange(item.lead_id, ['status', 'stage']);
    } else {
      summary.failed += 1;
      summary.notes.push(`${item.lead_id}: ${result.message}`);
    }

    // Space sends out so a burst does not look like a mail blast. Skipped on
    // the last item — there is nothing left to space it from.
    const isLast = item === due[due.length - 1];
    if (!isLast && config.sending.minGapSeconds > 0) {
      const gap = Math.min(config.sending.minGapSeconds * 1000, 10_000);
      await new Promise((resolve) => setTimeout(resolve, gap));
    }
  }

  summary.ok = summary.failed === 0;
  return finish(
    `${summary.sent} sent, ${summary.generated} draft(s) generated, ` +
      `${summary.skipped} skipped, ${summary.failed} failed (of ${summary.considered} due).`,
  );
}
