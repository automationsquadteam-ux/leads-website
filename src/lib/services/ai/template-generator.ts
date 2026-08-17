import { renderPlaceholders } from '@/lib/services/email/render';
import type { EmailType } from '@/lib/supabase/database.types';
import type { EmailGenerator, GenerationContext, GenerationResult } from './types';

/**
 * The default generator: deterministic, offline, no model.
 *
 * This is the "placeholder function" the architecture is built around, and it
 * is a real one rather than a stub that returns lorem ipsum. It composes a
 * draft from whatever research and personalization the lead actually has, so:
 *
 *   * the whole pipeline regenerate, version, review, approve, send can be
 *     exercised end to end before any model is configured;
 *   * a machine with no Ollama running still produces something an admin can
 *     edit into shape, instead of an error;
 *   * every draft is honestly attributed as `template`, never as AI output.
 *
 * Switch `ai.provider` to `ollama` in Settings to hand the same
 * GenerationContext to a model instead.
 */

/**
 * What a person would call the business, out of what the directory listed it as.
 *
 * Lead names come from scraped listings, so they carry the operator's SEO and
 * legal tail: `Clean & Pure GmbH | Gebäudereinigung & Büroreinigung in Hamburg`,
 * `Thomas Barry & Company Solicitors, Commissioners for Oaths & Notaries
 * Public`, `Saith Technical Services - Emergency AC Service & Repair Dubai`.
 * 71 of the 350 leads in the live send queue have one, and dropped whole into a
 * subject line they produced 62 subjects over 60 characters — the limit this
 * project's own model prompt states and the template quietly ignored. Nobody
 * writes to a business by its full registered name, so a subject that does is a
 * tell on its own, before the body is even read.
 *
 * NFKC first, because some listings are styled in mathematical-bold Unicode
 * (`𝗣𝘂𝘁𝘇𝗛𝗲𝗹𝗱𝗲𝗻 Hamburg`) to stand out in search results. Those code points
 * survive into a subject line looking like mojibake and read as spam. NFKC is
 * exactly the normalization that maps them back to plain letters.
 *
 * Cut at the first separator rather than at a character count: everything after
 * a pipe, a bracket, a comma or a spaced dash is the tail, and the head is the
 * name. The length clamp is only a backstop for a name with no separator at all,
 * and it breaks on a word so it cannot end mid-syllable.
 */
function shortName(name: string): string {
  const normalized = name.normalize('NFKC').trim();
  const head = normalized.split(/\s*[|(]|,\s|\s+[-–—]\s+/)[0]?.trim() || normalized;
  if (head.length <= 42) return head;

  const clipped = head.slice(0, 42);
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped).trim();
}

/*
 * The closing ask, initial and follow-up 1 alike.
 *
 * Was "reply and I will send over what it would look like for you
 * specifically" — a guess dressed up as an offer, and the reader has to do
 * the work of figuring out whether the guess was even right before they can
 * answer. Asking them to name their own problem instead is lower-effort to
 * reply to (one sentence, no research required on their end) and gets a
 * truer answer than a cold guess from outside the business ever could.
 *
 * Two different wordings, not one shared constant, because the file's own
 * rule for follow-ups applies here too: the single most obvious tell of an
 * automated sequence is repeating a line verbatim.
 */
const ASK_INITIAL = (name: string) =>
  `But rather than guess, I would rather just ask: what is one problem you wish technology could take off your plate at ${name}? I help local businesses fix exactly that kind of thing. Tell me what is bugging you and I will tell you honestly whether I can help.`;

const ASK_FOLLOWUP1 = (name: string) =>
  `Genuine question, no pitch attached: what is one problem you wish technology could just solve for you at ${name}? I work with local businesses on exactly that. Reply with what it is and I will tell you straight whether I can help.`;

