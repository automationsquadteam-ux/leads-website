import { createClient } from '@/lib/supabase/server';
import type { EmailLog, EmailType, Reply, Setting } from '@/lib/supabase/database.types';
import { dayBoundsUtc } from '@/lib/utils';

export interface EmailLogRow extends EmailLog {
  businessName: string | null;
  recipient: string | null;
}

/**
 * A calendar-date range for `getEmailLogs`, as the raw `YYYY-MM-DD` strings a
 * date `<input>` produces. Either end may be omitted.
 *
 * Interpreted as "select a date" when only one bound is given ,that single
 * day, not an open-ended "from here on" or "up to here" ,because that is
 * what picking ONE date in a filter like this means. Both bounds together
 * make a period. Neither means all time, which stays the default.
 */
export interface EmailLogDateRange {
  from?: string;
  to?: string;
}

export interface EmailLogStats {
  total: number;
  initial: number;
  followup1: number;
  followup2: number;
}

const EMPTY_STATS: EmailLogStats = { total: 0, initial: 0, followup1: 0, followup2: 0 };

/**
 * Turn a possibly-partial date range into UTC bounds, or null for "no filter".
 *
 * A malformed or out-of-order range (someone edits the URL by hand, `to`
 * before `from`) is treated as no filter rather than an empty/broken query —
 * the page should show everything and let the date inputs, which read back
 * from the same params, make the mistake visible.
 */
function resolveDateRange(range: EmailLogDateRange | undefined): { start: string; end: string } | null {
  const from = range?.from ? dayBoundsUtc(range.from) : null;
  const to = range?.to ? dayBoundsUtc(range.to) : null;

  if (from && to) {
    return from.start <= to.end ? { start: from.start, end: to.end } : null;
  }
  // Only one bound given: that single day.
  return from ?? to;
}

/**
 * Lead details are fetched in a second query rather than via a PostgREST
 * embedded select (`leads(...)`). The hand-written Database types declare no
 * Relationships metadata, so an embed cannot be type-resolved; a keyed lookup
 * is explicit and stays correct if the types are later regenerated.
 */
export async function getEmailLogs(
  page = 1,
  pageSize = 50,
  dateRange?: EmailLogDateRange,
): Promise<{ rows: EmailLogRow[]; total: number; stats: EmailLogStats; error: string | null }> {
  const supabase = await createClient();
  const from = (page - 1) * pageSize;
  const bounds = resolveDateRange(dateRange);

  /*
   * Filtered on `created_at`, the one column every row has. `sent_at` is only
   * ever set on success (null for queued/failed/bounced), so filtering on it
   * would drop every failure out of "today" instead of counting it ,and the
   * two are the same instant in all but a vanishingly small number of rows
   * anyway, since a row is inserted 'queued' and updated to its final status
   * moments later in the same request.
   */
  /*
   * Failures are excluded here and own their own page (/send-failures).
   *
   * Asked for directly, and it settles a split this app kept re-litigating:
   * one lead's retry loop put 41 rejection rows in this list in fifteen
   * minutes, so "what went out today" was mostly things that did not go out.
   * Email Logs is now the record of mail that WAS sent; Send Failures is the
   * record of mail that was not, collapsed one row per problem. Two pages,
   * two questions, neither burying the other.
   */
  let query = supabase
    .from('email_logs')
    .select('*', { count: 'exact' })
    .neq('status', 'failed')
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1);
  if (bounds) query = query.gte('created_at', bounds.start).lte('created_at', bounds.end);

  const { data, count, error } = await query;

  if (error) return { rows: [], total: 0, stats: EMPTY_STATS, error: error.message };

  const logs = data ?? [];
  const leadIds = [...new Set(logs.map((log) => log.lead_id))];
  const leadById = new Map<string, { business_name: string; email: string | null }>();

  if (leadIds.length > 0) {
    const { data: leads } = await supabase
      .from('leads')
      .select('id, business_name, email')
      .in('id', leadIds);
    for (const lead of leads ?? []) {
      leadById.set(lead.id, { business_name: lead.business_name, email: lead.email });
    }
  }

  const rows: EmailLogRow[] = logs.map((log) => {
    const lead = leadById.get(log.lead_id);
    return {
      ...log,
      businessName: lead?.business_name ?? null,
      recipient: lead?.email ?? null,
    };
  });

  /*
   * The stats row summarises the SAME filtered population the list below it
   * shows ,every attempt in range, not just the successful ones ,so the
   * two never disagree about what "this time frame" means. Scoped to the
   * same date bounds but NOT to the page: a stat that only covered the
   * current 50 rows would change when you paged, which answers "what's on
   * this page" instead of the question this row exists to answer.
   */
  let statsQuery = supabase.from('email_logs').select('email_type', { count: 'exact' }).neq('status', 'failed');
  if (bounds) statsQuery = statsQuery.gte('created_at', bounds.start).lte('created_at', bounds.end);
  const { data: statsRows, count: statsTotal } = await statsQuery;

  const typeCounts = new Map<EmailType, number>();
  for (const row of statsRows ?? []) {
    typeCounts.set(row.email_type, (typeCounts.get(row.email_type) ?? 0) + 1);
  }
  const stats: EmailLogStats = {
    total: statsTotal ?? 0,
    initial: typeCounts.get('initial') ?? 0,
    followup1: typeCounts.get('followup1') ?? 0,
    followup2: typeCounts.get('followup2') ?? 0,
  };

  return { rows, total: count ?? 0, stats, error: null };
}

