-- ===========================================================================
-- Schema update 35 - settings for the "daily cap reached" email alert.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-34 first. Re-runnable throughout.
--
-- See supabase/migrations/20260820140000_daily_cap_alert_settings.sql for
-- the full reasoning. Seeds two settings rows; all alert logic is in
-- lib/services/outreach/scheduler.ts, not the database.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0045 — daily-cap-alert settings.
-- ---------------------------------------------------------------------------

insert into public.settings (key, value, description, is_sensitive)
values (
  'outreach.daily_cap_alert_email',
  '"rayyanmasroor8@gmail.com"'::jsonb,
  'Recipient for the "daily send cap reached" summary email (who sent, what type, to which businesses). Empty disables the alert.',
  false
)
on conflict (key) do nothing;

insert into public.settings (key, value, description, is_sensitive)
values (
  'outreach.daily_cap_alert_date',
  'null'::jsonb,
  'Internal — last calendar date (DISPLAY_TIME_ZONE) the daily-cap-reached alert was sent. Written by runOutreachCycle(); not a user-facing setting.',
  false
)
on conflict (key) do nothing;
