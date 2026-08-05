'use server';

import { revalidatePath } from 'next/cache';

import { assertAdmin } from '@/lib/auth/session';
import { createServiceClient } from '@/lib/supabase/service-client';
import { importVerificationCsv } from '@/lib/services/email-verification';
import { finishRun, startRun } from '@/lib/services/integration-runs';
import { generateEmail } from '@/lib/services/ai';
import { createEmailVersion } from '@/lib/services/email-versions';
import { inspectDraft, repairDraft } from '@/lib/services/drafts/quality';
import { recordActivity } from '@/lib/services/activity';
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

export interface DraftSweepResult extends ActionResult {
  examined: number;
  repaired: number;
  approved: number;
  blocked: number;
  /** Why the blocked ones were left, most common first. */
  reasons: Array<{ kind: string; count: number; example: string }>;
  /**
   * The leads that were left behind, so the report is actionable rather than a
   * number. Capped, because a list of 400 links is not a report either.
   */
  blockedLeads: Array<{ leadId: string; businessName: string; reasons: string[] }>;
  /** A few that went through, so a run that approved nothing is distinguishable
   *  from one that approved silently. */
  approvedLeads: Array<{ leadId: string; businessName: string }>;
  remaining: number;
}

/**
 * Clean every pending draft, then approve the ones that come out spotless.
 *
 * The bottleneck this removes: drafts arrive from the upstream Ollama pipeline
 * as JSON payloads — `{"header": "...", "body": "Hi,\n\n..."}` — and every one
 * had to be opened and hand-edited before it could be approved.
 *
 * Two distinct steps, deliberately not merged:
 *
 *   REPAIR   unwrap the JSON, turn \n back into newlines, drop code fences.
 *            Mechanical and safe. Creates a NEW VERSION, so the original stays
 *            in the history and a bad repair is one click from being undone.
 *
 *   APPROVE  only for drafts with zero blocking issues afterwards. Anything
 *            still carrying a placeholder, stray braces or a truncated body
 *            keeps its place in the queue and says why.
 *
 * Repairing never implies approving. A draft this cannot fully clean is left
 * for a human, which is the whole point of having an approval step.
 */
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
      reasons: [], blockedLeads: [], approvedLeads: [], remaining: 0,
    };
  }

  const admin = createServiceClient();
  const runId = await startRun('ai', 'sweep_drafts', userId);

  const { data: pending } = await admin
    .from('email_versions')
    .select('id, lead_id, subject, content, generated_by, version_number')
    .eq('type', 'initial')
    .eq('active', true)
    .eq('status', 'draft')
    .order('created_at', { ascending: true })
    .limit(limit);

  const drafts = pending ?? [];

  // Business names up front, so the report can name leads rather than list
  // UUIDs. One query for the batch, not one per draft.
  const nameById = new Map<string, string>();
  for (let i = 0; i < drafts.length; i += 300) {
    const { data } = await admin
      .from('leads')
      .select('id, business_name')
      .in('id', drafts.slice(i, i + 300).map((d) => d.lead_id));
    for (const lead of data ?? []) nameById.set(lead.id, lead.business_name);
  }

  let repaired = 0;
  let approved = 0;
  const blockedBy = new Map<string, { count: number; example: string }>();
  const blockedLeads: DraftSweepResult['blockedLeads'] = [];
  const approvedLeads: DraftSweepResult['approvedLeads'] = [];
  const started = Date.now();
  let examined = 0;

  for (const draft of drafts) {
    // Server actions run inside a request; stop before the platform kills it
    // and report honestly. The button can simply be pressed again.
    if (Date.now() - started > 45_000) break;
    examined += 1;

    const result = repairDraft({ subject: draft.subject, content: draft.content });

    let subject = draft.subject;
    let content = draft.content;

    if (result.repaired && result.content.trim() !== '') {
      const created = await createEmailVersion({
        leadId: draft.lead_id,
        type: 'initial',
        subject: result.subject,
        content: result.content,
        // Provenance records that this is the same generation, cleaned — not a
        // fresh one. "which model wrote it" stays answerable.
        generatedBy: draft.generated_by.includes(':cleaned')
          ? draft.generated_by
          : `${draft.generated_by}:cleaned`,
        createdBy: userId,
        activate: true,
      });

      if (created.ok && created.version) {
        repaired += 1;
        subject = created.version.subject;
        content = created.version.content;

        await recordActivity({
          leadId: draft.lead_id,
          kind: 'draft_edited',
          summary: `Draft unwrapped from JSON — version ${created.version.version_number}`,
          detail: `Cleaned automatically. Version ${draft.version_number} is unchanged in the history.`,
          actorId: userId,
        });
      }
    }

    const issues = inspectDraft({ subject, content });
    const blocking = issues.filter((issue) => issue.blocking);

    if (blocking.length === 0) {
      // The version id may have changed if a repair created a new one, so
      // re-resolve the active row rather than trusting the one we started with.
      const { data: active } = await admin
        .from('email_versions')
        .select('id')
        .eq('lead_id', draft.lead_id)
        .eq('type', 'initial')
        .eq('active', true)
        .maybeSingle();

      if (active) {
        await admin
          .from('email_versions')
          .update({ status: 'approved', reviewed_by: userId, reviewed_at: new Date().toISOString() })
          .eq('id', active.id);
        await admin.from('leads').update({ status: 'approved' }).eq('id', draft.lead_id);
        approved += 1;

        if (approvedLeads.length < 20) {
          approvedLeads.push({
            leadId: draft.lead_id,
            businessName: nameById.get(draft.lead_id) ?? 'Unknown lead',
          });
        }
      }
    } else {
      const first = blocking[0]!;
      const entry = blockedBy.get(first.kind) ?? { count: 0, example: first.message };
      entry.count += 1;
      blockedBy.set(first.kind, entry);

      if (blockedLeads.length < 100) {
        blockedLeads.push({
          leadId: draft.lead_id,
          businessName: nameById.get(draft.lead_id) ?? 'Unknown lead',
          reasons: blocking.map((issue) => issue.message),
        });
      }
    }
  }

  const reasons = [...blockedBy.entries()]
    .map(([kind, v]) => ({ kind, count: v.count, example: v.example }))
    .sort((a, b) => b.count - a.count);

  const blocked = reasons.reduce((sum, r) => sum + r.count, 0);
  const remaining = Math.max(0, drafts.length - examined);

  const message =
    `${examined} draft(s) checked: ${repaired} cleaned, ${approved} approved and ready to send, ` +
    `${blocked} left for review.` +
    (remaining > 0 ? ` ${remaining} not reached — press again.` : '');

  await finishRun(runId, 'success', message, { examined, repaired, approved, blocked });

  revalidatePath('/leads');
  revalidatePath('/dashboard');
  revalidatePath('/settings');

  return {
    ok: true,
    message,
    examined,
    repaired,
    approved,
    blocked,
    reasons,
    blockedLeads,
    approvedLeads,
    remaining,
  };
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
