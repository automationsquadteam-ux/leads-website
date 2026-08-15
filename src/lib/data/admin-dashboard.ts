import { createClient } from '@/lib/supabase/server';
import type {
  EmailVersion,
  LeadActivity,
  PipelineBoardRow,
  Reply,
} from '@/lib/supabase/database.types';
import { dayBoundsUtc, DISPLAY_TIME_ZONE } from '@/lib/utils';

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

/**
 * Every pipeline figure below is a `current_stage` count.
 *
 * Since the stage is the first unmet gate, "how many leads are blocked on X"
 * and "how many leads are at stage X" are the same question, so a tile and the
 * ?view= it links to resolve through the same derivation and cannot drift. They
 * used to be assembled here from flags and again in lib/data/leads.ts from a
 * slightly different pile of flags, which is how a card reading 111 came to open
 * a page where only 15 leads were actually sendable.
 */

type Db = Awaited<ReturnType<typeof createClient>>;

/*
 * Every pipeline count in this file goes through these two, and the reason is
 * the whole of migration 0034.
 *
 * `lead_pipeline` has NO status column — the archive decision lives on `leads`
 * — so a count against it structurally cannot exclude archived rows, while the
 * list each tile links to queries `leads` and excludes them by default. That is
 * how Dead Addresses read 12 against a page of 11.
 *
 * `pipeline_board` is the same rows plus `lead_status`, already admin-gated, so
 * filtering here makes a tile and the page it opens resolve the same set by
 * construction. **Never reach for `lead_pipeline` directly in this file.**
 */
const activePipelineCount = (db: Db) =>
  db.from('pipeline_board').select('*', { count: 'exact', head: true }).neq('lead_status', 'archived');

const activePipelineLeadIds = (db: Db) =>
  db.from('pipeline_board').select('lead_id').neq('lead_status', 'archived');

export interface DashboardWidgets {
  emailsToday: number;
  repliesToday: number;
  approvalQueue: number;
  followup1DueToday: number;
  followup2DueToday: number;
  missingEmail: number;
  awaitingVerification: number;
  /** Checked, and the verifier could not prove it either way. */
  inconclusive: number;
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

  const countOf = async (build: () => PromiseLike<{ count: number | null; error: unknown }>) => {
    const { count } = await build();
    return count ?? 0;
  };