export interface EmailFailureRow extends EmailLog {
  businessName: string | null;
  recipient: string | null;
  /**
   * How many attempts this row stands for. One lead failing the same way
   * repeatedly is ONE problem to fix, so the page shows the newest attempt
   * with a count rather than N near-identical rows ,a malformed address
   * produced 41 of them in fifteen minutes before the send gate existed.
   */
  attemptCount: number;
}

export interface FailureReasonCount {
  reason: string;
  count: number;
}

/** How far back the "why" summary looks. See getEmailFailures for why. */
export const FAILURE_SUMMARY_WINDOW_DAYS = 14;

/**
 * Every send refusal (archived, no email, unverified, no draft, no subject,
 * provider misconfigured, unresolved placeholder) and every genuine
 * provider-level rejection, all writing `status='failed'` (0040). Before
 * this, only the provider-level case ever touched email_logs at all ,the
 * other eight return points in sendLeadEmail() just returned, leaving no
 * trace anywhere.
 *
 * Archived leads are excluded from both the list and the summary, same as
 * everywhere else this app reports a figure: archiving is a visibility
 * choice, and a "failure" against a lead someone chose to hide is not
 * something to act on.
 *
 * The summary is scoped to the last FAILURE_SUMMARY_WINDOW_DAYS so a bug
 * that was fixed months ago does not sit at the top forever, drowning out
 * whatever is actually failing today; the paginated list below it still
 * covers full history.
 */
