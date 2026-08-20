-- ===========================================================================
-- Schema update 17 - use the dead_email stage; retire the status views.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
--
-- ***** RUN UPDATE 16 FIRST AND LET IT COMMIT. *****
--
-- What it does:
--   1. compute_pipeline_stage returns 'dead_email' for a proven-dead address,
--      so need_email means "no address" and the stage filter finally matches
--      the dashboard tiles: 307 and 19 instead of one bucket of 326.
--   2. Adds public.lead_stage_counts, which counts stages with and without
--      archived leads. The filter panel said initial_sent 94 while the page it
--      opened showed 93, because one of the two archived leads sits there.
--   3. Adds a dead_email counter to public_stats_overview. Its need_email
--      counter reads the stage, so the split would otherwise have dropped 19
--      leads off the public page without a trace.
--   4. Drops dashboard_lead_status_counts, public_stats_statuses and
--      dashboard_leads_safe - the last views reporting leads.status, which has
--      been an inbound sheet label rather than the truth since 0025.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0027 ,Use the `dead_email` stage, and retire the last two views that report
--        leads.status.
--
-- **Run 0026 first and let it commit.** This script uses the enum value that
-- one adds; running them together fails with "unsafe use of new value".
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. A dead address is its own stage.
--
-- Order inside the gates matters. `not email_found` comes first because a lead
-- with no address has nothing that could have been proved dead; `invalid` then
-- catches the ones that had an address and lost it.
-- ---------------------------------------------------------------------------
create or replace function public.compute_pipeline_stage(p public.lead_pipeline)
returns public.pipeline_stage
language sql
immutable
as $$
  select (case
    -- Facts, newest first. These cannot be undone by a later gate failing.
    when p.closed           is not null then 'closed'
    when p.replied          is not null then 'replied'
    when p.followup2_sent   is not null then 'followup2_sent'
    when p.followup1_sent   is not null then 'followup1_sent'
    when p.first_email_sent is not null then 'initial_sent'

    -- Gates, in the order they have to be cleared. The FIRST unmet one wins.
    when not p.email_found                        then 'need_email'
    when p.email_verification_status = 'invalid'  then 'dead_email'
    when not p.email_verified                     then 'need_verification'
    when not p.research_complete                  then 'research'
    when not p.draft_ready                        then 'draft'
    when not p.approved                           then 'review'
    else 'approved'
  end)::public.pipeline_stage;
$$;

comment on function public.compute_pipeline_stage(public.lead_pipeline) is
  'Derives current_stage as the FIRST unmet gate, so a stage names what is blocking the lead. Sent leads stay pinned. The ONE definition ,do not re-implement in application code.';

-- ---------------------------------------------------------------------------
-- The NEXT STEP for both is identical: go and find an address. So
-- pipeline_next_step gains no value ,two stages, one action, which is the
-- honest answer and saves a second enum migration.
-- ---------------------------------------------------------------------------
create or replace function public.compute_next_step(p public.lead_pipeline)
returns public.pipeline_next_step
language sql
stable
as $$
  select (case
    when p.closed         is not null then 'complete'
    when p.replied        is not null then 'close_workflow'
    when p.followup2_sent is not null then 'close_workflow'
    when p.followup1_sent is not null then
      case when p.followup2_due is not null and p.followup2_due <= now()
           then 'send_followup2' else 'await_followup2' end
    when p.first_email_sent is not null then
      case when p.followup1_due is not null and p.followup1_due <= now()
           then 'send_followup1' else 'await_followup1' end

    when not p.email_found                       then 'need_email'
    when p.email_verification_status = 'invalid' then 'need_email'
    when not p.email_verified                    then 'need_verification'
    when not p.research_complete                 then 'research_lead'
    when not p.draft_ready                       then 'generate_draft'
    when not p.approved                          then 'approve_draft'
    else 'send_initial_email'
  end)::public.pipeline_next_step;
$$;

-- Re-derive the stored column. current_stage is written by the BEFORE trigger,
-- so a no-op UPDATE is what moves the 19 dead addresses onto their new stage.
update public.lead_pipeline set updated_at = now();

-- ---------------------------------------------------------------------------
-- 2. Stage counts for the leads list, honouring the archived filter.
--
-- The filter panel read `analytics_stage_distribution`, which counts every
-- pipeline row. The leads list hides archived leads by default. So the facet
-- said `initial_sent 94` and the page it opened showed 93 ,one of the two
-- archived leads sits at that stage.
--
-- Both figures, from one view, so the number on the chip and the number of rows
-- you get are the same question asked once. analytics_stage_distribution stays
-- as it is: /analytics is reporting on everything, deliberately.
-- ---------------------------------------------------------------------------
create or replace view public.lead_stage_counts
with (security_invoker = false) as
select
  p.current_stage::text                                        as stage,
  count(*) filter (where l.status <> 'archived')::bigint       as lead_count,
  count(*)::bigint                                             as lead_count_all
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where public.is_admin()
group by p.current_stage;

comment on view public.lead_stage_counts is
  'Stage counts for the leads filter panel. lead_count excludes archived (what the default list shows); lead_count_all includes them.';

grant select on public.lead_stage_counts to authenticated;


-- ---------------------------------------------------------------------------
-- 4. The public overview counts the new stage.
--
-- Its `need_email` counter reads `current_stage = 'need_email'`, so splitting
-- dead addresses out silently dropped 19 leads from every stage counter on the
-- public page. The whole body is restated because CREATE OR REPLACE VIEW needs
-- an identical leading column list; only the last column is new.
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
  )                                                                                            as avg_response_hours,

  -- Appended. CREATE OR REPLACE can only add columns at the END, so anything
  -- new goes here.
  (select count(*) from public.lead_pipeline where current_stage = 'dead_email')::bigint as dead_email;

comment on view public.public_stats_overview is
  'PUBLIC (anon-readable). Aggregate counters and rates only - no lead identity of any kind.';

-- ---------------------------------------------------------------------------
-- 5. The last two views reporting leads.status are retired.
--
-- Since 0025 the stage is the truth and leads.status is an inbound label from
-- the sheet. These two published the label: `dashboard_lead_status_counts` fed
-- a Lead-status table on /analytics and `public_stats_statuses` a breakdown on
-- the public page ,each sitting next to a stage chart that answered the same
-- question correctly. 472 leads read `researching` while 695 have research
-- complete, so the two charts contradicted each other on screen.
--
-- `dashboard_leads_safe` goes with them: nothing has ever read it, and the
-- viewer role it was shaped for still has no scope. A future viewer feature
-- should start from a deliberate decision, not from this guess.
-- ---------------------------------------------------------------------------
drop view if exists public.dashboard_lead_status_counts;
drop view if exists public.public_stats_statuses;
drop view if exists public.dashboard_leads_safe;
