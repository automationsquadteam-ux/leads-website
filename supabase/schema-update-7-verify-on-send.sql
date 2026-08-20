-- ===========================================================================
-- Schema update 7 - a delivered email verifies the address.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
--
-- Apply updates 1-6 first. Paste this into the Supabase SQL editor and Run.
-- Re-runnable: create-or-replace throughout, and both backfill UPDATEs are
-- guarded so a second run changes nothing.
--
-- What it does:
--   * a successful send now marks the address verified, because the relay
--     accepted it and no bounce came back. A later hard bounce (update 6)
--     revises that to invalid, which is what makes the claim safe to assert.
--   * backfills every lead already emailed, including the ones sent upstream.
--   * pipeline_board gains the verification columns so the leads list can show
--     and filter on them. Appended at the END - CREATE OR REPLACE can only
--     append, and inserting mid-list raises 42P16.
-- ===========================================================================
-- ---------------------------------------------------------------------------
-- 0017 ,A delivered email verifies the address; expose that on the board.
--
-- Three parts.
--
-- 1. A successful send is evidence. The relay accepted the address and no
--    bounce came back, which is stronger proof than any verifier offers,
--    because it is a real delivery rather than a probe. Those leads are now
--    marked verified automatically.
--
--    The self-correcting half matters: migration 0016 makes a hard bounce set
--    'invalid'. So "accepted, therefore valid" is a claim the system revises
--    the moment reality disagrees, which is what makes it safe to assert.
--
--    An existing 'invalid' is never overwritten. A verifier that says the
--    address is dead outranks a relay that merely agreed to try.
--
-- 2. Backfill the leads already sent to.
--
-- 3. pipeline_board gains the verification columns so the leads list can show
--    and filter on them. Appended at the END of the view ,CREATE OR REPLACE
--    can only append, and inserting mid-list raises 42P16.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Verify on a successful send.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_email_log()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sent_at timestamptz := coalesce(new.sent_at, now());
  d1 integer := public.setting_int('outreach.followup1_delay_days', 7);
  d2 integer := public.setting_int('outreach.followup2_delay_days', 3);
begin
  if new.status not in ('sent', 'delivered', 'opened', 'clicked') then
    return null;
  end if;

  insert into public.lead_pipeline (lead_id) values (new.lead_id)
  on conflict (lead_id) do nothing;

  if new.email_type = 'initial' then
    update public.lead_pipeline
       set first_email_sent = coalesce(first_email_sent, sent_at),
           followup1_due    = coalesce(followup1_due, sent_at + make_interval(days => d1))
     where lead_id = new.lead_id;

  elsif new.email_type = 'followup1' then
    update public.lead_pipeline
       set followup1_sent = coalesce(followup1_sent, sent_at),
           followup2_due  = coalesce(followup2_due, sent_at + make_interval(days => d2))
     where lead_id = new.lead_id;

  elsif new.email_type = 'followup2' then
    update public.lead_pipeline
       set followup2_sent = coalesce(followup2_sent, sent_at)
     where lead_id = new.lead_id;
  end if;

  -- The address accepted a real message. Upgrade unverified / unknown /
  -- accept_all, but never contradict a verifier that returned 'invalid'.
  update public.lead_pipeline
     set email_verification_status = 'valid',
         email_verification_source = 'delivered',
         email_checked_at          = coalesce(email_checked_at, sent_at)
   where lead_id = new.lead_id
     and email_verification_status <> 'invalid'
     and email_verification_status <> 'valid';

  return null;
end;
$$;

comment on function public.sync_pipeline_from_email_log() is
  'Advances the sequence on a recorded send and treats acceptance as proof the address works. A later hard bounce (0016) revises that to invalid.';

-- ---------------------------------------------------------------------------
-- 2. Backfill: everything already sent to counts as verified.
--
-- Covers sends made upstream too, since those land on
-- lead_pipeline.first_email_sent rather than in email_logs.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set email_verification_status = 'valid',
       email_verification_source = 'delivered',
       email_checked_at          = coalesce(p.email_checked_at, p.first_email_sent, now())
 where p.first_email_sent is not null
   and p.email_verification_status not in ('valid', 'invalid');

-- A recorded bounce is the opposite evidence; make sure it wins regardless of
-- the order these migrations ran in.
update public.lead_pipeline p
   set email_verification_status = 'invalid',
       email_verification_source = coalesce(p.email_verification_source, 'bounce')
  from public.leads l
 where l.id = p.lead_id
   and l.status = 'bounced'
   and p.email_verification_status <> 'invalid';

-- ---------------------------------------------------------------------------
-- 3. pipeline_board: append the verification columns.
--
-- Columns are listed explicitly, never p.* ,a view built with * captures its
-- column list at creation time and silently goes stale after an ALTER TABLE.
-- ---------------------------------------------------------------------------
create or replace view public.pipeline_board
with (security_invoker = false) as
select
  p.lead_id,
  l.business_name,
  l.email,
  l.city,
  l.country,
  l.niche,
  l.status                       as lead_status,
  l.campaign_id,
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
  -- Appended. Anything new goes here, at the end, for the reason in the header.
  p.email_verification_status,
  p.email_verification_source,
  p.email_checked_at
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where public.is_admin();

comment on view public.pipeline_board is
  'Admin-only pipeline rows with the derived next_step and verification state. Contains contact data ,never grant to anon.';
