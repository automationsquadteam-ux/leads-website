import 'server-only';

import { createServiceClient } from '@/lib/supabase/service-client';
import { createEmailVersion } from '@/lib/services/email-versions';
import { finishRun, startRun } from '@/lib/services/integration-runs';
import { recordActivity } from '@/lib/services/activity';
import { generateEmail } from '@/lib/services/ai';
import { EMAIL_TYPE_LABELS } from '@/lib/pipeline/labels';
import type { EmailType } from '@/lib/supabase/database.types';

/**
 * Bring machine-written, UNSENT follow-up drafts back in line with the current
 * template.
 *
 * **Why this has to exist at all.** A template change only affects the next
 * generation. Drafts are written days ahead of the send (that is the whole point
 * of `generateMissingFollowups()` ,outreach you can review rather than find out
 * about afterwards), so a fix to the generator leaves every already-written
 * draft holding the old wording, and the scheduler will not rewrite them: it
 * generates a follow-up only when NONE exists. On 2026-08-17 that was 184 of 203
 * active unsent follow-up drafts still telling recipients to "Offer to build a
 * modern website" ,copy the generator had stopped producing hours earlier.
 * Without this, the only remedies were 184 individual regenerate clicks or
 * leaving known-bad mail queued.
 *
 * **The service, not the button** ,same reasoning as `runDraftSweep()`: the
 * Settings button and any script must share one definition of what a stale
 * draft is, or they will drift. Authorization is deliberately NOT here; the
 * caller has earned it.
 *
 * Three conditions decide what may be touched, and each one is load-bearing:
 *
 *   `generated_by = 'template'`  A human edit is recorded as `manual`
 *                                (`saveDraft()`), and an Ollama draft as
 *                                `ollama:<model>`. Restricting to `template`
 *                                is what makes "replace it" provably safe:
 *                                there is no human wording here to lose. This
 *                                is the same promise `generateMissingFollowups()`
 *                                keeps by never overwriting at all.
 *
 *   the step is UNSENT            A sent follow-up's active version is the
 *                                record of what went out. Replacing it would
 *                                make the CRM misreport its own history.
 *
 *   the fresh draft DIFFERS       Compared, not assumed. This is what makes the
 *                                run idempotent ,press it twice and the second
 *                                pass writes nothing ,and it is why this
 *                                function is not tied to one particular bad
 *                                phrase: it asks "would the generator write
 *                                this today?", which stays true for the next
 *                                template change as well.
 *
 * Nothing is updated in place. Every replacement is a NEW version via
 * `createEmailVersion({ activate: true })`, so the old wording stays in the
 * lead's history and a bad refresh is one click from being undone.
 */

export interface DraftRefreshSummary {
  ok: boolean;
  message: string;
  /** Active, unsent, machine-written follow-up drafts considered. */
  examined: number;
  /** Replaced with a fresh version because the template now writes them differently. */
  refreshed: number;
  /** Already identical to what the generator produces now. */
  unchanged: number;
  /** Left alone because a human or a model wrote them, not the template. */
  handWritten: number;
  failed: number;
  /** Genuinely stale but not reached, by the cap or the clock. Press again. */
  deferred: number;
  /** A few examples, so a run that changed something is legible without a diff tool. */
  samples: Array<{ leadId: string; type: EmailType; before: string; after: string }>;
}

export interface DraftRefreshOptions {
  /** How many drafts to REGENERATE in one pass. */
  limit?: number;
  /** Whoever triggered it, for the audit trail. Null for a script or a cron. */
  userId?: string | null;
  /** Wall-clock budget: a Server Action is a request with a ceiling. */
  maxRuntimeMs?: number;
  /** Report what would change and write nothing. */
  dryRun?: boolean;
}

/** The paragraph most likely to have changed, for a legible before/after. */
function middleParagraph(content: string): string {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  // Skip the opener and the sign-off; the angle sits between them.
  return paragraphs.slice(1, -1).join(' / ').slice(0, 200) || content.slice(0, 200);
}

