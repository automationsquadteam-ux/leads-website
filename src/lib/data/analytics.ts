import { createClient } from '@/lib/supabase/server';
import type { Views } from '@/lib/supabase/database.types';

/**
 * Analytics reads.
 *
 * Every figure comes from an `analytics_*` or `dashboard_*` view none is
 * computed here. That is the point: a view is one definition, so "reply rate"
 * cannot mean one thing on the dashboard and another on this page. The only
 * TypeScript in this file is the shape of the response.
 *
 * All of them are gated on `public.is_admin()` inside the view body, so a
 * viewer's identical query returns zero rows rather than data.
 */

export interface AnalyticsData {
  emailDaily: Views<'dashboard_email_activity_daily'>[];
  emailWeekly: Views<'analytics_email_weekly'>[];
  emailMonthly: Views<'analytics_email_monthly'>[];
  replyRate: Views<'analytics_reply_rate_daily'>[];
  timing: Views<'analytics_funnel_timing'> | null;
  templates: Views<'analytics_template_performance'>[];
  industries: Views<'analytics_industry_performance'>[];
  stages: Views<'analytics_stage_distribution'>[];
  statuses: Views<'dashboard_lead_status_counts'>[];
  followups: Views<'analytics_followup_conversion'>[];
  campaigns: Views<'dashboard_campaign_stats'>[];
  generation: Views<'analytics_generation_daily'>[];
  error: string | null;
}

export async function getAnalytics(): Promise<AnalyticsData> {
  const supabase = await createClient();

  const [
    emailDaily,
    emailWeekly,
    emailMonthly,
    replyRate,
    timing,
    templates,
    industries,
    stages,
    statuses,
    followups,
    campaigns,
    generation,
  ] = await Promise.all([
    supabase
      .from('dashboard_email_activity_daily')
      .select('*')
      .order('day', { ascending: true })
      .limit(90),
    supabase.from('analytics_email_weekly').select('*').order('week_start', { ascending: true }),
    supabase.from('analytics_email_monthly').select('*').order('month_start', { ascending: true }),
    supabase.from('analytics_reply_rate_daily').select('*').order('day', { ascending: true }).limit(90),
    supabase.from('analytics_funnel_timing').select('*').maybeSingle(),
    supabase
      .from('analytics_template_performance')
      .select('*')
      .order('reply_rate_pct', { ascending: false, nullsFirst: false })
      .limit(15),
    supabase
      .from('analytics_industry_performance')
      .select('*')
      .order('leads', { ascending: false })
      .limit(15),
    supabase.from('analytics_stage_distribution').select('*'),
    supabase
      .from('dashboard_lead_status_counts')
      .select('*')
      .order('lead_count', { ascending: false }),
    supabase.from('analytics_followup_conversion').select('*').order('step_order', { ascending: true }),
    supabase.from('dashboard_campaign_stats').select('*').order('emails_sent', { ascending: false }),
    supabase.from('analytics_generation_daily').select('*').order('day', { ascending: true }),
  ]);

  return {
    emailDaily: emailDaily.data ?? [],
    emailWeekly: emailWeekly.data ?? [],
    emailMonthly: emailMonthly.data ?? [],
    replyRate: replyRate.data ?? [],
    timing: timing.data ?? null,
    templates: templates.data ?? [],
    industries: industries.data ?? [],
    stages: stages.data ?? [],
    statuses: statuses.data ?? [],
    followups: followups.data ?? [],
    campaigns: campaigns.data ?? [],
    generation: generation.data ?? [],
    // Any one of these failing means the same thing in practice (not an admin,
    // or the migration has not been applied), so the first error is enough.
    error:
      emailDaily.error?.message ??
      stages.error?.message ??
      followups.error?.message ??
      null,
  };
}
