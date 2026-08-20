-- ---------------------------------------------------------------------------
-- 0023 ,Ticking "Email verified" IS a verdict.
--
-- The relationship between the flag and the status was one-directional:
--
--     email_verification_status = 'valid'   ->  email_verified := true
--     email_verification_status = 'invalid' ->  email_verified := false
--
-- so a verifier result updated both, but an admin ticking the box on the lead
-- page set only `email_verified`. The status stayed `unverified`, the leads
-- table kept showing "Never checked", and the lead stayed in the export ,being
-- re-billed to a verifier for an address a human had already confirmed.
--
-- Made bidirectional. Which side wins is decided by WHICH ONE CHANGED in this
-- statement, so neither can quietly overwrite the other:
--
--   status changed  -> a verifier (or a bounce) spoke. It drives the flag.
--   flag changed    -> a human spoke. It drives the status, recorded as
--                      source 'manual' so the origin stays auditable.
--
-- An `invalid` status is never softened by unticking the box: a hard bounce is
-- evidence, and "I am no longer sure" is not a reason to discard it.
-- ---------------------------------------------------------------------------
create or replace function public.set_pipeline_stage()
returns trigger
language plpgsql
as $$
declare
  status_changed boolean;
  flag_changed   boolean;
begin
  -- On INSERT there is no OLD, so treat the incoming status as authoritative
  -- and let it drive the flag, which is the pre-existing behaviour.
  if tg_op = 'INSERT' then
    status_changed := true;
    flag_changed := false;
  else
    status_changed := new.email_verification_status is distinct from old.email_verification_status;
    flag_changed   := new.email_verified is distinct from old.email_verified;
  end if;

  if status_changed then
    if new.email_verification_status = 'valid' then
      new.email_verified := true;
    elsif new.email_verification_status = 'invalid' then
      new.email_verified := false;
    end if;

  elsif flag_changed then
    if new.email_verified and new.email_verification_status <> 'valid' then
      -- The operator checked this address themselves. Record it as a real
      -- verdict so the lead stops appearing in the verifier export.
      new.email_verification_status := 'valid';
      new.email_verification_source := 'manual';
      new.email_checked_at := now();

    elsif not new.email_verified and new.email_verification_status = 'valid' then
      -- Withdrawing a manual confirmation returns the address to unchecked,
      -- NOT to invalid: unticking means "no longer sure", not "proved dead".
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
  'Derives current_stage and keeps email_verified in step with email_verification_status in BOTH directions: a verifier result drives the flag, a human ticking the flag records a manual verdict.';

-- ---------------------------------------------------------------------------
-- Catch up the leads someone already ticked by hand: flag true, status still
-- claiming nobody has checked.
-- ---------------------------------------------------------------------------
update public.lead_pipeline
   set email_verification_status = 'valid',
       email_verification_source = coalesce(email_verification_source, 'manual'),
       email_checked_at = coalesce(email_checked_at, email_verified_at, now())
 where email_verified = true
   and email_verification_status in ('unverified', 'unknown', 'accept_all');
