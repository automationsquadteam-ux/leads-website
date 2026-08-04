-- ---------------------------------------------------------------------------
-- 0007 Dashboard views (the viewer role's ONLY window onto the data).
--
-- Why views instead of RLS policies on the base tables:
--   RLS is row-level. It cannot say "this role may read leads.status but not
--   leads.email". Viewers therefore get *no* row access to leads / templates /
--   replies / email_logs / settings at all, and read these aggregate views
--   instead.
--
--   Each view is created WITHOUT security_invoker, so it executes with the
--   privileges of its owner and bypasses the base tables' RLS. That is exactly
--   what makes them readable by viewers which is also why every view below
--   must be audited for what it exposes. The rules:
--     * no email addresses, no phone numbers
--     * no research, personalization, drafts, subject lines or reply bodies
--     * counts, rates and non-sensitive identity fields only
--
--   `where public.is_app_user()` keeps anonymous/profile-less tokens out even
--   if a GRANT is ever loosened by mistake.
-- ---------------------------------------------------------------------------

-- Headline counters -----------------------------------------------------------
create or replace view public.dashboard_overview
with (security_invoker = false) as
select
  count(*)::bigint                                                          as total_leads,
  count(*) filter (where l.status = 'new')::bigint                          as new_leads,
  count(*) filter (where l.status = 'researching')::bigint                  as researching_leads,
  count(*) filter (where l.status in ('ready', 'approved'))::bigint         as ready_leads,
  count(*) filter (where l.status = 'sent')::bigint                         as sent_leads,
  count(*) filter (where l.status = 'replied')::bigint                      as replied_leads,
  count(*) filter (where l.status = 'bounced')::bigint                      as bounced_leads,
  count(*) filter (where l.status in ('invalid', 'archived'))::bigint       as excluded_leads,
  count(*) filter (where l.research_summary is not null)::bigint            as leads_with_research,
  count(*) filter (where l.draft_email is not null)::bigint                 as leads_with_draft,
  count(*) filter (where l.next_followup_at is not null
                     and l.next_followup_at <= now())::bigint               as followups_due,
  count(distinct l.country)::bigint                                         as countries_covered,
  count(distinct l.niche)::bigint                                           as niches_covered
from public.leads l
where public.is_app_user();

comment on view public.dashboard_overview is
  'Single-row KPI counters. Safe for viewers: aggregates only.';

-- Pipeline breakdown ----------------------------------------------------------
create or replace view public.dashboard_lead_status_counts
with (security_invoker = false) as
select
  l.status,
  count(*)::bigint as lead_count,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_total
from public.leads l
where public.is_app_user()
group by l.status;

-- Geography -------------------------------------------------------------------
create or replace view public.dashboard_leads_by_country
with (security_invoker = false) as
select
  coalesce(nullif(btrim(l.country), ''), 'Unknown') as country,
  count(*)::bigint                                              as lead_count,
  count(*) filter (where l.status = 'sent')::bigint             as sent_count,
  count(*) filter (where l.status = 'replied')::bigint          as replied_count,
  count(*) filter (where l.draft_email is not null)::bigint     as drafted_count
from public.leads l
where public.is_app_user()
group by 1;

-- Vertical --------------------------------------------------------------------
create or replace view public.dashboard_leads_by_niche
with (security_invoker = false) as
select
  coalesce(nullif(btrim(l.niche), ''), 'Unknown') as niche,
  count(*)::bigint                                            as lead_count,
  count(*) filter (where l.status = 'replied')::bigint        as replied_count
from public.leads l
where public.is_app_user()
group by 1;

-- Qualification bucket --------------------------------------------------------
create or replace view public.dashboard_leads_by_category
with (security_invoker = false) as
select
  coalesce(nullif(btrim(l.category), ''), 'Uncategorised') as category,
  count(*)::bigint as lead_count
from public.leads l
where public.is_app_user()
group by 1;

-- Intake over time ------------------------------------------------------------
create or replace view public.dashboard_leads_created_daily
with (security_invoker = false) as
select
  date_trunc('day', l.created_at)::date as day,
  count(*)::bigint                      as leads_added
from public.leads l
where public.is_app_user()
  and l.created_at >= now() - interval '180 days'
group by 1;

-- Campaign performance --------------------------------------------------------
create or replace view public.dashboard_campaign_stats
with (security_invoker = false) as
select
  c.id            as campaign_id,
  c.name          as campaign_name,
  c.active,
  c.daily_limit,
  c.starts_at,
  c.ends_at,
  count(distinct l.id)::bigint                                             as leads_assigned,
  count(distinct el.id) filter (
    where el.status in ('sent', 'delivered', 'opened', 'clicked')
  )::bigint                                                                as emails_sent,
  count(distinct el.id) filter (where el.status = 'bounced')::bigint       as emails_bounced,
  count(distinct el.id) filter (where el.status = 'failed')::bigint        as emails_failed,
  count(distinct r.id)::bigint                                             as replies_received,
  round(
    100.0 * count(distinct r.id)
    / nullif(count(distinct el.id) filter (
        where el.status in ('sent', 'delivered', 'opened', 'clicked')
      ), 0),
    2
  )                                                                        as reply_rate_pct,
  round(
    100.0 * count(distinct el.id) filter (where el.status = 'bounced')
    / nullif(count(distinct el.id), 0),
    2
  )                                                                        as bounce_rate_pct
from public.campaigns c
left join public.leads      l  on l.campaign_id = c.id
left join public.email_logs el on el.campaign_id = c.id
left join public.replies    r  on r.lead_id = l.id
where public.is_app_user()
group by c.id, c.name, c.active, c.daily_limit, c.starts_at, c.ends_at;

comment on view public.dashboard_campaign_stats is
  'Per-campaign counts and rates. No recipient identities.';

-- Sending activity ------------------------------------------------------------
create or replace view public.dashboard_email_activity_daily
with (security_invoker = false) as
select
  date_trunc('day', coalesce(el.sent_at, el.created_at))::date          as day,
  count(*)::bigint                                                      as attempts,
  count(*) filter (where el.status in ('sent', 'delivered',
                                       'opened', 'clicked'))::bigint    as sent,
  count(*) filter (where el.status = 'delivered')::bigint               as delivered,
  count(*) filter (where el.status = 'opened')::bigint                  as opened,
  count(*) filter (where el.status = 'bounced')::bigint                 as bounced,
  count(*) filter (where el.status = 'failed')::bigint                  as failed
from public.email_logs el
where public.is_app_user()
  and coalesce(el.sent_at, el.created_at) >= now() - interval '180 days'
group by 1;

-- Reply statistics ------------------------------------------------------------
create or replace view public.dashboard_reply_stats
with (security_invoker = false) as
select
  coalesce(r.sentiment::text, 'unclassified') as sentiment,
  count(*)::bigint                            as reply_count,
  count(*) filter (where r.is_handled)::bigint     as handled_count,
  count(*) filter (where not r.is_handled)::bigint as unhandled_count,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_replies
from public.replies r
where public.is_app_user()
group by 1;

comment on view public.dashboard_reply_stats is
  'Reply counts by sentiment. Deliberately excludes replies.reply_text.';

create or replace view public.dashboard_reply_activity_daily
with (security_invoker = false) as
select
  date_trunc('day', r.received_at)::date               as day,
  count(*)::bigint                                     as replies,
  count(*) filter (where r.sentiment = 'positive')::bigint    as positive,
  count(*) filter (where r.sentiment = 'neutral')::bigint     as neutral,
  count(*) filter (where r.sentiment = 'negative')::bigint    as negative,
  count(*) filter (where r.sentiment = 'unsubscribe')::bigint as unsubscribe
from public.replies r
where public.is_app_user()
  and r.received_at >= now() - interval '180 days'
group by 1;

-- Non-sensitive per-lead list -------------------------------------------------
-- Lets a viewer dashboard show "recent activity" without leaking anything.
-- Column list is allow-listed on purpose: adding a column here is a security
-- decision, so `select *` is never used.
create or replace view public.dashboard_leads_safe
with (security_invoker = false) as
select
  l.id,
  l.business_name,
  l.city,
  l.country,
  l.niche,
  l.category,
  l.status,
  l.campaign_id,
  l.created_at,
  l.last_contacted_at,
  (l.research_summary is not null) as has_research,
  (l.draft_email is not null)      as has_draft
from public.leads l
where public.is_app_user();

comment on view public.dashboard_leads_safe is
  'Per-lead list with contact details, research and drafts stripped. Safe for viewers.';

-- ---------------------------------------------------------------------------
-- Grants: signed-in users only. Never anon.
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  foreach v in array array[
    'dashboard_overview',
    'dashboard_lead_status_counts',
    'dashboard_leads_by_country',
    'dashboard_leads_by_niche',
    'dashboard_leads_by_category',
    'dashboard_leads_created_daily',
    'dashboard_campaign_stats',
    'dashboard_email_activity_daily',
    'dashboard_reply_stats',
    'dashboard_reply_activity_daily',
    'dashboard_leads_safe'
  ]
  loop
    execute format('revoke all on public.%I from anon', v);
    execute format('grant select on public.%I to authenticated', v);
  end loop;
end
$$;
