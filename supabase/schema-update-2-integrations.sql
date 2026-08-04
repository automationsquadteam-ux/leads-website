-- ===========================================================================
--  LEADS CRM — UPDATE 2: INTEGRATIONS + VIEWER LOCKDOWN
--
--  Run this if you have ALREADY applied supabase/schema.sql once.
--  Paste the whole file into the Supabase SQL editor and press Run.
--
--  Safe to run more than once.
--
--  What it does
--    1. Restricts every dashboard_* view to admins only.
--       Viewers previously saw aggregate lead statistics; they now see nothing
--       until a viewer-specific view is defined.
--    2. Adds integration_secrets  (encrypted credentials, service-role only)
--       Adds integration_runs     (run history for the trigger buttons)
--       Adds leads.sheet_row_number / sheet_synced_at
--       Adds Google Sheets + email provider settings keys
--
--  GENERATED FILE — concatenated from supabase/migrations/. Edit those.
-- ===========================================================================

-- ===========================================================================
-- PART 1 of 2  --  20260803100000_restrict_viewer_dashboards.sql
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0009 — Restrict the dashboard views to admins.
--
-- Previously these views were guarded by public.is_app_user(), so any signed-in
-- user (including a viewer) could read aggregate lead statistics: totals,
-- per-country and per-niche breakdowns, campaign performance.
--
-- The requirement is now default-deny: only an admin sees data. What a viewer
-- is allowed to see will be specified separately, and should be added as its
-- own narrowly-scoped view rather than by widening these again.
--
-- Nothing else changes: the views keep running with owner privileges (that is
-- what lets them read past the admin-only RLS on the base tables), and the
-- authenticated grant stays — is_admin() inside the view is the actual gate.
-- ---------------------------------------------------------------------------

create or replace view public.dashboard_overview
with (security_invoker = false) as
select
  count(*)::bigint                                                          as total_leads,
  count(*) filter (where l.status = 'new')::bigint                          as new_leads,
  count(*) filter (where l.status = 'researching')::bigint                  as researching_leads,
  count(*) filter (where l.status in ('ready', 'approved'))::bigint         as ready_leads,
  count(*) filter (where l.status = 'sent')::bigint                         as sent_leads,
  count(*) filter (where l.status = 'replied')::bigint                      as replied_leads,
  count(*) filter (where l.status = 'bounced')::bigint                      as bounced_leads,
  count(*) filter (where l.status in ('invalid', 'archived'))::bigint       as excluded_leads,
  count(*) filter (where l.research_summary is not null)::bigint            as leads_with_research,
  count(*) filter (where l.draft_email is not null)::bigint                 as leads_with_draft,
  count(*) filter (where l.next_followup_at is not null
                     and l.next_followup_at <= now())::bigint               as followups_due,
  count(distinct l.country)::bigint                                         as countries_covered,
  count(distinct l.niche)::bigint                                           as niches_covered
from public.leads l
where public.is_admin();

create or replace view public.dashboard_lead_status_counts
with (security_invoker = false) as
select
  l.status,
  count(*)::bigint as lead_count,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_total
from public.leads l
where public.is_admin()
group by l.status;

create or replace view public.dashboard_leads_by_country
with (security_invoker = false) as
select
  coalesce(nullif(btrim(l.country), ''), 'Unknown') as country,
  count(*)::bigint                                              as lead_count,
  count(*) filter (where l.status = 'sent')::bigint             as sent_count,
  count(*) filter (where l.status = 'replied')::bigint          as replied_count,
  count(*) filter (where l.draft_email is not null)::bigint     as drafted_count
from public.leads l
where public.is_admin()
group by 1;

create or replace view public.dashboard_leads_by_niche
with (security_invoker = false) as
select
  coalesce(nullif(btrim(l.niche), ''), 'Unknown') as niche,
  count(*)::bigint                                            as lead_count,
  count(*) filter (where l.status = 'replied')::bigint        as replied_count
from public.leads l
where public.is_admin()
group by 1;

create or replace view public.dashboard_leads_by_category
with (security_invoker = false) as
select
  coalesce(nullif(btrim(l.category), ''), 'Uncategorised') as category,
  count(*)::bigint as lead_count
from public.leads l
where public.is_admin()
group by 1;

create or replace view public.dashboard_leads_created_daily
with (security_invoker = false) as
select
  date_trunc('day', l.created_at)::date as day,
  count(*)::bigint                      as leads_added
from public.leads l
where public.is_admin()
  and l.created_at >= now() - interval '180 days'
group by 1;

