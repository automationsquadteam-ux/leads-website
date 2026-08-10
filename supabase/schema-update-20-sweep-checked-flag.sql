-- ===========================================================================
-- Schema update 20 - the draft sweep stops re-examining the same stuck drafts.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-19 first. Re-runnable throughout.
--
-- Adds email_versions.sweep_checked_at: set the moment runDraftSweep()
-- examines a draft and it still has a blocking issue afterwards, so the same
-- ~10 permanently-stuck drafts stop being re-parsed and re-reported as newly
-- blocked four times a day. A new version (any edit, or a repair) starts
-- NULL again, so nothing needs a manual reset.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0030 — the draft sweep stops re-examining the same stuck drafts forever.
--
-- runDraftSweep() (the "Clean and approve drafts" button in Settings, and the
-- 0/7/14/21-hourly cron) re-reads every email_versions row with
-- status = 'draft' on every single run. A draft it cannot fully clean stays
-- status = 'draft' forever — that is the whole point of leaving it for a
-- human — so the same handful (roughly 10, per the 2026-08-05 sweep entry in
-- the changelog, "no answer in the database and stay blocked on purpose")
-- were being re-parsed and re-reported as newly blocked four times a day,
-- indefinitely, with no way to tell a genuinely new block from the same rows
-- surfacing again.
--
-- sweep_checked_at is set on the ACTIVE version row the moment a sweep
-- examines it and it still has a blocking issue afterwards. The sweep query
-- excludes anything already flagged. It is deliberately NOT set when a draft
-- gets approved — an approved version already leaves status = 'draft', so the
-- existing status filter excludes it on its own; the flag only has a job for
-- the ones left behind.
--
-- No reset mechanism is needed: editing a draft, or the sweep repairing one,
-- always creates a NEW email_versions row — versioning's whole premise is
-- that nothing is ever overwritten — and a new row starts with
-- sweep_checked_at NULL. A human who wants a flagged draft looked at again
-- edits it or writes a fresh version; that is already how every other "try
-- this again" works in this app, so this needs no new UI.
-- ---------------------------------------------------------------------------

alter table public.email_versions
  add column if not exists sweep_checked_at timestamptz;

comment on column public.email_versions.sweep_checked_at is
  'Set by runDraftSweep() when this version was examined and still had a blocking issue afterwards. Excludes it from future sweeps. NULL again on any new version (an edit or a repair), which is what lets a human ask for another pass just by touching the draft.';

-- Matches the sweep's own WHERE clause, so the partial index is exactly the
-- rows scanned rather than a broader one PostgREST would filter after the
-- fact.
create index if not exists email_versions_sweep_pending_idx
  on public.email_versions (type, active, status)
  where sweep_checked_at is null;