/**
 * Follow-up skeletons. Each takes one specific line from the lead's research.
 *
 * Follow-up 2 does NOT simply swap follow-up 1's opener and closer around the
 * same bare `{{angle}}` paragraph, which is how it used to read:
 *
 *     Last note from me about Chiangmai Best Homes.
 *
 *     Emphasize the unique features and benefits of Chiang Mai as a desirable
 *     location for real estate investment, such as the city's growing tourism
 *     industry, favorable climate, and lower cost of living.
 *
 *     If the timing is wrong, say the word and I will close the file.
 *
 * Follow-up 1 survives that layout because its closing ASK re-anchors the whole
 * email as ours: whatever the middle paragraph was, the reader lands on a
 * direct question from a person. Follow-up 2 deliberately has no ask — it is
 * the "no work to answer" step — so the angle paragraph IS the email, and an
 * unattributed sentence there reads as an instruction to the recipient: we
 * appeared to be telling a real estate agency in Chiang Mai to emphasize Chiang
 * Mai, or to "offer to build a modern website".
 *
 * So the angle gets an explicit lead-in naming whose thought it was, on the same
 * line as the sentence rather than above it — a one-line label with a lone
 * sentence under it reads like a slide bullet, which is its own tell.
 *
 * The lead-in also does a second job the filter cannot. 132 of the 350 live
 * research angles refer to the business in the THIRD PERSON ("the company could
 * benefit from…", "reducing manual work for staff"), because they were written
 * about the lead rather than to them. Rewriting that to "you" is not something
 * to attempt deterministically — measured against the real data, only 4 of 350
 * sentences could be swapped safely, and one of those four came out as "you is
 * a pioneering cafetería". Naming the sentence as a note I made when I looked
 * them up makes the third person correct instead of wrong: it is a quotation of
 * my own notes, and that is exactly what it is.
 */
const FOLLOWUP_SHAPES: Record<Exclude<EmailType, 'initial'>, (name: string) => string[]> = {
  followup1: (name) => [
    `I wrote last week about ${name} and never heard back. No problem, inboxes are inboxes.`,
    '',
    '{{angle}}',
    '',
    ASK_FOLLOWUP1(name),
  ],
  followup2: (name) => [
    `Last one from me about ${name}.`,
    '',
    'For what it is worth, here is the note I made when I looked you up: {{angle}}',
    '',
    'If the timing is simply wrong, no reply needed and I will close the file. If that changes later, reply to this and I will pick it back up.',
  ],
};

/**
 * Research text that is a note TO US, not a sentence for the lead.
 *
 * Every research field here is written as ADVICE on how to approach the
 * business: "Offer to build a modern website together with an AI chatbot…",
 * "Emphasize the unique features and benefits of Chiang Mai…", "Congratulate
 * them on ten years in business", "a potential outreach angle could be
 * highlighting…". To the person doing the outreach those are useful. Pasted
 * into the body — which is what this generator did — a bare imperative has no
 * subject left except the reader, so it lands as us instructing THEM to make an
 * offer, or to emphasize something about their own city.
 *
 * This was most of the mail, not an edge case: 782 of 958 non-archived leads
 * have an `outreach_angle` opening "Offer to …", and it is the first candidate
 * `bestAngle()` tries.
 *
 * Advice is SKIPPED, never rewritten. Turning arbitrary strategy notes into a
 * sentence in our own voice is not something a deterministic template can do
 * without producing something worse than the problem; there are five more
 * fields to fall through to and a generic line under those.
 */
const ADVICE_SHAPES: RegExp[] = [
  /*
   * A bare imperative verb opening the sentence — no subject, so the reader
   * becomes one. Gerunds are deliberately NOT blanket-matched: "Automating
   * enquiry routing would free up an hour a day" is an observation and reads
   * correctly, while "Highlighting their expertise could be an effective
   * angle" is advice, and what separates them is the predicate below, not the
   * opening word.
   */
  /^(offer|emphasi[sz]e|highlight|showcase|mention|target|focus|position|leverage|consider|collaborate|partner|pitch|congratulate|approach|engage|contact|tailor|frame|stress|suggest|propose|recommend|present|introduce|demonstrate|discuss|explain|note|point out|draw attention|lead with|reach out|follow up|use|try|include|build|create|provide|start|send|ask)\b/i,

  // Naming the outreach itself, in any wording: it is a note about the pitch.
  /\b(outreach|marketing|sales|messaging)\s+(angle|angles|strategy|strategies|approach|approaches|effort|efforts|campaign)\b/i,
  /\b(an?|one|another|potential|possible|effective|good|strong|key|primary)\s+(outreach\s+)?angle\b/i,

  // The hedged-recommendation predicate: "could consider", "could be effective".
  /\bcould\s+(consider|be\s+(an?\s+)?(effective|good|strong|compelling|useful|powerful))\b/i,
  /\b(we|you)\s+(could|should|can)\s+(highlight|emphasi[sz]e|offer|mention|target|position|pitch|showcase|stress)\b/i,
  /\b(worth|recommend)\s+(highlighting|emphasi[sz]ing|mentioning|showcasing|targeting)\b/i,
];

