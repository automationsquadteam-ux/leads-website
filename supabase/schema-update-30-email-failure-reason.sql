-- ===========================================================================
-- Schema update 30 - email_logs gets a failure_reason column.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-29 first. Re-runnable throughout.
--
-- Most email send refusals (archived lead, no email, unverified, no draft,
-- no subject, provider misconfigured, unresolved placeholder) never touched
-- email_logs at all - only a genuine SMTP-level failure did. The app-side fix
-- logs all of them now; this column gives the new "why emails are failing"
-- page a short stable code to group by instead of pattern-matching free text.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0040 ,most email failures never reached email_logs at all.
--
-- Reported as: "whenever an email fails, display why that email failed,
-- make a new page for that so i know y emails are failing."
-- ---------------------------------------------------------------------------
-- WHAT ACTUALLY HAPPENED
--
-- sendLeadEmail() (the one function every send path ,the manual Send
-- button and the scheduler alike ,goes through) has nine return points.
-- Only the LAST one, reached after a provider was actually called, writes
-- to email_logs. The other eight are refusals that happen before any log
-- row exists at all: archived lead, no email address, a verifier proved the
-- address undeliverable, verification required but missing, no active
-- draft, no subject line, the provider misconfigured, an unresolved
-- placeholder left in the text. Every one of those today leaves no trace
-- anywhere ,which is exactly why a bracketed business name silently
-- blocked its own lead for days with nothing in the database to find.
--
-- The application-side fix (a separate change, no migration needed) makes
-- sendLeadEmail() write a status='failed' row for every one of those
-- refusals too, not just genuine SMTP-level ones. This migration adds the
-- column that lets those rows be told apart at a glance and grouped into
-- "why" categories, instead of a new page having to pattern-match the
-- free-text `error` message.
-- ---------------------------------------------------------------------------
-- WHY A NEW COLUMN, NOT A NEW STATUS
--
-- email_logs.status is a Postgres enum and 'failed' already exists and is
-- semantically correct for all of these ,they are all failures. Adding a
-- new enum value would need the two-phase migration this project already
-- hit trouble with (0026/0027: a new enum value cannot be used in the same
-- transaction that added it) for no benefit here, since "failed" is not
-- what needs distinguishing ,the REASON is. A plain text column, filled
-- with a short stable code per refusal branch (e.g. 'archived',
-- 'no_email', 'unverified', 'no_draft', 'no_subject', 'provider_config',
-- 'unresolved_placeholder', 'send_rejected'), does that without touching
-- the enum at all. Left nullable and untouched on every existing row and
-- on every non-failed row.
--
-- No new index: email_logs_status_idx (0018) already covers
-- `where status = 'failed'`, which is the new page's primary query.
-- ---------------------------------------------------------------------------

alter table public.email_logs
  add column if not exists failure_reason text;

comment on column public.email_logs.failure_reason is
  'Short stable code for why a failed send never even reached (or was rejected by) the provider, e.g. archived, no_email, unverified, no_draft, no_subject, provider_config, unresolved_placeholder, send_rejected. Null for non-failed rows and for failures logged before this column existed.';
