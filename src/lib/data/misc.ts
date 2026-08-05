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
