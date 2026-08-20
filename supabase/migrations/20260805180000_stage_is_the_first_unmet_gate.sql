-- ---------------------------------------------------------------------------
-- 0025 ,The stage names what is BLOCKING a lead, not the last thing that
--        happened to it. Plus the cleanup that follows from it.
--
-- Both derivations were ordered newest-fact-first, so the CASE returned the
-- LAST gate that had been satisfied. That reads well until the gates stop being
-- satisfied in order, which is exactly what this dataset does ,the upstream
-- pipeline researches and drafts for leads it never found an address for:
--
--     leads with no email address                307
--     ...of which reading 'need_email'             2
--     ...with research already done              304
--     ...with a draft awaiting review            159
--     ...with an APPROVED draft                   62
--
-- So 305 leads with nowhere to send anything read "Draft Ready" or "Approved",
-- and the queues built on those stages promised work that could never ship:
-- Approval Queue 351, of which 172 were unsendable; Ready to Send 111, of which
-- 96 were unsendable.
--
-- Reordered to FIRST UNMET GATE. A stage now answers "what is stopping this
-- lead", which is the question every queue on the dashboard is really asking.
--
-- Facts stay pinned above the gates. A lead that has been emailed reads
-- 'initial_sent' even if its address later goes dead, because the email did
-- leave and no reordering can un-send it.
--
-- Nothing is destroyed. The 497 leads that move backwards keep their research,
-- their drafts and their approvals; the moment an address is found and verified
-- they arrive at 'approved' with the work already done.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The two derivations. They must stay in step: compute_next_step is the
--    same ladder, answering "so what do I do about it".
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
    when p.email_verification_status = 'invalid'  then 'need_email'
    when not p.email_verified                     then 'need_verification'
    when not p.research_complete                  then 'research'
    when not p.draft_ready                        then 'draft'
    when not p.approved                           then 'review'
    else 'approved'
  end)::public.pipeline_stage;
$$;

comment on function public.compute_pipeline_stage(public.lead_pipeline) is
  'Derives current_stage as the FIRST unmet gate, so a stage names what is blocking the lead. Sent leads stay pinned. The ONE definition ,do not re-implement in application code.';

-- STABLE, not IMMUTABLE: the follow-up arms compare a due date against now().
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

comment on function public.compute_next_step(public.lead_pipeline) is
  'The same ladder as compute_pipeline_stage, answering what to DO about the first unmet gate. STABLE because the follow-up arms compare against now().';

-- ---------------------------------------------------------------------------
-- 2. A verification result decides the flag, in every direction.
--
-- The rule used to be one-way-ish: 'valid' set the flag true, 'invalid' set it
-- false, and everything else LEFT IT ALONE. So moving a lead from Verified to
-- Catch-all or Unknown kept email_verified = true, and the lead stayed in Ready
-- to Send on the strength of a verdict that had just been withdrawn. With the
-- five-state control on the lead page that stops being a corner case.
--
-- Now: the flag simply IS "the verifier said valid". Nothing else counts,
-- which is what the column has always claimed to mean.
--
-- The human branch below is unchanged: ticking the flag by hand still records a
-- real 'manual' verdict, and unticking returns to 'unverified' rather than to
-- 'invalid', because "no longer sure" is not "proved dead".
-- ---------------------------------------------------------------------------
create or replace function public.set_pipeline_stage()
returns trigger
language plpgsql
as $$
declare
  status_changed boolean;
  flag_changed   boolean;
begin
  if tg_op = 'INSERT' then
    status_changed := true;
    flag_changed := false;
  else
    status_changed := new.email_verification_status is distinct from old.email_verification_status;
    flag_changed   := new.email_verified is distinct from old.email_verified;
  end if;

  if status_changed then
    new.email_verified := (new.email_verification_status = 'valid');

  elsif flag_changed then
    if new.email_verified and new.email_verification_status <> 'valid' then
      new.email_verification_status := 'valid';
      new.email_verification_source := 'manual';
      new.email_checked_at := now();

    elsif not new.email_verified and new.email_verification_status = 'valid' then
      new.email_verification_status := 'unverified';
      new.email_verification_source := null;
      new.email_checked_at := null;
    end if;
  end if;

  new.current_stage := public.compute_pipeline_stage(new);

  if new.email_found       and new.email_found_at        is null then new.email_found_at        := now(); end if;
  if new.email_verified    and new.email_verified_at     is null then new.email_verified_at     := now(); end if;
  if new.research_complete and new.research_completed_at is null then new.research_completed_at := now(); end if;
  if new.draft_ready       and new.draft_ready_at        is null then new.draft_ready_at        := now(); end if;
  if new.approved          and new.approved_at           is null then new.approved_at           := now(); end if;

  return new;