/** Research fields sometimes hold a literal "N/A", which used to be pasted verbatim. */
const NO_RESEARCH = /^(n\.?\/?a\.?|none|nil|null|unknown|tbd|not applicable|no data|not available)\.?$/i;

/**
 * One sentence from a research field, or null if it is not usable as body copy.
 *
 * Length floor is doing real work at both ends: too short and it is a fragment
 * or a placeholder, and the sentence split is unreliable on text that never
 * had proper punctuation, so a clamped slice is the fallback rather than the
 * whole field.
 */
function angleSentence(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed || NO_RESEARCH.test(trimmed)) return null;

  // One sentence is enough: a follow-up that restates the whole research
  // summary reads like a form letter, which is exactly what it must not.
  const first = trimmed.split(/(?<=[.!?])\s+/)[0]?.trim() ?? '';
  const sentence = first.length > 20 ? first : trimmed.slice(0, 220).trim();

  if (sentence.length < 20) return null;
  if (ADVICE_SHAPES.some((shape) => shape.test(sentence))) return null;
  return sentence;
}

/**
 * Pick the most specific sentence the research offers, for the middle of a
 * follow-up.
 *
 * `outreach_angle` stays first: a HAND-WRITTEN angle is the best line available
 * anywhere on the lead. The machine-written ones lose their place by failing
 * the shape test above, not by being read last, so this keeps working if the
 * field is ever filled in properly.
 */
function bestAngle(context: GenerationContext): string {
  const { lead } = context;
  const candidates = [
    lead.outreach_angle,
    lead.automation_opportunities,
    lead.ai_chatbot_opportunities,
    lead.website_improvement_opportunities,
    lead.personalization,
    lead.research_summary,
  ];

  for (const candidate of candidates) {
    const sentence = angleSentence(candidate);
    if (sentence) return sentence;
  }

  return 'The specific thing I had in mind was cutting the manual admin work around enquiries and follow-up.';
}

function defaultInitialBody(context: GenerationContext): string {
  const { lead } = context;
  const where = [lead.city, lead.country].filter(Boolean).join(', ');
  const name = shortName(lead.business_name);

  return [
    `Hi, I came across ${name}${where ? ` in ${where}` : ''}.`,
    '',
    lead.research_summary?.trim() ||
      `I work with ${lead.niche?.trim() || 'businesses like yours'} on automating the repetitive parts of their day.`,
    '',
    bestAngle(context),
    '',
    ASK_INITIAL(name),
    '',
    '{{signature}}',
  ].join('\n');
}

export class TemplateGenerator implements EmailGenerator {
  id = 'template';
  label = 'Template (deterministic, no model)';

  async verify(): Promise<{ ok: boolean; message: string }> {
    return {
      ok: true,
      message:
        'The template generator needs no external service. It composes drafts from the lead research.',
    };
  }

  async generate(context: GenerationContext): Promise<GenerationResult> {
    const { lead, type, signature } = context;

    let subjectSource: string;
    let bodySource: string;

    // Everywhere the business is addressed, it is addressed the way a person
    // would say it — subject and opener alike. See `shortName()`.
    const name = shortName(lead.business_name);

    if (type === 'initial') {
      subjectSource = `Quick idea for ${name}`;
      bodySource = defaultInitialBody(context);
    } else {
      /*
       * Follow-ups get their own shape rather than a reworded first email.
       * Reusing the opener verbatim is the single most obvious tell of an
       * automated sequence, so each one carries one specific line from the
       * research instead.
       */
      subjectSource =
        type === 'followup1' ? `Following up ${name}` : `Closing the loop on ${name}`;
      /*
       * Replaced through a function, not a string. A string replacement treats
       * `$&`, `$'` and `$1` in the REPLACEMENT as substitution patterns, and
       * research text is arbitrary prose that can contain a bare `$` — prices
       * especially. A replacer function is passed through verbatim.
       */
      const angle = bestAngle(context);
      bodySource = FOLLOWUP_SHAPES[type](name)
        .join('\n')
        .replace('{{angle}}', () => angle)
        .concat('\n\n{{signature}}');
    }

    const subject = renderPlaceholders(subjectSource, lead, signature).trim();
    const content = renderPlaceholders(bodySource, lead, signature).trim();

    if (content.length === 0) {
      return {
        ok: false,
        message: 'The generator produced an empty draft. This lead has no research to compose from.',
        email: null,
      };
    }

    return {
      ok: true,
      message: 'Draft composed from the lead research.',
      email: { subject, content, generatedBy: this.id },
    };
  }
}