create or replace view public.dashboard_campaign_stats
with (security_invoker = false) as
select
  c.id            as campaign_id,
  c.name          as campaign_name,
  c.active,
  c.daily_limit,
  c.starts_at,
  c.ends_at,
  count(distinct l.id)::bigint                                             as leads_assigned,
  count(distinct el.id) filter (
    where el.status in ('sent', 'delivered', 'opened', 'clicked')
  )::bigint                                                                as emails_sent,
  count(distinct el.id) filter (where el.status = 'bounced')::bigint       as emails_bounced,
  count(distinct el.id) filter (where el.status = 'failed')::bigint        as emails_failed,
  count(distinct r.id)::bigint                                             as replies_received,
  round(
    100.0 * count(distinct r.id)
    / nullif(count(distinct el.id) filter (
        where el.status in ('sent', 'delivered', 'opened', 'clicked')
      ), 0),
    2
  )                                                                        as reply_rate_pct,
  round(
    100.0 * count(distinct el.id) filter (where el.status = 'bounced')
    / nullif(count(distinct el.id), 0),
    2
  )                                                                        as bounce_rate_pct
from public.campaigns c
left join public.leads      l  on l.campaign_id = c.id
left join public.email_logs el on el.campaign_id = c.id
left join public.replies    r  on r.lead_id = l.id
where public.is_admin()
group by c.id, c.name, c.active, c.daily_limit, c.starts_at, c.ends_at;

create or replace view public.dashboard_email_activity_daily
with (security_invoker = false) as
select
  date_trunc('day', coalesce(el.sent_at, el.created_at))::date          as day,
  count(*)::bigint                                                      as attempts,
  count(*) filter (where el.status in ('sent', 'delivered',
                                       'opened', 'clicked'))::bigint    as sent,
  count(*) filter (where el.status = 'delivered')::bigint               as delivered,
  count(*) filter (where el.status = 'opened')::bigint                  as opened,
  count(*) filter (where el.status = 'bounced')::bigint                 as bounced,
  count(*) filter (where el.status = 'failed')::bigint                  as failed
from public.email_logs el
where public.is_admin()
  and coalesce(el.sent_at, el.created_at) >= now() - interval '180 days'
group by 1;

create or replace view public.dashboard_reply_stats
with (security_invoker = false) as
select
  coalesce(r.sentiment::text, 'unclassified') as sentiment,
  count(*)::bigint                            as reply_count,
  count(*) filter (where r.is_handled)::bigint     as handled_count,
  count(*) filter (where not r.is_handled)::bigint as unhandled_count,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_replies
from public.replies r
where public.is_admin()
group by 1;

create or replace view public.dashboard_reply_activity_daily
with (security_invoker = false) as
select
  date_trunc('day', r.received_at)::date               as day,
  count(*)::bigint                                     as replies,
  count(*) filter (where r.sentiment = 'positive')::bigint    as positive,
  count(*) filter (where r.sentiment = 'neutral')::bigint     as neutral,
  count(*) filter (where r.sentiment = 'negative')::bigint    as negative,
  count(*) filter (where r.sentiment = 'unsubscribe')::bigint as unsubscribe
from public.replies r
where public.is_admin()
  and r.received_at >= now() - interval '180 days'
group by 1;

create or replace view public.dashboard_leads_safe
with (security_invoker = false) as
select
  l.id,
  l.business_name,
  l.city,
  l.country,
  l.niche,
  l.category,
  l.status,
  l.campaign_id,
  l.created_at,
  l.last_contacted_at,
  (l.research_summary is not null) as has_research,
  (l.draft_email is not null)      as has_draft
from public.leads l
where public.is_admin();

comment on view public.dashboard_overview is
  'Admin-only KPI counters. Viewer-facing views will be added separately when their scope is defined.';

-- ===========================================================================
-- PART 2 of 2  --  20260803100100_integrations.sql
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0010 — Integration plumbing: Google Sheets ingestion, email providers.
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
  integration  text not null,   -- 'google_sheets' | 'email'
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
  ('sheets.write_back', 'false'::jsonb,
   'Push CRM edits back to the source sheet row. Requires service_account auth with Editor access.', false),

  ('email.provider', '"smtp"'::jsonb,
   'Active email provider: smtp | gmail. Only one is active at a time.', false),
  ('email.gmail_user', '""'::jsonb,
   'Gmail / Workspace address used to authenticate.', false),
  ('email.test_recipient', '""'::jsonb,
   'Default recipient for Send Test Email.', false)
on conflict (key) do nothing;

-- ===========================================================================
-- DONE
-- ===========================================================================
--
-- Verify:
--
--   select relname, relrowsecurity from pg_class
--   where relnamespace = 'public'::regnamespace and relkind = 'r'
--   order by relrowsecurity, relname;
--
-- Every row must show relrowsecurity = true, including the two new tables.
