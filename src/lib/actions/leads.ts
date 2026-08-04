'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { assertAdmin } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
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
  // record, so a Sheets outage must not make the save look like it failed — but
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

/** Bulk status change from the leads table selection. */
export async function bulkSetStatus(ids: string[], status: LeadStatus): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to perform this action.' };
  }
  if (ids.length === 0) return { ok: false, message: 'No leads selected.' };

  const supabase = await createClient();
  const { error } = await supabase.from('leads').update({ status }).in('id', ids);
  if (error) return { ok: false, message: error.message };

  revalidatePath('/leads');
  revalidatePath('/dashboard');
  return { ok: true, message: `${ids.length} lead${ids.length === 1 ? '' : 's'} updated.` };
}
