-- ---------------------------------------------------------------------------
-- 0028 — A verdict belongs to an ADDRESS, and so does a lead's identity.
--
-- Two bugs with one root cause: changing `leads.email` left everything that was
-- true of the OLD address attached to the lead.
--
-- ---------------------------------------------------------------------------
-- BUG 1 — editing an email created a duplicate lead on the next sync.
--
-- `dedupe_key` is computed once at import and nothing recomputed it. So:
--
--   1. lead exists with dedupe_key = 'email:info@apatchicars.com'
--   2. an admin corrects the address to showroom@apatchicars.com
--   3. write-back pushes the new address to the sheet row
--   4. the next sync reads that row, computes 'email:showroom@apatchicars.com',
--      finds no lead with that key -> INSERTS A NEW LEAD
--
-- Found in the live data as EIGHT sheet rows claimed by two leads each, three of
-- them email-to-email pairs that could only have come from this path:
--
--   row 686  Ali & Sons    email:ascon@ali-sons.com   || email:last@ali-sons.com
--   row 723  Apatchi Cars  email:showroom@apatchi...  || email:info@apatchi...
--   row 121  Modern Mart   email:contact@gmail.com    || email:info@modernmart.lk
--
-- plus four leads whose stored key no longer matched their own address, caught
-- mid-drift before the sync had run again.
--
-- The fix is to recompute the key AT THE MOMENT OF THE EDIT, in a trigger, so
-- every path behaves the same. GUIDE.md warns against recomputing keys, and that
-- warning was about a bulk backfill over every row at once, where a collision
-- fails an entire sync with nothing to show for it. One row at a time is the
-- opposite case: a collision means "another lead already owns that address",
-- which is a true and useful thing to say to whoever just typed it.
--
-- ---------------------------------------------------------------------------
-- BUG 2 — the verification verdict transferred to an address it was never about.
--
-- NeverBounce judged info@abc.com. Someone corrects a typo to info@abd.com. The
-- verdict stayed:
--
--   valid   -> the NEW, unchecked address is marked verified and passes the send
--              gate. An address nobody has ever checked gets mailed.
--   invalid -> the NEW, correct address is marked dead, blocked from sending
--              for ever, and counted in Dead Addresses.
--
-- Changing the address now resets the verdict to 'unverified'. That is what
-- makes "a verifier said invalid -> never send" safe to enforce: it applies only
-- while the address is the one that was judged, so correcting a typo genuinely
-- clears the history instead of needing an override that could be misused.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Remember what the VERIFIER said, separately from what a human said.
--
-- One status column could not answer "was this catch-all before you confirmed
-- it", because the manual verdict overwrote the verifier's. That question is the
-- whole basis of send priority: an address NeverBounce called valid deserves to
-- go before one that came back catch-all and was rescued by hand.
--
-- Only non-manual sources write here. `email_checked_address` records WHICH
-- address every verdict was about, which is what makes the reset below possible.
-- ---------------------------------------------------------------------------
alter table public.lead_pipeline
  add column if not exists email_verifier_status public.email_verification_status,
  add column if not exists email_checked_address text;

comment on column public.lead_pipeline.email_verifier_status is
  'The last verdict from a NON-manual source (a verifier, a bounce, a delivery). Survives a human override, so send priority can tell "NeverBounce said valid" from "NeverBounce said catch-all and a human confirmed it". NULL means no machine ever judged the current address.';

comment on column public.lead_pipeline.email_checked_address is
  'The address the current verdict is about. When leads.email changes to something else the verdict is reset, because it was never about the new address.';

-- Backfill: every verdict on record came from a verifier unless it says manual.
update public.lead_pipeline p
   set email_verifier_status = p.email_verification_status
 where p.email_verifier_status is null
   and p.email_verification_source is not null
   and p.email_verification_source <> 'manual';

-- And record which address each existing verdict was about.
update public.lead_pipeline p
   set email_checked_address = lower(btrim(l.email))
  from public.leads l
 where l.id = p.lead_id
   and p.email_checked_address is null
   and p.email_verification_status <> 'unverified'
   and l.email is not null;

-- ---------------------------------------------------------------------------
-- 2. The verdict trigger also records the verifier's own opinion.
--
-- Same bidirectional rule as 0023/0025, with one addition: a status arriving
-- from anything other than a human is remembered in email_verifier_status, and a
-- human's override leaves that column alone. That is the entire mechanism behind
-- send priority.
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

    -- A machine spoke. Remember it, because a later human override must not
    -- erase what the verifier actually found.
    if new.email_verification_source is not null
       and new.email_verification_source <> 'manual'
       and new.email_verification_status <> 'unverified' then
      new.email_verifier_status := new.email_verification_status;
    end if;

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
  'Derives current_stage, keeps email_verified in step with email_verification_status in both directions, and records the verifier''s own verdict separately from a human override.';

