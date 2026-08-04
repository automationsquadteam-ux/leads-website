-- ---------------------------------------------------------------------------
-- 0014 Admin analytics views.
--
-- Same contract as the dashboard_* family from 0007/0009: security_invoker is
-- off so the view reads past the base tables' admin-only RLS, and
-- `where public.is_admin()` inside the body is the actual gate. A viewer or an
-- anonymous token selecting from any of these gets zero rows.
--
-- These are NOT the public views. Anything anon may read lives in 0013 and is
-- named public_stats_*.
--
-- Everything the analytics pages show is computed here rather than in
-- TypeScript, so a number cannot mean one thing on the dashboard and something
-- else on the analytics page.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Sending volume at three resolutions.
--
-- date_trunc keeps the bucket a real timestamp, so ordering and range filters
-- work without parsing formatted labels back into dates.
-- ---------------------------------------------------------------------------
create or replace view public.analytics_email_weekly
with (security_invoker = false) as
select
  date_trunc('week', coalesce(el.sent_at, el.created_at))::date as week_start,
  count(*)::bigint                                                                        as attempts,
  count(*) filter (where el.status in ('sent', 'delivered', 'opened', 'clicked'))::bigint as sent,
  count(*) filter (where el.status = 'bounced')::bigint                                   as bounced,
  count(*) filter (where el.status = 'failed')::bigint                                    as failed
from public.email_logs el
where public.is_admin()
  and coalesce(el.sent_at, el.created_at) >= now() - interval '52 weeks'
group by 1;

create or replace view public.analytics_email_monthly
with (security_invoker = false) as
select
  date_trunc('month', coalesce(el.sent_at, el.created_at))::date as month_start,
  count(*)::bigint                                                                        as attempts,
  count(*) filter (where el.status in ('sent', 'delivered', 'opened', 'clicked'))::bigint as sent,
  count(*) filter (where el.status = 'bounced')::bigint                                   as bounced,
  count(*) filter (where el.status = 'failed')::bigint                                    as failed
from public.email_logs el
where public.is_admin()
  and coalesce(el.sent_at, el.created_at) >= now() - interval '24 months'
group by 1;

-- ---------------------------------------------------------------------------
-- Reply rate over time.
--
-- The rate is replies received on a day over emails sent on the same day. That
-- is a rate of *activity*, not a cohort conversion a reply on Tuesday usually
-- belongs to Monday's send. Cohort attribution lives in
-- analytics_followup_conversion, which tracks the actual sequence.
-- ---------------------------------------------------------------------------
create or replace view public.analytics_reply_rate_daily
with (security_invoker = false) as
with emails as (
  select
    date_trunc('day', coalesce(el.sent_at, el.created_at))::date as day,
    count(*) filter (where el.status in ('sent', 'delivered', 'opened', 'clicked'))::bigint as sent
  from public.email_logs el
  where coalesce(el.sent_at, el.created_at) >= now() - interval '180 days'
  group by 1
),
inbound as (
  select date_trunc('day', r.received_at)::date as day, count(*)::bigint as replies
  from public.replies r
  where r.received_at >= now() - interval '180 days'
  group by 1
)
select
  coalesce(e.day, i.day)     as day,
  coalesce(e.sent, 0)        as sent,
  coalesce(i.replies, 0)     as replies,
  round(100.0 * coalesce(i.replies, 0) / nullif(coalesce(e.sent, 0), 0), 2) as reply_rate_pct
from emails e
full outer join inbound i on i.day = e.day
where public.is_admin();

-- ---------------------------------------------------------------------------
-- Funnel timing. One row; every figure in hours.
--
-- Each average only counts leads that actually passed through both ends of the
-- interval, so a lead still waiting for approval does not drag the average
-- down as if it took zero hours.
-- ---------------------------------------------------------------------------
-- FILTER binds to the AGGREGATE, never to a function wrapping it. Writing
-- `round(avg(x), 1) filter (...)` fails with 42809 "round is not an aggregate
-- function" the parentheses below put the filter on avg() and the cast on its
-- result, which is what Postgres expects.
create or replace view public.analytics_funnel_timing
with (security_invoker = false) as
select
  round((avg(extract(epoch from (p.approved_at - p.draft_ready_at)) / 3600.0)
    filter (where p.approved_at is not null and p.draft_ready_at is not null
                  and p.approved_at >= p.draft_ready_at))::numeric, 1)         as avg_approval_hours,
  round((avg(extract(epoch from (p.first_email_sent - p.approved_at)) / 3600.0)
    filter (where p.first_email_sent is not null and p.approved_at is not null
                  and p.first_email_sent >= p.approved_at))::numeric, 1)       as avg_send_delay_hours,
  round((avg(extract(epoch from (p.replied - p.first_email_sent)) / 3600.0)
    filter (where p.replied is not null and p.first_email_sent is not null
                  and p.replied >= p.first_email_sent))::numeric, 1)           as avg_reply_hours,
  round((avg(extract(epoch from (p.draft_ready_at - p.research_completed_at)) / 3600.0)
    filter (where p.draft_ready_at is not null and p.research_completed_at is not null
                  and p.draft_ready_at >= p.research_completed_at))::numeric, 1) as avg_drafting_hours,
  count(*) filter (where p.approved_at is not null and p.draft_ready_at is not null)::bigint
                                                                               as approved_sample,
  count(*) filter (where p.first_email_sent is not null and p.approved_at is not null)::bigint
                                                                               as sent_sample
from public.lead_pipeline p
where public.is_admin();

