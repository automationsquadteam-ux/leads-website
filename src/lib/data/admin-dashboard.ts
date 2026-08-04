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
        .is('closed', null),
    ),
    // Due before today and still unsent — the queue the scheduled sender is
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
    error: null,
  };
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
 * so an embed cannot type-resolve — the same pattern lib/data/misc.ts uses.
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
      // 'manual' is an edit, not a regeneration — this widget is about what the
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
