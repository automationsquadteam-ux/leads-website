'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { assertAdmin } from '@/lib/auth/session';
import { createServiceClient } from '@/lib/supabase/service-client';
import { searchLeadsForPicker, type LeadOption } from '@/lib/data/inbox';
import { createReply } from '@/lib/services/inbound/ingest';
import { guessSentiment } from '@/lib/services/inbound/classify';
import type { ActionResult } from './leads';

/**
 * The Replies inbox actions.
 *
 * Manual assignment goes through the SAME `createReply()` the automatic path
 * uses, so a hand-assigned reply produces byte-identical state: the pipeline
 * trigger fires, follow-ups stop, and every reply figure counts it. A separate
 * insert here would be a second definition of "a reply happened" and would
 * eventually disagree with the first.
 */

const uuid = z.uuid();

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

function revalidateInbox(leadId?: string | null) {
  revalidatePath('/replies');
  revalidatePath('/dashboard');
  if (leadId) revalidatePath(`/leads/${leadId}`);
}

/** Type-ahead for the lead picker. */
export async function findLeads(term: string): Promise<LeadOption[]> {
  try {
    await assertAdmin();
  } catch {
    return [];
  }
  return searchLeadsForPicker(term);
}

/**
 * Attribute an unmatched message to a lead.
 *
 * This is the whole reason the unmatched queue exists: automatic matching
 * cannot attribute a reply sent from an address we have never seen, and a
 * human recognising the business in two seconds is a better answer than a
 * heuristic guessing.
 */
export async function assignInboundMessage(
  inboundId: string,
  leadId: string,
): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;

  if (!uuid.safeParse(inboundId).success || !uuid.safeParse(leadId).success) {
    return { ok: false, message: 'Invalid request.' };
  }

  const admin = createServiceClient();

  const { data: message } = await admin
    .from('inbound_messages')
    .select('*')
    .eq('id', inboundId)
    .maybeSingle();

  if (!message) return { ok: false, message: 'That message no longer exists.' };
  if (message.reply_id) return { ok: false, message: 'That message is already assigned.' };

  const body = message.body_text ?? '';
  const sentiment = message.sentiment ?? guessSentiment(body).sentiment;

  const replyId = await createReply({
    leadId,
    emailLogId: message.email_log_id,
    body,
    sentiment,
    confidence: message.confidence ?? 0.5,
    receivedAt: message.received_at,
    inboundId,
    fromAddress: message.from_address,
    actorId: auth.userId,
  });

  if (!replyId) return { ok: false, message: 'Could not create the reply.' };

  const { error } = await admin
    .from('inbound_messages')
    .update({
      lead_id: leadId,
      match_status: 'matched',
      match_method: 'manual',
      matched_at: new Date().toISOString(),
      matched_by: auth.userId,
      sentiment,
    })
    .eq('id', inboundId);

  if (error) return { ok: false, message: error.message };

  revalidateInbox(leadId);

  return { ok: true, message: 'Reply assigned. The lead is now marked as replied.' };
}

/** Set aside a message that is not outreach-related. Keeps the row. */
export async function ignoreInboundMessage(inboundId: string): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;
  if (!uuid.safeParse(inboundId).success) return { ok: false, message: 'Invalid request.' };

  const admin = createServiceClient();
  const { error } = await admin
    .from('inbound_messages')
    .update({ match_status: 'ignored', is_handled: true })
    .eq('id', inboundId);

  if (error) return { ok: false, message: error.message };

  revalidateInbox();
  return { ok: true, message: 'Message set aside. Nothing was deleted.' };
}

/** Correct a classification an admin disagrees with. */
export async function setInboundSentiment(
  inboundId: string,
  sentiment: 'positive' | 'neutral' | 'negative' | 'unsubscribe',
): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;
  if (!uuid.safeParse(inboundId).success) return { ok: false, message: 'Invalid request.' };

  const admin = createServiceClient();

  const { data: message } = await admin
    .from('inbound_messages')
    .select('reply_id, lead_id')
    .eq('id', inboundId)
    .maybeSingle();

  const { error } = await admin
    .from('inbound_messages')
    // 1.0: a human said so, which outranks anything the rules or the model
    // produced.
    .update({ sentiment, confidence: 1 })
    .eq('id', inboundId);

  if (error) return { ok: false, message: error.message };

  // Keep the reply row in step ,it is what the analytics read.
  if (message?.reply_id) {
    await admin.from('replies').update({ sentiment }).eq('id', message.reply_id);
  }

  if (sentiment === 'unsubscribe' && message?.lead_id) {
    await admin
      .from('lead_pipeline')
      .update({
        closed: new Date().toISOString(),
        closed_reason: 'Recipient asked to be removed',
        auto_followups: false,
      })
      .eq('lead_id', message.lead_id);
  }

  revalidateInbox(message?.lead_id);
  return { ok: true, message: `Marked as ${sentiment}.` };
}

export async function markInboundHandled(
  inboundId: string,
  handled: boolean,
): Promise<ActionResult> {
  const auth = await guard();
  if (!auth.ok) return auth.result;
  if (!uuid.safeParse(inboundId).success) return { ok: false, message: 'Invalid request.' };

  const admin = createServiceClient();
  const { data: message } = await admin
    .from('inbound_messages')
    .select('reply_id')
    .eq('id', inboundId)
    .maybeSingle();

  await admin.from('inbound_messages').update({ is_handled: handled }).eq('id', inboundId);
  if (message?.reply_id) {
    await admin.from('replies').update({ is_handled: handled }).eq('id', message.reply_id);
  }

  revalidateInbox();
  return { ok: true, message: handled ? 'Marked as handled.' : 'Reopened.' };
}
