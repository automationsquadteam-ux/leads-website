import { getIntegrationConfig } from '../config';
import type { ReplySentiment } from '@/lib/supabase/database.types';

/**
 * Sentiment classification for an inbound reply.
 *
 * Separate from the EmailGenerator interface on purpose. That contract is
 * `generate(context) -> subject + body`; classification takes a paragraph and
 * returns one label. Forcing them into one interface would mean a generator
 * that has to implement a method it has no business implementing.
 *
 * It reuses the same `ai.*` settings, so switching to Ollama switches both.
 *
 * Rules run first (see inbound/classify.ts) and settle the clear cases. This is
 * only asked about the ambiguous middle, which keeps it off the hot path: a
 * local model taking three seconds per message would make bulk ingestion
 * painful for no gain on messages a regex already answered.
 */

const LABELS: ReplySentiment[] = ['positive', 'neutral', 'negative', 'unsubscribe', 'auto_reply'];

const SYSTEM = [
  'You classify replies to cold outreach email.',
  '',
  'Answer with exactly one word from this list and nothing else:',
  'positive   the person wants to talk, asks a question, or requests more information',
  'neutral    acknowledgement, a referral to someone else, or an unclear response',
  'negative   a refusal: not interested, no budget, already covered, wrong time',
  'unsubscribe  they ask to be removed or to stop being contacted',
  'auto_reply an automatic message: out of office, ticket acknowledgement',
  '',
  'Output the single word. No punctuation, no explanation.',
].join('\n');

export interface ReplyClassification {
  sentiment: ReplySentiment;
  confidence: number;
  /** 'ollama:<model>' or 'rules'. Recorded so a bad run can be traced. */
  classifiedBy: string;
}

function parseLabel(raw: string): ReplySentiment | null {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z_]/g, '');
  const direct = LABELS.find((label) => label === cleaned);
  if (direct) return direct;
  // Models like to answer in a sentence however firmly you ask them not to.
  return LABELS.find((label) => cleaned.includes(label.replace('_', ''))) ?? null;
}

/**
 * Ask the configured model. Returns null when the provider is not Ollama, is
 * unreachable, or answers with something unusable — the caller keeps the rule
 * based guess in every one of those cases, so a model outage degrades the
 * classification rather than blocking ingestion.
 */
export async function classifyReplyWithModel(
  text: string,
): Promise<ReplyClassification | null> {
  const config = await getIntegrationConfig();
  if (config.ai.provider !== 'ollama') return null;

  const body = text.trim().slice(0, 2000);
  if (body === '') return null;

  const base = config.ai.ollamaUrl.trim().replace(/\/+$/, '');
  if (base === '') return null;

  let response: Response;
  try {
    response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ai.ollamaModel,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: body },
        ],
        // Near-zero temperature: this is a lookup, not a composition. Anything
        // higher just makes the same input classify differently on a re-run.
        options: { temperature: 0, num_predict: 8 },
      }),
      // Much shorter than generation. Classification is one token; if the model
      // is not warm, the rule-based guess is a fine answer and ingestion should
      // not stall behind a cold load.
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const payload = (await response.json().catch(() => ({}))) as {
    message?: { content?: string };
  };
  const label = parseLabel(payload.message?.content ?? '');
  if (!label) return null;

  return {
    sentiment: label,
    // Not a probability the model reported — it does not report one. This is a
    // fixed "a model said so", deliberately below the confidence given to an
    // unsubscribe rule match.
    confidence: 0.7,
    classifiedBy: `ollama:${config.ai.ollamaModel}`,
  };
}
