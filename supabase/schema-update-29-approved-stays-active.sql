-- ===========================================================================
-- Schema update 29 - an approved version stays active; CRLF is not an edit.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-28 first. Re-runnable throughout.
--
-- The lead form carried the draft in a hidden input, HTML form submission
-- normalises newlines to CRLF, and version_lead_draft() read that as an
-- external edit - spawning a new ACTIVE version and demoting the approved one
-- on every save of the Business-information card. Compares line-ending
-- normalised now, and never takes `active` from an approved version.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0039 — an approved version stays the active one, and a line ending is not
-- an edit.
--
-- Reported as: "I changed the email status and it made another version — the
-- approved one was 5 Aug, then one more appeared 12 minutes ago."
--
-- ---------------------------------------------------------------------------
-- WHAT ACTUALLY HAPPENED
--
-- Nothing to do with verification. The chain was:
--
--   1. The lead page's Business-information form carries the whole draft body
--      in a HIDDEN INPUT (`draft_email`), so it is re-submitted on every save
--      of that card — even a save that only changed the email address.
--   2. HTML form submission normalises line breaks to CRLF. The stored draft
--      used LF, so the value came back with every "\n" turned into "\r\n".
--   3. `updateLead()` wrote that to `leads.draft_email`.
--   4. `version_lead_draft()` (0015) compares the new `leads.draft_email` with
--      the ACTIVE version's content, saw a difference, and inserted a new
--      version with `active = true`.
--   5. `enforce_single_active_version()` then deactivated the approved one.
--
-- So saving the form silently replaced an approved draft with a byte-identical
-- copy that nobody had approved — and because the sender requires the ACTIVE
-- version to be approved, those leads stopped being sendable while still
-- reading `approved` on the pipeline. Measured live: 4 leads, and in all four
-- the replacement differed from the approved text ONLY by line endings.
--
-- The UI half of this fix removes the hidden inputs, so the form stops
-- round-tripping a draft it does not edit. This migration closes the same hole
-- at the database level, where every writer passes — including n8n, which
-- writes `leads` directly and cannot be fixed from the application.
--
-- ---------------------------------------------------------------------------
-- TWO CHANGES
--
-- 1. Compare content with line endings normalised. A draft that differs only
--    by CRLF vs LF is the same draft; versioning it records nothing and costs
--    an approval.
--
-- 2. A new auto-captured version NO LONGER STEALS `active` from an approved
--    one. The approved version is the text a human signed off and the text the
--    sender will actually send, so it stays active until somebody explicitly
--    chooses otherwise. History is still recorded — the new row is inserted,
--    just inactive.
--
--    This applies ONLY to this trigger, which fires on an incidental write to
--    `leads.draft_email`. Explicit actions — Regenerate, Save draft, activating
--    a version from the history list — go through `createEmailVersion()` and
--    still activate what they create, because there a human asked for it.
-- ---------------------------------------------------------------------------

create or replace function public.version_lead_draft()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  active_content   text;
  has_approved     boolean;
  incoming         text := replace(coalesce(new.draft_email, ''), E'\r\n', E'\n');
begin
  if new.draft_email is null or length(btrim(new.draft_email)) = 0 then
    return null;
  end if;

  select v.content into active_content
    from public.email_versions v
   where v.lead_id = new.id and v.type = 'initial' and v.active
   limit 1;

  -- Already the active text: this is the mirror writing back. Stop.
  -- Compared with line endings normalised, so a form round trip (which turns
  -- every LF into CRLF) is correctly recognised as "no change".
  if replace(coalesce(active_content, ''), E'\r\n', E'\n') is not distinct from incoming
     and active_content is not null then
    return null;
  end if;

  select exists (
    select 1 from public.email_versions v
     where v.lead_id = new.id and v.type = 'initial' and v.status = 'approved'
  ) into has_approved;

  insert into public.email_versions (lead_id, type, subject, content, status, active, generated_by)
  values (
    new.id,
    'initial',
    new.subject_line,
    new.draft_email,
    -- A lead the sheet already reports as sent had its draft approved
    -- upstream; anything else still needs a human here.
    case when new.status in ('sent', 'replied') then 'approved'::public.email_version_status
         else 'draft'::public.email_version_status end,
    -- Never take `active` away from a version a human approved.
    not has_approved,
    'ollama:external'
  );

  return null;
end;
$$;

comment on function public.version_lead_draft() is
  'Captures an external edit to leads.draft_email as a new version. Line endings are normalised before comparing, so a form round trip is not an edit, and the new row is left INACTIVE when an approved version already exists — an approved draft stays the one that sends.';

-- ---------------------------------------------------------------------------
-- Repair: put the approved version back in charge.
--
-- One statement per side, and the deactivate runs FIRST, because
-- email_versions carries a partial unique index on (lead_id, type) where
-- active — activating the approved row while its usurper is still active
-- would violate it.
-- ---------------------------------------------------------------------------
with stranded as (
  select v.lead_id,
         max(v.version_number) filter (where v.status = 'approved') as approved_version
    from public.email_versions v
   where v.type = 'initial'
   group by v.lead_id
  having bool_or(v.status = 'approved')
     and bool_or(v.active and v.status <> 'approved')
)
update public.email_versions v
   set active = false
  from stranded s
 where v.lead_id = s.lead_id
   and v.type = 'initial'
   and v.active
   and v.status <> 'approved';

with stranded as (
  select v.lead_id,
         max(v.version_number) filter (where v.status = 'approved') as approved_version
    from public.email_versions v
   where v.type = 'initial'
   group by v.lead_id
  having bool_or(v.status = 'approved')
     and not bool_or(v.active)
)
update public.email_versions v
   set active = true
  from stranded s
 where v.lead_id = s.lead_id
   and v.type = 'initial'
   and v.version_number = s.approved_version;
