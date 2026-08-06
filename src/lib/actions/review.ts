'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { assertAdmin } from '@/lib/auth/session';
import { createServiceClient } from '@/lib/supabase/service-client';
import { recordActivity } from '@/lib/services/activity';
import { generateEmail } from '@/lib/services/ai';
import {
  createEmailVersion,
  reviewVersion,
  setActiveVersion,
} from '@/lib/services/email-versions';
import { closeWorkflow, gateFlagPatch, reopenWorkflow, updatePipeline } from '@/lib/services/outreach/pipeline';
import { appendSyncMessage, syncLeadChange, type SyncField } from '@/lib/services/sync';
import { EMAIL_TYPE_LABELS, VERIFICATION_META } from '@/lib/pipeline/labels';
import {
  EMAIL_VERIFICATION_STATUSES,
  type EmailType,
  type EmailVerificationStatus,
} from '@/lib/supabase/database.types';
import type { ActionResult } from './leads';

/**
 * The admin review workflow.
 *
 * Every action here follows the same three beats:
 *
 *   1. assertAdmin() middleware does NOT run for Server Actions, so this is
 *      the real authorization check. RLS underneath is the third layer.
 *   2. Write to Supabase immediately. There is no draft state held in the
 *      client and no "save all" button; each control commits on its own.
 *   3. Push the change outward through lib/services/sync, and fold the outcome
 *      into the message so a failed Google Sheet write is impossible to miss.
 *
 * Drafts are never updated in place. Editing a draft inserts a new version, the
 * same as regenerating one that is the whole point of email_versions, and it
 * is why "Save draft" here is an INSERT and not an UPDATE.
 */

const uuid = z.uuid();
const emailTypeSchema = z.enum(['initial', 'followup1', 'followup2']);

/** Long-form fields: generous ceiling, empty string collapses to null. */
const longText = z
  .string()
  .trim()
  .max(20000)
  .transform((v) => (v === '' ? null : v))
  .nullable();

async function guard(): Promise<{ ok: true; userId: string } | { ok: false; result: ActionResult }> {
  try {
    const session = await assertAdmin();
    return { ok: true, userId: session.user.id };
  } catch {
    return {
      ok: false,
      result: { ok: false, message: 'You do not have permission to perform this action.' },
    };
  }
}

/**
 * Anything changed on one lead moves a figure on the list and the dashboard —
 * marking an address dead takes Dead Addresses from 19 to 20 — so all three
 * are revalidated together rather than leaving the counts stale until a reload.
 */
function revalidateLead(leadId: string) {
  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/leads');
  revalidatePath('/dashboard');
  revalidatePath('/settings');
}

/* -------------------------------------------------------------------------- */
/* Research, personalization, notes direct lead columns                      */
/* -------------------------------------------------------------------------- */

const researchSchema = z.object({
  leadId: uuid,
  research_summary: longText,
  website_observations: longText,
  automation_opportunities: longText,
  ai_chatbot_opportunities: longText,
  website_improvement_opportunities: longText,
  interesting_facts: longText,
  outreach_angle: longText,
});

export async function saveResearch(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;

  const parsed = researchSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const { leadId, ...values } = parsed.data;
  const admin = createServiceClient();

  /*
   * `researched_at` records WHEN research was done, and it is the carrier for
   * the sheet's own "research status" verdict (migration 0024), which is the
   * authoritative signal for research_complete.
   *
   * It used to be written as `research_summary ? now : null`, which had two
   * faults. Saving any research edit while the summary happened to be blank
   * NULLED the column — destroying the sheet's verdict for a lead that may have
   * had six other research fields filled in. And re-saving unchanged research
   * moved the timestamp forward, so "how long did research take" measured the
   * last time someone opened the form.
   *
   * Now: research changed -> stamp it. Research unchanged -> leave the column
   * exactly as it was. It is never set back to NULL from here; clearing the
   * upstream verdict is the sheet's business, not this form's.
   */
  const { data: existing } = await admin.from('leads').select('*').eq('id', leadId).maybeSingle();

  const fields = Object.keys(values) as Array<keyof typeof values>;
  const text = (value: string | null | undefined) => (value ?? '').trim();

  const changed = fields.some((field) => text(existing?.[field]) !== text(values[field]));
  const hasContent = fields.some((field) => text(values[field]) !== '');

  const { error } = await admin
    .from('leads')
    .update(changed && hasContent ? { ...values, researched_at: new Date().toISOString() } : values)
    .eq('id', leadId);

  if (error) return { ok: false, message: `Could not save research: ${error.message}` };

  await recordActivity({
    leadId,
    kind: 'research_edited',
    summary: 'Research updated',
    actorId: auth.userId,
  });

  const report = await syncLeadChange(leadId, ['research']);
  revalidateLead(leadId);

  return { ok: true, message: appendSyncMessage('Research saved.', report) };
}

