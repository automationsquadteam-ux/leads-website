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
 */
export async function generateMissingFollowups(limit = 100): Promise<FollowupGenerationResult> {
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

  const { data: pipelines } = await admin
    .from('lead_pipeline')
    .select('lead_id')
    .not('first_email_sent', 'is', null)
    .is('replied', null)
    .is('closed', null)
    .order('first_email_sent', { ascending: true })
    .limit(limit);

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

  let generated = 0;
  let skipped = 0;
  let failed = 0;
  const started = Date.now();

  for (const leadId of leadIds) {
    // A Server Action runs inside a request. Stop before the platform kills it
    // and report what was done; the button can simply be pressed again.
    if (Date.now() - started > 50_000) break;

    for (const type of ['followup1', 'followup2'] as EmailType[]) {
      if (have.has(`${leadId}:${type}`)) {
        skipped += 1;
        continue;
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
  }

  const message =
    `${generated} follow-up draft(s) generated, ${skipped} already existed` +
    (failed > 0 ? `, ${failed} failed.` : '.');

  await finishRun(runId, failed === 0 ? 'success' : 'failed', message, {
    generated,
    skipped,
    failed,
  });

  revalidatePath('/leads');
  revalidatePath('/dashboard');
  revalidatePath('/settings');

  return { ok: failed === 0, message, generated, skipped, failed };
}
