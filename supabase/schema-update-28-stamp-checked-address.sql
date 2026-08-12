-- ===========================================================================
-- Schema update 28 - record WHICH address a verdict was about, on every write.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-27 first. Re-runnable throughout.
--
-- 0028 resets a verification verdict when the address changes, guarded on
-- email_checked_address being set - but nothing ever set that column except
-- 0028's own backfill, so every verdict written since was immune to the reset
-- (125 of 522 live leads). Stamped centrally in set_pipeline_stage() now, and
-- the gap backfilled.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0038 — record WHICH address a verdict was about, on every write.
--
-- 0028 made a verification verdict reset when `leads.email` changes to a
-- different address, and that reset is guarded on
-- `email_checked_address is not null` — a verdict of unknown provenance is
-- left alone rather than silently discarded.
--
-- But NOTHING EVER SET THAT COLUMN except 0028's own one-time backfill.
-- Every path that records a verdict omits it:
--
--   setVerificationStatus()            (the lead-page dropdown)
--   sync_pipeline_from_email_log()     (a delivered message proves the address)
--   the bounce path                    (a hard bounce proves the opposite)
--   the verifier CSV import
--
-- So every verdict written since 0028 landed with `email_checked_address` NULL,
-- which makes that lead permanently immune to the reset: correct a typo and the
-- old verdict follows the new address, exactly the bug 0028 exists to prevent.
-- Measured live before this migration: 125 of 522 non-unverified leads.
--
-- Fixing each writer would be four fixes and a fifth one waiting for whoever
-- adds the next verdict source. `set_pipeline_stage()` is the BEFORE trigger
-- every write to `lead_pipeline` already passes through, so stamping it there
-- makes it impossible to forget — the same argument as putting the send gates
-- in `sendLeadEmail()` rather than in each caller.
--
-- The lead's address is fetched with a primary-key lookup, and only when the
-- status actually changed, so this costs nothing on ordinary pipeline writes.
--
-- Ordering note: `reset_verification_on_email_change()` (AFTER on leads) sets
-- the status to 'unverified' and the address to NULL, then this BEFORE trigger
-- fires on that same update. Because 'unverified' clears the column rather than
-- stamping it, the two agree instead of fighting.
-- ---------------------------------------------------------------------------

create or replace function public.set_pipeline_stage()
returns trigger
language plpgsql
as $$
declare
  status_changed boolean;
  flag_changed   boolean;
  current_email  text;
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

    /*
     * Stamp the address this verdict is about (0038), unless the caller
     * already named one — the CSV importer may be applying a result for an
     * address that has since been edited, and it knows better than we do.
     *
     * 'unverified' means "no verdict", so it clears the column instead. That
     * is also what keeps this agreeable with the reset trigger, which sets
     * both in the same statement.
     */
    if new.email_verification_status = 'unverified' then
      new.email_checked_address := null;
    elsif new.email_checked_address is null then
      select lower(btrim(l.email)) into current_email
        from public.leads l
       where l.id = new.lead_id;
      new.email_checked_address := nullif(current_email, '');
    end if;

  elsif flag_changed then
    if new.email_verified and new.email_verification_status <> 'valid' then
      new.email_verification_status := 'valid';
      new.email_verification_source := 'manual';
      new.email_checked_at := now();

      -- Same stamp on the flag-driven path: ticking the box on the lead page
      -- is a verdict too, and it is about the address showing on that page.
      if new.email_checked_address is null then
        select lower(btrim(l.email)) into current_email
          from public.leads l
         where l.id = new.lead_id;
        new.email_checked_address := nullif(current_email, '');
      end if;

    elsif not new.email_verified and new.email_verification_status = 'valid' then
      new.email_verification_status := 'unverified';
      new.email_verification_source := null;
      new.email_checked_at := null;
      new.email_checked_address := null;
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
  'Derives current_stage, keeps email_verified in step with email_verification_status in both directions, records the verifier''s own verdict separately from a human override, and stamps email_checked_address so every verdict knows which address it was about (0038).';

-- ---------------------------------------------------------------------------
-- Backfill the verdicts written between 0028 and now.
--
-- Same shape as 0028's original backfill. Only rows that actually carry a
-- verdict AND have an address to attribute it to; a lead with no address has
-- nothing to record.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set email_checked_address = lower(btrim(l.email))
  from public.leads l
 where l.id = p.lead_id
   and p.email_checked_address is null
   and p.email_verification_status <> 'unverified'
   and l.email is not null
   and length(btrim(l.email)) > 0;
