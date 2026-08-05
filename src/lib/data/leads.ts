import { createClient } from '@/lib/supabase/server';
import type {
  EmailLog,
  EmailVerificationStatus,
  EmailVersion,
  Lead,
  LeadActivity,
  LeadStatus,
  PipelineBoardRow,
  Reply,
} from '@/lib/supabase/database.types';

/** Columns the list view is allowed to sort by. Anything else is rejected. */
export const SORTABLE_COLUMNS = [
  'business_name',
  'city',
  'country',
  'niche',
  'status',
  'last_contacted_at',
  'created_at',
  'updated_at',
] as const;

export type SortColumn = (typeof SORTABLE_COLUMNS)[number];

export function isSortColumn(value: string): value is SortColumn {
  return (SORTABLE_COLUMNS as readonly string[]).includes(value);
}

/** Fields the global search scans. */
const SEARCH_COLUMNS = [
  'business_name',
  'email',
  'website',
  'phone',
  'city',
  'country',
  'niche',
] as const;

/**
 * PostgREST parses `or=(a.ilike.x,b.ilike.y)` positionally, so commas,
 * parentheses and backslashes in user input would break out of the expression.
 * Strip them, and neutralise the SQL LIKE wildcards so a stray `%` cannot turn
 * into "match everything".
 */
