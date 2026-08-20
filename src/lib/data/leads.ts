import { createClient } from '@/lib/supabase/server';
import type {
  EmailLog,
  EmailVerificationStatus,
  EmailVersion,
  Lead,
  LeadActivity,
  PipelineStage,
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
 *
 * **Most of them are now a `current_stage` equality and nothing else.** Since
 * the stage is the first unmet gate, "leads blocked on X" and "leads at stage X"
 * are the same set by construction, so a tile and its link cannot drift apart
 * the way they used to when each was assembled from its own pile of flags.
 */
export const LEAD_VIEWS = {
  missing_email: 'No email address yet',
  // Not the same as missing_email, and neither is a plain ?verify=unverified:
  // a lead with NO address also carries the 'unverified' status, so that filter
  // returned all 307 of them under a tile reading 0.
  awaiting_verification: 'Has an address, never sent to a verifier',
  inconclusive: 'Checked, but the verifier could not prove it either way',
  invalid_email: 'Address proved undeliverable needs a new source',
  needs_research: 'Verified, no research written',
  needs_draft: 'Research done, no draft',
  approval_queue: 'Drafted, waiting for approval',
  ready_to_send: 'Verified, initial approved and waiting to go out',
  followup1_due: 'Follow-up 1 due today',
  followup2_due: 'Follow-up 2 due today',
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
  /**
   * Filter by pipeline stage. Empty means no filter.
   *
   * This replaced a filter on `leads.status`. The two disagreed constantly —
   * 472 leads read `status = 'researching'` while 695 had research complete —
   * because status is a label somebody sets and the stage is derived from what
   * is actually true. Filtering on the label found the wrong leads.
   */
  stages?: PipelineStage[];
  view?: LeadView;
  /** Filter by email verification state. Empty means no filter. */
  verification?: EmailVerificationStatus[];
  /**
   * Archived leads are hidden by default. 'only' shows the archive and nothing
   * else, which is what you want when reviewing what you put away ,'include'
   * mixed them into 700 live leads and made them impossible to find.
   */
  archived?: 'exclude' | 'only';
  /**
   * Split by whether a website is on file. Empty means no filter.
   *
   * Deliberately independent of `stages`/`verification`/`view` ,a website is
   * a fact about the LEAD, not a position in the outreach pipeline, so it
   * composes with any of them ("verified AND has a website" is exactly the
   * two filters applied together) rather than being folded into one.
   */
  hasWebsite?: 'yes' | 'no';
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
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  let query = supabase.from('lead_pipeline').select('lead_id').is('closed', null);

  switch (view) {
    // One stage per view. Sourcing an address and replacing a dead one are
    // different jobs, so 0027 gave them a stage each rather than splitting one
    // stage on a flag ,which is what made the tiles read 307 and 19 against a
    // filter reading 326.
    case 'missing_email':
      query = query.eq('current_stage', 'need_email');
      break;
    case 'invalid_email':
      query = query.eq('current_stage', 'dead_email');
      break;

    /*
     * `need_verification` likewise splits in two, and this is the split that
     * caused the "it says verification wasn't done when it was" complaint:
     * every one of the 173 leads here HAS been through a verifier, which came
     * back catch-all or unknown. Counting them as "awaiting verification"
     * promised a re-run that resolves nothing ,a catch-all domain returns
     * catch-all every single time.
     */
    case 'awaiting_verification':
      query = query
        .eq('current_stage', 'need_verification')
        .eq('email_verification_status', 'unverified');
      break;
    case 'inconclusive':
      query = query
        .eq('current_stage', 'need_verification')
        .in('email_verification_status', ['accept_all', 'unknown']);
      break;

    case 'needs_research':
      query = query.eq('current_stage', 'research');
      break;
    case 'needs_draft':
      query = query.eq('current_stage', 'draft');
      break;
    case 'approval_queue':
      query = query.eq('current_stage', 'review');
      break;
    case 'ready_to_send': {
      /*
       * `current_stage = 'approved'` IS all four gates.
       *
       * Reaching that stage means every earlier gate was cleared ,an address
       * exists, EMAIL_VERIFIED IS TRUE, research is done, a draft exists,
       * and a human signed it off ,and that nothing above it has happened yet,
       * since sent / replied / closed are pinned higher in the ladder. One
       * equality replaces six conditions that used to be copied between here
       * and the dashboard, out of step twice.
       *
       * "A verifier called it valid" (this comment's old claim) is not the
       * same thing as email_verified = true, and that gap is real: found live,
       * 3 leads with email_verified = true ,a HUMAN ticked it ,while
       * email_verifier_status was still 'invalid' from an earlier verifier
       * check nobody overruled by correcting the address, only by ticking a
       * box. compute_pipeline_stage() only ever reads the boolean, so those 3
       * cleared this gate; compute_send_priority() reads BOTH and marks them
       * 9 ("not sendable"), and sendLeadEmail() refuses them unconditionally
       * ("the machine wins" once a verifier catches a real bounce). Reading
       * from pipeline_board instead of lead_pipeline for its send_priority
       * column closes that gap with the same computation the Send queue and
       * the scheduler already trust, rather than re-deriving the rule here.
       *
       * The active-version check stays on top. lead_pipeline.approved is set by
       * the email_versions trigger, but a stale `true` from before that trigger
       * existed would still read as approved here, and the sender demands the
       * VERSION immediately before an initial send. Without this, the count
       * would once again promise something the sender refuses.
       */
      /*
       * CANDIDATES FIRST, then their drafts ,never the whole table.
       *
       * This used to select every approved+active initial version with no
       * `.limit()` and intersect the result. PostgREST caps a response at
       * 1000 rows on this project, and that cap is SERVER-side: it is not
       * lifted by asking for `.limit(10000)`, and it reports no error ,you
       * simply get 1000 rows and a Set that is missing everyone else.
       * Measured live: 1,239 such versions exist, the query returned exactly
       * 1000, and the intersection produced 79 against 138 genuinely-ready
       * leads. 59 leads were dropped purely by row order.
       *
       * Inverting it removes the cap from the picture entirely: the version
       * lookup is now bounded by the candidate list (a few hundred at most),
       * chunked so the `in()` filter cannot build a URL PostgREST rejects.
       * This is the shape `getSendQueuePreview()` already used correctly.
       */
      const { data: pipelineReady } = await supabase
        .from('pipeline_board')
        .select('lead_id')
        .eq('current_stage', 'approved')
        .lt('send_priority', 9)
        .limit(1000);

      const candidateIds = (pipelineReady ?? []).map((r) => r.lead_id);
      if (candidateIds.length === 0) return [];

      const withApprovedDraft = new Set<string>();
      for (let i = 0; i < candidateIds.length; i += 300) {
        const { data } = await supabase
          .from('email_versions')
          .select('lead_id')
          .in('lead_id', candidateIds.slice(i, i + 300))
          .eq('type', 'initial')
          .eq('active', true)
          .eq('status', 'approved');
        for (const v of data ?? []) withApprovedDraft.add(v.lead_id);
      }

      return candidateIds.filter((id) => withApprovedDraft.has(id));
    }
    /*
     * Due TODAY means due today, both ends.
     *
     * These used to be open-ended (`<= end of today`) while the cards counting
     * them were bounded, so the card said 0 and the page it linked to could
     * show every overdue follow-up as well. They also overlapped Overdue
     * Follow-ups, which counts the same rows from the other side. Today / before
     * today / not yet due now partition the work with no row in two buckets.
     */
    case 'followup1_due':
      query = query
        .is('followup1_sent', null)
        .is('replied', null)
        .gte('followup1_due', startOfToday.toISOString())
        .lte('followup1_due', endOfToday.toISOString());
      break;
    case 'followup2_due':
      query = query
        .is('followup2_sent', null)
        .is('replied', null)
        .gte('followup2_due', startOfToday.toISOString())
        .lte('followup2_due', endOfToday.toISOString());
      break;
    case 'overdue_followups':
      query = query
        .is('replied', null)
        .or(
          `and(followup1_sent.is.null,followup1_due.lt.${startOfToday.toISOString()}),and(followup2_sent.is.null,followup2_due.lt.${startOfToday.toISOString()})`,
        );
      break;
    case 'replied':
      query = query.not('replied', 'is', null);
      break;
    case 'sent':
      query = query.not('first_email_sent', 'is', null);
      break;
  }

  const { data } = await query.limit(5000);
  return (data ?? []).map((r) => r.lead_id);
}

export async function getLeads(params: LeadListParams = {}): Promise<LeadListResult> {
  const {
    search = '',
    stages = [],
    view,
    verification = [],
    archived = 'exclude',
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

  if (stages.length > 0) {
    const { data } = await supabase
      .from('lead_pipeline')
      .select('lead_id')
      .in('current_stage', stages)
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

  /*
   * Archived means "put this out of the way", so the default list honours that.
   * Leaving them in made archiving pointless ,the row you wanted gone was
   * still in every count and every page of results.
   *
   * It is the ONE thing `leads.status` is still read for in the UI, because
   * archiving is a visibility choice rather than a position in the pipeline: an
   * archived lead can be at any stage, and the stage does not stop being true
   * because you put the lead away. Hence a filter of its own rather than a
   * twelfth entry in the stage list.
   *
   * ONLY, not "also": the point of opening the archive is to look at what is in
   * it, and mixing two archived leads into seven hundred live ones is not a way
   * to see them.
   */
  query = archived === 'only'
    ? query.eq('status', 'archived')
    : query.neq('status', 'archived');

  /*
   * Has a website on file, or not ,a fact about the lead, so it filters
   * `leads` directly rather than going through the idFilters intersection
   * above (which is for questions about the PIPELINE: stage, verification,
   * a named view). Applied straight on `query`, the same way `archived` and
   * `search` are, so it combines with every other filter by plain AND and
   * touches nothing else ,"verified and has a website" is just both
   * conditions on the one query, not a third mode to keep in sync.
   *
   * `website is null` is the whole check: 0031's normalizer turns a blank
   * string into NULL before the row is even written, and the column has
   * carried a `website is null or website ~* '^https?://'` CHECK since the
   * table's first migration, so no row has ever been able to hold ''.
   */
  if (params.hasWebsite === 'yes') query = query.not('website', 'is', null);
  if (params.hasWebsite === 'no') query = query.is('website', null);

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
    };
  }

  const [pipeline, versions, activity, logs, replies] = await Promise.all([
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
  ]);

  return {
    lead,
    pipeline: pipeline.data ?? null,
    versions: versions.data ?? [],
    activity: activity.data ?? [],
    emailLogs: logs.data ?? [],
    replies: replies.data ?? [],
  };
}

/**
 * Stage counts for the filter panel, so each option can show its size.
 *
 * Counted WITH the archived filter the list is actually using. Reading
 * analytics_stage_distribution instead meant the chip said `Initial Sent 94`
 * and the page it opened showed 93 ,one of the two archived leads sits at that
 * stage, and the list hides archived by default. A facet that does not answer
 * the same question as the list is worse than no facet.
 */
export async function getStageFacets(archived: 'exclude' | 'only' = 'exclude'): Promise<Record<string, number>> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('lead_stage_counts')
    .select('stage, lead_count, lead_count_all');

  return Object.fromEntries(
    (data ?? []).map((row) => [
      row.stage,
      // In archive-only mode the facet must count archived leads, which is the
      // difference between the two columns the view returns.
      archived === 'only' ? row.lead_count_all - row.lead_count : row.lead_count,
    ]),
  );
}
