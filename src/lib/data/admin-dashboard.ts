import { createClient } from '@/lib/supabase/server';
import type {
  EmailVersion,
  LeadActivity,
  PipelineBoardRow,
  Reply,
} from '@/lib/supabase/database.types';

/**
 * The admin dashboard's operational widgets.
 *
 * Read through the RLS-bound server client, not the service-role client: the
 * page has already called requireAdmin(), and going through RLS means a bug in
 * a guard cannot turn this into an open data source. Row Level Security is the
 * layer that has to hold when the other two fail.
 *
 * Counts use `head: true` with an exact count so the database returns a number
 * and not several hundred rows nobody renders.
 */

function startOfToday(): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function endOfToday(): string {
  const date = new Date();
  date.setHours(23, 59, 59, 999);
  return date.toISOString();
}

export interface DashboardWidgets {
  emailsToday: number;
  repliesToday: number;
  approvalQueue: number;
  awaitingReview: number;
  followup1DueToday: number;
  followup2DueToday: number;
  missingEmail: number;
  awaitingVerification: number;
  overdueFollowups: number;
  needsResearch: number;
  needsDraft: number;
  readyToSend: number;
  invalidEmail: number;
  error: string | null;
}

export async function getDashboardWidgets(): Promise<DashboardWidgets> {
  const supabase = await createClient();
  const dayStart = startOfToday();
  const dayEnd = endOfToday();
  const now = new Date().toISOString();

  const countOf = async (build: () => PromiseLike<{ count: number | null; error: unknown }>) => {
    const { count } = await build();
    return count ?? 0;
  };

  const [
    emailsToday,
    repliesToday,
    approvalQueue,
    awaitingReview,
    followup1DueToday,
    followup2DueToday,
    missingEmail,
    awaitingVerification,
    overdueFollowups,
    needsResearch,
    needsDraft,
    readyToSend,
    invalidEmail,
  ] = await Promise.all([
    countOf(() =>
      supabase
        .from('email_logs')
        .select('*', { count: 'exact', head: true })
        .in('status', ['sent', 'delivered', 'opened', 'clicked'])
        .gte('sent_at', dayStart)
        .lte('sent_at', dayEnd),
    ),
    countOf(() =>
      supabase
        .from('replies')
        .select('*', { count: 'exact', head: true })
        .gte('received_at', dayStart)
        .lte('received_at', dayEnd),
    ),
    // Approval queue: a draft exists and nobody has signed it off.
    countOf(() =>
      supabase
        .from('lead_pipeline')
        .select('*', { count: 'exact', head: true })
        .eq('draft_ready', true)
        .eq('approved', false)
        .is('closed', null),
    ),
    // Emails waiting review: draft versions nobody has approved or rejected.
    countOf(() =>
      supabase
        .from('email_versions')
        .select('*', { count: 'exact', head: true })
        .eq('active', true)
        .eq('status', 'draft'),
    ),
    countOf(() =>
      supabase
        .from('lead_pipeline')
        .select('*', { count: 'exact', head: true })
        .is('followup1_sent', null)
        .is('replied', null)
        .is('closed', null)
        .gte('followup1_due', dayStart)
        .lte('followup1_due', dayEnd),
    ),
    countOf(() =>
      supabase
        .from('lead_pipeline')
        .select('*', { count: 'exact', head: true })
        .is('followup2_sent', null)
        .is('replied', null)
        .is('closed', null)
        .gte('followup2_due', dayStart)
        .lte('followup2_due', dayEnd),
    ),
    countOf(() =>
      supabase
        .from('lead_pipeline')
        .select('*', { count: 'exact', head: true })
        .eq('email_found', false)
        .is('closed', null),
    ),
    countOf(() =>
      supabase
        .from('lead_pipeline')
        .select('*', { count: 'exact', head: true })
        .eq('email_found', true)
        .eq('email_verified', false)
        // A dead address is a different problem with a different fix, and it
        // has its own card. Counting it here would double-report it.
        .neq('email_verification_status', 'invalid')
        .is('closed', null),
    ),
    // Due before today and still unsent the queue the scheduled sender is
    // behind on, which is the number worth alarming about.
    countOf(() =>
      supabase
        .from('lead_pipeline')
        .select('*', { count: 'exact', head: true })
        .is('replied', null)
        .is('closed', null)
        .or(
          `and(followup1_sent.is.null,followup1_due.lt.${now}),and(followup2_sent.is.null,followup2_due.lt.${now})`,
        ),
    ),
    countOf(() =>
      supabase
        .from('lead_pipeline')
        .select('*', { count: 'exact', head: true })
        .eq('email_verified', true)
        .eq('research_complete', false)
        .is('closed', null),
    ),
    countOf(() =>
      supabase
        .from('lead_pipeline')
        .select('*', { count: 'exact', head: true })
        .eq('research_complete', true)
        .eq('draft_ready', false)
        .is('closed', null),
    ),
    // Counts what the SENDER requires, not just the pipeline flag: an initial
    // email also needs its active version approved. Counting the flag alone
    // produced a card reading N while the sender skipped all N. See the
    // ready_to_send view in lib/data/leads.ts.
    (async () => {
      const [{ data: approvedVersions }, { data: pipelineReady }] = await Promise.all([
        supabase
          .from('email_versions')
          .select('lead_id')
          .eq('type', 'initial')
          .eq('active', true)
          .eq('status', 'approved'),
        supabase
          .from('lead_pipeline')
          .select('lead_id')
          .eq('approved', true)
          .is('first_email_sent', null)
          .is('closed', null)
          .limit(5000),
      ]);

      const withApprovedDraft = new Set((approvedVersions ?? []).map((v) => v.lead_id));
      return (pipelineReady ?? []).filter((r) => withApprovedDraft.has(r.lead_id)).length;
    })(),
    countOf(() =>
      supabase
        .from('lead_pipeline')
        .select('*', { count: 'exact', head: true })
        .eq('email_verification_status', 'invalid')
        .is('closed', null),
    ),
  ]);

  return {
    emailsToday,
    repliesToday,
    approvalQueue,
    awaitingReview,
    followup1DueToday,
    followup2DueToday,
    missingEmail,
    awaitingVerification,
    overdueFollowups,
    needsResearch,
    needsDraft,
    readyToSend,
    invalidEmail,
    error: null,
  };
}

