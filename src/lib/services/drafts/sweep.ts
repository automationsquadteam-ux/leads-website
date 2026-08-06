import 'server-only';

import { createServiceClient } from '@/lib/supabase/service-client';
import { createEmailVersion } from '@/lib/services/email-versions';
import { finishRun, startRun } from '@/lib/services/integration-runs';
import { recordActivity } from '@/lib/services/activity';
import { inspectDraft, repairDraft } from './quality';

/**
 * Clean every pending draft, then approve the ones that come out spotless.
 *
 * **The service, not the button.** This lives here rather than inside the Server
 * Action because two callers now need identical behaviour: the "Clean and
 * approve drafts" button in Settings, and the scheduled run at
 * /api/cron/approve-drafts. A cron job that reimplemented any part of this would
 * be a second definition of "is this draft good enough to send", and the two
 * would drift — which is the same argument as the verification gate living in
 * sendLeadEmail() rather than in each caller.
 *
 * Authorization is deliberately NOT here. The action calls assertAdmin() and the
 * route checks the CRON_SECRET; this function assumes the caller has earned it.
 *
 * The bottleneck it removes: drafts arrive from the upstream Ollama pipeline as
 * JSON payloads — `{"header": "...", "body": "Hi,\n\n..."}` — and every one had
 * to be opened and hand-edited before it could be approved.
 *
 * Two distinct steps, deliberately not merged:
 *
 *   REPAIR   unwrap the JSON, turn \n back into newlines, drop code fences.
 *            Mechanical and safe. Creates a NEW VERSION, so the original stays
 *            in the history and a bad repair is one click from being undone.
 *
 *   APPROVE  only for drafts with zero blocking issues afterwards. Anything
 *            still carrying a placeholder, stray braces or a truncated body
 *            keeps its place in the queue and says why.
 *
 * Repairing never implies approving. A draft this cannot fully clean is left for
 * a human, which is the whole point of having an approval step.
 *
 * It changes the DRAFT and the APPROVAL and nothing else — not the address, not
 * the verification verdict, not the research, not `leads.status`. A lead with no
 * usable address can be approved here and simply never reaches Ready to Send,
 * because that requires all four pipeline gates.
 */

export interface DraftSweepSummary {
  ok: boolean;
  message: string;
  examined: number;
  repaired: number;
  approved: number;
  blocked: number;
  /** Why the blocked ones were left, most common first. */
  reasons: Array<{ kind: string; count: number; example: string }>;
  /**
   * The leads that were left behind, so the report is actionable rather than a
   * number. Capped, because a list of 400 links is not a report either.
   */
  blockedLeads: Array<{ leadId: string; businessName: string; reasons: string[] }>;
  /**
   * A few that went through, so a run that approved nothing is distinguishable
   * from one that approved silently.
   */
  approvedLeads: Array<{ leadId: string; businessName: string }>;
  remaining: number;
}

export interface DraftSweepOptions {
  /** How many pending drafts to consider in one pass. */
  limit?: number;
  /** Whoever triggered it, for the audit trail. Null for a scheduled run. */
  userId?: string | null;
  /**
   * Wall-clock budget. A Server Action and a serverless function are both
   * requests with a ceiling, so the loop stops itself and reports honestly
   * rather than being killed mid-write.
   */
  maxRuntimeMs?: number;
}