end;
$$;

comment on function public.set_pipeline_stage() is
  'Derives current_stage and keeps email_verified in step with email_verification_status in BOTH directions. A verifier result decides the flag outright (verified means valid, nothing else); a human ticking the flag records a manual verdict.';

-- ---------------------------------------------------------------------------
-- 3. leads.status stops deciding whether a lead is approved.
--
-- `approved` was OR'd in from `status in ('approved','sending','sent','replied')`,
-- which made a label somebody types a second source of truth for a gate that
-- email_versions already owns. That is the coupling behind the whole
-- two-definitions-of-approved saga (0018, 0022): the flag said yes, the active
-- version still said draft, and the sender refused work the dashboard had
-- promised. sync_pipeline_from_version() is the one writer now.
--
-- The `was_sent` half STAYS. The sheet's "Email sent status" column reaches the
-- CRM as status='sent', and for the 89 leads n8n emailed that is the only
-- record the send ever happened ,there is no email_logs row. Removing it would
-- lose them.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_lead()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  has_email    boolean := new.email is not null and length(btrim(new.email)) > 0;

  sheet_says_researched boolean := new.researched_at is not null;

  has_research_fields boolean := (
       coalesce(length(btrim(new.research_summary)), 0) > 0
    or coalesce(length(btrim(new.website_observations)), 0) > 0
    or coalesce(length(btrim(new.automation_opportunities)), 0) > 0
    or coalesce(length(btrim(new.ai_chatbot_opportunities)), 0) > 0
    or coalesce(length(btrim(new.website_improvement_opportunities)), 0) > 0
    or coalesce(length(btrim(new.outreach_angle)), 0) > 0
    or coalesce(length(btrim(new.interesting_facts)), 0) > 0
  );

  has_research boolean := sheet_says_researched or has_research_fields;
  has_draft    boolean := new.draft_email is not null and length(btrim(new.draft_email)) > 0;

  -- Deliberately NOT is_approved. See the header.
  was_sent     boolean := new.status in ('sent', 'replied');
  d1           integer := public.setting_int('outreach.followup1_delay_days', 7);

  sheet_sent   timestamptz := new.last_contacted_at;
  assumed_sent timestamptz := coalesce(new.last_contacted_at, new.imported_at, now());

  crm_sent boolean := exists (
    select 1 from public.email_logs el
     where el.lead_id = new.id and el.sent_at is not null
  );
  sheet_wins boolean := was_sent and sheet_sent is not null and not crm_sent;
begin
  insert into public.lead_pipeline as p (
    lead_id, email_found, research_complete, draft_ready,
    first_email_sent, followup1_due
  )
  values (
    new.id, has_email, has_research, has_draft,
    case when was_sent then assumed_sent else null end,
    case when was_sent then assumed_sent + make_interval(days => d1) else null end
  )
  on conflict (lead_id) do update
    set email_found       = p.email_found       or excluded.email_found,
        research_complete = p.research_complete or excluded.research_complete,
        draft_ready       = p.draft_ready       or excluded.draft_ready,

        first_email_sent =
          case when sheet_wins then sheet_sent
               else coalesce(p.first_email_sent, excluded.first_email_sent) end,

        followup1_due =
          case when sheet_wins and p.followup1_sent is null
               then sheet_sent + make_interval(days => d1)
               else coalesce(p.followup1_due, excluded.followup1_due) end;

  return null;
end;
$$;

comment on function public.sync_pipeline_from_lead() is
  'Projects lead columns onto the pipeline. Research is complete when the sheet says so (researched_at) OR when any research field is filled. Does NOT touch `approved` ,email_versions owns that.';

-- ---------------------------------------------------------------------------
-- 4. Recompute the stored stage.
--
-- current_stage is a STORED column filled by the BEFORE trigger, so changing
-- the function above does nothing to the 701 rows already written. A no-op
-- UPDATE fires lead_pipeline_derive_stage and every row is re-derived.
-- ---------------------------------------------------------------------------
update public.lead_pipeline set updated_at = now();

