-- ===========================================================================
--  LEADS CRM — UPDATE 3: REMOVE n8n, ADD SHEET WRITE-BACK
--
--  Run this if you have already applied schema.sql and
--  schema-update-2-integrations.sql.
--
--  Paste into the Supabase SQL editor and press Run. Safe to run twice.
--
--  What it does
--    1. Deletes the n8n settings keys, secret and run history.
--    2. Adds the sheets.write_back setting (off by default).
--
--  GENERATED FILE — concatenated from supabase/migrations/. Edit those.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0011 — Drop the n8n integration; add Google Sheets write-back.
--
-- n8n is no longer called from the CRM. Migration 0010 created its settings
-- keys and they have already been applied to the live database, so they are
-- removed here rather than by editing 0010 — an applied migration must stay
-- immutable, and this file is the record of the change.
--
-- Nothing structural is dropped: integration_runs keeps its generic
-- `integration text` column, so removing one integration is data cleanup only.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Remove n8n configuration and run history.
-- ---------------------------------------------------------------------------
delete from public.settings
 where key in (
   'n8n.webhook_url',
   'n8n.timeout_seconds',
   'n8n.include_api_key_header'
 );

delete from public.integration_secrets where key = 'n8n.api_key';

delete from public.integration_runs where integration = 'n8n';

-- ---------------------------------------------------------------------------
-- Google Sheets write-back.
--
-- When enabled, saving a lead in the CRM pushes the edit back to the row it
-- came from (leads.sheet_row_number). Off by default: it needs service-account
-- auth with Editor access on the sheet, because a Google API key is read-only
-- and can never authorise a write.
-- ---------------------------------------------------------------------------
insert into public.settings (key, value, description, is_sensitive) values
  ('sheets.write_back', 'false'::jsonb,
   'Push CRM edits back to the source sheet row. Requires service_account auth with Editor access on the sheet.',
   false)
on conflict (key) do nothing;

-- ===========================================================================
-- Verify
-- ===========================================================================
--
--   select key from public.settings where key like 'n8n%';          -- expect 0 rows
--   select key from public.settings where key = 'sheets.write_back'; -- expect 1 row
