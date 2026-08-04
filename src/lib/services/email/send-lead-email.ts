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
  if (!lead.email) {
    return { ok: false, message: 'This lead has no email address.', messageId: null, logId: null };
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

  const config = await getIntegrationConfig();

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
  const unresolved = [
    ...findUnresolvedPlaceholders(subject),
    ...findUnresolvedPlaceholders(body),
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
      campaign_id: lead.campaign_id,
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