-- ---------------------------------------------------------------------------
-- 5. Campaigns and templates are removed.
--
-- Every one of the 701 leads has campaign_id = NULL, so the campaign lookup in
-- lib/services/ai/index.ts has never found a template and the generator has
-- always fallen through to its built-in default. Deleting this changes no
-- behaviour; it removes two pages, two tables and three views that only ever
-- reported zeroes.
--
-- Order matters: views before the columns they select, columns before the
-- tables they reference.
-- ---------------------------------------------------------------------------
drop view if exists public.dashboard_campaign_stats;
drop view if exists public.public_stats_campaigns;
drop view if exists public.analytics_template_performance;

-- ---------------------------------------------------------------------------
-- 6. Views nothing reads.
--
-- The five that only lib/data/dashboard.ts consumed ,a module imported by
-- nothing ,plus one that never had a consumer at all, plus the category view
-- that stands between us and dropping the column.
-- ---------------------------------------------------------------------------
drop view if exists public.dashboard_overview;
drop view if exists public.dashboard_leads_by_country;
drop view if exists public.dashboard_leads_by_niche;
drop view if exists public.dashboard_reply_activity_daily;
drop view if exists public.dashboard_reply_stats;
drop view if exists public.dashboard_leads_created_daily;
drop view if exists public.dashboard_leads_by_category;

-- ---------------------------------------------------------------------------
-- 7. Two surviving views select columns that are about to disappear.
--
-- CREATE OR REPLACE cannot drop a column from a view (42P16), so both are
-- dropped and rebuilt. dashboard_leads_safe is kept even though nothing reads
-- it yet: it is the shape a viewer role would be given, and that scope is still
-- an open product question.
-- ---------------------------------------------------------------------------
drop view if exists public.dashboard_leads_safe;
create view public.dashboard_leads_safe
with (security_invoker = false) as
select
  l.id,
  l.business_name,
  l.city,
  l.country,
  l.niche,
  l.status,
  l.created_at,
  l.last_contacted_at,
  (l.research_summary is not null) as has_research,
  (l.draft_email is not null)      as has_draft
from public.leads l
where public.is_admin();

comment on view public.dashboard_leads_safe is
  'Per-lead list with contact details, research and drafts stripped. Safe for viewers, currently read by nothing.';

drop view if exists public.pipeline_board;
create view public.pipeline_board
with (security_invoker = false) as
select
  p.lead_id,
  l.business_name,
  l.email,
  l.city,
  l.country,
  l.niche,
  l.status                       as lead_status,
  p.current_stage,
  public.compute_next_step(p)    as next_step,
  p.email_found,
  p.email_verified,
  p.research_complete,
  p.draft_ready,
  p.approved,
  p.approved_at,
  p.draft_ready_at,
  p.first_email_sent,
  p.followup1_due,
  p.followup1_sent,
  p.followup2_due,
  p.followup2_sent,
  p.replied,
  p.closed,
  p.closed_reason,
  p.auto_followups,
  p.updated_at,
  p.email_verification_status,
  p.email_verification_source,
  p.email_checked_at
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where public.is_admin();

comment on view public.pipeline_board is
  'Admin-only pipeline rows with the derived next_step and verification state. Contains contact data ,never grant to anon.';

grant select on public.pipeline_board to authenticated;
grant select on public.dashboard_leads_safe to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Now the columns and the tables.
--
-- `category` held 348 Skip / 241 Needs Automation / 112 No Website. Migration
-- 0024 kept it on the theory that the Skip marks were a real qualification
-- signal; the user has since confirmed they are stale, so it goes.
--
-- `next_followup_at` was never written by anything and was NULL on all 701 rows.
-- ---------------------------------------------------------------------------
alter table public.leads      drop column if exists campaign_id;
alter table public.leads      drop column if exists category;
alter table public.leads      drop column if exists next_followup_at;
alter table public.email_logs drop column if exists campaign_id;
alter table public.email_logs drop column if exists template_id;

drop table if exists public.campaigns;
drop table if exists public.templates;

-- ---------------------------------------------------------------------------
-- 9. Settings rows nothing reads.
--
-- Seeded by 0006 and never wired to anything: lib/services/config.ts does not
-- mention them and neither does any UI. `ai.default_model` is especially
-- misleading, since it names a model this project never calls.
-- ---------------------------------------------------------------------------
delete from public.settings
 where key in ('ai.default_model', 'provider.name', 'followup.default_delay_days');
