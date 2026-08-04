-- ---------------------------------------------------------------------------
-- 0010 — Integration plumbing: n8n, Google Sheets ingestion, email providers.
--
-- NOTE: the n8n parts of this migration are removed again by 0011. This file is
-- left as-is because it has already been applied to the live database, and an
-- applied migration must never be edited — the follow-up migration is the
-- record of the change.
--
-- Splits configuration into two stores on purpose:
--   public.settings            non-secret config (host, port, sheet id, URLs)
--   public.integration_secrets ciphertext only, unreachable through PostgREST
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Secrets.
--
-- Values are encrypted by the application (AES-256-GCM, key from
-- APP_ENCRYPTION_KEY) before they ever reach Postgres, so a database dump on
-- its own discloses nothing.
--
-- Access is restricted to the service role: anon AND authenticated are revoked,
-- so no browser token can read this table even with a valid admin JWT. Server
-- code reaches it through createAdminClient() after its own assertAdmin().
-- ---------------------------------------------------------------------------
create table if not exists public.integration_secrets (
  key        text primary key,
  ciphertext text not null,
  hint       text,          -- e.g. last 4 chars, safe to show in the UI
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint integration_secrets_key_format check (key ~ '^[a-z0-9]+(\.[a-z0-9_]+)*$')
);

comment on table public.integration_secrets is
  'Encrypted integration credentials. Service-role only — never exposed to any browser token.';

drop trigger if exists integration_secrets_set_updated_at on public.integration_secrets;
create trigger integration_secrets_set_updated_at
  before update on public.integration_secrets
  for each row execute function public.set_updated_at();

alter table public.integration_secrets enable row level security;

-- No policies at all: RLS with zero policies denies everyone. The service role
-- bypasses RLS, which is the only intended access path.
revoke all on public.integration_secrets from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Integration run history.
--
-- Backs the "Running / Success / Failed / Last run time" display. Persisted
-- rather than held in memory so the status survives a page reload, a redeploy,
-- and (later) a scheduled job running outside the browser entirely.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'integration_run_status') then
    create type public.integration_run_status as enum ('running', 'success', 'failed');
  end if;
end
$$;

create table if not exists public.integration_runs (
  id           uuid primary key default gen_random_uuid(),
  integration  text not null,   -- 'google_sheets' | 'email' (n8n removed in 0011)
  action       text not null,   -- 'sync_data' | 'test_connection' | 'send_test'
  status       public.integration_run_status not null default 'running',
  message      text,
  stats        jsonb not null default '{}'::jsonb,  -- imported / updated / skipped / invalid
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  duration_ms  integer,
  triggered_by uuid references auth.users (id) on delete set null,

  constraint integration_runs_integration_not_blank check (length(btrim(integration)) > 0)
);

comment on table public.integration_runs is
  'One row per integration invocation. Admin-readable; drives the trigger-button status UI.';

create index if not exists integration_runs_integration_idx
  on public.integration_runs (integration, started_at desc);
create index if not exists integration_runs_status_idx
  on public.integration_runs (status) where status = 'running';

alter table public.integration_runs enable row level security;

revoke all on public.integration_runs from anon;
grant select, insert, update, delete on public.integration_runs to authenticated;

drop policy if exists integration_runs_select_admin on public.integration_runs;
drop policy if exists integration_runs_insert_admin on public.integration_runs;
drop policy if exists integration_runs_update_admin on public.integration_runs;
drop policy if exists integration_runs_delete_admin on public.integration_runs;

create policy integration_runs_select_admin on public.integration_runs
  for select to authenticated using (public.is_admin());
create policy integration_runs_insert_admin on public.integration_runs
  for insert to authenticated with check (public.is_admin());
create policy integration_runs_update_admin on public.integration_runs
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy integration_runs_delete_admin on public.integration_runs
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Google Sheet provenance on leads.
--
-- sheet_row_number is the 1-based row in the source sheet. Storing it gives a
-- stable handle back to the origin row for later read/write/update, and makes
-- the sync summary point at a real line number when a row fails validation.
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists sheet_row_number integer,
  add column if not exists sheet_synced_at  timestamptz;

create index if not exists leads_sheet_row_number_idx
  on public.leads (sheet_row_number) where sheet_row_number is not null;

comment on column public.leads.sheet_row_number is
  'Row number in the source Google Sheet (1-based, includes the header row).';

-- ---------------------------------------------------------------------------
-- Configuration keys.
--
-- SMTP host/port/username are NOT secrets and were previously flagged
-- is_sensitive, which hid them from the settings screen. Only the password is
-- secret, and it now lives in integration_secrets.
-- ---------------------------------------------------------------------------
update public.settings
   set is_sensitive = false
 where key in ('smtp.host', 'smtp.port', 'smtp.secure', 'smtp.username');

delete from public.settings where key = 'smtp.password_ref';

insert into public.settings (key, value, description, is_sensitive) values
  ('n8n.webhook_url', '""'::jsonb,
   'n8n webhook URL invoked by the Sync Data button.', false),
  ('n8n.timeout_seconds', '30'::jsonb,
   'How long to wait for n8n before giving up.', false),
  ('n8n.include_api_key_header', 'false'::jsonb,
   'Send the stored n8n API key as an X-N8N-API-KEY header.', false),

  ('sheets.spreadsheet_id', '""'::jsonb,
   'Google Sheets document id (the long string in the sheet URL).', false),
  ('sheets.sheet_name', '"Sheet1"'::jsonb,
   'Worksheet/tab name to read.', false),
  ('sheets.header_row', '1'::jsonb,
   'Row number containing the column headers.', false),
  ('sheets.auth_mode', '"api_key"'::jsonb,
   'How to authenticate to Google: api_key (public sheets) or service_account.', false),
  ('sheets.update_existing', 'true'::jsonb,
   'Whether a sync refreshes leads that already exist.', false),

  ('email.provider', '"smtp"'::jsonb,
   'Active email provider: smtp | gmail. Only one is active at a time.', false),
  ('email.gmail_user', '""'::jsonb,
   'Gmail / Workspace address used to authenticate.', false),
  ('email.test_recipient', '""'::jsonb,
   'Default recipient for Send Test Email.', false)
on conflict (key) do nothing;
