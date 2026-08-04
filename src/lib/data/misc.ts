import { createClient } from '@/lib/supabase/server';
import type { Campaign, EmailLog, Reply, Setting, Template } from '@/lib/supabase/database.types';

export interface CampaignRow extends Campaign {
  templateName: string | null;
  leadsTotal: number;
  leadsRemaining: number;
  emailsSent: number;
  replies: number;
}

/**
 * Campaigns plus the progress figures the cards show.
 *
 * "Remaining" counts leads assigned to the campaign that have not reached a
 * terminal state — that is what a daily-limit burndown actually needs.
 */
export async function getCampaigns(): Promise<{ rows: CampaignRow[]; error: string | null }> {
  const supabase = await createClient();

  const [campaigns, templates, stats, leadRows] = await Promise.all([
    supabase.from('campaigns').select('*').order('created_at', { ascending: false }),
    supabase.from('templates').select('id, name'),
    supabase.from('dashboard_campaign_stats').select('*'),
    supabase.from('leads').select('campaign_id, status'),
  ]);

  if (campaigns.error) return { rows: [], error: campaigns.error.message };

  const templateById = new Map((templates.data ?? []).map((t) => [t.id, t.name]));
  const statsById = new Map((stats.data ?? []).map((s) => [s.campaign_id, s]));

  const TERMINAL = new Set(['sent', 'replied', 'bounced', 'invalid', 'archived']);
  const totals = new Map<string, { total: number; remaining: number }>();
  for (const row of leadRows.data ?? []) {
    if (!row.campaign_id) continue;
    const entry = totals.get(row.campaign_id) ?? { total: 0, remaining: 0 };
    entry.total += 1;
    if (!TERMINAL.has(row.status)) entry.remaining += 1;
    totals.set(row.campaign_id, entry);
  }

  const rows: CampaignRow[] = (campaigns.data ?? []).map((campaign) => {
    const stat = statsById.get(campaign.id);
    const total = totals.get(campaign.id) ?? { total: 0, remaining: 0 };
    return {
      ...campaign,
      templateName: campaign.template_id ? (templateById.get(campaign.template_id) ?? null) : null,
      leadsTotal: total.total,
      leadsRemaining: total.remaining,
      emailsSent: stat?.emails_sent ?? 0,
      replies: stat?.replies_received ?? 0,
    };
  });

  return { rows, error: null };
}

export async function getTemplates(): Promise<{ rows: Template[]; error: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .order('created_at', { ascending: false });
  return { rows: data ?? [], error: error?.message ?? null };
}

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
