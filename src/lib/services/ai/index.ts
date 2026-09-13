import 'server-only';

import { createServiceClient } from '@/lib/supabase/service-client';
import type { EmailType, Lead } from '@/lib/supabase/database.types';
import { getIntegrationConfig } from '../config';
import { isLanguageCode, type LanguageCode } from './languages';
import { OllamaGenerator } from './ollama';
import { TemplateGenerator } from './template-generator';
import type { EmailGenerator, GenerationContext, GenerationResult } from './types';

export type { EmailGenerator, GenerationContext, GeneratedEmail, GenerationResult } from './types';

/**
 * Draft generation the one entry point.
 *
 * Callers (the regenerate endpoint, the server action, the outreach scheduler)
 * only ever see `generateEmail(leadId, type)`. Which engine runs, how the prompt
 * is assembled and how its output is parsed are all behind this module, so
 * swapping the engine is a Settings change and not a code change.
 *
 * Provider selection is the `ai.provider` setting:
 *   template  deterministic, offline, always available (the default)
 *   ollama    a local model over HTTP
 */

export async function getActiveGenerator(): Promise<EmailGenerator> {
  const config = await getIntegrationConfig();

  if (config.ai.provider === 'ollama') {
    return new OllamaGenerator({
      baseUrl: config.ai.ollamaUrl,
      model: config.ai.ollamaModel,
      temperature: config.ai.temperature,
      maxTokens: config.ai.maxTokens,
      timeoutSeconds: config.ai.timeoutSeconds,
    });
  }

  return new TemplateGenerator();
}

/**
 * Assemble everything a generator needs: the lead
 * points at, the sender identity, and the drafts already written.
 *
 * Split out from generateEmail() so the regenerate endpoint can build the exact
 * same context for a dry run or a prompt preview without producing a version.
 */
export async function buildGenerationContext(
  leadId: string,
  type: EmailType,
): Promise<{ ok: true; context: GenerationContext } | { ok: false; message: string }> {
  const admin = createServiceClient();
  const config = await getIntegrationConfig();

  const { data: lead } = await admin.from('leads').select('*').eq('id', leadId).maybeSingle();
  if (!lead) return { ok: false, message: 'Lead not found.' };

  // Only the ACTIVE version of each other step: a follow-up needs to avoid
  // repeating what will actually be sent, not every draft ever discarded.
  const { data: previous } = await admin
    .from('email_versions')
    .select('type, subject, content')
    .eq('lead_id', leadId)
    .eq('active', true)
    .neq('type', type);

  /*
   * LANGUAGE IS LOCKED ON THE FIRST EMAIL (0046).
   *
   * Read from the ACTIVE INITIAL version, never from the lead's country. A
   * lead first contacted in English keeps getting English follow-ups even if
   * its country maps to German ,406 live leads are mid-sequence that way,
   * and a language switch halfway through a thread is worse than either
   * language alone. Pre-0046 rows carry 'en' by column default, which is the
   * lock for all of them at once.
   *
   * When the draft being generated IS the initial (no initial exists yet),
   * the lock has nothing to bind to, so the country decides ,that is the
   * one path where `country_languages` is consulted in code.
   */
  const { data: initial } = await admin
    .from('email_versions')
    .select('language, angle')
    .eq('lead_id', leadId)
    .eq('type', 'initial')
    .eq('active', true)
    .maybeSingle();

  let language: LanguageCode = 'en';
  if (initial && isLanguageCode(initial.language)) {
    language = initial.language;
  } else if (!initial && type === 'initial') {
    const { data: mapping } = await admin
      .from('country_languages')
      .select('language')
      .eq('country', (lead.country ?? '').trim())
      .maybeSingle();
    if (mapping && isLanguageCode(mapping.language)) language = mapping.language;
  }

  return {
    ok: true,
    context: {
      lead: lead as Lead,
      type,
      signature: config.email.signature,
      fromName: config.email.fromName,
      previousDrafts: previous ?? [],
      language,
      angle: initial?.angle?.trim() || null,
    },
  };
}

/**
 * Generate one draft. Does NOT write anything persisting the result as a new
 * version is `createEmailVersion`'s job, so a failed generation cannot leave a
 * half-written row behind.
 */
export async function generateEmail(leadId: string, type: EmailType): Promise<GenerationResult> {
  const built = await buildGenerationContext(leadId, type);
  if (!built.ok) return { ok: false, message: built.message, email: null };

  const generator = await getActiveGenerator();
  try {
    return await generator.generate(built.context);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Draft generation failed.',
      email: null,
    };
  }
}

/** Reachability check for the Settings screen. */
export async function verifyGenerator(): Promise<{ ok: boolean; message: string; provider: string }> {
  const generator = await getActiveGenerator();
  try {
    const result = await generator.verify();
    return { ...result, provider: generator.label };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Verification failed.',
      provider: generator.label,
    };
  }
}
