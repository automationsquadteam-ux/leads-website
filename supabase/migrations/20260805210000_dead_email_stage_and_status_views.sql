-- ---------------------------------------------------------------------------
-- 0027 — Use the `dead_email` stage, and retire the last two views that report
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
  'Derives current_stage as the FIRST unmet gate, so a stage names what is blocking the lead. Sent leads stay pinned. The ONE definition — do not re-implement in application code.';

-- ---------------------------------------------------------------------------
-- The NEXT STEP for both is identical: go and find an address. So
-- pipeline_next_step gains no value — two stages, one action, which is the
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
-- said `initial_sent 94` and the page it opened showed 93 — one of the two
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
-- 3. The last two views reporting leads.status are retired.
--
-- Since 0025 the stage is the truth and leads.status is an inbound label from
-- the sheet. These two published the label: `dashboard_lead_status_counts` fed
-- a Lead-status table on /analytics and `public_stats_statuses` a breakdown on
-- the public page — each sitting next to a stage chart that answered the same
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
