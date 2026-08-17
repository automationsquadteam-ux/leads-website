'use server';

import { revalidatePath } from 'next/cache';

import { assertAdmin } from '@/lib/auth/session';
import { createServiceClient } from '@/lib/supabase/service-client';
import { importVerificationCsv } from '@/lib/services/email-verification';
import { finishRun, startRun } from '@/lib/services/integration-runs';
import { generateEmail } from '@/lib/services/ai';
import { createEmailVersion } from '@/lib/services/email-versions';
import { recordActivity } from '@/lib/services/activity';
import { runDraftSweep, type DraftSweepSummary } from '@/lib/services/drafts/sweep';
import {
  refreshStaleFollowupDrafts,
  type DraftRefreshSummary,
} from '@/lib/services/drafts/refresh';
import { EMAIL_TYPE_LABELS } from '@/lib/pipeline/labels';
import type { EmailType } from '@/lib/supabase/database.types';
import type { ActionResult } from './leads';

/**
 * Verification upload and bulk follow-up generation.
 *
 * Both are the browser-facing halves of things that already exist as CLI
 * scripts. Same services underneath, so a CSV imported through the UI and one
 * imported from the terminal produce identical state.
 */

/**
 * Apply a verifier's result CSV uploaded from the browser.
 *
 * Takes FormData because that is how a file reaches a Server Action. The file
 * is read fully into memory: verifier exports of a few thousand rows are well
 * under a megabyte, and streaming would buy nothing but complexity.
 */
export async function uploadVerificationCsv(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let userId: string;
  try {
    const session = await assertAdmin();
    userId = session.user.id;
  } catch {
    return { ok: false, message: 'You do not have permission to do that.' };
  }

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Choose a CSV file first.' };
  }
  if (file.size > 10 * 1024 * 1024) {
    return { ok: false, message: 'That file is larger than 10 MB. Split it and try again.' };
  }

  const source = (formData.get('source') as string | null)?.trim() || 'neverbounce';

  const runId = await startRun('ai', 'verify_emails', userId);

  let text: string;
  try {
    text = await file.text();
  } catch {
    await finishRun(runId, 'failed', 'Could not read the uploaded file.');
    return { ok: false, message: 'Could not read that file.' };
  }

  const summary = await importVerificationCsv(text, source);

  await finishRun(runId, summary.ok ? 'success' : 'failed', summary.message, {
    matched: summary.matched,
    unmatched: summary.unmatched,
    valid: summary.applied.valid,
    invalid: summary.applied.invalid,
    accept_all: summary.applied.accept_all,
    unknown: summary.applied.unknown,
  });

  revalidatePath('/leads');
  revalidatePath('/dashboard');
  revalidatePath('/settings');

  if (!summary.ok) return { ok: false, message: summary.message };

  const extra =
    summary.unrecognisedStatuses.length > 0
      ? ` Unrecognised results ignored: ${summary.unrecognisedStatuses.slice(0, 5).join(', ')}.`
      : '';

  return { ok: true, message: `${summary.message}${extra}` };
}

/* -------------------------------------------------------------------------- */
/* Bulk draft repair and approval                                              */
/* -------------------------------------------------------------------------- */

/**
 * The browser's half of the draft sweep.
 *
 * All of the work is in lib/services/drafts/sweep.ts, because the scheduled run
 * at /api/cron/approve-drafts has to do exactly the same thing — pressing the
 * button and letting the schedule fire must produce identical state, the same
 * way a verification CSV handled here and from the terminal does.
 *
 * What is left here is what only a browser needs: the admin check, and telling
 * Next which pages went stale.
 */
export type DraftSweepResult = DraftSweepSummary;

export async function repairAndApproveDrafts(limit = 400): Promise<DraftSweepResult> {
  let userId: string;
  try {
    const session = await assertAdmin();
    userId = session.user.id;
  } catch {
    return {
      ok: false,
      message: 'You do not have permission to do that.',
      examined: 0, repaired: 0, approved: 0, blocked: 0,
      reasons: [], blockedLeads: [], approvedLeads: [], remaining: 0, flaggedStuck: 0,
    };
  }

  const summary = await runDraftSweep({ limit, userId });

  revalidatePath('/leads');
  revalidatePath('/dashboard');
  revalidatePath('/settings');

  return summary;
}

