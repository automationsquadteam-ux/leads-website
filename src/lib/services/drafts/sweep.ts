import 'server-only';

import { createServiceClient } from '@/lib/supabase/service-client';
import { createEmailVersion } from '@/lib/services/email-versions';
import { finishRun, startRun } from '@/lib/services/integration-runs';
import { recordActivity } from '@/lib/services/activity';
import { getIntegrationConfig } from '@/lib/services/config';
import { inspectDraft, repairDraft, type DraftContext } from './quality';

/**
 * Clean every pending draft, then approve the ones that come out spotless.
 *
 * **The service, not the button.** This lives here rather than inside the Server
 * Action because two callers now need identical behaviour: the "Clean and
 * approve drafts" button in Settings, and the scheduled run at
 * /api/cron/approve-drafts. A cron job that reimplemented any part of this would
 * be a second definition of "is this draft good enough to send", and the two
 * would drift ,which is the same argument as the verification gate living in
 * sendLeadEmail() rather than in each caller.
 *
 * Authorization is deliberately NOT here. The action calls assertAdmin() and the
 * route checks the CRON_SECRET; this function assumes the caller has earned it.
 *
 * The bottleneck it removes: drafts arrive from the upstream Ollama pipeline as
 * JSON payloads ,`{"header": "...", "body": "Hi,\n\n..."}` ,and every one had
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
 * It changes the DRAFT and the APPROVAL and nothing else ,not the address, not
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
  /** Drafts flagged stuck by a previous run (0030) ,excluded from `examined`, but not gone. */
  flaggedStuck: number;
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
    // 0030. A draft already flagged stuck by a previous sweep is left alone
    // until a NEW version replaces it (an edit, or a repair) ,otherwise the
    // same permanently-blocked handful gets re-parsed and re-reported as
    // newly blocked on every run, four times a day, forever.
    .is('sweep_checked_at', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  const drafts = pending ?? [];

  /*
   * The leads themselves, up front. One query per 300, not one per draft.
   *
   * Not just for naming them in the report: the repair fills bracket
   * placeholders ,[City], [Niche], [Business Summary] ,from these fields, and
   * that is only possible with the lead in hand. 30 of 92 pending drafts were
   * blocked on placeholders the database could answer.
   */
  const nameById = new Map<string, string>();
  const contextById = new Map<string, DraftContext>();
  const senderName = (await getIntegrationConfig()).email.fromName;

  for (let i = 0; i < drafts.length; i += 300) {
    const { data } = await admin
      .from('leads')
      .select('*')
      .in('id', drafts.slice(i, i + 300).map((d) => d.lead_id));

    for (const lead of data ?? []) {
      nameById.set(lead.id, lead.business_name);
      contextById.set(lead.id, {
        businessName: lead.business_name,
        city: lead.city,
        country: lead.country,
        niche: lead.niche,
        website: lead.website,
        researchSummary: lead.research_summary,
        websiteObservations: lead.website_observations,
        automationOpportunities: lead.automation_opportunities,
        aiChatbotOpportunities: lead.ai_chatbot_opportunities,
        websiteImprovementOpportunities: lead.website_improvement_opportunities,
        senderName,
      });
    }
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

    const result = repairDraft(
      { subject: draft.subject, content: draft.content },
      contextById.get(draft.lead_id) ?? {},
    );

    let subject = draft.subject;
    let content = draft.content;

    if (result.repaired && result.content.trim() !== '') {
      const created = await createEmailVersion({
        leadId: draft.lead_id,
        type: 'initial',
        subject: result.subject,
        content: result.content,
        // Provenance records that this is the same generation, cleaned ,not a
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
          summary: `Draft cleaned version ${created.version.version_number}`,
          detail: `Unwrapped and placeholders filled from the lead's own fields. Version ${draft.version_number} is unchanged in the history.`,
          actorId: userId,
        });
      }
    }

    // Same context repairDraft() above already used, so a bracketed tag that
    // is genuinely part of the lead's own name never blocks here either.
    const issues = inspectDraft({ subject, content, context: contextById.get(draft.lead_id) ?? {} });
    const blocking = issues.filter((issue) => issue.blocking);

    // The version id may have changed if a repair created a new one, so
    // re-resolve the active row rather than trusting the one we started with.
    // Needed either way now: to approve it, or to flag it as checked.
    const { data: active } = await admin
      .from('email_versions')
      .select('id')
      .eq('lead_id', draft.lead_id)
      .eq('type', 'initial')
      .eq('active', true)
      .maybeSingle();

    if (blocking.length === 0) {
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
      // 0030. Still blocked after a repair attempt ,flag it so the next run
      // (in 7 hours, or the next button click) does not re-parse and
      // re-report the same draft as a fresh block. A human editing it, or a
      // future repair improvement, creates a new version and this clears
      // itself.
      if (active) {
        await admin
          .from('email_versions')
          .update({ sweep_checked_at: new Date().toISOString() })
          .eq('id', active.id);
      }

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

  /*
   * 0030 excludes flagged drafts from `pending` entirely, so this run's own
   * numbers can no longer say how many are sitting behind the flag ,a sweep
   * that flags its way to "0 blocked" every run would otherwise look like a
   * cleared queue instead of a growing pile nobody is looking at.
   */
  const { count: flaggedStuck } = await admin
    .from('email_versions')
    .select('*', { count: 'exact', head: true })
    .eq('type', 'initial')
    .eq('active', true)
    .eq('status', 'draft')
    .not('sweep_checked_at', 'is', null);

  const message =
    `${examined} draft(s) checked: ${repaired} cleaned, ${approved} approved and ready to send, ` +
    `${blocked} left for review.` +
    (remaining > 0 ? ` ${remaining} not reached run again.` : '') +
    (flaggedStuck ? ` ${flaggedStuck} flagged from earlier runs stay excluded until edited.` : '');

  await finishRun(runId, 'success', message, { examined, repaired, approved, blocked, flaggedStuck: flaggedStuck ?? 0 });

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
    flaggedStuck: flaggedStuck ?? 0,
  };
}
