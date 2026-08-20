-- ===========================================================================
-- Schema update 23 - the Google Sheet is retired.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-22 first. Re-runnable throughout.
--
-- Removes the six sheets.* settings rows and the two stored Google
-- credentials. Keeps leads.sheet_row_number / sheet_synced_at (provenance for
-- the 718 leads that came in that way, and still read by leads:duplicates)
-- and the google_sheets integration_runs history.
--
-- REVOKE THE SERVICE-ACCOUNT KEY AT THE GOOGLE END TOO - deleting the
-- ciphertext here does not invalidate the credential itself.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0033 ,the Google Sheet is retired.
--
-- n8n now writes leads and drafts straight into Supabase (0029/0031/0032 are
-- what made that safe), so the sheet is no longer the ingestion layer and no
-- longer a mirror of anything. The application code for it is deleted in the
-- same change: google-sheets.ts, sheet-writer.ts, sheet-sync.ts, the whole
-- lib/services/sync/ dispatcher, /api/cron/sheet-sync and the Sync Data button.
--
-- This migration removes what those left behind in the database.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY KEPT
--
-- `leads.sheet_row_number` and `leads.sheet_synced_at` STAY.
--
-- They are provenance: 718 of the current leads came in through the sheet, and
-- the row number is the only record of where each one came from. It is also
-- still read by `npm run leads:duplicates`, which groups by sheet row to find
-- the 0028 leak pairs ,the pattern that grouping by email alone cannot see.
-- Dropping them would destroy history to save two nullable columns, and
-- nothing writes to them any more, so they simply stop changing.
--
-- `integration_runs` rows with integration = 'google_sheets' STAY, for the same
-- reason: they record work that actually happened. Nothing renders them now
-- that the Sheets triggers are gone from the Settings page, but an audit trail
-- that deletes itself when a feature is removed is not an audit trail.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Configuration rows. Six keys, all seeded by 0010/0011, all now unread —
--    getIntegrationConfig() no longer has a `sheets` block at all, so leaving
--    them would mean settings that appear in the table and control nothing.
-- ---------------------------------------------------------------------------
delete from public.settings
 where key in (
   'sheets.spreadsheet_id',
   'sheets.sheet_name',
   'sheets.header_row',
   'sheets.auth_mode',
   'sheets.update_existing',
   'sheets.write_back'
 );

-- ---------------------------------------------------------------------------
-- 2. The stored credentials.
--
-- This is the part that actually matters for security rather than tidiness: a
-- Google service-account private key with Editor access to the spreadsheet is
-- still a live credential while it sits in this table, and it now grants
-- access this application has no reason to hold. Removing the row is the
-- revocation this end of it can do.
--
-- REVOKE THE KEY AT THE GOOGLE END TOO. Deleting the ciphertext here does not
-- invalidate the service account ,delete the key (or the whole service
-- account) in the Google Cloud console, and remove its share from the
-- spreadsheet. See GUIDE.md section 8.
-- ---------------------------------------------------------------------------
delete from public.integration_secrets
 where key in ('sheets.api_key', 'sheets.service_account_json');