  const [
    emailsToday,
    repliesToday,
    approvalQueue,
    followup1DueToday,
    followup2DueToday,
    missingEmail,
    awaitingVerification,
    inconclusive,
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
    /*
     * A draft exists and nobody has signed it off.
     *
     * There used to be a second card beside this one, "Emails Waiting Review",
     * counting active email_versions still marked draft. They were the same 351
     * leads plus 24 follow-up drafts one queue counted twice, and neither
     * number said which. Follow-up drafts are reviewed from the lead page,
     * where the thread they belong to is visible.
     */
    countOf(() =>
      activePipelineCount(supabase)
        .eq('current_stage', 'review'),
    ),
    countOf(() =>
      activePipelineCount(supabase)
        .is('followup1_sent', null)
        .is('replied', null)
        .is('closed', null)
        .gte('followup1_due', dayStart)
        .lte('followup1_due', dayEnd),
    ),
    countOf(() =>
      activePipelineCount(supabase)
        .is('followup2_sent', null)
        .is('replied', null)
        .is('closed', null)
        .gte('followup2_due', dayStart)
        .lte('followup2_due', dayEnd),
    ),
    // No address at all. A dead address is its own stage since 0027, so this
    // is a plain stage count and the tile matches the stage filter exactly.
    countOf(() =>
      activePipelineCount(supabase)
        .eq('current_stage', 'need_email'),
    ),
    // Genuinely never checked. Today this is 0 every address in the database
    // has already been through a verifier.
    countOf(() =>
      activePipelineCount(supabase)
        .eq('current_stage', 'need_verification')
        .eq('email_verification_status', 'unverified'),
    ),
    /*
     * Checked, and the verifier could not prove it either way.
     *
     * These 173 used to be counted as "awaiting verification", which is the
     * report that verification had not happened when it had. Re-running them
     * resolves nothing a catch-all domain returns catch-all every time so
     * they need a human decision rather than another export.
     */
    countOf(() =>
      activePipelineCount(supabase)
        .eq('current_stage', 'need_verification')
        .in('email_verification_status', ['accept_all', 'unknown']),
    ),
    /*
     * Due BEFORE TODAY and still unsent the queue the scheduled sender is
     * behind on, which is the number worth alarming about.
     *
     * Measured against the start of today, not against now(). With now() a
     * follow-up due at 09:00 was "overdue" by 09:01 while still being due
     * today, so it was counted by this card AND by the Due Today card, and the
     * two cards summed to more work than exists. The hint on this card has
     * always said "Due before today"; the query now agrees with it.
     */
    countOf(() =>
      activePipelineCount(supabase)
        .is('replied', null)
        .is('closed', null)
        .or(
          `and(followup1_sent.is.null,followup1_due.lt.${dayStart}),and(followup2_sent.is.null,followup2_due.lt.${dayStart})`,
        ),
    ),
    countOf(() =>
      activePipelineCount(supabase)
        .eq('current_stage', 'research'),
    ),
    countOf(() =>
      activePipelineCount(supabase)
        .eq('current_stage', 'draft'),
    ),
    /*
     * Stage 'approved' IS all four gates cleared with nothing sent yet. The
     * active-version check on top is explained in the ready_to_send view in
     * lib/data/leads.ts the two must stay identical.
     *
     * `send_priority < 9` on top of that, found live: 3 leads read stage
     * 'approved' (email_verified = true, a human ticked it) while
     * email_verifier_status was STILL 'invalid' from an earlier verifier
     * check nobody had overruled by correcting the address, only by ticking
     * a box. compute_pipeline_stage() only ever looks at the email_verified
     * BOOLEAN, so the stage ladder has no way to see that — but
     * compute_send_priority() does, and sendLeadEmail() refuses these
     * unconditionally regardless of the setting ("the machine wins" once a
     * verifier catches a real bounce; see its own comment). Without this,
     * the tile counted 3 leads the sender would refuse forever, and the
     * card whose whole job is "does the displayed count match what can
     * actually send" (0037) disagreed with this one next to it.
     */
    (async () => {
      const [{ data: approvedVersions }, { data: pipelineReady }] = await Promise.all([
        supabase
          .from('email_versions')
          .select('lead_id')
          .eq('type', 'initial')
          .eq('active', true)
          .eq('status', 'approved'),
        activePipelineLeadIds(supabase)
          .eq('current_stage', 'approved')
          .lt('send_priority', 9)
          .limit(5000),
      ]);

      const withApprovedDraft = new Set((approvedVersions ?? []).map((v) => v.lead_id));
      return (pipelineReady ?? []).filter((r) => withApprovedDraft.has(r.lead_id)).length;
    })(),
    countOf(() =>
      activePipelineCount(supabase)
        .eq('current_stage', 'dead_email'),
    ),
  ]);

  return {
    emailsToday,
    repliesToday,
    approvalQueue,
    followup1DueToday,
    followup2DueToday,
    missingEmail,
    awaitingVerification,
    inconclusive,
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
      const { count } = await activePipelineCount(supabase)
        .eq('email_verification_status', status);
      counts[status] = count ?? 0;
    }),
  );

  const countWhere = async (build: PromiseLike<{ count: number | null }>) => (await build).count ?? 0;

  const [noAddress, exportable, inconclusive] = await Promise.all([
    countWhere(
      activePipelineCount(supabase)
        .eq('email_found', false),
    ),
    countWhere(
      activePipelineCount(supabase)
        .eq('email_verification_status', 'unverified')
        .eq('email_found', true)
        .is('closed', null),
    ),
    countWhere(
      activePipelineCount(supabase)
        .in('email_verification_status', ['accept_all', 'unknown'])
        .eq('email_found', true)
        .is('closed', null),
    ),
  ]);

  // Leads that have been emailed and are still in play.
  const { data: sent } = await activePipelineLeadIds(supabase)
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
  /** What the scheduler would actually attempt next, in the order it would attempt it. */
  sendQueue: PipelineBoardRow[];
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

/**
 * What the scheduler would actually attempt next, in the order it would
 * attempt it — not "looks ready", verifiably ready (code only, no
 * migration — 0042 is still the next free number, reserved for whatever
 * genuinely needs one next).
 *
 * Deliberately mirrors `findDueWork()` in `outreach/scheduler.ts` rather than
 * calling it: that function sends real email, and a dashboard preview must
 * never share a code path that can. Two definitions of "due" now exist and
 * have to be kept in step by hand if either changes — the trade is a card
 * that cannot itself dispatch mail even by accident.
 *
 * Ordering is the point of this rewrite. The previous version sorted
 * everything — initial sends AND both follow-up steps — by one column,
 * `approved_at`, ascending. That timestamp is stamped exactly once, when the
 * lead's INITIAL draft is approved, and never touched again. So a lead
 * sitting in follow-up-2 territory was ordered by how long ago its original
 * draft was approved months earlier, not by anything about its current
 * urgency — and the card could show a brand-new initial candidate above a
 * follow-up-2 the real sender would process first, which starves the
 * longest-waiting lead exactly the way `findDueWork()`'s own ordering
 * comment says it must not.
 *
 * The fix is the same order `findDueWork()` uses, concatenated rather than
 * sorted by a shared key: follow-up 2s overdue from before today, follow-up
 * 1s overdue from before today, follow-up 2s due today, follow-up 1s due
 * today, then initial sends (verifier tier, then oldest-approved within a
 * tier). The overdue/today split (asked for directly: prioritize whatever
 * was already due before today over today's own fresh batch, step for step)
 * closes a starvation hole plain type-only order had — a healthy day's new
 * follow-up-2 crop would fully drain the queue before a single OVERDUE
 * follow-up-1 was even shown as next, so a backlog could read as permanently
 * stuck behind "higher priority" work that was actually younger than it.
 *
 * "Today" is a calendar day in DISPLAY_TIME_ZONE (`dayBoundsUtc`), same as
 * `findDueWork()` — not the server's own clock, which may be UTC.
 *
 * Initial candidates get one more check `findDueWork()` itself does not
 * need: the active version's OWN status, not just `lead_pipeline.approved`.
 * That flag is derived by OR-ing upward and never resets when a newer,
 * unapproved draft replaces an approved one (0039's root cause) — so
 * trusting the flag alone can list a lead as "next" that `sendLeadEmail()`
 * would actually refuse. The real scheduler gets away without this check
 * here because `ensureDraft()` / `needsApproval` catch it downstream, in the
 * send loop; a preview card has no downstream, so it checks here instead.
 */
