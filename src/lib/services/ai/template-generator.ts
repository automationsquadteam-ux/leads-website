import { renderPlaceholders } from '@/lib/services/email/render';
import type { EmailType } from '@/lib/supabase/database.types';
import type { EmailGenerator, GenerationContext, GenerationResult } from './types';

/**
 * The default generator: deterministic, offline, no model.
 *
 * This is the "placeholder function" the architecture is built around, and it
 * is a real one rather than a stub that returns lorem ipsum. It composes a
 * draft from the template plus whatever research and personalization the lead
 * actually has, so:
 *
 *   * the whole pipeline — regenerate, version, review, approve, send — can be
 *     exercised end to end before any model is configured;
 *   * a machine with no Ollama running still produces something an admin can
 *     edit into shape, instead of an error;
 *   * every draft is honestly attributed as `template`, never as AI output.
 *
 * Switch `ai.provider` to `ollama` in Settings to hand the same
 * GenerationContext to a model instead.
 */

/** Follow-up skeletons, used when the campaign template covers only the first email. */
const FOLLOWUP_SHAPES: Record<Exclude<EmailType, 'initial'>, (name: string) => string[]> = {
  followup1: (name) => [
    `I wrote last week about ${name} and never heard back — no problem, inboxes are inboxes.`,
    '',
    '{{angle}}',
    '',
    'Worth a short reply either way? Even a "not now" is useful.',
  ],
  followup2: (name) => [
    `Last note from me about ${name}.`,
    '',
    '{{angle}}',
    '',
    'If the timing is wrong, say the word and I will close the file. If it changes later, reply to this and I will pick it back up.',
  ],
};

/** Pick the most specific sentence the research offers, for the middle of a follow-up. */
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
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    // One sentence is enough: a follow-up that restates the whole research
    // summary reads like a form letter, which is exactly what it must not.
    const sentence = trimmed.split(/(?<=[.!?])\s+/)[0]?.trim();
    if (sentence && sentence.length > 20) return sentence;
    return trimmed.slice(0, 220);
  }

  return 'The specific thing I had in mind was cutting the manual admin work around enquiries and follow-up.';
}

function defaultInitialBody(context: GenerationContext): string {
  const { lead } = context;
  const where = [lead.city, lead.country].filter(Boolean).join(', ');

  return [
    `Hi — I came across ${lead.business_name}${where ? ` in ${where}` : ''}.`,
    '',
    lead.research_summary?.trim() ||
      `I work with ${lead.niche?.trim() || 'businesses like yours'} on automating the repetitive parts of their day.`,
    '',
    bestAngle(context),
    '',
    'If that is worth ten minutes, reply and I will send over what it would look like for you specifically.',
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
        'The template generator needs no external service. It composes drafts from the campaign template plus the lead research.',
    };
  }

  async generate(context: GenerationContext): Promise<GenerationResult> {
    const { lead, template, type, signature } = context;

    let subjectSource: string;
    let bodySource: string;

    if (type === 'initial') {
      subjectSource = template?.subject?.trim() || `Quick idea for ${lead.business_name}`;
      bodySource = template?.body?.trim() || defaultInitialBody(context);
    } else {
      // A campaign template describes the first email. Reusing it verbatim for
      // a follow-up is the single most obvious tell of an automated sequence,
      // so follow-ups get their own shape with one specific line from research.
      subjectSource =
        type === 'followup1'
          ? `Following up — ${lead.business_name}`
          : `Closing the loop — ${lead.business_name}`;
      bodySource = FOLLOWUP_SHAPES[type](lead.business_name)
        .join('\n')
        .replace('{{angle}}', bestAngle(context))
        .concat('\n\n{{signature}}');
    }

    const subject = renderPlaceholders(subjectSource, lead, signature).trim();
    const content = renderPlaceholders(bodySource, lead, signature).trim();

    if (content.length === 0) {
      return {
        ok: false,
        message: 'The template produced an empty draft. Check the campaign template body.',
        email: null,
      };
    }

    return {
      ok: true,
      message:
        type === 'initial' && template
          ? `Draft composed from the "${template.name}" template.`
          : 'Draft composed from the lead research.',
      email: { subject, content, generatedBy: this.id },
    };
  }
}
