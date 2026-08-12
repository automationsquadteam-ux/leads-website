'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { assertAdmin } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service-client';
import { recordActivity } from '@/lib/services/activity';
import { sendLeadEmail } from '@/lib/services/email/send-lead-email';
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
  /*
   * The DATABASE enum, not a label. `public.lead_status` has ten values and
   * 'approved' is one of them; renaming it here to 'initial approved' is what
   * broke the last deploy, because Postgres has no such value and TypeScript
   * has no such LeadStatus.
   *
   * Wording belongs in STAGE_META and GATE_LABELS, which is where "Initial
   * Approved" now lives. Nothing a user reads comes from this list.
   */
  status: z.enum([
    'new', 'researching', 'ready', 'approved', 'sending',
    'sent', 'replied', 'bounced', 'invalid', 'archived',
  ]),
  research_summary: optionalText,
  personalization: optionalText,
  outreach_angle: optionalText,
  notes: optionalText,
  /*
   * `subject_line` and `draft_email` are deliberately ABSENT (0039).
   *
   * This action must never write the draft. It used to accept both from hidden
   * inputs on the lead form, which meant every save of the Business-information
   * card rewrote leads.draft_email with a CRLF-normalised copy of itself — and
   * `version_lead_draft()` correctly read that as an external edit, spawning a
   * new active version and demoting the approved one.
   *
   * The draft's owner is email_versions, edited through DraftWorkspace, which
   * creates a version per change. Accepting it here was a second writer for
   * something that already had one.
   */
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

  return { ok: true, message: 'Lead saved.' };
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
 * Archiving is the one thing `leads.status` is still used for in the UI.
 *
 * Approval lives in lib/actions/review.ts (`approveVersion`), because approving
 * is a decision about a specific draft version, not about the lead, and the
 * pipeline learns about it from the version. Whether an address is dead is
 * `email_verification_status`, set by the verification control on the lead page.
 * Neither is a lead status any more.
 *
 * Archiving genuinely is: it is a visibility choice that no derived stage can
 * express, since an archived lead still sits wherever it sat in the pipeline.
 */
export async function archiveLead(id: string): Promise<ActionResult> {
  return setStatus(id, 'archived', 'Lead archived.');
}

export async function unarchiveLead(id: string): Promise<ActionResult> {
  return setStatus(id, 'ready', 'Lead restored.');
}

/** Bulk archive from the leads table selection. */
export async function archiveLeads(ids: string[]): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to perform this action.' };
  }
  if (ids.length === 0) return { ok: false, message: 'No leads selected.' };

  const supabase = await createClient();
  const { error } = await supabase.from('leads').update({ status: 'archived' }).in('id', ids);
  if (error) return { ok: false, message: error.message };

  revalidatePath('/leads');
  revalidatePath('/dashboard');
  return { ok: true, message: `${ids.length} lead${ids.length === 1 ? '' : 's'} archived.` };
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

/**
 * Approve the active initial draft for each selected lead.
 *
 * **This changes the draft and the approval, and nothing else.** It does not
 * touch the address, the verification verdict, the research or the lead status.
 * Approving is a judgement about the WORDS, and it stays valid whether or not
 * the lead has a usable address yet — a lead can be approved and still never
 * reach Ready to Send, because that requires all four pipeline gates.
 *
 * It approves the VERSION rather than setting a status, because
 * `sync_pipeline_from_version()` is what sets `lead_pipeline.approved` and the
 * sender re-checks the version immediately before an initial send. It used to
 * set `leads.status = 'approved'` too, which satisfied the dashboard and not the
 * sender, so leads were reported Ready to Send while every run skipped them.
 *
 * Rejected versions are left alone. Without that filter this re-approved drafts
 * a human had explicitly turned down, silently.
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
    .eq('active', true)
    .eq('status', 'draft');

  const approvable = versions ?? [];
  if (approvable.length === 0) {
    return {
      ok: false,
      message:
        'None of those leads has a draft awaiting approval. They are either already approved, ' +
        'rejected, or have no draft yet.',
    };
  }

  const { error } = await admin
    .from('email_versions')
    .update({ status: 'approved', reviewed_by: session.user.id, reviewed_at: reviewedAt })
    .in('id', approvable.map((v) => v.id));

  if (error) return { ok: false, message: error.message };

  revalidatePath('/leads');
  revalidatePath('/dashboard');

  const skipped = ids.length - approvable.length;
  return {
    ok: true,
    message:
      `${approvable.length} draft${approvable.length === 1 ? '' : 's'} approved.` +
      (skipped > 0 ? ` ${skipped} had no draft awaiting approval and were skipped.` : ''),
  };
}

/* -------------------------------------------------------------------------- */
/* Bulk address editing and verification                                       */
/* -------------------------------------------------------------------------- */

