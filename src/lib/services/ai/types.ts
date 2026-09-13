import type { EmailType, Lead } from '@/lib/supabase/database.types';
import type { LanguageCode } from './languages';

/**
 * The generation contract.
 *
 * One interface, several implementations, chosen at runtime by the `ai.provider`
 * setting. Adding a provider is a new file plus one line in `index.ts` the
 * regenerate endpoint, the server action and the UI never change.
 */

/** Everything a generator needs. Assembled once, in `context.ts`. */
export interface GenerationContext {
  lead: Lead;
  type: EmailType;
  /** Signature from settings, so a draft ends the way a sent email will. */
  signature: string;
  /** Sender identity, so the model can write in the first person credibly. */
  fromName: string;
  /**
   * Drafts already written for this lead, oldest first. A follow-up that
   * repeats the opening line of the initial email is worse than no follow-up.
   */
  previousDrafts: Array<{ type: EmailType; subject: string | null; content: string }>;
  /**
   * The language this draft must be written in. LOCKED ON THE FIRST EMAIL:
   * this is the language of the lead's active initial version, never derived
   * from the country here — a lead first contacted in English keeps getting
   * English, whatever its country maps to (0046). 'en' when no initial exists.
   */
  language: LanguageCode;
  /**
   * The native one-liner n8n wrote alongside the initial, if any. Follow-ups
   * quote it in preference to the English research, so the whole email reads
   * in one language. Null on leads whose initial predates 0046.
   */
  angle: string | null;
}

export interface GeneratedEmail {
  subject: string;
  content: string;
  /** Recorded on the version row; follow-ups of it inherit this. */
  language: LanguageCode;
  /**
   * Provenance recorded on the version row: 'template', 'ollama:llama3.1:8b'.
   * Never a bare 'ai' six months later you will want to know which model
   * wrote the drafts that performed.
   */
  generatedBy: string;
}

export interface GenerationResult {
  ok: boolean;
  message: string;
  email: GeneratedEmail | null;
}

export interface EmailGenerator {
  id: string;
  label: string;
  /**
   * Cheap reachability check. Separate from generate() so the settings screen
   * can prove the provider works without producing a draft nobody asked for.
   */
  verify(): Promise<{ ok: boolean; message: string }>;
  generate(context: GenerationContext): Promise<GenerationResult>;
}

/** Thrown for configuration problems, which are the user's to fix, not bugs. */
export class GenerationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationConfigError';
  }
}