-- ---------------------------------------------------------------------------
-- 3. Changing the address resets everything that was true of the old one.
--
-- BEFORE, on leads, so the recomputed dedupe_key is written in the same
-- statement rather than in a second round trip that could interleave.
--
-- The key is only recomputed when it was ALREADY email-based. A lead keyed
-- `site:` or `name:` keeps that identity: those keys were chosen because there
-- was no address at import, and switching identity scheme underneath a lead
-- that the sheet still matches by site would create the very duplicate this is
-- here to prevent.
-- ---------------------------------------------------------------------------
create or replace function public.rekey_lead_on_email_change()
returns trigger
language plpgsql
as $$
declare
  old_email text := lower(btrim(coalesce(old.email, '')));
  new_email text := lower(btrim(coalesce(new.email, '')));
begin
  if old_email is not distinct from new_email then
    return new;
  end if;

  if new.dedupe_key like 'email:%' and new_email <> '' then
    new.dedupe_key := 'email:' || new_email;
  end if;

  return new;
end;
$$;

comment on function public.rekey_lead_on_email_change() is
  'Keeps dedupe_key in step with the address it names. Without this, correcting an email made the next sheet sync insert a second lead for the same row.';

drop trigger if exists leads_rekey_on_email_change on public.leads;
create trigger leads_rekey_on_email_change
  before update of email on public.leads
  for each row execute function public.rekey_lead_on_email_change();

-- ---------------------------------------------------------------------------
-- 4. ...and the verification verdict resets with it.
--
-- AFTER, because it writes to a different table. Guarded on the address it was
-- actually about: a sync that rewrites the same address with different
-- whitespace or casing must not throw away a verdict.
-- ---------------------------------------------------------------------------
create or replace function public.reset_verification_on_email_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_email text := lower(btrim(coalesce(new.email, '')));
begin
  update public.lead_pipeline p
     set email_verification_status = 'unverified',
         email_verification_source = null,
         email_verifier_status     = null,
         email_checked_at          = null,
         email_checked_address     = null,
         email_verified_at         = null
   where p.lead_id = new.id
     -- Only when the verdict was about a DIFFERENT address. A NULL
     -- email_checked_address means a pre-0028 verdict of unknown provenance;
     -- those are left alone rather than silently discarded.
     and p.email_checked_address is not null
     and p.email_checked_address is distinct from nullif(new_email, '');

  return null;
end;
$$;

comment on function public.reset_verification_on_email_change() is
  'A verdict is about an address. When leads.email changes to a different one the verdict, its source, the verifier''s own verdict and the timestamps all reset to unverified.';

drop trigger if exists leads_reset_verification_on_email_change on public.leads;
create trigger leads_reset_verification_on_email_change
  after update of email on public.leads
  for each row execute function public.reset_verification_on_email_change();

-- ---------------------------------------------------------------------------
-- 5. Send priority.
--
-- Tier 1 goes out before any tier 2, tier 2 before any tier 3. Ordering only —
-- nothing is gated, because an address a human confirmed from the company's own
-- website is worth mailing; it just goes after the ones a verifier proved.
--
--   1  a verifier said valid, or a real email was already delivered
--   2  a human confirmed it, and no machine had said anything negative
--      (catch-all, or never checked at all)
--   3  a human confirmed it after the verifier tried and gave up (unknown)
--   9  not sendable
--
-- `invalid` is 9 even when a human has since marked it valid, BECAUSE the
-- verdict now resets on an address change: if the address is the same one that
-- bounced, no override should rescue it, and if it has been corrected the
-- verifier status is already NULL and the lead is nowhere near this branch.
-- ---------------------------------------------------------------------------
create or replace function public.compute_send_priority(p public.lead_pipeline)
returns integer
language sql
immutable
as $$
  select (case
    when p.email_verifier_status = 'invalid'                    then 9
    when not p.email_verified                                   then 9
    when p.email_verification_source = 'delivered'              then 1
    when p.email_verifier_status = 'valid'                      then 1
    when p.email_verifier_status = 'unknown'                    then 3
    else 2
  end);
$$;

comment on function public.compute_send_priority(public.lead_pipeline) is
  'Send order for initial emails: 1 = a verifier proved it, 2 = a human confirmed it with no negative machine signal, 3 = a human confirmed it after the verifier gave up, 9 = not sendable. Ordering only, never a gate.';

-- ---------------------------------------------------------------------------
-- 6. Expose it on the board, appended at the end (CREATE OR REPLACE can only
--    add columns there — inserting mid-list raises 42P16).
-- ---------------------------------------------------------------------------
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
  p.email_checked_at,
  p.email_verifier_status,
  p.email_checked_address,
  public.compute_send_priority(p) as send_priority
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where public.is_admin();

comment on view public.pipeline_board is
  'Admin-only pipeline rows with the derived next_step, verification state and send priority. Contains contact data — never grant to anon.';

grant select on public.pipeline_board to authenticated;
