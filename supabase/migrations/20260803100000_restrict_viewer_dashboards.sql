-- ---------------------------------------------------------------------------
-- 0009 Restrict the dashboard views to admins.
--
-- Previously these views were guarded by public.is_app_user(), so any signed-in
-- user (including a viewer) could read aggregate lead statistics: totals,
-- per-country and per-niche breakdowns, campaign performance.
--
-- The requirement is now default-deny: only an admin sees data. What a viewer
-- is allowed to see will be specified separately, and should be added as its
-- own narrowly-scoped view rather than by widening these again.
--
-- Nothing else changes: the views keep running with owner privileges (that is
-- what lets them read past the admin-only RLS on the base tables), and the
-- authenticated grant stays is_admin() inside the view is the actual gate.
-- ---------------------------------------------------------------------------

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
where public.is_admin();

create or replace view public.dashboard_lead_status_counts
with (security_invoker = false) as
select
  l.status,
  count(*)::bigint as lead_count,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_total
from public.leads l
where public.is_admin()
group by l.status;

create or replace view public.dashboard_leads_by_country
with (security_invoker = false) as
select
  coalesce(nullif(btrim(l.country), ''), 'Unknown') as country,
  count(*)::bigint                                              as lead_count,
  count(*) filter (where l.status = 'sent')::bigint             as sent_count,
  count(*) filter (where l.status = 'replied')::bigint          as replied_count,
  count(*) filter (where l.draft_email is not null)::bigint     as drafted_count
from public.leads l
where public.is_admin()
group by 1;

create or replace view public.dashboard_leads_by_niche
with (security_invoker = false) as
select
  coalesce(nullif(btrim(l.niche), ''), 'Unknown') as niche,
  count(*)::bigint                                            as lead_count,
  count(*) filter (where l.status = 'replied')::bigint        as replied_count
from public.leads l
where public.is_admin()
group by 1;

create or replace view public.dashboard_leads_by_category
with (security_invoker = false) as
select
  coalesce(nullif(btrim(l.category), ''), 'Uncategorised') as category,
  count(*)::bigint as lead_count
from public.leads l
where public.is_admin()
group by 1;

create or replace view public.dashboard_leads_created_daily
with (security_invoker = false) as
select
  date_trunc('day', l.created_at)::date as day,
  count(*)::bigint                      as leads_added
from public.leads l
where public.is_admin()
  and l.created_at >= now() - interval '180 days'
group by 1;

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
where public.is_admin()
group by c.id, c.name, c.active, c.daily_limit, c.starts_at, c.ends_at;

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
where public.is_admin()
  and coalesce(el.sent_at, el.created_at) >= now() - interval '180 days'
group by 1;

create or replace view public.dashboard_reply_stats
with (security_invoker = false) as
select
  coalesce(r.sentiment::text, 'unclassified') as sentiment,
  count(*)::bigint                            as reply_count,
  count(*) filter (where r.is_handled)::bigint     as handled_count,
  count(*) filter (where not r.is_handled)::bigint as unhandled_count,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_replies
from public.replies r
where public.is_admin()
group by 1;

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
where public.is_admin()
  and r.received_at >= now() - interval '180 days'
group by 1;

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
where public.is_admin();

comment on view public.dashboard_overview is
  'Admin-only KPI counters. Viewer-facing views will be added separately when their scope is defined.';
