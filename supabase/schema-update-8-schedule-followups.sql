-- ===========================================================================
-- Schema update 8 - two faults that between them meant nothing could ever send.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-7 first. Re-runnable: every UPDATE is guarded.
--
-- 1. Sends recorded from the SHEET never scheduled a follow-up. followup1_due
--    is set by the email_logs trigger, and those 58 leads have no email_logs
--    rows, so their due date stayed NULL. compute_next_step() read that as
--    "awaiting follow-up 1" forever while the cron reported nothing to do.
--
-- 2. Two different definitions of "approved". lead_pipeline.approved comes
--    from leads.status; the scheduler instead requires the ACTIVE
--    email_versions row to be approved. They disagreed, so the dashboard could
--    say Ready to Send while the sender skipped every one.
--
-- Only leads ALREADY SENT are auto-approved here. Drafts still awaiting review
-- are left alone.
-- ===========================================================================
-- ---------------------------------------------------------------------------
-- 0018 — Two faults that between them meant the sender could never send.
--
-- FAULT 1: sends recorded from the sheet never scheduled a follow-up.
--
--   followup1_due is set by the email_logs trigger. The 58 leads sent by the
--   upstream n8n pipeline have no email_logs rows at all — migration 0015 wrote
--   first_email_sent directly — so their followup1_due stayed NULL.
--
--   compute_next_step() then reads "sent, but no due date" as await_followup1,
--   forever. The scheduler looks for `followup1_due <= now()` and finds
--   nothing. Those leads would have sat in Awaiting Follow-up 1 permanently
--   while the cron ran happily every hour reporting nothing to do.
--
-- FAULT 2: two different definitions of "approved".
--
--   lead_pipeline.approved comes from leads.status via sync_pipeline_from_lead.
--   The scheduler, before sending an initial email, instead requires the ACTIVE
--   email_versions row to have status = 'approved'.
--
--   Those can disagree, and they did: 58 leads had pipeline.approved = true
--   while 0 active initial versions were approved. The dashboard would have
--   said "Ready to Send: N" and the sender would have skipped every one of them
--   with "waiting for approval".
--
--   Approving must set both. Fixed here for existing rows, and in
--   lib/actions/leads.ts for the bulk-approve path that only set the status.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- FAULT 1a — a sheet-reported send now schedules follow-up 1 as well.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_lead()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  has_email    boolean := new.email is not null and length(btrim(new.email)) > 0;
  has_research boolean := new.research_summary is not null and length(btrim(new.research_summary)) > 0;
  has_draft    boolean := new.draft_email is not null and length(btrim(new.draft_email)) > 0;
  is_approved  boolean := new.status in ('approved', 'sending', 'sent', 'replied');
  was_sent     boolean := new.status in ('sent', 'replied');
  sent_at      timestamptz := coalesce(new.last_contacted_at, new.imported_at, now());
  d1           integer := public.setting_int('outreach.followup1_delay_days', 7);
begin
  insert into public.lead_pipeline as p (
    lead_id, email_found, research_complete, draft_ready, approved,
    first_email_sent, followup1_due
  )
  values (
    new.id, has_email, has_research, has_draft, is_approved,
    case when was_sent then sent_at else null end,
    -- Without this the lead reaches 'initial_sent' with no due date, and
    -- compute_next_step() parks it on await_followup1 for good.
    case when was_sent then sent_at + make_interval(days => d1) else null end
  )
  on conflict (lead_id) do update
    set email_found       = p.email_found       or excluded.email_found,
        research_complete = p.research_complete or excluded.research_complete,
        draft_ready       = p.draft_ready       or excluded.draft_ready,
        approved          = p.approved          or excluded.approved,
        first_email_sent  = coalesce(p.first_email_sent, excluded.first_email_sent),
        followup1_due     = coalesce(p.followup1_due, excluded.followup1_due);

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- FAULT 1b — backfill the leads already stuck.
--
-- Dated from the send, not from now(), so a lead sent three weeks ago is
-- immediately due rather than waiting another week from today.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set followup1_due = p.first_email_sent
                       + make_interval(days => public.setting_int('outreach.followup1_delay_days', 7))
 where p.first_email_sent is not null
   and p.followup1_due is null
   and p.followup1_sent is null
   and p.replied is null
   and p.closed is null;

-- Same for the second step, where the first has gone but nothing scheduled the
-- second.
update public.lead_pipeline p
   set followup2_due = p.followup1_sent
                       + make_interval(days => public.setting_int('outreach.followup2_delay_days', 3))
 where p.followup1_sent is not null
   and p.followup2_due is null
   and p.followup2_sent is null
   and p.replied is null
   and p.closed is null;

-- ---------------------------------------------------------------------------
-- FAULT 2 — make the two definitions of "approved" agree.
--
-- Only for leads already sent: the message went out, so it was approved
-- upstream whatever this database recorded. Drafts still awaiting review are
-- left strictly alone — auto-approving 270 unreviewed drafts because a status
-- column implied it would be exactly the accident this system exists to
-- prevent.
-- ---------------------------------------------------------------------------
update public.email_versions v
   set status = 'approved'
  from public.lead_pipeline p
 where p.lead_id = v.lead_id
   and v.type = 'initial'
   and v.active
   and v.status = 'draft'
   and p.first_email_sent is not null;

comment on function public.sync_pipeline_from_lead() is
  'Projects lead columns onto the pipeline. A sheet-reported send also schedules follow-up 1, otherwise the lead parks on await_followup1 forever.';
