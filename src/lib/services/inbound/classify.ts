import type { InboundKind, ReplySentiment } from '@/lib/supabase/database.types';

/**
 * What arrived, and what it means.
 *
 * Pure functions over headers and text. No database, no network, no
 * `server-only` marker, so this is testable in isolation and callable from a
 * script.
 *
 * The order the ingest pipeline applies these matters:
 *   bounce   -> never a reply, and it tells us an address is dead
 *   auto     -> recorded, but must never mark the lead as having replied
 *   reply    -> the real thing
 */

export interface RawInbound {
  from: string;
  to?: string | null;
  subject?: string | null;
  text?: string | null;
  /** Lower-cased header name -> value. */
  headers: Record<string, string>;
}

export function header(headers: Record<string, string>, name: string): string {
  return headers[name.toLowerCase()] ?? '';
}

/* -------------------------------------------------------------------------- */
/* Bounces                                                                     */
/* -------------------------------------------------------------------------- */

const BOUNCE_SENDERS = [
  'mailer-daemon',
  'postmaster',
  'no-reply@',
  'noreply-dmarc',
  'bounce',
];

/**
 * A delivery status notification.
 *
 * The authoritative signal is `Content-Type: multipart/report;
 * report-type=delivery-status` (RFC 3464). The sender heuristics are a fallback
 * for relays that do not set it properly, which is more of them than it should
 * be.
 */
export function isBounce(raw: RawInbound): boolean {
  const contentType = header(raw.headers, 'content-type').toLowerCase();
  if (contentType.includes('report-type=delivery-status')) return true;
  if (contentType.includes('multipart/report')) return true;

  const from = raw.from.toLowerCase();
  if (BOUNCE_SENDERS.some((needle) => from.includes(needle))) {
    const subject = (raw.subject ?? '').toLowerCase();
    return (
      subject.includes('undeliverable') ||
      subject.includes('delivery status') ||
      subject.includes('delivery failure') ||
      subject.includes('returned mail') ||
      subject.includes('mail delivery failed') ||
      subject.includes('failure notice')
    );
  }

  return false;
}

/**
 * Hard versus soft, from the DSN status code.
 *
 * 5.x.x is permanent (no such mailbox, domain does not exist) and means the
 * address is dead. 4.x.x is temporary (mailbox full, greylisted) and means try
 * later. Treating a full mailbox as a dead address would throw away a perfectly
 * good lead, so only 5.x.x marks a lead invalid.
 *
 * Returns null when no status code is present, which is treated as soft: the
 * cautious reading is the one that does not delete work.
 */
export function isHardBounce(raw: RawInbound): boolean | null {
  const body = `${raw.text ?? ''}\n${header(raw.headers, 'x-failed-recipients')}`;

  const status = body.match(/status:\s*([245])\.\d{1,3}\.\d{1,3}/i);
  if (status) return status[1] === '5';

  // Some relays only put the SMTP reply in prose: "550 5.1.1 User unknown".
  const smtp = body.match(/\b(5\d{2})[\s-]\d\.\d\.\d\b/);
  if (smtp) return true;

  if (/\b(550|551|553|554)\b/.test(body) && /unknown|does not exist|no such/i.test(body)) {
    return true;
  }
  if (/\b(421|450|451|452)\b/.test(body)) return false;

  return null;
}

/* -------------------------------------------------------------------------- */
/* Auto-replies                                                                */
/* -------------------------------------------------------------------------- */