export async function getEmailFailures(
  page = 1,
  pageSize = 50,
): Promise<{
  rows: EmailFailureRow[];
  total: number;
  summary: FailureReasonCount[];
  error: string | null;
}> {
  const supabase = await createClient();

  const { data: archivedLeads } = await supabase.from('leads').select('id').eq('status', 'archived');
  const archivedIds = (archivedLeads ?? []).map((lead) => lead.id);
  const archivedList = archivedIds.length > 0 ? `(${archivedIds.join(',')})` : null;

  /*
   * Every failure row is read, then collapsed by (lead, reason) BEFORE
   * paging ,the page numbers count problems, not attempts.
   *
   * Paged with `.range()` rather than one big select: PostgREST's 1000-row
   * cap is server-side and silent on this project (see getDashboardWidgets's
   * readyToSend comment for what that cost once), and a retry loop is exactly
   * the thing that can produce thousands of rows.
   */
  const allFailures: EmailLog[] = [];
  for (let offset = 0; ; offset += 1000) {
    let query = supabase
      .from('email_logs')
      .select('*')
      .eq('status', 'failed')
      .order('created_at', { ascending: false })
      .range(offset, offset + 999);
    if (archivedList) query = query.not('lead_id', 'in', archivedList);

    const { data, error } = await query;
    if (error) return { rows: [], total: 0, summary: [], error: error.message };

    const batch = data ?? [];
    allFailures.push(...batch);
    if (batch.length < 1000) break;
  }

  /*
   * Newest attempt per (lead, reason) wins, carrying the count of the rest.
   * The list is already newest-first, so the first one seen for a key is the
   * one to keep.
   */
  const grouped = new Map<string, { log: EmailLog; attemptCount: number }>();
  for (const log of allFailures) {
    const key = `${log.lead_id}|${log.failure_reason ?? 'unknown'}`;
    const existing = grouped.get(key);
    if (existing) existing.attemptCount += 1;
    else grouped.set(key, { log, attemptCount: 1 });
  }

  const problems = [...grouped.values()];
  const total = problems.length;
  const from = (page - 1) * pageSize;
  const pageOfProblems = problems.slice(from, from + pageSize);

  const logs = pageOfProblems.map((p) => p.log);
  const attemptsById = new Map(pageOfProblems.map((p) => [p.log.id, p.attemptCount]));
  const leadIds = [...new Set(logs.map((log) => log.lead_id))];
  const leadById = new Map<string, { business_name: string; email: string | null }>();

  if (leadIds.length > 0) {
    const { data: leads } = await supabase
      .from('leads')
      .select('id, business_name, email')
      .in('id', leadIds);
    for (const lead of leads ?? []) {
      leadById.set(lead.id, { business_name: lead.business_name, email: lead.email });
    }
  }

  const rows: EmailFailureRow[] = logs.map((log) => {
    const lead = leadById.get(log.lead_id);
    return {
      ...log,
      businessName: lead?.business_name ?? null,
      recipient: lead?.email ?? null,
      attemptCount: attemptsById.get(log.id) ?? 1,
    };
  });

  /*
   * The "why" summary counts PROBLEMS too, over the same collapsed set ,not
   * raw attempts. Counting attempts made one stuck lead read as 41 failures
   * of one kind and drowned out two genuinely separate problems sitting
   * beside it, which is the opposite of what a "why" breakdown is for.
   */
  const since = new Date(Date.now() - FAILURE_SUMMARY_WINDOW_DAYS * 86_400_000).toISOString();
  const counts = new Map<string, number>();
  for (const { log } of problems) {
    if (log.created_at < since) continue;
    const key = log.failure_reason ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return { rows, total, summary, error: null };
}

export interface ReplyRow extends Reply {
  businessName: string | null;
}

export async function getReplies(
  page = 1,
  pageSize = 50,
): Promise<{ rows: ReplyRow[]; total: number; error: string | null }> {
  const supabase = await createClient();
  const from = (page - 1) * pageSize;

  const { data, count, error } = await supabase
    .from('replies')
    .select('*', { count: 'exact' })
    .order('received_at', { ascending: false })
    .range(from, from + pageSize - 1);

  if (error) return { rows: [], total: 0, error: error.message };

  const replies = data ?? [];
  const leadIds = [...new Set(replies.map((reply) => reply.lead_id))];
  const nameById = new Map<string, string>();

  if (leadIds.length > 0) {
    const { data: leads } = await supabase.from('leads').select('id, business_name').in('id', leadIds);
    for (const lead of leads ?? []) nameById.set(lead.id, lead.business_name);
  }

  const rows: ReplyRow[] = replies.map((reply) => ({
    ...reply,
    businessName: nameById.get(reply.lead_id) ?? null,
  }));

  return { rows, total: count ?? 0, error: null };
}

export async function getSettings(): Promise<{ rows: Setting[]; error: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.from('settings').select('*').order('key');
  return { rows: data ?? [], error: error?.message ?? null };
}

/** Convenience lookup: key -> value, for pre-filling the settings form. */
export function settingsMap(rows: Setting[]): Map<string, unknown> {
  return new Map(rows.map((row) => [row.key, row.value]));
}
