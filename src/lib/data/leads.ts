import { createClient } from '@/lib/supabase/server';
import type {
  EmailLog,
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
  'category',
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
  'category',
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

export interface LeadListParams {
  search?: string;
  statuses?: LeadStatus[];
  sort?: SortColumn;
  direction?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

/** A lead plus the two pipeline figures the list shows on every row. */
export interface LeadRow extends Lead {
  stage: PipelineBoardRow['current_stage'] | null;
  nextStep: PipelineBoardRow['next_step'] | null;
}

export interface LeadListResult {
  rows: LeadRow[];
  total: number;
  page: number;
  pageSize: number;
  error: string | null;
}

export async function getLeads(params: LeadListParams = {}): Promise<LeadListResult> {
  const {
    search = '',
    statuses = [],
    sort = 'created_at',
    direction = 'desc',
    page = 1,
    pageSize = 50,
  } = params;

  const supabase = await createClient();

  let query = supabase.from('leads').select('*', { count: 'exact' });

  const term = sanitizeSearch(search);
  if (term) {
    // An admin looking up "someone@example.com" should land on that one lead,
    // so email is part of the same OR rather than a separate mode.
    query = query.or(SEARCH_COLUMNS.map((col) => `${col}.ilike.*${term}*`).join(','));
  }

  if (statuses.length > 0) {
    query = query.in('status', statuses);
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
  const stageById = new Map<string, { stage: PipelineBoardRow['current_stage']; nextStep: PipelineBoardRow['next_step'] }>();
  if (leads.length > 0) {
    const { data: board } = await supabase
      .from('pipeline_board')
      .select('lead_id, current_stage, next_step')
      .in('lead_id', leads.map((lead) => lead.id));

    for (const row of board ?? []) {
      stageById.set(row.lead_id, { stage: row.current_stage, nextStep: row.next_step });
    }
  }

  return {
    rows: leads.map((lead) => ({
      ...lead,
      stage: stageById.get(lead.id)?.stage ?? null,
      nextStep: stageById.get(lead.id)?.nextStep ?? null,
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
 * table, because next_step only exists there — it is computed by
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