-- ---------------------------------------------------------------------------
-- Template performance.
--
-- A send records template_id only when one was chosen explicitly; otherwise the
-- campaign's template is the one that produced the copy, so coalesce covers
-- both. Templates that have never been sent still appear, with zeroes an
-- unused template is a finding, not a row to hide.
-- ---------------------------------------------------------------------------
create or replace view public.analytics_template_performance
with (security_invoker = false) as
with attributed as (
  select
    coalesce(el.template_id, c.template_id) as template_id,
    el.id                                   as log_id,
    el.lead_id,
    el.status
  from public.email_logs el
  left join public.campaigns c on c.id = el.campaign_id
)
select
  t.id                     as template_id,
  t.name                   as template_name,
  t.is_active,
  count(distinct a.log_id) filter (
    where a.status in ('sent', 'delivered', 'opened', 'clicked')
  )::bigint                as emails_sent,
  count(distinct a.log_id) filter (where a.status = 'bounced')::bigint as emails_bounced,
  count(distinct r.id)::bigint as replies_received,
  round(
    100.0 * count(distinct r.id)
    / nullif(count(distinct a.log_id) filter (
        where a.status in ('sent', 'delivered', 'opened', 'clicked')
      ), 0), 2
  )                        as reply_rate_pct
from public.templates t
left join attributed a on a.template_id = t.id
left join public.replies r on r.lead_id = a.lead_id
where public.is_admin()
group by t.id, t.name, t.is_active;

-- ---------------------------------------------------------------------------
-- Industry (niche) performance.
-- ---------------------------------------------------------------------------
create or replace view public.analytics_industry_performance
with (security_invoker = false) as
select
  coalesce(nullif(btrim(l.niche), ''), 'Unknown') as industry,
  count(distinct l.id)::bigint                    as leads,
  count(distinct el.id) filter (
    where el.status in ('sent', 'delivered', 'opened', 'clicked')
  )::bigint                                       as emails_sent,
  count(distinct r.id)::bigint                    as replies_received,
  count(distinct r.id) filter (where r.sentiment = 'positive')::bigint as positive_replies,
  round(
    100.0 * count(distinct r.id)
    / nullif(count(distinct el.id) filter (
        where el.status in ('sent', 'delivered', 'opened', 'clicked')
      ), 0), 2
  )                                               as reply_rate_pct
from public.leads l
left join public.email_logs el on el.lead_id = l.id
left join public.replies    r  on r.lead_id = l.id
where public.is_admin()
group by 1;

-- ---------------------------------------------------------------------------
-- Stage distribution (admin copy of the public one, so an admin page never has
-- to read from a public_stats_* view and blur the boundary between them).
-- ---------------------------------------------------------------------------
create or replace view public.analytics_stage_distribution
with (security_invoker = false) as
select
  p.current_stage::text as stage,
  count(*)::bigint      as lead_count,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_total
from public.lead_pipeline p
where public.is_admin()
group by p.current_stage;

-- ---------------------------------------------------------------------------
-- Follow-up conversion.
--
-- A reply is attributed to the LAST step that had been sent when it arrived —
-- the only attribution the data actually supports. `sent` counts leads that
-- reached the step, not raw messages, so the rate is "of the people who got
-- this email, how many answered".
-- ---------------------------------------------------------------------------
create or replace view public.analytics_followup_conversion
with (security_invoker = false) as
with steps as (
  select
    'initial' as step, 1 as step_order,
    count(*) filter (where p.first_email_sent is not null)::bigint as sent,
    count(*) filter (
      where p.replied is not null
        and p.first_email_sent is not null
        and p.replied >= p.first_email_sent
        and (p.followup1_sent is null or p.replied < p.followup1_sent)
    )::bigint as replies
  from public.lead_pipeline p

  union all
  select
    'followup1', 2,
    count(*) filter (where p.followup1_sent is not null)::bigint,
    count(*) filter (
      where p.replied is not null
        and p.followup1_sent is not null
        and p.replied >= p.followup1_sent
        and (p.followup2_sent is null or p.replied < p.followup2_sent)
    )::bigint
  from public.lead_pipeline p

  union all
  select
    'followup2', 3,
    count(*) filter (where p.followup2_sent is not null)::bigint,
    count(*) filter (
      where p.replied is not null
        and p.followup2_sent is not null
        and p.replied >= p.followup2_sent
    )::bigint
  from public.lead_pipeline p
)
select
  s.step,
  s.step_order,
  s.sent,
  s.replies,
  round(100.0 * s.replies / nullif(s.sent, 0), 2) as reply_rate_pct
from steps s
where public.is_admin();

-- ---------------------------------------------------------------------------
-- Draft regeneration activity "how much are we rewriting, and by what".
-- ---------------------------------------------------------------------------
create or replace view public.analytics_generation_daily
with (security_invoker = false) as
select
  date_trunc('day', v.created_at)::date as day,
  v.generated_by,
  count(*)::bigint                                        as versions_created,
  count(*) filter (where v.status = 'approved')::bigint   as approved,
  count(*) filter (where v.status = 'rejected')::bigint   as rejected
from public.email_versions v
where public.is_admin()
  and v.created_at >= now() - interval '180 days'
group by 1, 2;

-- ---------------------------------------------------------------------------
-- Grants: signed-in users only. is_admin() inside each body is the real gate.
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  foreach v in array array[
    'analytics_email_weekly',
    'analytics_email_monthly',
    'analytics_reply_rate_daily',
    'analytics_funnel_timing',
    'analytics_template_performance',
    'analytics_industry_performance',
    'analytics_stage_distribution',
    'analytics_followup_conversion',
    'analytics_generation_daily'
  ]
  loop
    execute format('revoke all on public.%I from anon', v);
    execute format('grant select on public.%I to authenticated', v);
  end loop;
end
$$;