/**
 * The browser's half of the follow-up draft refresh.
 *
 * Same split as the sweep above and for the same reason: the definition of "this
 * draft is stale" lives in the service, so a button press and a script produce
 * identical state. See `refreshStaleFollowupDrafts()` for why it only ever
 * touches unsent, template-written drafts.
 */
export type DraftRefreshResult = DraftRefreshSummary;

export async function refreshFollowupDrafts(limit = 250): Promise<DraftRefreshResult> {
  let userId: string;
  try {
    const session = await assertAdmin();
    userId = session.user.id;
  } catch {
    return {
      ok: false,
      message: 'You do not have permission to do that.',
      examined: 0, refreshed: 0, unchanged: 0, handWritten: 0, failed: 0, deferred: 0, samples: [],
    };
  }

  const summary = await refreshStaleFollowupDrafts({ limit, userId });

  revalidatePath('/leads');
  revalidatePath('/dashboard');
  revalidatePath('/settings');

  return summary;
}

/* -------------------------------------------------------------------------- */
/* Bulk follow-up drafts                                                       */
/* -------------------------------------------------------------------------- */

export interface FollowupGenerationResult extends ActionResult {
  generated: number;
  skipped: number;
  failed: number;
}

/**
 * Pre-generate follow-up 1 and 2 for every lead the initial email has gone to.
 *
 * The scheduled sender already generates a missing follow-up on the day it is
 * due, so this is not required for the sequence to work. It exists so the
 * drafts can be READ AND EDITED in advance rather than being written moments
 * before they are sent, which is the difference between reviewing your outreach
 * and finding out what it said afterwards.
 *
 * Leads that already have an active draft for a step are left alone: this must
 * be safe to run twice, and overwriting an edited draft would be the opposite
 * of safe.
 *
 * `limit` bounds how many DRAFTS this run attempts, not how many leads are
 * considered as candidates (0041). It used to be the other way round: the
 * candidate query fetched only the oldest 100 sent leads, THEN checked which
 * of those already had both follow-ups — so the query capped its own input
 * before it knew which rows were actually missing anything. On a live queue
 * of 267 sent leads where the oldest 100 were already fully drafted, the
 * button reported "0 generated, 200 already existed" and could never see the
 * 167 that genuinely needed one, on this run or any future one — the same
 * oldest 100 come back every time, because nothing about a resolved lead
 * changes its position in that ordering. The dashboard's own count (which
 * this button's copy quotes) was never wrong; only the button's candidate
 * pool was silently disjoint from it.
 */
