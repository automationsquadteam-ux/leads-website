import 'server-only';

import { createServiceClient } from '@/lib/supabase/service-client';
import type { EmailType } from '@/lib/supabase/database.types';
import { getIntegrationConfig } from '../config';
import { getActiveProvider } from './index';
import { findUnresolvedPlaceholders, renderPlaceholders } from './render';
import { EmailConfigError } from './types';

export { renderPlaceholders } from './render';

/**
 * Send a lead's draft through the active provider and record the attempt.
 *
 * Ordering matters: the email_logs row is written as 'queued' BEFORE the send,
 * so a crash, timeout or serverless kill mid-send still leaves evidence that an
 * attempt happened. A log written only on success would silently lose exactly
 * the cases you most need to investigate.
 */

export interface SendLeadEmailResult {
  ok: boolean;
  message: string;
  messageId: string | null;
  logId: string | null;
}

/**
 * Why a send was refused, phrased for the person reading the toast rather than
 * as the enum value. 'valid' and 'invalid' are absent: one is never refused and
 * the other has its own, blunter message.
 */
const VERIFICATION_REASON: Record<string, string> = {
  unverified: 'has never been checked',
  accept_all: 'is on a catch-all domain, so the check proved nothing either way',
  unknown: 'came back unresolved the verifier could not decide',
};

/**
 * Send one step of the sequence.
 *
 * The copy comes from the ACTIVE version in email_versions, which is the whole
 * point of versioning: whichever draft the admin selected is the one that goes
 * out, with no separate "publish" step to forget. For `initial` there is a
 * fallback to leads.subject_line / draft_email, because leads imported before
 * versioning existed have their draft there the mirror trigger keeps the two
 * in step from here on.
 *
 * Advancing lead_pipeline is NOT done here. The email_logs trigger does it, so
 * a send recorded by the cron sender, this function, or a future webhook
 * reconciliation all move the lifecycle identically.
 */
