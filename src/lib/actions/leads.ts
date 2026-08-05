'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { assertAdmin } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service-client';
import { recordActivity } from '@/lib/services/activity';
import { sendLeadEmail } from '@/lib/services/email/send-lead-email';
import { appendSyncMessage, syncLeadChange } from '@/lib/services/sync';
import type { EmailType, LeadStatus } from '@/lib/supabase/database.types';

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Every action here calls assertAdmin() first.
 *
 * Middleware does not run for Server Actions, so this is the real
 * authorization check. RLS underneath is the third layer: even if this were
 * bypassed, a non-admin's UPDATE matches no policy and affects zero rows.
 */

const optionalText = z
  .string()
  .trim()
  .max(20000)
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

const leadUpdateSchema = z.object({
  id: z.uuid(),
  business_name: z.string().trim().min(1, 'Business name is required.').max(300),
  website: z
    .string()
    .trim()
    .max(500)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .refine((v) => v === null || /^https?:\/\//i.test(v), {
      message: 'Website must start with http:// or https://',
    }),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(320)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .refine((v) => v === null || /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v), {
      message: 'Enter a valid email address.',
    }),
  phone: optionalText,
  city: optionalText,
  country: optionalText,
  niche: optionalText,
  category: optionalText,
  status: z.enum([
    'new', 'researching', 'ready', 'approved', 'sending',
    'sent', 'replied', 'bounced', 'invalid', 'archived',
  ]),
  research_summary: optionalText,
  personalization: optionalText,
  outreach_angle: optionalText,
  subject_line: optionalText,
  draft_email: optionalText,
  notes: optionalText,
});

export async function updateLead(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to edit leads.' };
  }

  const parsed = leadUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const { id, ...values } = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase.from('leads').update(values).eq('id', id);

  if (error) return { ok: false, message: `Could not save: ${error.message}` };

  revalidatePath('/leads');
  revalidatePath(`/leads/${id}`);

  // Push the edit outward through the sync layer (Google Sheet today, whatever
  // is registered tomorrow). Best-effort on purpose: the CRM is the system of
  // record, so a Sheets outage must not make the save look like it failed but
  // the outcome is appended to the message, so it can never fail silently.
  const report = await syncLeadChange(id, ['identity', 'research', 'personalization', 'status']);
  return { ok: true, message: appendSyncMessage('Lead saved.', report) };
}

async function setStatus(id: string, status: LeadStatus, successMessage: string): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to perform this action.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.from('leads').update({ status }).eq('id', id);
  if (error) return { ok: false, message: error.message };

  revalidatePath('/leads');
  revalidatePath(`/leads/${id}`);
  revalidatePath('/dashboard');
  return { ok: true, message: successMessage };
}

/**
 * Approval lives in lib/actions/review.ts (`approveVersion`), because approving
 * is a decision about a specific draft version, not about the lead. The
 * status-only helpers below remain for the list view's bulk actions.
 */
export async function archiveLead(id: string): Promise<ActionResult> {
  return setStatus(id, 'archived', 'Lead archived.');
}

export async function unarchiveLead(id: string): Promise<ActionResult> {
  return setStatus(id, 'ready', 'Lead restored.');
}

export async function markInvalid(id: string): Promise<ActionResult> {
  return setStatus(id, 'invalid', 'Lead marked invalid.');
}

/**
 * Send one step of the sequence through the active email provider.
 *
 * The heavy lifting lives in the email service: it resolves the active draft,
 * writes the email_logs row, sends, records the provider message id and moves
 * the lead's status. Advancing lead_pipeline is the email_logs trigger's job.
 * This action only handles authorization, the audit line and cache invalidation.
 */
export async function sendEmail(id: string, emailType: EmailType = 'initial'): Promise<ActionResult> {
  let session;
  try {
    session = await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to send email.' };
  }

  const result = await sendLeadEmail(id, session.user.id, emailType);

  if (result.ok) {
    await recordActivity({
      leadId: id,
      kind: 'email_sent',
      summary: `${emailType} sent manually`,
      detail: result.messageId ? `Provider message id: ${result.messageId}` : null,
      actorId: session.user.id,
    });
    await syncLeadChange(id, ['status', 'stage']);
  }

  revalidatePath(`/leads/${id}`);
  revalidatePath('/leads');
  revalidatePath('/email-logs');
  revalidatePath('/dashboard');

  return { ok: result.ok, message: result.message };
}