export async function refreshStaleFollowupDrafts(
  options: DraftRefreshOptions = {},
): Promise<DraftRefreshSummary> {
  const limit = options.limit ?? 250;
  const userId = options.userId ?? null;
  const maxRuntimeMs = options.maxRuntimeMs ?? 45_000;
  const dryRun = options.dryRun ?? false;

  const admin = createServiceClient();
  const runId = await startRun('ai', 'refresh_followup_drafts', userId ?? undefined);

  /*
   * `lead_send_queue`, not `lead_pipeline` and not `pipeline_board` ,the same
   * choice, for the same two reasons, as 0034/0035/0041: the raw table has no
   * status column so archived leads would be included, and the board view is
   * gated `where public.is_admin()`, which the service-role client does not
   * satisfy and would silently return zero rows for.
   *
   * Paused leads (`auto_followups = false`) are deliberately INCLUDED. Pause
   * means "try me next quarter", so that draft will be sent one day and is
   * worth fixing now; it is closed and replied leads that have nothing left to
   * send.
   */
  const { data: queue } = await admin
    .from('lead_send_queue')
    .select('lead_id, followup1_sent, followup2_sent')
    .not('first_email_sent', 'is', null)
    .is('replied', null)
    .is('closed', null);

  const sentSteps = new Map<string, { followup1: boolean; followup2: boolean }>(
    (queue ?? []).map((row) => [
      row.lead_id,
      { followup1: row.followup1_sent !== null, followup2: row.followup2_sent !== null },
    ]),
  );

  if (sentSteps.size === 0) {
    const message = 'No live leads have been emailed yet, so there are no follow-up drafts to refresh.';
    await finishRun(runId, 'success', message);
    return {
      ok: true, message, examined: 0, refreshed: 0, unchanged: 0,
      handWritten: 0, failed: 0, deferred: 0, samples: [],
    };
  }

  const { data: versions } = await admin
    .from('email_versions')
    .select('id, lead_id, type, subject, content, generated_by')
    .in('lead_id', [...sentSteps.keys()])
    .in('type', ['followup1', 'followup2'])
    .eq('active', true);

  /*
   * Split before doing any work, so `handWritten` is a real figure rather than
   * a per-iteration skip count. A draft someone edited is not a problem to be
   * reported ,it is the outcome the review step exists to produce.
   */
  const candidates: Array<{ leadId: string; type: EmailType; content: string }> = [];
  let handWritten = 0;

  for (const version of versions ?? []) {
    const type = version.type as Exclude<EmailType, 'initial'>;
    if (sentSteps.get(version.lead_id)?.[type]) continue; // already sent
    if (version.generated_by !== 'template') {
      handWritten += 1;
      continue;
    }
    candidates.push({ leadId: version.lead_id, type, content: version.content });
  }

  let refreshed = 0;
  let unchanged = 0;
  let failed = 0;
  let attempted = 0;
  let stoppedEarly = false;
  const samples: DraftRefreshSummary['samples'] = [];
  const started = Date.now();

  for (const candidate of candidates) {
    if (refreshed + failed >= limit) break;
    if (Date.now() - started > maxRuntimeMs) {
      stoppedEarly = true;
      break;
    }
    attempted += 1;

    const generation = await generateEmail(candidate.leadId, candidate.type);
    if (!generation.ok || !generation.email) {
      failed += 1;
      continue;
    }

    // Whitespace-insensitive: a stored draft that differs only in trailing
    // newlines is not stale, and rewriting it would churn the version history
    // for nothing.
    if (generation.email.content.trim() === candidate.content.trim()) {
      unchanged += 1;
      continue;
    }

    if (dryRun) {
      refreshed += 1;
      if (samples.length < 5) {
        samples.push({
          leadId: candidate.leadId,
          type: candidate.type,
          before: middleParagraph(candidate.content),
          after: middleParagraph(generation.email.content),
        });
      }
      continue;
    }

    const created = await createEmailVersion({
      leadId: candidate.leadId,
      type: candidate.type,
      subject: generation.email.subject,
      content: generation.email.content,
      generatedBy: generation.email.generatedBy,
      createdBy: userId,
      activate: true,
    });

    if (!created.ok) {
      failed += 1;
      continue;
    }

    refreshed += 1;
    if (samples.length < 5) {
      samples.push({
        leadId: candidate.leadId,
        type: candidate.type,
        before: middleParagraph(candidate.content),
        after: middleParagraph(generation.email.content),
      });
    }

    await recordActivity({
      leadId: candidate.leadId,
      kind: 'draft_regenerated',
      summary: `${EMAIL_TYPE_LABELS[candidate.type]} rewritten to the current template`,
      detail: 'The previous version was written by an older template and is kept in the history.',
      actorId: userId,
    });
  }

  const deferred = candidates.length - attempted;

  const message = dryRun
    ? `${refreshed} of ${candidates.length} unsent template drafts would be rewritten, ${unchanged} are already current.`
    : `${refreshed} draft(s) rewritten to the current template, ${unchanged} already current` +
      (handWritten > 0 ? `, ${handWritten} left alone (hand-written or model-written)` : '') +
      (deferred > 0
        ? `, ${deferred} not reached${stoppedEarly ? ' (ran out of time)' : ' (limit reached)'} ,run it again.`
        : '.') +
      (failed > 0 ? ` ${failed} failed.` : '');

  await finishRun(runId, failed === 0 ? 'success' : 'failed', message, {
    examined: candidates.length,
    refreshed,
    unchanged,
    handWritten,
    deferred,
    failed,
    dryRun,
  });

  return {
    ok: failed === 0,
    message,
    examined: candidates.length,
    refreshed,
    unchanged,
    handWritten,
    failed,
    deferred,
    samples,
  };
}