/**
 * Verification counts, plus how many sent leads are still missing a follow-up
 * draft. Feeds the Settings verification panel.
 */
export async function getVerificationCounts(): Promise<{
  counts: Record<string, number>;
  /** Leads with no address at all. Cannot be verified, only sourced. */
  noAddress: number;
  /** Never-checked addresses that DO exist. What an export actually contains. */
  exportable: number;
  /** Catch-all + unknown: already paid for, re-checkable but rarely worth it. */
  inconclusive: number;
  sentWithoutFollowups: number;
  /** Leads (not drafts) still missing a follow-up. */
  leadsMissingFollowups: number;
}> {
  const supabase = await createClient();

  const statuses = ['unverified', 'valid', 'invalid', 'accept_all', 'unknown'] as const;
  const counts: Record<string, number> = {};

  /*
   * "Unverified" counted leads with NO ADDRESS as well as unchecked ones, and
   * in this dataset every single unverified lead was the former: 308 with no
   * address, 0 with an unchecked one. So the tile read 308 while the export
   * produced 184, and the number promised work the download could not deliver.
   *
   * Splitting them is the fix. You cannot verify an address you do not have;
   * that is a sourcing problem, and it belongs under Leads Missing Email.
   */
  await Promise.all(
    statuses.map(async (status) => {
      const { count } = await supabase
        .from('lead_pipeline')
        .select('*', { count: 'exact', head: true })
        .eq('email_verification_status', status);
      counts[status] = count ?? 0;
    }),
  );

  const countWhere = async (build: PromiseLike<{ count: number | null }>) => (await build).count ?? 0;

  const [noAddress, exportable, inconclusive] = await Promise.all([
    countWhere(
      supabase
        .from('lead_pipeline')
        .select('*', { count: 'exact', head: true })
        .eq('email_found', false),
    ),
    countWhere(
      supabase
        .from('lead_pipeline')
        .select('*', { count: 'exact', head: true })
        .eq('email_verification_status', 'unverified')
        .eq('email_found', true)
        .is('closed', null),
    ),
    countWhere(
      supabase
        .from('lead_pipeline')
        .select('*', { count: 'exact', head: true })
        .in('email_verification_status', ['accept_all', 'unknown'])
        .eq('email_found', true)
        .is('closed', null),
    ),
  ]);

  // Leads that have been emailed and are still in play.
  const { data: sent } = await supabase
    .from('lead_pipeline')
    .select('lead_id')
    .not('first_email_sent', 'is', null)
    .is('replied', null)
    .is('closed', null)
    .limit(5000);

  const sentIds = (sent ?? []).map((row) => row.lead_id);
  let sentWithoutFollowups = 0;
  let leadsMissingFollowups = 0;

  if (sentIds.length > 0) {
    const { data: versions } = await supabase
      .from('email_versions')
      .select('lead_id, type')
      .in('lead_id', sentIds)
      .eq('active', true)
      .in('type', ['followup1', 'followup2']);

    const have = new Set((versions ?? []).map((row) => `${row.lead_id}:${row.type}`));

    /*
     * Both figures, because they answer different questions and the difference
     * is roughly a factor of two.
     *
     * A single badge reading "118 missing" against 60 emailed leads reads like
     * a contradiction. It was counting DRAFTS: 59 leads each missing follow-up
     * 1 and follow-up 2. The UI now leads with the lead count and mentions the
     * draft count as the work involved.
     */
    for (const id of sentIds) {
      const missing1 = !have.has(`${id}:followup1`);
      const missing2 = !have.has(`${id}:followup2`);
      if (missing1) sentWithoutFollowups += 1;
      if (missing2) sentWithoutFollowups += 1;
      if (missing1 || missing2) leadsMissingFollowups += 1;
    }
  }

  return { counts, noAddress, exportable, inconclusive, sentWithoutFollowups, leadsMissingFollowups };
}