const AUTO_SUBJECT_PATTERNS = [
  /^\s*(re:\s*)?out of (the )?office/i,
  /^\s*(re:\s*)?automatic reply/i,
  /^\s*(re:\s*)?auto[\s-]?reply/i,
  /^\s*(re:\s*)?autoresponse/i,
  /^\s*(re:\s*)?away from (my )?(desk|office|email)/i,
  /^\s*(re:\s*)?on (annual )?leave/i,
  /^\s*(re:\s*)?vacation/i,
  /^\s*(re:\s*)?thank you for (your|contacting)/i,
  /\[ticket[\s#]/i,
  /case\s*#?\d+\s*(opened|created|received)/i,
];

/**
 * An autoresponder, not a person.
 *
 * Out-of-office is the single most common thing cold outreach gets back, so
 * getting this wrong in either direction is expensive: count them and every
 * reply rate is inflated while sequences stop for people who never read the
 * message; miss them and the same thing happens one message later.
 *
 * The RFC 3834 headers are checked first because they are unambiguous. Subject
 * patterns are the fallback, since plenty of autoresponders set no headers at
 * all.
 */
export function isAutoReply(raw: RawInbound): boolean {
  const autoSubmitted = header(raw.headers, 'auto-submitted').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;

  if (header(raw.headers, 'x-autoreply')) return true;
  if (header(raw.headers, 'x-autorespond')) return true;
  if (header(raw.headers, 'x-auto-response-suppress')) return true;

  const precedence = header(raw.headers, 'precedence').toLowerCase();
  if (['bulk', 'auto_reply', 'junk', 'list'].includes(precedence)) return true;

  // Microsoft and Google both set this on OOF replies.
  if (header(raw.headers, 'x-ms-exchange-inbox-rules-loop')) return true;
  if (header(raw.headers, 'feedback-id')) return true;

  const subject = raw.subject ?? '';
  return AUTO_SUBJECT_PATTERNS.some((pattern) => pattern.test(subject));
}

export function classifyKind(raw: RawInbound): InboundKind {
  if (isBounce(raw)) return 'bounce';
  if (isAutoReply(raw)) return 'auto_reply';
  return 'reply';
}

/* -------------------------------------------------------------------------- */
/* Sentiment — rules first                                                     */
/* -------------------------------------------------------------------------- */

const UNSUBSCRIBE_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bstop (emailing|contacting|messaging)\b/i,
  /\bdo not (contact|email)\b/i,
  /\bopt[\s-]?out\b/i,
  /\bno longer wish\b/i,
];

const NEGATIVE_PATTERNS = [
  /\bnot interested\b/i,
  /\bno thanks?\b/i,
  /\bnot (a )?(good )?(fit|right)\b/i,
  /\bwe('| a)re (all )?(good|set|sorted)\b/i,
  /\balready have\b/i,
  /\bno budget\b/i,
  /\bplease stop\b/i,
  /\bspam\b/i,
];

const POSITIVE_PATTERNS = [
  /\b(sounds|looks) (good|great|interesting)\b/i,
  /\b(i'?m|we'?re) interested\b/i,
  /\btell me more\b/i,
  /\b(let'?s|happy to) (chat|talk|discuss|meet)\b/i,
  /\bbook (a )?(call|meeting|time)\b/i,
  /\bsend (me )?(more|over)\b/i,
  /\bwhen (are|can) you\b/i,
  /\byes,? (please|i)\b/i,
];

export interface SentimentGuess {
  sentiment: ReplySentiment;
  confidence: number;
  /** True when a rule decided it, so the model call can be skipped. */
  certain: boolean;
}

/**
 * Cheap classification.
 *
 * Unsubscribe is checked first and hardest: getting it wrong has legal and
 * reputational cost that no other misclassification carries. It is also the one
 * category where phrasing is formulaic enough for rules to beat a small model.
 *
 * Anything the rules cannot settle returns `certain: false`, and the caller may
 * hand it to Ollama.
 */
export function guessSentiment(text: string | null | undefined): SentimentGuess {
  const body = (text ?? '').slice(0, 4000);
  if (body.trim() === '') {
    return { sentiment: 'neutral', confidence: 0.2, certain: false };
  }

  if (UNSUBSCRIBE_PATTERNS.some((p) => p.test(body))) {
    return { sentiment: 'unsubscribe', confidence: 0.95, certain: true };
  }

  const negative = NEGATIVE_PATTERNS.filter((p) => p.test(body)).length;
  const positive = POSITIVE_PATTERNS.filter((p) => p.test(body)).length;

  if (negative > 0 && negative > positive) {
    return { sentiment: 'negative', confidence: 0.8, certain: true };
  }
  if (positive > 0 && positive > negative) {
    return { sentiment: 'positive', confidence: 0.75, certain: true };
  }

  return { sentiment: 'neutral', confidence: 0.3, certain: false };
}

/* -------------------------------------------------------------------------- */
/* Quoting                                                                     */
/* -------------------------------------------------------------------------- */

const QUOTE_MARKERS = [
  /^\s*on .{10,80}wrote:\s*$/im,
  /^\s*-{2,}\s*original message\s*-{2,}\s*$/im,
  /^\s*from:\s.+$/im,
  /^\s*_{5,}\s*$/m,
];

/**
 * Strip the quoted original from a reply.
 *
 * Without this, every reply "contains" our own pitch, which wrecks keyword
 * classification: our draft mentions automation and AI, so a curt "not
 * interested" would score positive on our own words. Only the text above the
 * first quote marker is the person's actual answer.
 */
export function stripQuotedText(body: string | null | undefined): string {
  if (!body) return '';
  let earliest = body.length;

  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(body);
    if (match?.index !== undefined && match.index < earliest) earliest = match.index;
  }

  const lines = body.slice(0, earliest).split('\n');
  // Drop trailing '>' quoted lines that survived the marker scan.
  while (lines.length > 0 && /^\s*>/.test(lines[lines.length - 1] ?? '')) lines.pop();

  return lines.join('\n').trim();
}

/** `"Ada Lovelace" <ada@example.com>` -> address and display name. */
export function parseAddress(value: string): { address: string; name: string | null } {
  const angled = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (angled) {
    const name = angled[1]?.replace(/^["']|["']$/g, '').trim() ?? '';
    return { address: (angled[2] ?? '').trim().toLowerCase(), name: name || null };
  }
  return { address: value.trim().toLowerCase(), name: null };
}

/**
 * Every Message-ID referenced by this message, newest first.
 *
 * In-Reply-To points at the immediate parent, which is the most likely match,
 * so it is tried before the References chain.
 */
export function referencedMessageIds(raw: RawInbound): string[] {
  const collect = (value: string): string[] => (value.match(/<[^>\s]+>/g) ?? []).map((id) => id.trim());

  const inReplyTo = collect(header(raw.headers, 'in-reply-to'));
  const references = collect(header(raw.headers, 'references')).reverse();

  return [...new Set([...inReplyTo, ...references])];
}