export async function runDraftSweep(options: DraftSweepOptions = {}): Promise<DraftSweepSummary> {
  const limit = options.limit ?? 400;
  const userId = options.userId ?? null;
  const maxRuntimeMs = options.maxRuntimeMs ?? 45_000;

  const admin = createServiceClient();
  const runId = await startRun('ai', 'sweep_drafts', userId ?? undefined);

  const { data: pending } = await admin
    .from('email_versions')
    .select('id, lead_id, subject, content, generated_by, version_number')
    .eq('type', 'initial')
    .eq('active', true)
    .eq('status', 'draft')
    .order('created_at', { ascending: true })
    .limit(limit);

  const drafts = pending ?? [];

  // Business names up front, so the report can name leads rather than list
  // UUIDs. One query for the batch, not one per draft.
  const nameById = new Map<string, string>();
  for (let i = 0; i < drafts.length; i += 300) {
    const { data } = await admin
      .from('leads')
      .select('id, business_name')
      .in('id', drafts.slice(i, i + 300).map((d) => d.lead_id));
    for (const lead of data ?? []) nameById.set(lead.id, lead.business_name);
  }

  let repaired = 0;
  let approved = 0;
  const blockedBy = new Map<string, { count: number; example: string }>();
  const blockedLeads: DraftSweepSummary['blockedLeads'] = [];
  const approvedLeads: DraftSweepSummary['approvedLeads'] = [];
  const started = Date.now();
  let examined = 0;

  for (const draft of drafts) {
    if (Date.now() - started > maxRuntimeMs) break;
    examined += 1;

    const result = repairDraft({ subject: draft.subject, content: draft.content });

    let subject = draft.subject;
    let content = draft.content;

    if (result.repaired && result.content.trim() !== '') {
      const created = await createEmailVersion({
        leadId: draft.lead_id,
        type: 'initial',
        subject: result.subject,
        content: result.content,
        // Provenance records that this is the same generation, cleaned — not a
        // fresh one. "Which model wrote it" stays answerable.
        generatedBy: draft.generated_by.includes(':cleaned')
          ? draft.generated_by
          : `${draft.generated_by}:cleaned`,
        createdBy: userId,
        activate: true,
      });

      if (created.ok && created.version) {
        repaired += 1;
        subject = created.version.subject;
        content = created.version.content;

        await recordActivity({
          leadId: draft.lead_id,
          kind: 'draft_edited',
          summary: `Draft unwrapped from JSON version ${created.version.version_number}`,
          detail: `Cleaned automatically. Version ${draft.version_number} is unchanged in the history.`,
          actorId: userId,
        });
      }
    }

    const issues = inspectDraft({ subject, content });
    const blocking = issues.filter((issue) => issue.blocking);

    if (blocking.length === 0) {
      // The version id may have changed if a repair created a new one, so
      // re-resolve the active row rather than trusting the one we started with.
      const { data: active } = await admin
        .from('email_versions')
        .select('id')
        .eq('lead_id', draft.lead_id)
        .eq('type', 'initial')
        .eq('active', true)
        .maybeSingle();

      if (active) {
        /*
         * The version, and only the version.
         *
         * `sync_pipeline_from_version()` sets lead_pipeline.approved from here,
         * which is the one path the sender actually checks. This used to also
         * write `leads.status = 'approved'`, which satisfied the dashboard and
         * not the sender, and meant a sweep whose whole job is wording was
         * writing a field about the lead.
         */
        await admin
          .from('email_versions')
          .update({ status: 'approved', reviewed_by: userId, reviewed_at: new Date().toISOString() })
          .eq('id', active.id);
        approved += 1;

        if (approvedLeads.length < 20) {
          approvedLeads.push({
            leadId: draft.lead_id,
            businessName: nameById.get(draft.lead_id) ?? 'Unknown lead',
          });
        }
      }
    } else {
      const first = blocking[0]!;
      const entry = blockedBy.get(first.kind) ?? { count: 0, example: first.message };
      entry.count += 1;
      blockedBy.set(first.kind, entry);

      if (blockedLeads.length < 100) {
        blockedLeads.push({
          leadId: draft.lead_id,
          businessName: nameById.get(draft.lead_id) ?? 'Unknown lead',
          reasons: blocking.map((issue) => issue.message),
        });
      }
    }
  }

  const reasons = [...blockedBy.entries()]
    .map(([kind, v]) => ({ kind, count: v.count, example: v.example }))
    .sort((a, b) => b.count - a.count);

  const blocked = reasons.reduce((sum, r) => sum + r.count, 0);
  const remaining = Math.max(0, drafts.length - examined);

  const message =
    `${examined} draft(s) checked: ${repaired} cleaned, ${approved} approved and ready to send, ` +
    `${blocked} left for review.` +
    (remaining > 0 ? ` ${remaining} not reached run again.` : '');

  await finishRun(runId, 'success', message, { examined, repaired, approved, blocked });

  return {
    ok: true,
    message,
    examined,
    repaired,
    approved,
    blocked,
    reasons,
    blockedLeads,
    approvedLeads,
    remaining,
  };
}
