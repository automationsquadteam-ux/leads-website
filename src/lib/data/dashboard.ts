import { createClient } from '@/lib/supabase/server';
import type { Views } from '@/lib/supabase/database.types';

export interface DashboardData {
  overview: Views<'dashboard_overview'> | null;
  statusCounts: Views<'dashboard_lead_status_counts'>[];
  byCountry: Views<'dashboard_leads_by_country'>[];
  byNiche: Views<'dashboard_leads_by_niche'>[];
  emailActivity: Views<'dashboard_email_activity_daily'>[];
  replyActivity: Views<'dashboard_reply_activity_daily'>[];
  replyStats: Views<'dashboard_reply_stats'>[];
  campaigns: Views<'dashboard_campaign_stats'>[];
  error: string | null;
}

/**
 * Everything the dashboard needs, from the dashboard_* views only.
 *
 * Those views are aggregate-only and readable by both roles, which is what
 * makes this page safe to serve to a viewer without any branching.
 */
export async function getDashboardData(): Promise<DashboardData> {
  const supabase = await createClient();

  const [overview, statusCounts, byCountry, byNiche, emailActivity, replyActivity, replyStats, campaigns] =
    await Promise.all([
      supabase.from('dashboard_overview').select('*').maybeSingle(),
      supabase.from('dashboard_lead_status_counts').select('*').order('lead_count', { ascending: false }),
      supabase.from('dashboard_leads_by_country').select('*').order('lead_count', { ascending: false }).limit(10),
      supabase.from('dashboard_leads_by_niche').select('*').order('lead_count', { ascending: false }).limit(10),
      supabase.from('dashboard_email_activity_daily').select('*').order('day', { ascending: true }).limit(30),
      supabase.from('dashboard_reply_activity_daily').select('*').order('day', { ascending: true }).limit(30),
      supabase.from('dashboard_reply_stats').select('*').order('reply_count', { ascending: false }),
      supabase.from('dashboard_campaign_stats').select('*').order('campaign_name', { ascending: true }),
    ]);

  return {
    overview: overview.data ?? null,
    statusCounts: statusCounts.data ?? [],
    byCountry: byCountry.data ?? [],
    byNiche: byNiche.data ?? [],
    emailActivity: emailActivity.data ?? [],
    replyActivity: replyActivity.data ?? [],
    replyStats: replyStats.data ?? [],
    campaigns: campaigns.data ?? [],
    error: overview.error?.message ?? null,
  };
}

/** Emails attempted today, for the "Emails Today" metric card. */
export async function getEmailsToday(): Promise<number> {
  const supabase = await createClient();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data } = await supabase
    .from('dashboard_email_activity_daily')
    .select('day, sent')
    .gte('day', startOfDay.toISOString().slice(0, 10));

  return (data ?? []).reduce((total, row) => total + (row.sent ?? 0), 0);
}