export async function generateMissingFollowups(limit = 200): Promise<FollowupGenerationResult> {
  let userId: string;
  try {
    const session = await assertAdmin();
    userId = session.user.id;
  } catch {
    return {
      ok: false,
      message: 'You do not have permission to do that.',
      generated: 0,
      skipped: 0,
      failed: 0,
    };
  }

  const admin = createServiceClient();
  const runId = await startRun('ai', 'generate_followups', userId);

  /*
   * `lead_send_queue`, not `lead_pipeline` directly (0041, same reasoning as
   * 0035 and 0034).
   *
   * Two independent things go wrong with a raw `lead_pipeline` query here.
   * First, that table has no `status` column — the archive decision lives on
   * `leads` — so nothing stopped this from drafting follow-ups for archived
   * leads, the exact bug class 0034 fixed for the dashboard tiles. Second,
   * `pipeline_board` (the obvious fix for the first problem) is gated
   * `where public.is_admin()`, and this runs on the SERVICE-ROLE client,
   * which satisfies no such predicate and would silently get zero rows back
   * — that is the entire story of 0035. `lead_send_queue` already solves
   * both: archived-excluded, and readable by service_role because it is
   * protected by grants instead of a predicate.
   *
   * No `.limit()` here — the cap belongs on the WORK below, not on which
   * leads are even considered. See the function comment for what happened
   * when it capped the candidate list first.
   */
  const { data: pipelines } = await admin
    .from('lead_send_queue')
    .select('lead_id, first_email_sent')
    .not('first_email_sent', 'is', null)
    .is('replied', null)
    .is('closed', null)
    .order('first_email_sent', { ascending: true });

  const leadIds = (pipelines ?? []).map((row) => row.lead_id);

  if (leadIds.length === 0) {
    await finishRun(runId, 'success', 'No sent leads need follow-up drafts.');
    return {
      ok: true,
      message: 'No sent leads need follow-up drafts yet.',
      generated: 0,
      skipped: 0,
      failed: 0,
    };
  }

  // One query for every existing active follow-up, rather than two per lead.
  const { data: existing } = await admin
    .from('email_versions')
    .select('lead_id, type')
    .in('lead_id', leadIds)
    .eq('active', true)
    .in('type', ['followup1', 'followup2']);

  const have = new Set((existing ?? []).map((row) => `${row.lead_id}:${row.type}`));

  /*
   * The actual work list — only the (lead, step) pairs genuinely missing a
   * draft, oldest-sent lead first — capped by `limit`. This is what was
   * missing before: the old code capped LEADS first, by date, then checked
   * which of THOSE needed anything. On a queue where the oldest 100 sent
   * leads were already fully drafted, that query could never see the ~167
   * further down the list that actually needed one, this run or the next
   * ten — the same fully-resolved 100 came back every time, because nothing
   * about being resolved moves a lead's position in "oldest first".
   */
  const work: Array<{ leadId: string; type: EmailType }> = [];
  for (const { lead_id: leadId } of pipelines ?? []) {
    for (const type of ['followup1', 'followup2'] as EmailType[]) {
      if (!have.has(`${leadId}:${type}`)) work.push({ leadId, type });
    }
  }
  const toAttempt = work.slice(0, limit);

  // Already had an active draft for that step — the true "nothing to do"
  // count. Distinct from `deferred` below: that skip decision was made once,
  // up front, by excluding the pair from `work` entirely, not per-iteration.
  const alreadyExisted = leadIds.length * 2 - work.length;

  let generated = 0;
  let failed = 0;
  let stoppedEarly = false;
  const started = Date.now();

  for (const { leadId, type } of toAttempt) {
    // A Server Action runs inside a request. Stop before the platform kills it
    // and report what was done; the button can simply be pressed again.
    if (Date.now() - started > 50_000) {
      stoppedEarly = true;
      break;
    }

    const generation = await generateEmail(leadId, type);
    if (!generation.ok || !generation.email) {
      failed += 1;
      continue;
    }

    const created = await createEmailVersion({
      leadId,
      type,
      subject: generation.email.subject,
      content: generation.email.content,
      generatedBy: generation.email.generatedBy,
      createdBy: userId,
      activate: true,
    });

    if (!created.ok) {
      failed += 1;
      continue;
    }

    generated += 1;
    await recordActivity({
      leadId,
      kind: 'draft_regenerated',
      summary: `${EMAIL_TYPE_LABELS[type]} drafted ahead of schedule`,
      detail: `Generated by ${generation.email.generatedBy} in a bulk run.`,
      actorId: userId,
    });
  }

  /*
   * `deferred` covers BOTH reasons a genuinely-missing pair was not attempted
   * this run: the `limit` cap (work.length > limit) and the wall-clock stop
   * (stoppedEarly, before toAttempt was exhausted). Either way it is real,
   * still-outstanding work — reported so the operator knows to press the
   * button again rather than reading a quiet "done" as actually done.
   */
  const attempted = generated + failed;
  const deferred = work.length - attempted;
  const skipped = alreadyExisted; // kept for the stats blob's existing shape

  const message =
    `${generated} follow-up draft(s) generated, ${alreadyExisted} already existed` +
    (deferred > 0
      ? `, ${deferred} more are missing and were not reached${stoppedEarly ? ' (ran out of time)' : ' (limit reached)'} — press the button again.`
      : '.') +
    (failed > 0 ? ` ${failed} failed.` : '');

  await finishRun(runId, failed === 0 ? 'success' : 'failed', message, {
    generated,
    skipped,
    alreadyExisted,
    deferred,
    failed,
  });

  revalidatePath('/leads');
  revalidatePath('/dashboard');
  revalidatePath('/settings');

  return { ok: failed === 0, message, generated, skipped, failed };
}
