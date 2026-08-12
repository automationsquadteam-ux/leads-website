import { findUnresolvedPlaceholders } from '@/lib/services/email/render';

/**
 * Draft cleaning and inspection.
 *
 * Pure functions: no database, no network, no `server-only`. Callable from a
 * script, a server action and a client component, and testable on its own.
 *
 * Two jobs:
 *
 *   normaliseDraft()  a model asked for JSON returns JSON. Pull the subject and
 *                     body out of it and turn escape sequences back into real
 *                     characters, so the draft is prose rather than a payload.
 *
 *   inspectDraft()    everything that would embarrass you if it went out.
 *                     Anything with issues stays in the approval queue; a clean
 *                     draft can be approved in bulk without reading it.
 *
 * The point of the split: repairing is safe and reversible (it creates a new
 * version), whereas approving is a decision. Cleaning must never imply approval.
 */

/* -------------------------------------------------------------------------- */
/* Normalising                                                                 */
/* -------------------------------------------------------------------------- */

/** Key names models use for the subject line, in preference order. */
const SUBJECT_KEYS = ['header', 'subject', 'subject_line', 'title', 'email_header'];
/** Key names for the body. */
const BODY_KEYS = ['body', 'content', 'email', 'email_body', 'message', 'text'];

/**
 * Turn JSON escape sequences back into characters.
 *
 * Needed because a draft can arrive as JSON that failed to parse (a model
 * emitting a raw newline inside a string makes the whole document invalid), and
 * the salvaged fragments still carry `\n` as two literal characters. Left alone,
 * every recipient reads "Hi,\n\nI came across..." exactly like that.
 */