export async function sendLeadEmail(
  leadId: string,
  userId: string | null,
  emailType: EmailType = 'initial',
): Promise<SendLeadEmailResult> {
  const admin = createServiceClient();

  const { data: lead, error: leadError } = await admin
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .maybeSingle();

  if (leadError || !lead) {
    return { ok: false, message: 'Lead not found.', messageId: null, logId: null };
  }

  /*
   * Archiving is documented elsewhere as "a visibility choice" — the pipeline
   * row is untouched on purpose, so a merge that archives a duplicate (or any
   * other archive) does not lose its history. But that means nothing else
   * stops it from being sent to: findDueWork() reads lead_pipeline directly
   * and has never checked leads.status, so an archived lead with a live
   * followup1_due/followup2_due — exactly what `leads:duplicates --merge`
   * leaves behind on the loser — gets auto-emailed on schedule like any other.
   * Observed live: 6 of 8 archived duplicate-losers still armed, one of them
   * (Lanka Safe Tours) due in days, most sharing the SURVIVOR's exact address,
   * which is a duplicate send waiting to happen.
   *
   * This is the one gate every send path goes through (Send button, API, cron)
   * so this is the only place that closes it for good, the same reasoning as
   * the verification and placeholder gates below.
   */
  if (lead.status === 'archived') {
    return {
      ok: false,
      message: 'This lead is archived and cannot be emailed. Restore it first if that was not intended.',
      messageId: null,
      logId: null,
    };
  }

  if (!lead.email) {
    return { ok: false, message: 'This lead has no email address.', messageId: null, logId: null };
  }

  const config = await getIntegrationConfig();

  /*
   * The verification gate, in the ONE function every send path goes through.
   *
   * It used to live only in findDueWork(), which protected the scheduled sender
   * and nothing else the Send button on a lead page would happily mail an
   * address a verifier had already proved dead, and so would the API route. A
   * rule enforced only by the callers that happen to remember it is not
   * enforced, which is the same argument as the placeholder check below.
   *
   * Checked BEFORE the draft, because "this address is dead" is the more useful
   * answer when both are wrong: writing a draft for it would be wasted work.
   *
   * Fails closed. A lead with no pipeline row reads as unverified, so a missing
   * projection blocks a send rather than waving it through.
   */
  const { data: pipeline } = await admin
    .from('lead_pipeline')
    .select('email_verified, email_verification_status, email_verifier_status')
    .eq('lead_id', leadId)
    .maybeSingle();

  const verification = pipeline?.email_verification_status ?? 'unverified';

  /*
   * 'invalid' is refused whatever the settings say. require_verified_email is
   * about how much proof we insist on before a first contact; a hard bounce is
   * not a lack of proof, it is proof of the opposite, and no setting should let
   * the system keep mailing an address it knows is dead.
   */
  if (verification === 'invalid') {
    return {
      ok: false,
      message:
        `${lead.email} was proved undeliverable, so sending to it would bounce. ` +
        'Find a new address for this lead first.',
      messageId: null,
      logId: null,
    };
  }

  /*
   * A VERIFIER called this address dead, and a human has since marked it valid.
   * The machine wins.
   *
   * This is only safe — and only correct — because 0028 resets the verdict when
   * the address changes. If the address still is the one that bounced, no
   * override on a contact page should rescue it; if it has been corrected since,
   * email_verifier_status is already NULL and this branch never fires. That is
   * exactly the difference between "I fixed the typo" and "I disagree with the
   * bounce".
   */
  if (pipeline?.email_verifier_status === 'invalid') {
    return {
      ok: false,
      message:
        `A verifier proved ${lead.email} undeliverable, and that has not been ` +
        'overruled by correcting the address. Change the address to the right one ' +
        'and the verdict clears by itself.',
      messageId: null,
      logId: null,
    };
  }

  if (config.outreach.requireVerifiedEmail && !pipeline?.email_verified) {
    return {
      ok: false,
      message:
        `${lead.email} ${VERIFICATION_REASON[verification] ?? 'is not verified'}. ` +
        'Verify the address, or turn off "Require a verified email" in Settings, then send.',
      messageId: null,
      logId: null,
    };
  }

  const { data: version } = await admin
    .from('email_versions')
    .select('id, subject, content')
    .eq('lead_id', leadId)
    .eq('type', emailType)
    .eq('active', true)
    .maybeSingle();

  const rawSubject = version?.subject ?? (emailType === 'initial' ? lead.subject_line : null);
  const rawBody = version?.content ?? (emailType === 'initial' ? lead.draft_email : null);

  if (!rawBody?.trim()) {
    return {
      ok: false,
      message:
        emailType === 'initial'
          ? 'This lead has no active initial draft. Write or generate one before sending.'
          : `This lead has no active ${emailType === 'followup1' ? 'follow-up 1' : 'follow-up 2'} draft. Generate one before sending.`,
      messageId: null,
      logId: null,
    };
  }
  if (!rawSubject?.trim()) {
    return {
      ok: false,
      message: 'That draft has no subject line. Add one before sending.',
      messageId: null,
      logId: null,
    };
  }

  let provider;
  try {
    provider = await getActiveProvider();
  } catch (error) {
    const message =
      error instanceof EmailConfigError
        ? error.message
        : 'The email provider is not configured correctly.';
    return { ok: false, message, messageId: null, logId: null };
  }

  const subject = renderPlaceholders(rawSubject, lead, config.email.signature);
  const body = renderPlaceholders(rawBody, lead, config.email.signature);

  /*
   * Refuse to send a draft that still contains a placeholder.
   *
   * Checked here rather than in the UI because this is the ONE function every
   * send path goes through the Send button, the API and the cron sender. A
   * check in the review screen would protect the click and miss the automation,
   * which is precisely the case where nobody is watching.
   *
   * Blocking rather than warning is a deliberate asymmetry: the cost of a
   * refused send is one edit, the cost of mailing "Hi [Business Owner's Name]"
   * to a prospect is that prospect, permanently.
   */
  // The lead's own real values, so a bracketed tag genuinely part of its
  // name — "Emirates Dermatology & Cosmetology Center [EDCC]" — is not
  // mistaken for an unfilled `[Business Owner]`. See findUnresolvedPlaceholders.
  const knownValues = [lead.business_name, lead.niche, lead.city, lead.country].filter(
    (v): v is string => Boolean(v),
  );
  const unresolved = [
    ...findUnresolvedPlaceholders(subject, knownValues),
    ...findUnresolvedPlaceholders(body, knownValues),
  ];
  if (unresolved.length > 0) {
    const shown = [...new Set(unresolved)].slice(0, 5).join(', ');
    return {
      ok: false,
      message:
        `This draft still contains placeholder text (${shown}) which would be sent literally. ` +
        'Edit the draft or regenerate it, then send.',
      messageId: null,
      logId: null,
    };
  }

  // Record the attempt first see the note at the top of this file.
  const { data: log } = await admin
    .from('email_logs')
    .insert({
      lead_id: lead.id,
      status: 'queued',
      provider: provider.id,
      subject,
      sent_by: userId,
      email_type: emailType,
      email_version_id: version?.id ?? null,
    })
    .select('id')
    .single();

  const logId = log?.id ?? null;

  // Mark the lead in-flight so a second click cannot double-send while the
  // provider is still working.
  await admin.from('leads').update({ status: 'sending' }).eq('id', lead.id);

  const result = await provider.send({
    to: lead.email,
    subject,
    text: body,
    replyTo: config.email.replyTo || undefined,
  });

  const now = new Date().toISOString();

  if (logId) {
    await admin
      .from('email_logs')
      .update({
        status: result.ok ? 'sent' : 'failed',
        message_id: result.messageId,
        sent_at: result.ok ? now : null,
        error: result.ok ? null : `${result.message}${result.detail ? ` ${result.detail}` : ''}`.slice(0, 2000),
      })
      .eq('id', logId);
  }

  await admin
    .from('leads')
    .update(
      result.ok
        ? { status: 'sent', last_contacted_at: now }
        // Roll back on failure so the lead stays actionable instead of being
        // stranded in 'sending'. A failed follow-up returns to 'sent' the
        // earlier email did go out, and 'approved' would misreport that.
        : { status: emailType === 'initial' ? 'approved' : 'sent' },
    )
    .eq('id', lead.id);

  return {
    ok: result.ok,
    message: result.ok
      ? `Email sent to ${lead.email}.`
      : `Send failed: ${result.message}`,
    messageId: result.messageId,
    logId,
  };
}

/** Send a fixed test message to prove the provider works end to end. */
export async function sendTestEmail(recipient: string): Promise<{ ok: boolean; message: string; messageId: string | null }> {
  let provider;
  try {
    provider = await getActiveProvider();
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Provider not configured.',
      messageId: null,
    };
  }

  const result = await provider.send({
    to: recipient,
    subject: 'Leads CRM test email',
    text:
      'This is a test message from Leads CRM.\n\n' +
      `Provider: ${provider.label}\n` +
      `Sent at: ${new Date().toISOString()}\n\n` +
      'If you received this, outbound email is configured correctly.',
  });

  return {
    ok: result.ok,
    message: result.ok ? `Test email sent to ${recipient}.` : result.message,
    messageId: result.messageId,
  };
}
