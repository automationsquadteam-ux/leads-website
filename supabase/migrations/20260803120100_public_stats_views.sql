-- ---------------------------------------------------------------------------
-- 0013 — Public statistics: the ONLY objects in this schema readable by anon.
--
-- READ THIS BEFORE TOUCHING ANY VIEW BELOW.
--
-- Migrations 0007 and 0009 established that no anonymous token can read
-- anything: every table has RLS with admin-only policies, and every dashboard_*
-- view carries `where public.is_admin()`. That invariant is deliberately broken
-- here, for these five views and nothing else, because the product requires a
-- login-free statistics page.
--
-- The rules these views live under:
--
--   * Aggregates only. Never a lead id, business name, website, email address,
--     phone number, city, note, research paragraph, draft, subject line or
--     reply body. Not even indirectly — a count grouped by business_name is a
--     list of business names with extra steps.
--   * Campaign NAMES are ours, not the prospects'. They are the one identifier
--     that appears here, and only because "Campaign Performance" is explicitly
--     part of the public brief.
--   * Column lists are written out. `select *` over a base table is how a
--     column added six months from now quietly becomes public.
--   * No `where public.is_admin()`: that is what makes them readable, and it is
--     why every column had to be justified above.
--
-- Adding a column to any view in this file is a disclosure decision. If you are
-- not certain it is aggregate-only, it does not belong here — put it in a
-- dashboard_* view instead, where is_admin() applies.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Headline counters + rates. One row.
-- ---------------------------------------------------------------------------
create or replace view public.public_stats_overview
with (security_invoker = false) as
select
  (select count(*) from public.lead_pipeline)::bigint                                          as total_leads,
  (select count(*) from public.lead_pipeline where current_stage = 'need_email')::bigint       as need_email,
  (select count(*) from public.lead_pipeline where current_stage = 'need_verification')::bigint as need_verification,
  (select count(*) from public.lead_pipeline where current_stage = 'research')::bigint         as researching,
  (select count(*) from public.lead_pipeline where current_stage = 'draft')::bigint            as awaiting_draft,
  (select count(*) from public.lead_pipeline where current_stage = 'review')::bigint           as draft_ready,
  (select count(*) from public.lead_pipeline where current_stage = 'approved')::bigint         as approved,
  (select count(*) from public.lead_pipeline where closed is not null)::bigint                 as closed,

  (select count(*) from public.email_logs
    where status in ('sent', 'delivered', 'opened', 'clicked'))::bigint                        as emails_sent,
  (select count(*) from public.email_logs)::bigint                                             as emails_attempted,
  (select count(*) from public.email_logs where status = 'bounced')::bigint                    as emails_bounced,
  (select count(*) from public.email_logs where email_type = 'initial'
     and status in ('sent', 'delivered', 'opened', 'clicked'))::bigint                         as initial_sent,
  (select count(*) from public.email_logs where email_type = 'followup1'
     and status in ('sent', 'delivered', 'opened', 'clicked'))::bigint                         as followup1_sent,
  (select count(*) from public.email_logs where email_type = 'followup2'
     and status in ('sent', 'delivered', 'opened', 'clicked'))::bigint                         as followup2_sent,

  (select count(*) from public.replies)::bigint                                                as replies,
  (select count(*) from public.replies where sentiment = 'positive')::bigint                   as positive_replies,
  (select count(*) from public.replies where sentiment = 'negative')::bigint                   as negative_replies,
  (select count(*) from public.replies where sentiment = 'neutral')::bigint                    as neutral_replies,

  -- Bounce rate is measured against every attempt, reply rate against
  -- successful sends: you cannot get a reply to a message that never left.
  round(
    100.0 * (select count(*) from public.email_logs where status = 'bounced')
    / nullif((select count(*) from public.email_logs), 0), 2
  )                                                                                            as bounce_rate_pct,
  round(
    100.0 * (select count(*) from public.replies)
    / nullif((select count(*) from public.email_logs
               where status in ('sent', 'delivered', 'opened', 'clicked')), 0), 2
  )                                                                                            as reply_rate_pct,

  -- Average hours between the message that prompted a reply and the reply
  -- itself. Prefers the log the reply is explicitly linked to; otherwise the
  -- most recent send to that lead before the reply arrived.
  (
    select round(avg(extract(epoch from (r.received_at - sent.sent_at)) / 3600.0)::numeric, 1)
    from public.replies r
    join lateral (
      select el.sent_at
      from public.email_logs el
      where el.sent_at is not null
        and (
          el.id = r.email_log_id
          or (r.email_log_id is null and el.lead_id = r.lead_id and el.sent_at <= r.received_at)
        )
      order by el.sent_at desc
      limit 1
    ) sent on true
  )                                                                                            as avg_response_hours;

comment on view public.public_stats_overview is
  'PUBLIC (anon-readable). Aggregate counters and rates only — no lead identity of any kind.';

