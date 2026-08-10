-- ===========================================================================
-- Schema update 24 - an archived lead is counted nowhere.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-23 first. Re-runnable throughout.
--
-- Fixes the Dead Addresses tile reading 12 against a list of 11: every count
-- queried lead_pipeline, which has no status column, while the list queries
-- leads and excludes archived by default. Rewrites public_stats_overview,
-- public_stats_stages, public_stats_leads and analytics_stage_distribution to
-- join leads and exclude archived. public_stats_leads was also a disclosure
-- fix - an archived lead could be published by name on the public page.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0034 — an archived lead is counted nowhere.
--
-- Reported: the Dead Addresses tile read 12 while the list it links to showed
-- 11. Both were right about their own query. The list resolves ids through
-- lead_pipeline and then queries `leads`, which excludes archived by default
-- (0023). Every COUNT, in the views below and in lib/data/admin-dashboard.ts,
-- queried `lead_pipeline` directly — and lead_pipeline HAS NO status COLUMN,
-- so there was nothing to exclude by. One archived dead address was the whole
-- difference.
--
-- This is the same class of bug GUIDE.md section 2 already names ("a tile must
-- link to exactly the rows it counted"), reappearing through a different door:
-- not a filter/view mismatch this time, but a table that structurally cannot
-- express the filter. `lead_pipeline` is a projection keyed on lead_id; the
-- visibility decision lives on `leads`. Anything counting pipeline rows must
-- join back to `leads` to honour it.
--
-- Archiving is the user's "this row should not exist for me any more" marker —
-- duplicate-merge losers, junk. A number that silently re-includes them
-- re-raises the question the archive already answered, which is exactly the
-- 724-vs-723 confusion that started the 2026-08-09 audit.
--
-- Every view below keeps its exact column list and order, so CREATE OR REPLACE
-- is safe (it can only append, never rename or reorder — see the gotcha table).
--
-- `pipeline_board` is deliberately NOT changed: it already exposes
-- `lead_status`, so its callers filter for themselves, and the leads list needs
-- to be able to SHOW archived rows when the Archived toggle is on.
-- `lead_stage_counts` is already correct — it has carried both figures since
-- 0027 and is the model the rest of this follows.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The public front page. This one also had a disclosure edge: an archived
--    lead was being counted in the figures anonymous visitors read.
-- ---------------------------------------------------------------------------
create or replace view public.public_stats_overview
with (security_invoker = false) as
with active as (
  select p.*
  from public.lead_pipeline p
  join public.leads l on l.id = p.lead_id
  where l.status <> 'archived'
)
select
  (select count(*) from active)::bigint                                                       as total_leads,
  (select count(*) from active where current_stage = 'need_email')::bigint                    as need_email,
  (select count(*) from active where current_stage = 'need_verification')::bigint             as need_verification,
  (select count(*) from active where current_stage = 'research')::bigint                      as researching,
  (select count(*) from active where current_stage = 'draft')::bigint                         as awaiting_draft,
  (select count(*) from active where current_stage = 'review')::bigint                        as draft_ready,
  (select count(*) from active where current_stage = 'approved')::bigint                      as approved,
  (select count(*) from active where closed is not null)::bigint                              as closed,

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
  --
  -- The email_logs figures above are deliberately NOT filtered by archive
  -- state: a message that left the building was really sent, and a reply that
  -- arrived was really received. Archiving the lead afterwards does not unsend
  -- it. Only the LEAD counts, which describe the working set, exclude archived.
  round(
    100.0 * (select count(*) from public.email_logs where status = 'bounced')
    / nullif((select count(*) from public.email_logs), 0), 2
  )                                                                                            as bounce_rate_pct,
  round(
    100.0 * (select count(*) from public.replies)
    / nullif((select count(*) from public.email_logs
               where status in ('sent', 'delivered', 'opened', 'clicked')), 0), 2
  )                                                                                            as reply_rate_pct,

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
  )                                                                                            as avg_response_hours,

  (select count(*) from active where current_stage = 'dead_email')::bigint                     as dead_email;

comment on view public.public_stats_overview is
  'PUBLIC (anon-readable). Aggregate counters and rates only - no lead identity of any kind. Lead counts exclude archived; email_logs / replies figures do not, because a sent message stays sent.';

-- ---------------------------------------------------------------------------
-- 2. Public stage distribution.
-- ---------------------------------------------------------------------------
create or replace view public.public_stats_stages
with (security_invoker = false) as
select
  p.current_stage::text as stage,
  count(*)::bigint      as lead_count,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_total
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where l.status <> 'archived'
group by p.current_stage;

comment on view public.public_stats_stages is
  'PUBLIC (anon-readable). Lead counts per pipeline stage, excluding archived.';

-- ---------------------------------------------------------------------------
-- 3. The opt-in public lead list.
--
-- This one is a disclosure fix, not just an arithmetic one: with
-- public.show_leads on, an archived lead — typically a duplicate the admin
-- deliberately took out of circulation — could be published by name on the
-- front page.
-- ---------------------------------------------------------------------------
create or replace view public.public_stats_leads
with (security_invoker = false) as
select
  l.business_name,
  l.city,
  l.country,
  coalesce(nullif(btrim(l.niche), ''), 'Unknown') as industry,
  p.current_stage::text                          as stage
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where
  l.status <> 'archived'
  and coalesce(
    (select (s.value #>> '{}')::boolean from public.settings s where s.key = 'public.show_leads'),
    false
  )
  and p.current_stage::text in (
    select jsonb_array_elements_text(
      coalesce(
        (select s.value from public.settings s where s.key = 'public.lead_stages'),
        '[]'::jsonb
      )
    )
  );

comment on view public.public_stats_leads is
  'PUBLIC (anon-readable), default-denied twice over (public.show_leads = false AND public.lead_stages = []). Archived leads are never published.';

-- ---------------------------------------------------------------------------
-- 4. Admin analytics: stage distribution.
-- ---------------------------------------------------------------------------
create or replace view public.analytics_stage_distribution
with (security_invoker = false) as
select
  p.current_stage::text as stage,
  count(*)::bigint      as lead_count,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_total
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where public.is_admin()
  and l.status <> 'archived'
group by p.current_stage;
