-- ---------------------------------------------------------------------------
-- 0021 ,Research is done when ANY research field is filled in.
--
-- research_complete was driven by `research_summary` alone. But the upstream
-- enrichment writes seven separate fields, and the summary is only one of them
-- ,often the one that is missing:
--
--     research_summary                   452
--     website_observations               685
--     automation_opportunities           673
--     ai_chatbot_opportunities           674
--     website_improvement_opportunities  680
--     outreach_angle                     675
--     interesting_facts                  614
--
--     leads with ANY research field      691
--     leads with a summary               452
--     research but NO summary            239   <- wrongly parked at "Researching"
--
-- 239 leads had genuine research and were reported as still needing it, which
-- also meant the next step said "Research Lead" for work already done.
--
-- `personalization` is deliberately NOT in the list. It is the one-line hook
-- used in the draft, not research, and 688 of 698 leads have it ,including it
-- would make the flag true for essentially everything and stop it meaning
-- anything at all.
-- ---------------------------------------------------------------------------

create or replace function public.sync_pipeline_from_lead()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  has_email    boolean := new.email is not null and length(btrim(new.email)) > 0;

  -- Any one of these is evidence the lead has been researched.
  has_research boolean := (
       coalesce(length(btrim(new.research_summary)), 0) > 0
    or coalesce(length(btrim(new.website_observations)), 0) > 0
    or coalesce(length(btrim(new.automation_opportunities)), 0) > 0
    or coalesce(length(btrim(new.ai_chatbot_opportunities)), 0) > 0
    or coalesce(length(btrim(new.website_improvement_opportunities)), 0) > 0
    or coalesce(length(btrim(new.outreach_angle)), 0) > 0
    or coalesce(length(btrim(new.interesting_facts)), 0) > 0
  );

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

-- ---------------------------------------------------------------------------
-- The trigger has to WATCH those columns too.
--
-- It previously fired on (email, research_summary, draft_email, status), so a
-- sync that filled in website_observations and nothing else would not have
-- re-evaluated the flag no matter what the function said.
-- ---------------------------------------------------------------------------
drop trigger if exists leads_sync_pipeline on public.leads;
create trigger leads_sync_pipeline
  after insert or update of
    email, status, draft_email, last_contacted_at,
    research_summary, website_observations, automation_opportunities,
    ai_chatbot_opportunities, website_improvement_opportunities,
    outreach_angle, interesting_facts
  on public.leads
  for each row execute function public.sync_pipeline_from_lead();

-- ---------------------------------------------------------------------------
-- Backfill the 239 leads that were researched but reported otherwise.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set research_complete = true,
       research_completed_at = coalesce(p.research_completed_at, l.researched_at, l.imported_at, now())
  from public.leads l
 where l.id = p.lead_id
   and p.research_complete = false
   and (
        coalesce(length(btrim(l.research_summary)), 0) > 0
     or coalesce(length(btrim(l.website_observations)), 0) > 0
     or coalesce(length(btrim(l.automation_opportunities)), 0) > 0
     or coalesce(length(btrim(l.ai_chatbot_opportunities)), 0) > 0
     or coalesce(length(btrim(l.website_improvement_opportunities)), 0) > 0
     or coalesce(length(btrim(l.outreach_angle)), 0) > 0
     or coalesce(length(btrim(l.interesting_facts)), 0) > 0
   );

comment on function public.sync_pipeline_from_lead() is
  'Projects lead columns onto the pipeline. Research counts as done when ANY of the seven research fields is filled, not just the summary.';