/**
 * Mark the selected leads' addresses as verified, by hand.
 *
 * This is a VERDICT about the address, and it is a different thing entirely
 * from `bulkApproveDrafts()`, which is a judgement about the WORDS. A lead
 * needs both before it can be sent, and conflating them in one button is how
 * you end up approving copy for an address nobody has checked.
 *
 * Recorded as source `manual`, so `email_verifier_status` is left alone and
 * send priority can still tell "a verifier proved this" from "a human said so"
 * (0028). Only ever raises unproven addresses: a lead a verifier has already
 * called `invalid` is skipped rather than overridden, because a hard bounce is
 * evidence and a tick box is not.
 */
export async function bulkMarkEmailVerified(ids: string[]): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to perform this action.' };
  }
  if (ids.length === 0) return { ok: false, message: 'No leads selected.' };

  const admin = createServiceClient();

  // An address has to exist before it can be called good.
  const { data: withEmail } = await admin
    .from('leads')
    .select('id')
    .in('id', ids)
    .not('email', 'is', null);

  const candidates = (withEmail ?? []).map((l) => l.id);
  if (candidates.length === 0) {
    return { ok: false, message: 'None of the selected leads has an email address to verify.' };
  }

  const { data: updated, error } = await admin
    .from('lead_pipeline')
    .update({
      email_verification_status: 'valid',
      email_verification_source: 'manual',
      email_checked_at: new Date().toISOString(),
    })
    .in('lead_id', candidates)
    .neq('email_verification_status', 'invalid')
    .select('lead_id');

  if (error) return { ok: false, message: error.message };

  revalidatePath('/leads');
  revalidatePath('/dashboard');

  const n = updated?.length ?? 0;
  const skipped = ids.length - n;
  return {
    ok: true,
    message:
      `${n} address${n === 1 ? '' : 'es'} marked verified.` +
      (skipped > 0
        ? ` ${skipped} skipped — no address, already verified, or proved undeliverable.`
        : ''),
  };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

/**
 * Write addresses for several leads at once, from the leads table.
 *
 * Every address written here is NEW information, so the verdict that was true
 * of the old one cannot survive it: each updated lead is put back to
 * `unverified` ("never checked") in the same call. 0028's trigger does this
 * too, but only for leads whose verdict recorded which address it was about —
 * so it is done explicitly here rather than relied upon, and the outcome is the
 * same whether or not 0038 has been applied.
 *
 * One lead at a time, deliberately. `leads.dedupe_key` is UNIQUE and is
 * recomputed from the address by trigger (0028), so a typo that collides with
 * an existing lead must fail that ONE row and report which, rather than
 * aborting a batch of thirty and leaving the operator to guess.
 */
export async function bulkUpdateEmails(
  entries: Array<{ id: string; email: string }>,
): Promise<ActionResult> {
  try {
    await assertAdmin();
  } catch {
    return { ok: false, message: 'You do not have permission to edit leads.' };
  }
  if (entries.length === 0) return { ok: false, message: 'No addresses to save.' };

  const admin = createServiceClient();
  let saved = 0;
  const failures: string[] = [];

  for (const entry of entries) {
    const email = entry.email.trim().toLowerCase();
    if (email !== '' && !EMAIL_RE.test(email)) {
      failures.push(`${email || '(blank)'}: not a valid address`);
      continue;
    }

    const { error } = await admin
      .from('leads')
      .update({ email: email === '' ? null : email })
      .eq('id', entry.id);

    if (error) {
      failures.push(
        error.code === '23505'
          ? `${email}: already belongs to another lead`
          : `${email}: ${error.message}`,
      );
      continue;
    }

    /*
     * Back to "never checked". Written after the address, never before: if the
     * address write fails, the old verdict is still true of the old address and
     * must not be thrown away.
     */
    await admin
      .from('lead_pipeline')
      .update({
        email_verification_status: 'unverified',
        email_verification_source: null,
        email_verifier_status: null,
        email_checked_at: null,
        email_checked_address: null,
      })
      .eq('lead_id', entry.id);

    saved += 1;
  }

  revalidatePath('/leads');
  revalidatePath('/dashboard');

  if (saved === 0) {
    return { ok: false, message: `Nothing saved. ${failures.join('; ')}` };
  }
  return {
    ok: true,
    message:
      `${saved} address${saved === 1 ? '' : 'es'} saved and set back to never checked.` +
      (failures.length > 0 ? ` ${failures.length} failed — ${failures.join('; ')}` : ''),
  };
}
