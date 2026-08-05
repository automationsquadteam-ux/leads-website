-- ===========================================================================
-- Schema update 14 - the sheet's "research status" column decides research.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-13 first. Re-runnable: the backfill is guarded.
--
-- 0021 inferred research from whether any of seven fields was filled. That is
-- still a guess about someone else's process, and the upstream pipeline says so
-- outright in a "research status" column. That verdict now rides in on
-- leads.researched_at and the trigger treats it as authoritative.
--
-- Field presence is KEPT as a fallback, not replaced: a lead with a page of
-- website observations has plainly been researched whatever a status column
-- says, and dropping that check would push hundreds of finished leads back into
-- the queue the moment a column went blank.
--
-- Also marks leads.category DEPRECATED. It is removed from the sheet and from
-- every CRM code path, but the column is NOT dropped: it still holds
-- qualification marks (348 Skip, 241 Needs Automation, 112 No Website) and
-- dropping it would destroy them with no way back. The comment on the column
-- carries the exact statements to run when you are sure.
-- ===========================================================================
-- ---------------------------------------------------------------------------
-- 0024 — The sheet's "research status" column decides whether research is done.
--
-- Migration 0021 inferred it from whether any of seven research fields was
-- filled in. That was a big improvement on "does research_summary exist", but
-- it is still a guess about someone else's process: the upstream pipeline knows
-- perfectly well whether it finished, and says so in a column.
--
-- `leads.researched_at` becomes the carrier. The importer stamps it when the
-- sheet reports research done (see lib/import/mapping.ts), and the trigger
-- treats a non-null value as authoritative.
--
-- Field presence is KEPT as a fallback rather than replaced. A lead with a full
-- page of website observations has plainly been researched whatever the status
-- column says, and dropping that check would push hundreds of finished leads
-- back into the research queue the moment a column went blank.
--
-- So: research is complete when the sheet says so, OR when the evidence says
-- so. Both are true signals; requiring both would be strictly worse than
-- either.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_lead()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  has_email    boolean := new.email is not null and length(btrim(new.email)) > 0;

  -- The sheet's own verdict, carried on researched_at.
  sheet_says_researched boolean := new.researched_at is not null;

  -- Evidence, as a fallback. personalization is excluded: it is the hook line
  -- used in the draft rather than research, and 691 of 698 leads have it, which
  -- would make the flag true for everything.
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
  is_approved  boolean := new.status in ('approved', 'sending', 'sent', 'replied');
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
    lead_id, email_found, research_complete, draft_ready, approved,
    first_email_sent, followup1_due
  )
  values (
    new.id, has_email, has_research, has_draft, is_approved,
    case when was_sent then assumed_sent else null end,
    case when was_sent then assumed_sent + make_interval(days => d1) else null end
  )
  on conflict (lead_id) do update
    set email_found       = p.email_found       or excluded.email_found,
        research_complete = p.research_complete or excluded.research_complete,
        draft_ready       = p.draft_ready       or excluded.draft_ready,
        approved          = p.approved          or excluded.approved,

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

-- researched_at must be watched, or a sync that sets only that column would not
-- re-evaluate the flag however the function is written.
drop trigger if exists leads_sync_pipeline on public.leads;
create trigger leads_sync_pipeline
  after insert or update of
    email, status, draft_email, last_contacted_at, researched_at,
    research_summary, website_observations, automation_opportunities,
    ai_chatbot_opportunities, website_improvement_opportunities,
    outreach_angle, interesting_facts
  on public.leads
  for each row execute function public.sync_pipeline_from_lead();

comment on function public.sync_pipeline_from_lead() is
  'Projects lead columns onto the pipeline. Research is complete when the sheet says so (researched_at) OR when any research field is filled.';

-- ---------------------------------------------------------------------------
-- Anything already carrying research evidence is marked complete, so the queue
-- reflects reality immediately rather than after the next sync.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set research_complete = true,
       research_completed_at = coalesce(p.research_completed_at, l.researched_at, l.imported_at, now())
  from public.leads l
 where l.id = p.lead_id
   and p.research_complete = false
   and (
        l.researched_at is not null
     or coalesce(length(btrim(l.research_summary)), 0) > 0
     or coalesce(length(btrim(l.website_observations)), 0) > 0
     or coalesce(length(btrim(l.automation_opportunities)), 0) > 0
     or coalesce(length(btrim(l.ai_chatbot_opportunities)), 0) > 0
     or coalesce(length(btrim(l.website_improvement_opportunities)), 0) > 0
     or coalesce(length(btrim(l.outreach_angle)), 0) > 0
     or coalesce(length(btrim(l.interesting_facts)), 0) > 0
   );

-- ---------------------------------------------------------------------------
-- `category` is being retired from the sheet.
--
-- The COLUMN IS DEPRECATED, NOT DROPPED. It currently holds a real
-- qualification signal on every lead — 348 "Skip", 241 "Needs Automation",
-- 112 "No Website" — and dropping it would destroy that with no way back.
-- Nothing reads or writes it any more: the importer no longer maps it, the
-- Sheets write-back no longer sends it, and it is gone from the UI.
--
-- To drop it for real, once you are sure the "Skip" marks are not needed:
--
--   drop view if exists public.dashboard_leads_by_category;
--   alter table public.leads drop column category;
--
-- The view has to go first, because it selects the column.
-- ---------------------------------------------------------------------------
comment on column public.leads.category is
  'DEPRECATED 2026-08-05. Removed from the sheet and from all CRM code paths. Retained because it still holds qualification marks (Skip / Needs Automation / No Website). Safe to drop once those are confirmed unnecessary.';