export interface ActivityRow extends LeadActivity {
  businessName: string | null;
}

export interface ReplyFeedRow extends Reply {
  businessName: string | null;
}

export interface RegenerationRow extends EmailVersion {
  businessName: string | null;
}

export interface DashboardFeeds {
  recentActivity: ActivityRow[];
  recentReplies: ReplyFeedRow[];
  recentRegenerations: RegenerationRow[];
  approvalQueue: PipelineBoardRow[];
  dueToday: PipelineBoardRow[];
}

/**
 * Business names are resolved with a second keyed query rather than a PostgREST
 * embedded select. The hand-written Database types declare `Relationships: []`,
 * so an embed cannot type-resolve the same pattern lib/data/misc.ts uses.
 */
async function attachNames<T extends { lead_id: string }>(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rows: T[],
): Promise<Array<T & { businessName: string | null }>> {
  const ids = [...new Set(rows.map((row) => row.lead_id))];
  const nameById = new Map<string, string>();

  if (ids.length > 0) {
    const { data } = await supabase.from('leads').select('id, business_name').in('id', ids);
    for (const lead of data ?? []) nameById.set(lead.id, lead.business_name);
  }

  return rows.map((row) => ({ ...row, businessName: nameById.get(row.lead_id) ?? null }));
}

export async function getDashboardFeeds(limit = 8): Promise<DashboardFeeds> {
  const supabase = await createClient();
  const dayEnd = endOfToday();

  const [activity, replies, regenerations, queue, due] = await Promise.all([
    supabase.from('lead_activity').select('*').order('created_at', { ascending: false }).limit(limit),
    supabase.from('replies').select('*').order('received_at', { ascending: false }).limit(limit),
    supabase
      .from('email_versions')
      .select('*')
      // 'manual' is an edit, not a regeneration this widget is about what the
      // generator produced.
      .neq('generated_by', 'manual')
      .neq('generated_by', 'import')
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('pipeline_board')
      .select('*')
      .eq('draft_ready', true)
      .eq('approved', false)
      .is('closed', null)
      .order('draft_ready_at', { ascending: true })
      .limit(limit),
    supabase
      .from('pipeline_board')
      .select('*')
      .is('replied', null)
      .is('closed', null)
      .in('next_step', ['send_followup1', 'send_followup2', 'send_initial_email'])
      .lte('updated_at', dayEnd)
      .order('updated_at', { ascending: true })
      .limit(limit),
  ]);

  const [recentActivity, recentReplies, recentRegenerations] = await Promise.all([
    attachNames(supabase, activity.data ?? []),
    attachNames(supabase, replies.data ?? []),
    attachNames(supabase, regenerations.data ?? []),
  ]);

  return {
    recentActivity,
    recentReplies,
    recentRegenerations,
    approvalQueue: queue.data ?? [],
    dueToday: due.data ?? [],
  };
}