const personalizationSchema = z.object({
  leadId: uuid,
  personalization: longText,
});

export async function savePersonalization(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;

  const parsed = personalizationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const { leadId, personalization } = parsed.data;
  const admin = createServiceClient();

  const { error } = await admin.from('leads').update({ personalization }).eq('id', leadId);
  if (error) return { ok: false, message: `Could not save: ${error.message}` };

  await recordActivity({
    leadId,
    kind: 'personalization_edited',
    summary: 'Personalization updated',
    actorId: auth.userId,
  });

  const report = await syncLeadChange(leadId, ['personalization']);
  revalidateLead(leadId);

  return { ok: true, message: appendSyncMessage('Personalization saved.', report) };
}

const notesSchema = z.object({ leadId: uuid, notes: longText });

export async function saveNotes(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;

  const parsed = notesSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const { leadId, notes } = parsed.data;
  const admin = createServiceClient();

  const { error } = await admin.from('leads').update({ notes }).eq('id', leadId);
  if (error) return { ok: false, message: `Could not save notes: ${error.message}` };

  await recordActivity({ leadId, kind: 'notes_edited', summary: 'Notes updated', actorId: auth.userId });

  const report = await syncLeadChange(leadId, ['notes']);
  revalidateLead(leadId);

  return { ok: true, message: appendSyncMessage('Notes saved.', report) };
}

/* -------------------------------------------------------------------------- */
/* Drafts every write is a new version                                       */
/* -------------------------------------------------------------------------- */

const draftSchema = z.object({
  leadId: uuid,
  type: emailTypeSchema,
  subject: z
    .string()
    .trim()
    .max(300)
    .transform((v) => (v === '' ? null : v))
    .nullable(),
  content: z.string().trim().min(1, 'A draft cannot be empty.').max(20000),
});

/**
 * Save an edited draft.
 *
 * INSERTs a version rather than updating one. An admin editing the wording is
 * making the same kind of change as a regeneration, and the previous wording is
 * exactly what you want back when the edit turns out to have been worse.
 */
export async function saveDraft(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;

  const parsed = draftSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const { leadId, type, subject, content } = parsed.data;

  const created = await createEmailVersion({
    leadId,
    type,
    subject,
    content,
    generatedBy: 'manual',
    createdBy: auth.userId,
    activate: true,
  });

  if (!created.ok || !created.version) {
    return { ok: false, message: created.message };
  }

  await recordActivity({
    leadId,
    kind: 'draft_edited',
    summary: `${EMAIL_TYPE_LABELS[type]} edited version ${created.version.version_number}`,
    detail: content.slice(0, 500),
    actorId: auth.userId,
  });

  const report = await syncLeadChange(leadId, [draftFieldFor(type)]);
  revalidateLead(leadId);

  return { ok: true, message: appendSyncMessage(created.message, report) };
}

function draftFieldFor(type: EmailType): SyncField {
  return type === 'initial' ? 'draft' : type === 'followup1' ? 'followup1' : 'followup2';
}

/**
 * Regenerate.
 *
 * Produces a brand-new draft through the configured generator, saves it as a
 * new version and makes it active. Nothing is overwritten; the previous version
 * stays one click away in the history.
 */
export async function regenerateDraft(leadId: string, type: EmailType): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;

  if (!uuid.safeParse(leadId).success || !emailTypeSchema.safeParse(type).success) {
    return { ok: false, message: 'Invalid request.' };
  }

  const generation = await generateEmail(leadId, type);
  if (!generation.ok || !generation.email) {
    return { ok: false, message: generation.message };
  }

  const created = await createEmailVersion({
    leadId,
    type,
    subject: generation.email.subject,
    content: generation.email.content,
    generatedBy: generation.email.generatedBy,
    createdBy: auth.userId,
    activate: true,
  });

  if (!created.ok || !created.version) return { ok: false, message: created.message };

  await recordActivity({
    leadId,
    kind: 'draft_regenerated',
    summary: `${EMAIL_TYPE_LABELS[type]} regenerated version ${created.version.version_number}`,
    detail: `Generated by ${generation.email.generatedBy}.`,
    actorId: auth.userId,
  });

  const report = await syncLeadChange(leadId, [draftFieldFor(type)]);
  revalidateLead(leadId);

  return {
    ok: true,
    message: appendSyncMessage(
      `${generation.message} Saved as version ${created.version.version_number}.`,
      report,
    ),
  };
}

