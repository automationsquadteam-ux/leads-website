-- ===========================================================================
-- Schema update 27 - close a sequence that ran out.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-26 first. Re-runnable throughout.
--
-- Adds the `outreach.close_after_followup2_days` setting (default 14). The
-- sweep itself lives in runOutreachCycle(); the code defaults to 14 whether or
-- not this row exists, so this migration is what makes the Settings control
-- able to PERSIST a different value - updateSettings() does UPDATE ... WHERE
-- key, not an upsert, so without the row a save silently changes nothing.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0037 — a sequence that ran out closes itself.
--
-- A lead that received follow-up 2 and never answered has nothing left to do:
-- `compute_next_step()` already returns `close_workflow` for it. But nothing
-- ever performed that close, so those leads sat at stage `followup2_sent`
-- forever, counted in every figure describing live prospects. 56 of them
-- accumulated in the first two days of sending alone.
--
-- The threshold is a SETTING rather than a constant, for the same reason
-- followup1_delay_days and followup2_delay_days are: changing a cadence should
-- not need a deploy.
--
-- The sweep itself lives in runOutreachCycle() (lib/services/outreach/
-- scheduler.ts), NOT in a new cron route. It is a single UPDATE that normally
-- touches zero rows, so running it on the existing 3-minute tick costs
-- nothing, and it avoids a third endpoint plus a third cron-job.org schedule
-- to register and forget about.
--
-- Two conditions in that UPDATE are load-bearing and easy to leave out:
--
--   replied is null    — as a WHERE clause, not a read-then-write. A reply can
--                        land between a SELECT and an UPDATE, and closing a
--                        lead that just answered is the one outcome that
--                        actually loses a conversation.
--
--   auto_followups     — Pause (`auto_followups = false`) means "not right
--                        now, try me next quarter" (see "Pause versus close").
--                        Letting a pause decay into a close on a timer would
--                        silently destroy a decision somebody made on purpose.
--                        Pause and close mean different things; a clock must
--                        not collapse one into the other.
--
-- Set to 0 to disable the sweep entirely.
-- ---------------------------------------------------------------------------

insert into public.settings (key, value, description, is_sensitive)
values (
  'outreach.close_after_followup2_days',
  '14'::jsonb,
  'Close a lead this many days after follow-up 2 when it has not replied. The sequence is exhausted, so the lead leaves every queue and dashboard figure. Paused leads (auto_followups off) are never closed this way. 0 disables it.',
  false
)
on conflict (key) do nothing;