async function getSendQueuePreview(
  supabase: Awaited<ReturnType<typeof createClient>>,
  limit: number,
): Promise<PipelineBoardRow[]> {
  const nowIso = new Date().toISOString();

  const { data: requireVerifiedSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'outreach.require_verified_email')
    .maybeSingle();
  // Same default as config.ts's own asBoolean(..., true) — missing means on.
  const requireVerified = requireVerifiedSetting?.value !== false;

  const base = () =>
    supabase
      .from('pipeline_board')
      .select('*')
      .neq('lead_status', 'archived')
      .is('replied', null)
      .is('closed', null)
      .eq('auto_followups', true);

  let initialQuery = base()
    .eq('approved', true)
    .is('first_email_sent', null)
    .lt('send_priority', 9);
  if (requireVerified) initialQuery = initialQuery.eq('email_verified', true);

  const todayDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: DISPLAY_TIME_ZONE }).format(new Date());
  const startOfToday = dayBoundsUtc(todayDateStr)?.start ?? nowIso;

  const [followup2Overdue, followup1Overdue, followup2Today, followup1Today, initialCandidates] =
    await Promise.all([
      base()
        .not('followup1_sent', 'is', null)
        .is('followup2_sent', null)
        .not('followup2_due', 'is', null)
        .lt('followup2_due', startOfToday)
        .order('followup2_due', { ascending: true })
        .limit(limit),
      base()
        .not('first_email_sent', 'is', null)
        .is('followup1_sent', null)
        .not('followup1_due', 'is', null)
        .lt('followup1_due', startOfToday)
        .order('followup1_due', { ascending: true })
        .limit(limit),
      base()
        .not('followup1_sent', 'is', null)
        .is('followup2_sent', null)
        .not('followup2_due', 'is', null)
        .gte('followup2_due', startOfToday)
        .lte('followup2_due', nowIso)
        .order('followup2_due', { ascending: true })
        .limit(limit),
      base()
        .not('first_email_sent', 'is', null)
        .is('followup1_sent', null)
        .not('followup1_due', 'is', null)
        .gte('followup1_due', startOfToday)
        .lte('followup1_due', nowIso)
        .order('followup1_due', { ascending: true })
        .limit(limit),
      initialQuery
        .order('send_priority', { ascending: true })
        .order('approved_at', { ascending: true, nullsFirst: false })
        .limit(limit),
    ]);

  const initialIds = (initialCandidates.data ?? []).map((row) => row.lead_id);
  const { data: approvedVersions } =
    initialIds.length > 0
      ? await supabase
          .from('email_versions')
          .select('lead_id')
          .in('lead_id', initialIds)
          .eq('type', 'initial')
          .eq('active', true)
          .eq('status', 'approved')
      : { data: [] as Array<{ lead_id: string }> };
  const trulyApproved = new Set((approvedVersions ?? []).map((row) => row.lead_id));
  const initial = (initialCandidates.data ?? []).filter((row) => trulyApproved.has(row.lead_id));

  return [
    ...(followup2Overdue.data ?? []),
    ...(followup1Overdue.data ?? []),
    ...(followup2Today.data ?? []),
    ...(followup1Today.data ?? []),
    ...initial,
  ].slice(0, limit);
}

export async function getDashboardFeeds(limit = 8): Promise<DashboardFeeds> {
  const supabase = await createClient();

  const [activity, replies, regenerations, queue, sendQueue] = await Promise.all([
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
    // `pipeline_board` carries no status filter of its own (it is gated on
    // `is_admin()`, not on the lead) — 0034 fixed the COUNT tiles for this;
    // this list needed the same `.neq('lead_status', 'archived')`, which it
    // never got, so an archived lead could still turn up in the queue below.
    supabase
      .from('pipeline_board')
      .select('*')
      .eq('current_stage', 'review')
      .neq('lead_status', 'archived')
      .order('draft_ready_at', { ascending: true })
      .limit(limit),
    getSendQueuePreview(supabase, limit),
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
    sendQueue,
  };
}