/**
 * Delete leads permanently.
 *
 * Archiving is the reversible option and is right for "not now". This is for
 * rows that should never have existed — a duplicate, a test record, junk from a
 * bad import — where leaving them archived means filtering around them forever.
 *
 * Every dependent row goes with it. `leads.id` is referenced with ON DELETE
 * CASCADE by email_logs, replies, email_versions, lead_pipeline and
 * lead_activity, so the send history and drafts are destroyed too. That is the
 * intent, and it is why the UI asks twice.
 *
 * No undo. `npm run leads:purge` writes a JSON backup before deleting and can
 * restore from it; this deliberately does not, because a per-row backup file
 * for a duplicate nobody wanted is clutter rather than safety.
 */
export async function deleteLeads(ids: string[]): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to delete leads.' };
  }

  if (ids.length === 0) return { ok: false, message: 'No leads selected.' };
  if (ids.length > 500) {
    return {
      ok: false,
      message: 'Refusing to delete more than 500 at once. Use npm run leads:purge, which writes a backup first.',
    };
  }

  const admin = createServiceClient();

  // Read the names before they are gone, so the confirmation can say what it
  // actually removed rather than a bare count.
  const { data: doomed } = await admin.from('leads').select('business_name').in('id', ids);
  const names = (doomed ?? []).map((l) => l.business_name);

  const { data, error } = await admin.from('leads').delete().in('id', ids).select('id');
  if (error) return { ok: false, message: `Could not delete: ${error.message}` };

  const deleted = (data ?? []).length;

  revalidatePath('/leads');
  revalidatePath('/dashboard');
  revalidatePath('/replies');

  const preview =
    names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;

  return {
    ok: true,
    message: `Deleted ${deleted} lead${deleted === 1 ? '' : 's'} permanently${preview ? `: ${preview}` : ''}. Sent history and drafts went with them.`,
  };
}

/** Bulk status change from the leads table selection. */
export async function bulkSetStatus(ids: string[], status: LeadStatus): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to perform this action.' };
  }
  if (ids.length === 0) return { ok: false, message: 'No leads selected.' };

  // Approving is not a status change. Route it to the action that also signs
  // off the draft version, or the lead looks approved everywhere except the one
  // place the sender checks.
  if (status === 'approved') return bulkApproveDrafts(ids);

  const supabase = await createClient();
  const { error } = await supabase.from('leads').update({ status }).in('id', ids);
  if (error) return { ok: false, message: error.message };

  revalidatePath('/leads');
  revalidatePath('/dashboard');
  return { ok: true, message: `${ids.length} lead${ids.length === 1 ? '' : 's'} updated.` };
}

/**
 * Approve the active initial draft for each selected lead.
 *
 * There are two records of "approved" and they must move together:
 *
 *   lead_pipeline.approved   what the dashboard counts and the scheduler
 *                            queries to find work
 *   email_versions.status    what the scheduler checks immediately BEFORE
 *                            sending an initial email
 *
 * Setting only the lead status (which is what this used to do) satisfied the
 * first and not the second, so the dashboard would report leads as Ready to
 * Send while the sender skipped every one of them saying "waiting for
 * approval" — with nothing in the UI to explain the contradiction.
 *
 * Approving the VERSION is the right primitive: its trigger sets
 * lead_pipeline.approved, and the lead status follows here.
 */
export async function bulkApproveDrafts(ids: string[]): Promise<ActionResult> {
  let session;
  try {
    session = await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to perform this action.' };
  }
  if (ids.length === 0) return { ok: false, message: 'No leads selected.' };

  const admin = createServiceClient();
  const reviewedAt = new Date().toISOString();

  const { data: versions } = await admin
    .from('email_versions')
    .select('id, lead_id')
    .in('lead_id', ids)
    .eq('type', 'initial')
    .eq('active', true);

  const approvable = versions ?? [];
  if (approvable.length === 0) {
    return {
      ok: false,
      message: 'None of those leads has a draft to approve. Generate one first.',
    };
  }

  const { error } = await admin
    .from('email_versions')
    .update({ status: 'approved', reviewed_by: session.user.id, reviewed_at: reviewedAt })
    .in('id', approvable.map((v) => v.id));

  if (error) return { ok: false, message: error.message };

  const approvedLeadIds = approvable.map((v) => v.lead_id);
  await admin.from('leads').update({ status: 'approved' }).in('id', approvedLeadIds);

  revalidatePath('/leads');
  revalidatePath('/dashboard');

  const missing = ids.length - approvedLeadIds.length;
  return {
    ok: true,
    message:
      `${approvedLeadIds.length} draft${approvedLeadIds.length === 1 ? '' : 's'} approved and ready to send.` +
      (missing > 0 ? ` ${missing} had no draft and were skipped.` : ''),
  };
}
