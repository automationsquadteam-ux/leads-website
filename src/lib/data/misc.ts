import { createClient } from '@/lib/supabase/server';
import type { EmailLog, Reply, Setting } from '@/lib/supabase/database.types';

export interface EmailLogRow extends EmailLog {
  businessName: string | null;
  recipient: string | null;
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
): Promise<{ rows: EmailLogRow[]; total: number; error: string | null }> {
  const supabase = await createClient();
  const from = (page - 1) * pageSize;

  const { data, count, error } = await supabase
    .from('email_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1);

  if (error) return { rows: [], total: 0, error: error.message };

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

  return { rows, total: count ?? 0, error: null };
}

export interface EmailFailureRow extends EmailLog {
  businessName: string | null;
  recipient: string | null;
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
 * this, only the provider-level case ever touched email_logs at all — the
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
  const from = (page - 1) * pageSize;

  const { data: archivedLeads } = await supabase.from('leads').select('id').eq('status', 'archived');
  const archivedIds = (archivedLeads ?? []).map((lead) => lead.id);
  const archivedList = archivedIds.length > 0 ? `(${archivedIds.join(',')})` : null;

  let query = supabase
    .from('email_logs')
    .select('*', { count: 'exact' })
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1);
  if (archivedList) query = query.not('lead_id', 'in', archivedList);

  const { data, count, error } = await query;

  if (error) return { rows: [], total: 0, summary: [], error: error.message };

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

  const rows: EmailFailureRow[] = logs.map((log) => {
    const lead = leadById.get(log.lead_id);
    return {
      ...log,
      businessName: lead?.business_name ?? null,
      recipient: lead?.email ?? null,
    };
  });

  const since = new Date(Date.now() - FAILURE_SUMMARY_WINDOW_DAYS * 86_400_000).toISOString();
  let summaryQuery = supabase
    .from('email_logs')
    .select('failure_reason')
    .eq('status', 'failed')
    .gte('created_at', since);
  if (archivedList) summaryQuery = summaryQuery.not('lead_id', 'in', archivedList);
  const { data: summaryRows } = await summaryQuery;

  const counts = new Map<string, number>();
  for (const row of summaryRows ?? []) {
    const key = row.failure_reason ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return { rows, total: count ?? 0, summary, error: null };
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