export async function activateVersion(versionId: string, leadId: string): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;
  if (!uuid.safeParse(versionId).success || !uuid.safeParse(leadId).success) {
    return { ok: false, message: 'Invalid request.' };
  }

  const result = await setActiveVersion(versionId);
  if (!result.ok || !result.version) return { ok: false, message: result.message };

  await recordActivity({
    leadId,
    kind: 'version_activated',
    summary: `${EMAIL_TYPE_LABELS[result.version.type]} version ${result.version.version_number} made active`,
    actorId: auth.userId,
  });

  const report = await syncLeadChange(leadId, [draftFieldFor(result.version.type)]);
  revalidateLead(leadId);

  return { ok: true, message: appendSyncMessage(result.message, report) };
}

/**
 * Approve a draft.
 *
 * Approving the INITIAL email flags the pipeline, which is what makes the lead
 * eligible for sending. Approving a follow-up only marks that version.
 *
 * It deliberately no longer writes `leads.status`. That column is a label the
 * sheet sets and reads; the pipeline gate is the fact, and having approval write
 * both created two records of the same thing that then disagreed.
 */
export async function approveVersion(
  versionId: string,
  leadId: string,
  note?: string,
): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;
  if (!uuid.safeParse(versionId).success || !uuid.safeParse(leadId).success) {
    return { ok: false, message: 'Invalid request.' };
  }

  const result = await reviewVersion(versionId, 'approved', auth.userId, note?.trim() || null);
  if (!result.ok || !result.version) return { ok: false, message: result.message };

  if (result.version.type === 'initial') {
    await updatePipeline(leadId, gateFlagPatch('approved', true));
  }

  await recordActivity({
    leadId,
    kind: 'draft_approved',
    summary: `${EMAIL_TYPE_LABELS[result.version.type]} version ${result.version.version_number} approved`,
    detail: note?.trim() || null,
    actorId: auth.userId,
  });

  const report = await syncLeadChange(leadId, ['status', 'stage', draftFieldFor(result.version.type)]);
  revalidateLead(leadId);

  return { ok: true, message: appendSyncMessage(result.message, report) };
}

/**
 * Reject a draft.
 *
 * The row survives with its content intact rejected drafts are the ones worth
 * reading later. Rejecting the initial email un-approves the lead, because
 * leaving `approved` set would let the scheduled sender pick up a draft a human
 * just refused.
 */
export async function rejectVersion(
  versionId: string,
  leadId: string,
  note?: string,
): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;
  if (!uuid.safeParse(versionId).success || !uuid.safeParse(leadId).success) {
    return { ok: false, message: 'Invalid request.' };
  }

  const result = await reviewVersion(versionId, 'rejected', auth.userId, note?.trim() || null);
  if (!result.ok || !result.version) return { ok: false, message: result.message };

  if (result.version.type === 'initial') {
    await updatePipeline(leadId, gateFlagPatch('approved', false));
  }

  await recordActivity({
    leadId,
    kind: 'draft_rejected',
    summary: `${EMAIL_TYPE_LABELS[result.version.type]} version ${result.version.version_number} rejected`,
    detail: note?.trim() || null,
    actorId: auth.userId,
  });

  const report = await syncLeadChange(leadId, ['status', 'stage']);
  revalidateLead(leadId);

  return { ok: true, message: appendSyncMessage(result.message, report) };
}

/* -------------------------------------------------------------------------- */
/* Pipeline marking stages complete                                          */
/* -------------------------------------------------------------------------- */

const GATE_LABELS = {
  research_complete: 'Research complete',
  draft_ready: 'Initial draft written',
  approved: 'Initial email approved',
} as const;

export type PipelineGate = keyof typeof GATE_LABELS;