export function unescapeJsonText(value: string): string {
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

/** Strip a ```json ... ``` fence, which models add however firmly you ask. */
function stripCodeFence(value: string): string {
  const fenced = value.match(/^\s*```(?:json|text)?\s*\n([\s\S]*?)\n?\s*```\s*$/i);
  return fenced?.[1] ?? value;
}

const KEY_NAMES = 'header|subject|subject_line|title|email_header|body|content|email|email_body|message|text';

/**
 * Peel JSON wreckage off the ends of a draft.
 *
 * The sheet splits one JSON object across two columns, so the Body cell gets
 * the tail and nothing else:
 *
 *     Hi,
 *     ...
 *     Best regards,
 *     Team Automation"
 *     }
 *
 * There is no leading `{`, so every structural parser skips it, and a
 * strip-quotes rule that requires BOTH ends to match does nothing either. The
 * result reached the approval queue with a brace on the last line and stayed
 * there forever.
 *
 * Loops until stable, because the debris nests: `"` then `}` then a stray
 * comma.
 *
 * The trailing quote is only removed when the quote count is ODD. An email
 * ending `...he called it "the good one"` has balanced quotes and is left
 * alone; a body ending in a single unmatched `"` is the tail of a JSON string.
 * That test is what makes this safe to run over every draft unattended.
 */
function stripJsonDebris(value: string): string {
  let text = value.trim();
  let previous = '';

  while (text !== previous && text !== '') {
    previous = text;

    text = text.replace(/^[{[]\s*/, '');
    text = text.replace(new RegExp(`^"?(?:${KEY_NAMES})"?\\s*:\\s*"?`, 'i'), '');
    text = text.replace(/[\s,]*[}\]]\s*$/, '');

    const quotes = (text.match(/"/g) ?? []).length;
    if (quotes % 2 === 1) {
      text = text.replace(/\s*"\s*$/, '');
      // A leading quote is debris only if stripping the trailing one did not
      // already balance them.
      if ((text.match(/"/g) ?? []).length % 2 === 1) text = text.replace(/^\s*"/, '');
    }

    /*
     * MATCHED wrapping quotes: `"Hi Sam, ... Best regards"`.
     *
     * The odd-count rule above deliberately never touches these, and that left
     * 59 of 92 pending drafts blocked on "The whole body is wrapped in quotes"
     * — by far the biggest single reason anything was stuck. An even count was
     * being read as "these quotes are part of the prose", but a body that both
     * OPENS and CLOSES on a quote is a JSON string value that lost its key.
     *
     * Stripping the outer pair is right even when the email legitimately quotes
     * something: `"I saw your "great" work"` has four quotes, and removing the
     * outermost pair leaves the inner one exactly where it belongs. The case it
     * would damage — prose that genuinely begins and ends with different
     * quotations — does not occur in cold outreach, and the length guard keeps
     * it from ever eating a short body whole.
     */
    if (text.length > 20 && text.startsWith('"') && text.endsWith('"')) {
      text = text.slice(1, -1).trim();
    }

    /*
     * A `{` or `}` alone on its own line is wreckage from the wrapper, never
     * prose. Braces INSIDE a line are left alone: they are almost always a
     * template token someone still has to deal with, and silently deleting one
     * would turn a visible problem into an invisible one.
     */
    text = text.replace(/^[ \t]*[{}][ \t]*$/gm, '');

    text = text.trim();
  }

  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * The lead's own facts, for filling placeholders the generator left behind.
 *
 * Passed in rather than looked up, because this module is pure — no database,
 * no network, no `server-only` — so a script, a Server Action and a client
 * component all share one definition of what a clean draft is.
 */
export interface DraftContext {
  businessName?: string | null;
  city?: string | null;
  country?: string | null;
  niche?: string | null;
  website?: string | null;
  researchSummary?: string | null;
  websiteObservations?: string | null;
  automationOpportunities?: string | null;
  aiChatbotOpportunities?: string | null;
  websiteImprovementOpportunities?: string | null;
  /** The configured from-name, for `[Your Name]`. */
  senderName?: string | null;
}

/** Bracket tokens we can answer from the lead itself, lower-cased. */
function knownValues(context: DraftContext): Map<string, string> {
  const map = new Map<string, string>();
  const put = (keys: string[], value: string | null | undefined) => {
    const text = (value ?? '').trim();
    if (text === '') return;
    for (const key of keys) map.set(key.toLowerCase(), text);
  };

  put(['business name', 'company name', 'business', 'company'], context.businessName);
  put(['city'], context.city);
  put(['country'], context.country);
  put(['niche', 'industry'], context.niche);
  put(['website', 'website url', 'url'], context.website);
  put(['business summary', 'research summary', 'summary'], context.researchSummary);
  put(['website observations'], context.websiteObservations);
  put(['automation opportunities'], context.automationOpportunities);
  put(['ai chatbot opportunities', 'chatbot opportunities'], context.aiChatbotOpportunities);
  put(['website improvement opportunities'], context.websiteImprovementOpportunities);
  put(['your name', 'sender name', 'my name'], context.senderName);

  return map;
}

/**
 * Fill the placeholders we genuinely know the answer to, and drop the one kind
 * of unfillable placeholder that is safe to drop.
 *
 * **What it will not do is guess.** `[Owner's Name]`, `[insert number]` and
 * `[specific observation about their website]` have no answer in this database,
 * and inventing one is how "Hi [Owner's Name]" becomes "Hi Sarah" for someone
 * called Ahmed. Those stay, the draft stays blocked, and a human writes the
 * line — which is the entire reason the placeholder check is blocking.
 *
 * The exception is a SALUTATION built round an unknown name. "Hi [Owner's
 * Name]," carries no information beyond "Hi," so collapsing it loses nothing
 * and rescues a draft that is otherwise complete. Every other position keeps
 * its placeholder, because elsewhere the sentence was built around the missing
 * fact and deleting it would leave a sentence that no longer says anything.
 */
export function fillKnownPlaceholders(value: string, context: DraftContext): string {
  const known = knownValues(context);
  const business = (context.businessName ?? '').trim().toLowerCase();

  let text = value.replace(/\[([^\]\n]{1,80})\]/g, (whole, inner: string) => {
    // Trailing punctuation is the generator's, not part of the token name:
    // `[Niche:]` and `[Niche]` mean the same thing and both have an answer.
    const key = inner.trim().toLowerCase().replace(/[\s:.,;-]+$/, '');
    const answer = known.get(key);
    if (answer) return answer;
    // The generator sometimes brackets the business name itself.
    if (business !== '' && key === business) return context.businessName!.trim();
    return whole;
  });

  // A greeting whose only content is an unknown name becomes a plain greeting.
  text = text.replace(
    /^([ \t]*(?:Hi|Hello|Hey|Dear|Good morning|Good afternoon))[ \t]+\[[^\]\n]{1,80}\][ \t]*(,|!|\.|)?[ \t]*$/gim,
    (_m, greeting: string, punctuation: string) => `${greeting}${punctuation || ','}`,
  );
  // ...and the same greeting when it runs on into the rest of the line.
  text = text.replace(
    /\b(Hi|Hello|Hey|Dear)[ \t]+\[[^\]\n]{1,80}\][ \t]*,/g,
    (_m, greeting: string) => `${greeting},`,
  );

  return text;
}

function pick(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const direct = record[key];
    if (typeof direct === 'string' && direct.trim() !== '') return direct;
  }
  // Case-insensitive second pass: "Header", "Body", "EMAIL_BODY".
  const lowered = new Map(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]));
  for (const key of keys) {
    const value = lowered.get(key);
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

export interface NormalisedDraft {
  subject: string | null;
  content: string;
  /** True when the input was a JSON payload rather than prose. */
  wasStructured: boolean;
}

/**
 * Extract a usable subject and body from whatever the generator produced.
 *
 * Three passes, most reliable first:
 *
 *   1. strict JSON.parse
 *   2. tolerant key extraction, for JSON broken by a raw newline inside a
 *      string — which is most of it, because that is exactly what a model does
 *      when it writes a multi-line email into a JSON field
 *   3. give up and treat the input as prose
 *
 * Returning the original text on failure is deliberate: a draft that cannot be
 * parsed is still a draft a human can fix, and inspectDraft() will flag it.
 */
export function normaliseDraft(raw: string | null | undefined, fallbackSubject?: string | null): NormalisedDraft {
  const input = (raw ?? '').trim();
  if (input === '') return { subject: fallbackSubject ?? null, content: '', wasStructured: false };

  const unfenced = stripCodeFence(input).trim();
  const looksStructured = unfenced.startsWith('{') || unfenced.startsWith('[');

  if (looksStructured) {
    // Pass 1: valid JSON.
    try {
      const parsed: unknown = JSON.parse(unfenced);
      const record = Array.isArray(parsed) ? parsed[0] : parsed;
      if (record && typeof record === 'object') {
        const asRecord = record as Record<string, unknown>;
        const body = pick(asRecord, BODY_KEYS);
        if (body !== null) {
          return {
            subject: pick(asRecord, SUBJECT_KEYS) ?? fallbackSubject ?? null,
            content: body.trim(),
            wasStructured: true,
          };
        }
      }
    } catch {
      // Fall through to the tolerant pass.
    }

    // Pass 2: pull the values out by hand. `[\s\S]*?` so a body spanning lines
    // is captured, and the lookahead stops at the next key or the closing brace
    // rather than swallowing the rest of the document.
    const grab = (keys: string[]): string | null => {
      for (const key of keys) {
        const pattern = new RegExp(
          `"${key}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,\\s*"|\\}|$)`,
          'i',
        );
        const match = pattern.exec(unfenced);
        if (match?.[1] !== undefined && match[1].trim() !== '') return match[1];
      }
      return null;
    };

    const body = grab(BODY_KEYS);
    if (body !== null) {
      const subject = grab(SUBJECT_KEYS);
      return {
        subject: subject ? stripJsonDebris(unescapeJsonText(subject)) : (fallbackSubject ?? null),
        // Debris survives a tolerant extraction, so peel it here too.
        content: stripJsonDebris(unescapeJsonText(body)),
        wasStructured: true,
      };
    }
  }

  /*
   * Pass 3: a bare FRAGMENT rather than a whole object.
   *
   * The sheet keeps "Email Header" and "Email Body" in separate columns, so
   * each cell holds one key-value pair with no enclosing braces:
   *
   *     "body": "Hi,\n\nI came across..."
   *
   * That is not JSON and never starts with `{`, so the passes above skip it
   * entirely and it would otherwise reach the recipient with the key name and
   * quotes still attached.
   */
  const fragment = /^\s*"?(header|subject|body|content|email_body|message|text)"?\s*:\s*"?([\s\S]*?)"?\s*,?\s*$/i.exec(
    unfenced,
  );
  if (fragment?.[2] !== undefined && fragment[2].trim() !== '') {
    return {
      subject: fallbackSubject ?? null,
      content: stripJsonDebris(unescapeJsonText(fragment[2])),
      wasStructured: true,
    };
  }

  /*
   * Pass 4: prose, plus whatever JSON wreckage is stuck to the ends.
   *
   * This is the common case and the one that was failing: a body that reads as
   * an ordinary email but finishes with a dangling `"` and `}` from the object
   * it was cut out of.
   */
  let content = /\\n|\\"/.test(unfenced) ? unescapeJsonText(unfenced) : unfenced;
  const cleaned = stripJsonDebris(content);
  const hadDebris = cleaned !== content.trim();
  content = cleaned;

  return { subject: fallbackSubject ?? null, content, wasStructured: hadDebris };
}

/**
 * Clean a subject line.
 *
 * The sheet's "Email Header" column has the same problem as the body: it can
 * hold `"header": "Quick idea"` rather than `Quick idea`. Subjects are single
 * line, so this is deliberately stricter than the body cleaner — any newline
 * that survives is collapsed, because a subject containing one is a parse
 * failure rather than a formatting choice.
 */
export function normaliseSubjectLine(raw: string | null | undefined): string | null {
  const input = (raw ?? '').trim();
  if (input === '') return null;

  const { content } = normaliseDraft(input);
  const cleaned = content
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return cleaned === '' ? null : cleaned;
}

/* -------------------------------------------------------------------------- */
/* Inspecting                                                                  */
/* -------------------------------------------------------------------------- */

export type DraftIssueKind =
  | 'empty'
  | 'too_short'
  | 'structured'
  | 'escaped_newlines'
  | 'stray_braces'
  | 'placeholder'
  | 'wrapping_quotes'
  | 'code_fence'
  | 'no_subject'
  | 'subject_too_long';

export interface DraftIssue {
  kind: DraftIssueKind;
  /** What is wrong, in the operator's terms. */
  message: string;
  /**
   * blocking issues stop a bulk approval. A warning is worth seeing but is not
   * a reason to refuse a draft a human would happily send.
   */
  blocking: boolean;
  /** The offending text, where quoting it helps. */
  sample?: string;
}

/**
 * Everything wrong with a draft.
 *
 * `[Placeholder]` is deliberately NOT checked here — the send path already
 * refuses those outright (see findUnresolvedPlaceholders), and duplicating the
 * rule would mean two places to keep in step. It IS surfaced, so the approval
 * queue explains why a draft cannot be approved rather than leaving you to
 * discover it at send time.
 *
 * Round brackets are left alone on purpose: "(and yes, really)" is ordinary
 * prose. Braces and square brackets are not.
 */
export function inspectDraft(input: {
  subject: string | null | undefined;
  content: string | null | undefined;
  /**
   * The lead's own real values, so a bracketed tag genuinely part of its name
   * ("Emirates Dermatology & Cosmetology Center [EDCC]") is not flagged as an
   * unfilled `[Business Owner]`. Optional because several callers (the
   * standalone "is this draft well-formed" checks) have no lead in hand;
   * omitting it means those checks are slightly more conservative, never less.
   */
  context?: DraftContext;
}): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const content = (input.content ?? '').trim();
  const subject = (input.subject ?? '').trim();
  const knownValues = input.context
    ? [input.context.businessName, input.context.niche, input.context.city, input.context.country].filter(
        (v): v is string => Boolean(v),
      )
    : [];

  if (content === '') {
    return [{ kind: 'empty', message: 'The draft is empty.', blocking: true }];
  }

  if (content.length < 120) {
    issues.push({
      kind: 'too_short',
      message: `Only ${content.length} characters. Probably truncated or a failed generation.`,
      blocking: true,
    });
  }

  // A JSON payload rather than an email. The single most common failure when a
  // model is asked for structured output.
  if (/^\s*[{[]/.test(content) || /"\s*(body|header|subject|content)\s*"\s*:/i.test(content)) {
    issues.push({
      kind: 'structured',
      message: 'This is raw JSON, not an email. It needs unwrapping before it can be sent.',
      blocking: true,
      sample: content.slice(0, 90),
    });
  }

  if (/\\n|\\r|\\t|\\"/.test(content)) {
    issues.push({
      kind: 'escaped_newlines',
      message: 'Contains literal \\n escape sequences, which would be sent as those characters.',
      blocking: true,
    });
  }

  if (/```/.test(content)) {
    issues.push({
      kind: 'code_fence',
      message: 'Contains a markdown code fence (```).',
      blocking: true,
    });
  }

  // Braces anywhere in a finished email are wrong. Template tokens are caught
  // separately and read differently, so exclude {{...}} from this check.
  const withoutTokens = content.replace(/\{\{[^}]*\}\}/g, '');
  if (/[{}]/.test(withoutTokens)) {
    const sample = withoutTokens.match(/.{0,30}[{}].{0,30}/)?.[0];
    issues.push({
      kind: 'stray_braces',
      message: 'Contains a stray { or } left over from a JSON wrapper.',
      blocking: true,
      sample: sample?.trim(),
    });
  }

  if (/^["']|["']$/.test(content)) {
    issues.push({
      kind: 'wrapping_quotes',
      message: 'The whole body is wrapped in quotes.',
      blocking: true,
    });
  }

  const placeholders = [
    ...findUnresolvedPlaceholders(content, knownValues),
    ...findUnresolvedPlaceholders(subject, knownValues),
  ];
  if (placeholders.length > 0) {
    issues.push({
      kind: 'placeholder',
      message: `Unfilled placeholder text: ${[...new Set(placeholders)].slice(0, 4).join(', ')}`,
      blocking: true,
      sample: placeholders[0],
    });
  }

  if (subject === '') {
    issues.push({ kind: 'no_subject', message: 'No subject line.', blocking: true });
  } else if (subject.length > 90) {
    issues.push({
      kind: 'subject_too_long',
      message: `Subject is ${subject.length} characters; most clients truncate around 60.`,
      blocking: false,
    });
  }

  return issues;
}

/** Ready to send without a human reading it first. */
export function isDraftClean(input: {
  subject: string | null | undefined;
  content: string | null | undefined;
}): boolean {
  return inspectDraft(input).every((issue) => !issue.blocking);
}

/**
 * Clean a draft and report whether that fixed it.
 *
 * `repaired` is true only when normalising actually changed the text, which is
 * what decides whether a new version is worth creating.
 */
export function repairDraft(
  input: {
    subject: string | null | undefined;
    content: string | null | undefined;
  },
  /**
   * The lead's own facts. Optional, so every existing caller keeps working —
   * without it the structural repairs still run and placeholders are simply
   * left for a human, which is the old behaviour exactly.
   */
  context: DraftContext = {},
): {
  subject: string | null;
  content: string;
  repaired: boolean;
  issuesBefore: DraftIssue[];
  issuesAfter: DraftIssue[];
} {
  const issuesBefore = inspectDraft({ ...input, context });
  const normalised = normaliseDraft(input.content, input.subject);

  // The subject gets the same treatment: it comes from its own sheet column and
  // can carry the same `"header": "..."` wrapping as the body.
  const rawSubject = normaliseSubjectLine(normalised.subject);

  const content = fillKnownPlaceholders(normalised.content, context).trim();
  const subject = rawSubject === null ? null : fillKnownPlaceholders(rawSubject, context).trim() || null;

  const repaired = content !== (input.content ?? '').trim() || subject !== (input.subject ?? '').trim();

  return {
    subject,
    content,
    repaired,
    issuesBefore,
    issuesAfter: inspectDraft({ subject, content, context }),
  };
}