function sanitizeSearch(term: string): string {
  return term
    .trim()
    .replace(/[,()\\]/g, ' ')
    .replace(/[%_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Named views the dashboard widgets link to.
 *
 * Every widget on the dashboard is a count of something; clicking it has to
 * land on exactly the rows that were counted. Defining those queries once, here,
 * is what guarantees the number and the list agree a widget that says 114 and
 * a page that shows 97 is worse than no widget.
 */
export const LEAD_VIEWS = {
  missing_email: 'Leads with no email address',
  // Distinct from missing_email: these HAVE an address that has simply never
  // been sent to a verifier. A plain ?verify=unverified filter cannot express
  // that, because a lead with no address is also "unverified" and there are 308
  // of those — which is why the tile said 2 and the link showed 308.
  never_checked: 'Has an address, never sent to a verifier',
  awaiting_verification: 'Address on file, not yet verified',
  invalid_email: 'Address proved undeliverable needs a new source',
  approval_queue: 'Drafted, waiting for approval',
  awaiting_review: 'Active draft still marked as draft',
  needs_research: 'Verified, no research written',
  needs_draft: 'Research done, no draft',
  ready_to_send: 'Approved and waiting to go out',
  followup1_due: 'Follow-up 1 due today or earlier',
  followup2_due: 'Follow-up 2 due today or earlier',
  overdue_followups: 'Follow-ups due before today, still unsent',
  replied: 'Prospect replied',
  sent: 'Initial email has gone out',
} as const;

export type LeadView = keyof typeof LEAD_VIEWS;

export function isLeadView(value: string): value is LeadView {
  return value in LEAD_VIEWS;
}

export interface LeadListParams {
  search?: string;
  statuses?: LeadStatus[];
  view?: LeadView;
  /** Filter by email verification state. Empty means no filter. */
  verification?: EmailVerificationStatus[];
  sort?: SortColumn;
  direction?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

/** A lead plus the pipeline figures the list shows on every row. */
export interface LeadRow extends Lead {
  stage: PipelineBoardRow['current_stage'] | null;
  nextStep: PipelineBoardRow['next_step'] | null;
  verification: PipelineBoardRow['email_verification_status'] | null;
}

export interface LeadListResult {
  rows: LeadRow[];
  total: number;
  page: number;
  pageSize: number;
  error: string | null;
}

/**
 * Resolve a named view to the lead ids in it.
 *
 * Done as a pre-query against lead_pipeline rather than a join, because the
 * hand-written Database types declare `Relationships: []` and PostgREST embeds
 * therefore do not type-resolve. Returns null when the view needs no pipeline
 * filter at all.
 */
async function idsForView(
  supabase: Awaited<ReturnType<typeof createClient>>,
  view: LeadView,
): Promise<string[]> {
  const now = new Date().toISOString();
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  let query = supabase.from('lead_pipeline').select('lead_id').is('closed', null);

  switch (view) {
    case 'missing_email':
      query = query.eq('email_found', false);
      break;
    case 'never_checked':
      query = query.eq('email_found', true).eq('email_verification_status', 'unverified');
      break;
    case 'awaiting_verification':
      query = query
        .eq('email_found', true)
        .eq('email_verified', false)
        .neq('email_verification_status', 'invalid');
      break;
    case 'invalid_email':
      query = query.eq('email_verification_status', 'invalid');
      break;
    case 'approval_queue':
      query = query.eq('draft_ready', true).eq('approved', false);
      break;
    case 'needs_research':
      query = query.eq('email_verified', true).eq('research_complete', false);
      break;
    case 'needs_draft':
      query = query.eq('research_complete', true).eq('draft_ready', false);
      break;
    case 'ready_to_send': {
      /*
       * "Ready to send" must mean what the SENDER means by it.
       *
       * lead_pipeline.approved alone is not enough: before an initial email the
       * scheduler checks that the ACTIVE version is approved. Counting only the
       * pipeline flag produced a card reading N while the sender skipped all N
       * saying "waiting for approval". Both conditions, or the number lies.
       */
      const { data: approvedVersions } = await supabase
        .from('email_versions')
        .select('lead_id')
        .eq('type', 'initial')
        .eq('active', true)
        .eq('status', 'approved');

      const withApprovedDraft = new Set((approvedVersions ?? []).map((v) => v.lead_id));
      if (withApprovedDraft.size === 0) return [];

      const { data: pipelineReady } = await supabase
        .from('lead_pipeline')
        .select('lead_id')
        .eq('approved', true)
        .is('first_email_sent', null)
        .is('closed', null)
        .limit(5000);

      return (pipelineReady ?? [])
        .map((r) => r.lead_id)
        .filter((id) => withApprovedDraft.has(id));
    }
    case 'followup1_due':
      query = query
        .is('followup1_sent', null)
        .is('replied', null)
        .not('followup1_due', 'is', null)
        .lte('followup1_due', endOfToday.toISOString());
      break;
    case 'followup2_due':
      query = query
        .is('followup2_sent', null)
        .is('replied', null)
        .not('followup2_due', 'is', null)
        .lte('followup2_due', endOfToday.toISOString());
      break;
    case 'overdue_followups':
      query = query
        .is('replied', null)
        .or(
          `and(followup1_sent.is.null,followup1_due.lt.${now}),and(followup2_sent.is.null,followup2_due.lt.${now})`,
        );
      break;
    case 'replied':
      query = query.not('replied', 'is', null);
      break;
    case 'sent':
      query = query.not('first_email_sent', 'is', null);
      break;
    case 'awaiting_review': {
      // This one lives on email_versions, not the pipeline.
      const { data } = await supabase
        .from('email_versions')
        .select('lead_id')
        .eq('active', true)
        .eq('status', 'draft');
      return [...new Set((data ?? []).map((r) => r.lead_id))];
    }
  }

  const { data } = await query.limit(5000);
  return (data ?? []).map((r) => r.lead_id);
}

export async function getLeads(params: LeadListParams = {}): Promise<LeadListResult> {
  const {
    search = '',
    statuses = [],
    view,
    verification = [],
    sort = 'created_at',
    direction = 'desc',
    page = 1,
    pageSize = 50,
  } = params;

  const supabase = await createClient();

  let query = supabase.from('leads').select('*', { count: 'exact' });

  // A named view and a verification filter both resolve to a set of lead ids.
  // Intersecting them here keeps "Awaiting verification, and also dead" a
  // sensible combination rather than two mutually exclusive modes.
  const idFilters: string[][] = [];

  if (view) idFilters.push(await idsForView(supabase, view));

  if (verification.length > 0) {
    const { data } = await supabase
      .from('lead_pipeline')
      .select('lead_id')
      .in('email_verification_status', verification)
      .limit(5000);
    idFilters.push((data ?? []).map((r) => r.lead_id));
  }

  if (idFilters.length > 0) {
    const intersection = idFilters.reduce((acc, ids) => {
      const set = new Set(ids);
      return acc.filter((id) => set.has(id));
    });

    if (intersection.length === 0) {
      return { rows: [], total: 0, page, pageSize, error: null };
    }
    query = query.in('id', intersection);
  }

  const term = sanitizeSearch(search);
  if (term) {
    // An admin looking up "someone@example.com" should land on that one lead,
    // so email is part of the same OR rather than a separate mode.
    query = query.or(SEARCH_COLUMNS.map((col) => `${col}.ilike.*${term}*`).join(','));
  }

  if (statuses.length > 0) {
    query = query.in('status', statuses);
  } else if (!view) {
    /*
     * Archived means "put this out of the way", so the default list honours
     * that. Leaving them in made archiving pointless — the row you wanted gone
     * was still in every count and every page of results.
     *
     * Still reachable: tick Archived in the status filter, and they appear.
     * A named view is left alone, because a view like missing_email is asking a
     * specific question that archiving does not answer.
     */
    query = query.neq('status', 'archived');
  }

  const from = (page - 1) * pageSize;
  query = query
    .order(sort, { ascending: direction === 'asc', nullsFirst: false })
    // Tie-breaker keeps pagination stable when the sort column has duplicates.
    .order('id', { ascending: true })
    .range(from, from + pageSize - 1);

  const { data, count, error } = await query;
  const leads = data ?? [];

  // Stage and next step come from pipeline_board in a second keyed query. An
  // embedded select cannot be used: the hand-written Database types declare
  // `Relationships: []`, so PostgREST embeds do not type-resolve. Only the page
  // of leads actually being rendered is looked up.
  const stageById = new Map<
    string,
    {
      stage: PipelineBoardRow['current_stage'];
      nextStep: PipelineBoardRow['next_step'];
      verification: PipelineBoardRow['email_verification_status'];
    }
  >();
  if (leads.length > 0) {
    const { data: board } = await supabase
      .from('pipeline_board')
      .select('lead_id, current_stage, next_step, email_verification_status')
      .in('lead_id', leads.map((lead) => lead.id));

    for (const row of board ?? []) {
      stageById.set(row.lead_id, {
        stage: row.current_stage,
        nextStep: row.next_step,
        verification: row.email_verification_status,
      });
    }
  }

  return {
    rows: leads.map((lead) => ({
      ...lead,
      stage: stageById.get(lead.id)?.stage ?? null,
      nextStep: stageById.get(lead.id)?.nextStep ?? null,
      verification: stageById.get(lead.id)?.verification ?? null,
    })),
    total: count ?? 0,
    page,
    pageSize,
    error: error?.message ?? null,
  };
}

export interface LeadDetail {
  lead: Lead | null;
  pipeline: PipelineBoardRow | null;
  versions: EmailVersion[];
  activity: LeadActivity[];
  emailLogs: EmailLog[];
  replies: Reply[];
  campaignName: string | null;
}

/**
 * Everything the review workspace renders, in one round of parallel queries.
 *
 * `pipeline` is read from the pipeline_board view rather than the lead_pipeline
 * table, because next_step only exists there it is computed by
 * public.compute_next_step() against the current clock, so it cannot be a
 * stored column and must not be re-derived in TypeScript.
 */
export async function getLeadDetail(id: string): Promise<LeadDetail> {
  const supabase = await createClient();

  const { data: lead } = await supabase.from('leads').select('*').eq('id', id).maybeSingle();

  if (!lead) {
    return {
      lead: null,
      pipeline: null,
      versions: [],
      activity: [],
      emailLogs: [],
      replies: [],
      campaignName: null,
    };
  }

  const [pipeline, versions, activity, logs, replies, campaign] = await Promise.all([
    supabase.from('pipeline_board').select('*').eq('lead_id', id).maybeSingle(),
    supabase
      .from('email_versions')
      .select('*')
      .eq('lead_id', id)
      .order('version_number', { ascending: false }),
    supabase
      .from('lead_activity')
      .select('*')
      .eq('lead_id', id)
      .order('created_at', { ascending: false })
      .limit(40),
    supabase
      .from('email_logs')
      .select('*')
      .eq('lead_id', id)
      .order('created_at', { ascending: false }),
    supabase.from('replies').select('*').eq('lead_id', id).order('received_at', { ascending: false }),
    lead.campaign_id
      ? supabase.from('campaigns').select('name').eq('id', lead.campaign_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    lead,
    pipeline: pipeline.data ?? null,
    versions: versions.data ?? [],
    activity: activity.data ?? [],
    emailLogs: logs.data ?? [],
    replies: replies.data ?? [],
    campaignName: campaign.data?.name ?? null,
  };
}

/** Status counts for the filter panel, so each option can show its size. */
export async function getStatusFacets(): Promise<Record<string, number>> {
  const supabase = await createClient();
  const { data } = await supabase.from('dashboard_lead_status_counts').select('status, lead_count');
  return Object.fromEntries((data ?? []).map((row) => [row.status, row.lead_count]));
}
