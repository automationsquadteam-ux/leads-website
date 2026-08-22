-- ---------------------------------------------------------------------------
-- 0045 — settings backing the "daily cap reached" email alert.
--
-- Asked for directly: an email whenever the day's send cap is hit, with the
-- breakdown (how many initial, follow-up 1, follow-up 2, to whom). The alert
-- logic itself lives entirely in code (`runOutreachCycle()`,
-- lib/services/outreach/scheduler.ts) — this migration only seeds the two
-- settings rows that make it configurable and idempotent:
--
--   outreach.daily_cap_alert_email  the recipient. Not hardcoded, same
--                                    reasoning as every other outreach.* knob
--                                    in this project — changing who gets
--                                    told should not need a deploy. Empty
--                                    disables the alert outright.
--
--   outreach.daily_cap_alert_date   internal bookkeeping, NOT user-facing
--                                    (no Settings form field for it). Stores
--                                    the last calendar date (DISPLAY_TIME_ZONE)
--                                    the alert was sent, so a cron tick every
--                                    few minutes for the rest of the day does
--                                    not re-send it. A database row, not an
--                                    in-memory flag, because each cron
--                                    invocation is a separate cold process —
--                                    the same reason `sendsToday()` (gap
--                                    pacing) already measures against
--                                    email_logs instead of a loop-local timer.
--
-- updateSettings() does UPDATE ... WHERE key, not an upsert (lib/actions/
-- misc.ts), so without these rows existing a future Settings change to the
-- alert email would silently write nothing — same trap 0037's migration note
-- already documents for close_after_followup2_days.
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
