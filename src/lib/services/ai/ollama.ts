import { buildSystemPrompt, buildUserPrompt, parseGeneratedEmail } from './prompt';
import type { EmailGenerator, GenerationContext, GenerationResult } from './types';

/**
 * Ollama provider a local model over plain HTTP.
 *
 * No SDK: Ollama's chat endpoint is a single JSON POST, and a dependency for
 * that would be a dependency to keep current for no benefit.
 *
 * Notes that will save you time:
 *
 *   * `stream: false` matters. Ollama streams by default and returns NDJSON,
 *     which JSON.parse chokes on halfway through.
 *   * The first request after `ollama run` loads the model into memory and can
 *     take a minute on a cold start, which is why the timeout is a setting and
 *     defaults to 120s rather than the usual 30.
 *   * Ollama binds to 127.0.0.1. If the CRM runs anywhere other than the same
 *     machine, it cannot reach it set OLLAMA_HOST=0.0.0.0 on the Ollama box
 *     and point `ai.ollama_url` at it over a private network, never the open
 *     internet: the API is unauthenticated.
 */

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
}

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

function normaliseBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export class OllamaGenerator implements EmailGenerator {
  id: string;
  label = 'Ollama (local model)';

  constructor(private config: OllamaConfig) {
    // The model tag is part of the provenance recorded on every version row —
    // "which model wrote the drafts that performed" is the first question you
    // ask once you have two of them.
    this.id = `ollama:${config.model}`;
  }

  async verify(): Promise<{ ok: boolean; message: string }> {
    const base = normaliseBaseUrl(this.config.baseUrl);
    if (!base) {
      return { ok: false, message: 'Set the Ollama URL in Settings (default http://localhost:11434).' };
    }

    let response: Response;
    try {
      response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(10_000) });
    } catch {
      return {
        ok: false,
        message: `Could not reach Ollama at ${base}. Is it running? Try: ollama serve`,
      };
    }

    if (!response.ok) {
      return { ok: false, message: `Ollama replied ${response.status} ${response.statusText}.` };
    }

    const body = (await response.json().catch(() => ({}))) as { models?: Array<{ name?: string }> };
    const names = (body.models ?? []).map((m) => m.name ?? '').filter(Boolean);

    if (names.length === 0) {
      return { ok: false, message: `Ollama is reachable but has no models. Pull one: ollama pull ${this.config.model}` };
    }

    // Ollama reports "llama3.1:8b"; a user may have typed "llama3.1".
    const installed = names.some(
      (name) => name === this.config.model || name.split(':')[0] === this.config.model.split(':')[0],
    );

    return installed
      ? { ok: true, message: `Ollama is reachable and ${this.config.model} is installed.` }
      : {
          ok: false,
          message: `Ollama is reachable but ${this.config.model} is not installed. Run: ollama pull ${this.config.model}. Installed: ${names.join(', ')}`,
        };
  }

  async generate(context: GenerationContext): Promise<GenerationResult> {
    const base = normaliseBaseUrl(this.config.baseUrl);
    if (!base) {
      return { ok: false, message: 'Ollama URL is not configured.', email: null };
    }

    let response: Response;
    try {
      response = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            { role: 'user', content: buildUserPrompt(context) },
          ],
          options: {
            temperature: this.config.temperature,
            num_predict: this.config.maxTokens,
          },
        }),
        signal: AbortSignal.timeout(this.config.timeoutSeconds * 1000),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return {
        ok: false,
        message: timedOut
          ? `Ollama did not respond within ${this.config.timeoutSeconds}s. A cold model load can exceed this raise ai.timeout_seconds or pre-warm with "ollama run ${this.config.model}".`
          : `Could not reach Ollama at ${base}.`,
        email: null,
      };
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      return {
        ok: false,
        message: `Ollama returned ${response.status}: ${detail || response.statusText}`,
        email: null,
      };
    }

    const body = (await response.json().catch(() => ({}))) as OllamaChatResponse;
    if (body.error) return { ok: false, message: `Ollama error: ${body.error}`, email: null };

    const raw = body.message?.content?.trim() ?? '';
    if (raw === '') {
      return { ok: false, message: 'Ollama returned an empty response.', email: null };
    }

    const parsed = parseGeneratedEmail(raw);
    if (parsed.content.trim() === '') {
      return { ok: false, message: 'Ollama returned a response with no email body.', email: null };
    }

    return {
      ok: true,
      message: `Draft generated by ${this.config.model}.`,
      email: {
        // A missing subject is recoverable the admin is about to read this
        // anyway so fall back rather than discarding a usable body.
        subject: parsed.subject || `Quick idea for ${context.lead.business_name}`,
        content: parsed.content,
        generatedBy: this.id,
      },
    };
  }
}
