import { createServiceClient } from '@/lib/supabase/service-client';
import type {
  InboundMatchMethod,
  ReplySentiment,
} from '@/lib/supabase/database.types';
import { classifyReplyWithModel } from '../ai/classify-reply';
import { recordActivity } from '../activity';
import {
  classifyKind,
  guessSentiment,
  isHardBounce,
  parseAddress,
  referencedMessageIds,
  stripQuotedText,
  type RawInbound,
} from './classify';

/**
 * Inbound mail ingestion.
 *
 * Not marked `server-only`: a script may want to replay a message. It depends
 * only on `service-client.ts`, which is marker-free for that reason.
 *
 * The order of operations is the whole design:
 *
 *   1. store the message first, always, whatever it turns out to be
 *   2. classify it (bounce / auto-reply / reply)
 *   3. attribute it: threading headers, then From address, then give up
 *   4. only a matched, genuine reply becomes a row in public.replies
 *
 * Storing first means a message we cannot classify or attribute is still
 * visible in the inbox rather than silently dropped, which is the failure mode
 * that makes people distrust an inbox.
 */

export interface IngestResult {
  ok: boolean;
  message: string;
  /** The inbound_messages row, whatever happened. */
  inboundId: string | null;
  kind: string;
  matched: boolean;
  matchMethod: InboundMatchMethod | null;
  leadId: string | null;
  replyId: string | null;
  /** True when this Message-ID had already been ingested. */
  duplicate: boolean;
}

interface MatchOutcome {
  leadId: string | null;
  emailLogId: string | null;
  method: InboundMatchMethod | null;
}

/**
 * Attribute a message to a lead.
 *
 * Threading first, and it is not merely "more accurate" ,it is the only method
 * that survives the normal case. You email `info@company.com`; the owner reads
 * it and answers from their personal address. From-address matching loses that
 * reply entirely. `In-Reply-To` still carries the Message-ID we recorded on the
 * send, so threading finds it.
 *
 * From address is the fallback for clients that strip threading headers, and
 * for someone starting a fresh message rather than hitting reply.
 */
async function matchMessage(raw: RawInbound): Promise<MatchOutcome> {
  const admin = createServiceClient();

  const referenced = referencedMessageIds(raw);
  if (referenced.length > 0) {
    // Providers are inconsistent about storing the angle brackets, so try both
    // forms. Ordered newest-first by referencedMessageIds, and the first hit
    // wins because that is the message actually being replied to.
    const candidates = [...referenced, ...referenced.map((id) => id.replace(/^<|>$/g, ''))];

    const { data } = await admin
      .from('email_logs')
      .select('id, lead_id, message_id')
      .in('message_id', candidates)
      .limit(10);

    if (data && data.length > 0) {
      const ordered = referenced
        .map((id) => data.find((log) => log.message_id === id || `<${log.message_id}>` === id))
        .filter(Boolean);
      const hit = ordered[0] ?? data[0];
      if (hit) {
        return { leadId: hit.lead_id, emailLogId: hit.id, method: 'threading' };
      }
    }
  }

  const { address } = parseAddress(raw.from);
  if (address) {
    const { data } = await admin
      .from('leads')
      .select('id')
      .eq('email', address)
      // Two leads can share an address in this dataset; picking one arbitrarily
      // would be a coin flip presented as a fact. Only an unambiguous match
      // counts, otherwise it goes to the unmatched queue for a human.
      .limit(2);

    if (data && data.length === 1 && data[0]) {
      return { leadId: data[0].id, emailLogId: null, method: 'from_address' };
    }
  }

  return { leadId: null, emailLogId: null, method: null };
}

/**
 * A hard bounce is free verification.
 *
 * The address just proved undeliverable against a real send, which is better
 * evidence than any verifier gives. Marking it invalid sends the lead back to
 * the need_email stage automatically.
 *
 * Soft bounces (mailbox full, greylisted) change nothing: treating a full
 * mailbox as a dead address would throw away a good lead.
 */
async function applyBounce(raw: RawInbound, leadId: string | null, emailLogId: string | null) {
  const admin = createServiceClient();
  const hard = isHardBounce(raw);

  if (emailLogId) {
    await admin
      .from('email_logs')
      .update({
        status: 'bounced',
        error: `Bounce received ${new Date().toISOString()}${hard === false ? ' (soft)' : ''}`.slice(0, 2000),
      })
      .eq('id', emailLogId);
  }

  if (leadId && hard === true) {
    await admin
      .from('lead_pipeline')
      .update({
        email_verification_status: 'invalid',
        email_verification_source: 'bounce',
        email_checked_at: new Date().toISOString(),
      })
      .eq('lead_id', leadId);

    await admin.from('leads').update({ status: 'bounced' }).eq('id', leadId);

    await recordActivity({
      leadId,
      kind: 'reply_received',
      summary: 'Hard bounce ,address marked invalid',
      detail: `From ${raw.from}. The lead is back at the Need Email stage.`,
    });
  }
}

/** Rules settle the clear cases; the model is only asked about the rest. */
async function resolveSentiment(
  body: string,
): Promise<{ sentiment: ReplySentiment; confidence: number }> {
  const guess = guessSentiment(body);
  if (guess.certain) return { sentiment: guess.sentiment, confidence: guess.confidence };

  const model = await classifyReplyWithModel(body);
  if (model) return { sentiment: model.sentiment, confidence: model.confidence };

  return { sentiment: guess.sentiment, confidence: guess.confidence };
}

