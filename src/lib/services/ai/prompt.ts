import type { EmailType } from '@/lib/supabase/database.types';
import type { GenerationContext } from './types';

/**
 * Prompt assembly.
 *
 * Deliberately its own module and free of any HTTP: every provider builds the
 * same prompt from the same context, so switching from the template generator
 * to Ollama (or to a hosted model later) changes *how* the text is produced,
 * never *what the model was told*. It is also the only part of the AI layer
 * that is worth reading when a draft comes out wrong.
 */

const STEP_BRIEF: Record<EmailType, string> = {
  initial:
    'This is the FIRST contact. They have never heard from us. Lead with something ' +
    'specific to their business that proves this is not a mass mail. Then, instead of ' +
    'guessing what problem to pitch, ASK them directly: something like "what is one ' +
    'problem you wish technology could take off your plate?" Say plainly that this is ' +
    'exactly the kind of thing you help local businesses with, and that you will tell ' +
    'them honestly whether you can help once you know what it is. Ask for a short reply, ' +
    'not a meeting.',
  followup1:
    'This is the FIRST follow-up, about a week after an email they did not answer. ' +
    'Keep it short four sentences at most. Do not repeat the original pitch or the ' +
    'original opening line. Add one new angle or a concrete example, and close by asking ' +
    'the same kind of direct question as the first email — what is one problem they wish ' +
    'technology could solve for them — worded differently than the first email asked it. ' +
    'Make it easy to say no.',
  followup2:
    'This is the FINAL follow-up, a few days after the second email. Two or three ' +
    'sentences. Acknowledge that the timing may simply be wrong, leave the door open, ' +
    'and do not ask a question that needs work to answer.',
};

const SYSTEM_PROMPT = [
  'You write cold outreach email for a small automation and AI consultancy.',
  '',
  'Rules:',
  '- Plain text only. No markdown, no HTML, no bullet characters.',
  '- Write as a person, not a brand. Short sentences. No hype adjectives.',
  '- Never invent facts about the business. Use only what the research provides.',
  '- Never use a placeholder like [Name] or [Business Owner]. If you do not know',
  '  a first name, address the business or open without a name at all.',
  '- Body under 150 words for an initial email, under 90 for a follow-up.',
  '- Subject under 60 characters, lower-case or sentence case, no emoji, no "Re:".',
  '',
  'Return exactly this shape and nothing else:',
  'SUBJECT: <the subject line>',
  'BODY:',
  '<the email body>',
].join('\n');

/** Trim a field to something a small local model can hold without drifting. */
function clamp(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()}…`;
}

function section(title: string, value: string | null): string | null {
  return value ? `${title}:\n${value}` : null;
}

export function buildSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

/**
 * The user-turn prompt: business facts, research, personalization, and any
 * drafts already written so a follow-up does not repeat them.
 */
export function buildUserPrompt(context: GenerationContext): string {
  const { lead, type, signature, fromName } = context;

  const social = (lead.social_links ?? {}) as Record<string, unknown>;
  const socialList = Object.entries(social)
    .filter(([key, value]) => key !== '_raw' && typeof value === 'string')
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join('\n');

  const blocks = [
    section(
      'BUSINESS',
      [
        `Name: ${lead.business_name}`,
        lead.website ? `Website: ${lead.website}` : null,
        [lead.city, lead.country].filter(Boolean).join(', ') || null,
        lead.niche ? `Industry: ${lead.niche}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    section('RESEARCH', clamp(lead.research_summary, 2000)),
    section('WEBSITE OBSERVATIONS', clamp(lead.website_observations, 1200)),
    section('AUTOMATION OPPORTUNITIES', clamp(lead.automation_opportunities, 1200)),
    section('AI CHATBOT OPPORTUNITIES', clamp(lead.ai_chatbot_opportunities, 1200)),
    section('WEBSITE IMPROVEMENTS', clamp(lead.website_improvement_opportunities, 1200)),
    section('PERSONALIZATION', clamp(lead.personalization, 1500)),
    section('INTERESTING FACTS', clamp(lead.interesting_facts, 800)),
    section('OUTREACH ANGLE', clamp(lead.outreach_angle, 800)),
    section('SOCIAL', clamp(socialList, 400)),
    context.previousDrafts.length > 0
      ? section(
          'ALREADY SENT OR DRAFTED FOR THIS LEAD (do not repeat these)',
          context.previousDrafts
            .map((d) => `--- ${d.type} ---\n${d.subject ?? ''}\n${clamp(d.content, 900)}`)
            .join('\n\n'),
        )
      : null,
    section('SENDER', `${fromName}\n\nSignature to end with:\n${signature}`),
    section('THIS EMAIL', STEP_BRIEF[type]),
  ].filter(Boolean);

  return blocks.join('\n\n');
}

/**
 * Parse the model's reply back into a subject and a body.
 *
 * Models drift from any output contract, so this is forgiving on purpose: it
 * accepts the SUBJECT/BODY form, falls back to "first line is the subject" when
 * that line is short enough to plausibly be one, and otherwise returns the whole
 * response as the body with a null subject rather than throwing away a usable
 * draft over formatting.
 */
export function parseGeneratedEmail(raw: string): { subject: string; content: string } {
  const text = raw.replace(/\r\n/g, '\n').trim();

  const subjectMatch = text.match(/^\s*subject\s*:\s*(.+)$/im);
  const bodyMatch = text.match(/^\s*body\s*:\s*\n?([\s\S]+)$/im);

  if (subjectMatch && bodyMatch) {
    return {
      subject: subjectMatch[1]!.trim().replace(/^["']|["']$/g, ''),
      content: bodyMatch[1]!.trim(),
    };
  }

  const lines = text.split('\n');
  const first = lines[0]?.trim() ?? '';
  if (subjectMatch) {
    return {
      subject: subjectMatch[1]!.trim().replace(/^["']|["']$/g, ''),
      content: text.replace(subjectMatch[0], '').trim(),
    };
  }
  if (first.length > 0 && first.length <= 80 && !first.endsWith('.')) {
    return { subject: first.replace(/^["']|["']$/g, ''), content: lines.slice(1).join('\n').trim() };
  }

  return { subject: '', content: text };
}