/**
 * Record a verification verdict for this lead's address.
 *
 * `email_verified` is not in GATE_LABELS any more, because a tick box cannot
 * represent a five-value verdict. It rendered catch-all and unknown as an empty
 * circle indistinguishable from "nobody has looked", which is exactly the
 * complaint that started this: 173 addresses that HAD been checked reading as
 * unchecked, on the lead page and in the dashboard alike.
 *
 * The status is written and the trigger derives the flag from it —
 * `email_verified := (status = 'valid')` — so the two can no longer disagree.
 * Source and timestamp are stamped here because a status written directly is
 * the "a verifier spoke" path, and the operator IS the verifier in this case.
 */
export async function setVerificationStatus(
  leadId: string,
  status: EmailVerificationStatus,
): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;
  if (!uuid.safeParse(leadId).success || !EMAIL_VERIFICATION_STATUSES.includes(status)) {
    return { ok: false, message: 'Invalid request.' };
  }

  const result = await updatePipeline(leadId, {
    email_verification_status: status,
    email_verification_source: 'manual',
    email_checked_at: status === 'unverified' ? null : new Date().toISOString(),
  });
  if (!result.ok) return { ok: false, message: result.message };

  await recordActivity({
    leadId,
    kind: 'stage_completed',
    summary: `Address marked ${VERIFICATION_META[status].label.toLowerCase()}`,
    actorId: auth.userId,
  });

  const report = await syncLeadChange(leadId, ['stage']);
  revalidateLead(leadId);

  return {
    ok: true,
    message: appendSyncMessage(`Address marked ${VERIFICATION_META[status].label.toLowerCase()}.`, report),
  };
}

/**
 * Mark a stage complete (or undo it).
 *
 * The stage itself is not written public.compute_pipeline_stage() derives it
 * from these flags on every write. Setting a flag is the only thing an operator
 * can actually assert.
 */
export async function setPipelineGate(
  leadId: string,
  gate: PipelineGate,
  value: boolean,
): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;
  if (!uuid.safeParse(leadId).success || !(gate in GATE_LABELS)) {
    return { ok: false, message: 'Invalid request.' };
  }

  const result = await updatePipeline(leadId, gateFlagPatch(gate, value));
  if (!result.ok) return { ok: false, message: result.message };

  await recordActivity({
    leadId,
    kind: 'stage_completed',
    summary: value ? `${GATE_LABELS[gate]} marked complete` : `${GATE_LABELS[gate]} cleared`,
    actorId: auth.userId,
  });

  const report = await syncLeadChange(leadId, ['stage']);
  revalidateLead(leadId);

  return {
    ok: true,
    message: appendSyncMessage(
      value ? `${GATE_LABELS[gate]} marked complete.` : `${GATE_LABELS[gate]} cleared.`,
      report,
    ),
  };
}

/** Per-lead opt out of the automatic follow-up sender. */
export async function setAutoFollowups(leadId: string, value: boolean): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;
  if (!uuid.safeParse(leadId).success) return { ok: false, message: 'Invalid request.' };

  const result = await updatePipeline(leadId, { auto_followups: value });
  if (!result.ok) return { ok: false, message: result.message };

  revalidateLead(leadId);
  return {
    ok: true,
    message: value
      ? 'Automatic follow-ups enabled for this lead.'
      : 'Automatic follow-ups paused for this lead.',
  };
}

export async function closeLeadWorkflow(leadId: string, reason: string): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;
  if (!uuid.safeParse(leadId).success) return { ok: false, message: 'Invalid request.' };

  const result = await closeWorkflow(leadId, reason || 'Closed by an administrator');
  if (!result.ok) return result;

  await recordActivity({
    leadId,
    kind: 'stage_completed',
    summary: 'Workflow closed',
    detail: reason || null,
    actorId: auth.userId,
  });

  const report = await syncLeadChange(leadId, ['stage', 'status']);
  revalidateLead(leadId);

  return { ok: true, message: appendSyncMessage('Workflow closed.', report) };
}

export async function reopenLeadWorkflow(leadId: string): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;
  if (!uuid.safeParse(leadId).success) return { ok: false, message: 'Invalid request.' };

  const result = await reopenWorkflow(leadId);
  if (!result.ok) return result;

  const report = await syncLeadChange(leadId, ['stage']);
  revalidateLead(leadId);

  return { ok: true, message: appendSyncMessage('Workflow reopened.', report) };
}