export async function ingestInboundMessage(raw: RawInbound): Promise<IngestResult> {
  const admin = createServiceClient();

  const { address: fromAddress, name: fromName } = parseAddress(raw.from);
  const messageId = (raw.headers['message-id'] ?? '').trim() || null;
  const cleanBody = stripQuotedText(raw.text);

  const base: IngestResult = {
    ok: false,
    message: '',
    inboundId: null,
    kind: 'other',
    matched: false,
    matchMethod: null,
    leadId: null,
    replyId: null,
    duplicate: false,
  };

  if (!fromAddress) {
    return { ...base, message: 'Message has no usable From address.' };
  }

  // Idempotency: the Worker retries on any non-2xx, so a duplicate POST must
  // not create a second row or a second reply.
  if (messageId) {
    const { data: existing } = await admin
      .from('inbound_messages')
      .select('id, kind, match_status, lead_id, reply_id')
      .eq('message_id', messageId)
      .maybeSingle();

    if (existing) {
      return {
        ...base,
        ok: true,
        duplicate: true,
        inboundId: existing.id,
        kind: existing.kind,
        matched: existing.match_status === 'matched',
        leadId: existing.lead_id,
        replyId: existing.reply_id,
        message: 'Already ingested.',
      };
    }
  }

  const kind = classifyKind(raw);
  const match = await matchMessage(raw);

  const receivedAt = new Date().toISOString();

  const { data: inbound, error: insertError } = await admin
    .from('inbound_messages')
    .insert({
      from_address: fromAddress,
      from_name: fromName,
      to_address: raw.to ?? null,
      subject: raw.subject ?? null,
      // Keep the readable part. The quoted original is our own copy anyway.
      body_text: (cleanBody || raw.text || '').slice(0, 20000),
      message_id: messageId,
      in_reply_to: (raw.headers['in-reply-to'] ?? '').trim() || null,
      references_header: (raw.headers.references ?? '').trim() || null,
      received_at: receivedAt,
      kind,
      match_status: match.leadId ? 'matched' : 'unmatched',
      match_method: match.method,
      lead_id: match.leadId,
      email_log_id: match.emailLogId,
      matched_at: match.leadId ? receivedAt : null,
    })
    .select('id')
    .single();

  if (insertError || !inbound) {
    return { ...base, message: insertError?.message ?? 'Could not store the message.' };
  }

  const result: IngestResult = {
    ...base,
    ok: true,
    inboundId: inbound.id,
    kind,
    matched: Boolean(match.leadId),
    matchMethod: match.method,
    leadId: match.leadId,
    message: '',
  };

  if (kind === 'bounce') {
    await applyBounce(raw, match.leadId, match.emailLogId);
    return { ...result, message: 'Bounce recorded.' };
  }

  if (kind === 'auto_reply') {
    // Deliberately does NOT become a public.replies row. An out-of-office is
    // not an answer, and the pipeline must not treat it as one.
    await admin.from('inbound_messages').update({ sentiment: 'auto_reply' }).eq('id', inbound.id);
    return { ...result, message: 'Auto-reply recorded; the sequence continues.' };
  }

  const { sentiment, confidence } = await resolveSentiment(cleanBody || raw.text || '');
  await admin.from('inbound_messages').update({ sentiment, confidence }).eq('id', inbound.id);

  if (!match.leadId) {
    return {
      ...result,
      message: 'Reply stored but not attributed. Assign it from the Replies inbox.',
    };
  }

  const replyId = await createReply({
    leadId: match.leadId,
    emailLogId: match.emailLogId,
    body: cleanBody || raw.text || '',
    sentiment,
    confidence,
    receivedAt,
    inboundId: inbound.id,
    fromAddress,
  });

  return { ...result, replyId, message: `Reply from ${fromAddress} recorded as ${sentiment}.` };
}

/**
 * Create the public.replies row and link it back.
 *
 * Shared by automatic ingestion and manual assignment so both produce identical
 * state ,the pipeline trigger fires either way, which is what stops follow-ups
 * and feeds every reply figure.
 */
export async function createReply(input: {
  leadId: string;
  emailLogId: string | null;
  body: string;
  sentiment: ReplySentiment;
  confidence: number;
  receivedAt: string;
  inboundId: string;
  fromAddress: string;
  actorId?: string | null;
}): Promise<string | null> {
  const admin = createServiceClient();

  const { data: reply } = await admin
    .from('replies')
    .insert({
      lead_id: input.leadId,
      email_log_id: input.emailLogId,
      reply_text: input.body.slice(0, 20000),
      sentiment: input.sentiment,
      confidence: input.confidence,
      received_at: input.receivedAt,
    })
    .select('id')
    .single();

  if (!reply) return null;

  await admin.from('inbound_messages').update({ reply_id: reply.id }).eq('id', input.inboundId);

  await recordActivity({
    leadId: input.leadId,
    kind: 'reply_received',
    summary: `Reply received (${input.sentiment})`,
    detail: `From ${input.fromAddress}. ${input.body.slice(0, 300)}`,
    actorId: input.actorId ?? null,
  });

  // An unsubscribe is terminal. Closing the workflow is what actually
  // guarantees no follow-up fires; the replied stamp alone only changes the
  // next step, and leaving it there invites someone to reopen the sequence.
  if (input.sentiment === 'unsubscribe') {
    await admin
      .from('lead_pipeline')
      .update({
        closed: new Date().toISOString(),
        closed_reason: 'Recipient asked to be removed',
        auto_followups: false,
      })
      .eq('lead_id', input.leadId);
  }

  return reply.id;
}