-- ---------------------------------------------------------------------------
-- Stage distribution — the funnel chart.
-- ---------------------------------------------------------------------------
create or replace view public.public_stats_stages
with (security_invoker = false) as
select
  p.current_stage::text as stage,
  count(*)::bigint      as lead_count,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_total
from public.lead_pipeline p
group by p.current_stage;

comment on view public.public_stats_stages is
  'PUBLIC (anon-readable). Lead counts per pipeline stage.';

-- ---------------------------------------------------------------------------
-- Status distribution. Mirrors dashboard_lead_status_counts without the
-- is_admin() gate — a bare enum label and a count.
-- ---------------------------------------------------------------------------
create or replace view public.public_stats_statuses
with (security_invoker = false) as
select
  l.status::text   as status,
  count(*)::bigint as lead_count
from public.leads l
group by l.status;

comment on view public.public_stats_statuses is
  'PUBLIC (anon-readable). Lead counts per status enum value.';

-- ---------------------------------------------------------------------------
-- Daily sending / reply activity, 90 days. Feeds the public trend charts.
--
-- Emails and replies are aggregated separately and then full-joined on the day,
-- so a day with replies but no sends (or the reverse) still appears.
-- ---------------------------------------------------------------------------
create or replace view public.public_stats_activity_daily
with (security_invoker = false) as
with emails as (
  select
    date_trunc('day', coalesce(el.sent_at, el.created_at))::date as day,
    count(*) filter (where el.status in ('sent', 'delivered', 'opened', 'clicked'))::bigint as emails_sent,
    count(*) filter (where el.status = 'bounced')::bigint as emails_bounced
  from public.email_logs el
  where coalesce(el.sent_at, el.created_at) >= now() - interval '90 days'
  group by 1
),
inbound as (
  select
    date_trunc('day', r.received_at)::date as day,
    count(*)::bigint                                          as replies,
    count(*) filter (where r.sentiment = 'positive')::bigint  as positive_replies,
    count(*) filter (where r.sentiment = 'negative')::bigint  as negative_replies
  from public.replies r
  where r.received_at >= now() - interval '90 days'
  group by 1
)
select
  coalesce(e.day, i.day)            as day,
  coalesce(e.emails_sent, 0)        as emails_sent,
  coalesce(e.emails_bounced, 0)     as emails_bounced,
  coalesce(i.replies, 0)            as replies,
  coalesce(i.positive_replies, 0)   as positive_replies,
  coalesce(i.negative_replies, 0)   as negative_replies
from emails e
full outer join inbound i on i.day = e.day;

comment on view public.public_stats_activity_daily is
  'PUBLIC (anon-readable). Per-day send and reply counts for the last 90 days.';

-- ---------------------------------------------------------------------------
-- Campaign performance. Campaign names are our own labels, not prospect data.
-- Deliberately omits daily_limit and the schedule window — operational detail
-- with no reason to be public.
-- ---------------------------------------------------------------------------
create or replace view public.public_stats_campaigns
with (security_invoker = false) as
select
  c.name           as campaign_name,
  c.active,
  count(distinct l.id)::bigint as leads_assigned,
  count(distinct el.id) filter (
    where el.status in ('sent', 'delivered', 'opened', 'clicked')
  )::bigint                    as emails_sent,
  count(distinct el.id) filter (where el.status = 'bounced')::bigint as emails_bounced,
  count(distinct r.id)::bigint as replies_received,
  round(
    100.0 * count(distinct r.id)
    / nullif(count(distinct el.id) filter (
        where el.status in ('sent', 'delivered', 'opened', 'clicked')
      ), 0), 2
  )                            as reply_rate_pct,
  round(
    100.0 * count(distinct el.id) filter (where el.status = 'bounced')
    / nullif(count(distinct el.id), 0), 2
  )                            as bounce_rate_pct
from public.campaigns c
left join public.leads      l  on l.campaign_id = c.id
left join public.email_logs el on el.campaign_id = c.id
left join public.replies    r  on r.lead_id = l.id
group by c.id, c.name, c.active;

comment on view public.public_stats_campaigns is
  'PUBLIC (anon-readable). Per-campaign counts and rates. Campaign names are ours; no prospect data.';

-- ---------------------------------------------------------------------------
-- Grants.
--
-- This is the exception to "anon gets nothing". It is limited to these five
-- views; every table and every dashboard_* view stays closed.
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  foreach v in array array[
    'public_stats_overview',
    'public_stats_stages',
    'public_stats_statuses',
    'public_stats_activity_daily',
    'public_stats_campaigns'
  ]
  loop
    execute format('grant select on public.%I to anon, authenticated', v);
    -- Read-only, categorically: a view is not updatable through a grant we
    -- never issue, and stating it makes the intent unmistakable.
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', v);
  end loop;
end
$$;
