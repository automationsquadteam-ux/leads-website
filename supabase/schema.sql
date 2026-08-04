-- ===========================================================================
-- Leads CRM — complete schema for a fresh Supabase project.
--
-- GENERATED FILE. Do not hand-edit: it is every migration in
-- supabase/migrations/ concatenated in filename order. Add a migration, then
-- regenerate this file.
--
-- For an EXISTING database, apply the incremental bundles instead:
--   schema-update-2-integrations.sql                   0009 + 0010
--   schema-update-3-remove-n8n.sql                     0011
--   schema-update-4-review-workflow.sql                0012 + 0013 + 0014
--   schema-update-5-verification-and-public-leads.sql  0015
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- source: supabase/migrations/20260803090000_init_enums_and_helpers.sql
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0001 — Extensions, enums and shared helper functions.
--
-- Everything downstream depends on this file, so it must stay first.
-- ---------------------------------------------------------------------------

-- gen_random_uuid() lives in pgcrypto on older servers; on PG13+ it is core.
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Exactly two roles, as per the product spec. Anything not 'admin' is treated
-- as read-only by every policy in this schema.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type public.app_role as enum ('admin', 'viewer');
  end if;
end
$$;

-- Lifecycle of a single lead through the outreach pipeline.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'lead_status') then
    create type public.lead_status as enum (
      'new',          -- freshly imported, nothing done yet
      'researching',  -- research in progress / partially enriched
      'ready',        -- research + draft exist, awaiting human approval
      'approved',     -- a human signed off on the draft
      'sending',      -- handed to the sending worker
      'sent',         -- delivered to the provider successfully
      'replied',      -- prospect responded
      'bounced',      -- hard/soft bounce reported by the provider
      'invalid',      -- unusable record (bad email, closed business, ...)
      'archived'      -- intentionally removed from the working set
    );
  end if;
end
$$;

-- Per-attempt outcome recorded in email_logs.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'email_log_status') then
    create type public.email_log_status as enum (
      'queued',
      'sent',
      'delivered',
      'opened',
      'clicked',
      'bounced',
      'complained',
      'failed'
    );
  end if;
end
$$;

-- Classification applied to an inbound reply.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'reply_sentiment') then
    create type public.reply_sentiment as enum (
      'positive',
      'neutral',
      'negative',
      'unsubscribe',
      'auto_reply'
    );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Helper: keep updated_at honest without trusting the client.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger function: stamps updated_at with the server clock.';


-- ---------------------------------------------------------------------------
-- source: supabase/migrations/20260803090100_profiles.sql
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0002 — profiles + the role helpers every RLS policy is built on.
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  role       public.app_role not null default 'viewer',
  full_name  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'One row per auth user. `role` is the single source of truth for authorization.';

create index if not exists profiles_role_idx on public.profiles (role);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Role helpers.
--
-- SECURITY DEFINER so they can read public.profiles from inside a policy that
-- is itself defined *on* public.profiles without recursing. search_path is
-- pinned so a caller cannot shadow `profiles` with their own relation.
-- ---------------------------------------------------------------------------

create or replace function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid();
$$;

comment on function public.current_app_role() is
  'Role of the calling user, or NULL when unauthenticated / profile missing.';

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select p.role = 'admin' from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

comment on function public.is_admin() is
  'True only for signed-in users whose profile role is admin. Fails closed.';

-- Any signed-in user with a profile. Dashboard views are gated on this.
create or replace function public.is_app_user()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid());
$$;

revoke all on function public.current_app_role() from public;
revoke all on function public.is_admin() from public;
revoke all on function public.is_app_user() from public;
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_app_user() to authenticated;

-- ---------------------------------------------------------------------------
-- Auto-provision a profile whenever an auth user is created.
--
-- The role is read from app_metadata (which only the service role can set), so
-- a user signing themselves up can never mint an admin profile: the COALESCE
-- falls through to 'viewer'.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_role text := new.raw_app_meta_data ->> 'role';
begin
  insert into public.profiles (id, role, full_name)
  values (
    new.id,
    case when requested_role = 'admin' then 'admin'::public.app_role
         else 'viewer'::public.app_role
    end,
    nullif(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Privilege-escalation guard.
--
-- The profiles UPDATE policy lets a user edit their own row (display name), so
-- the role column needs its own gate: only an admin may change it. WITH CHECK
-- cannot see the OLD row, hence a trigger.
-- ---------------------------------------------------------------------------
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Trusted callers: an admin acting through the API, or a trusted server-side
  -- session (migrations, the seed script running on the service role) where
  -- there is no end-user JWT to check in the first place.
  is_privileged boolean := public.is_admin()
    or auth.uid() is null
    or current_user in ('postgres', 'supabase_admin', 'service_role');
begin
  if new.role is distinct from old.role and not is_privileged then
    raise exception 'Only an admin may change a profile role'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_prevent_role_escalation on public.profiles;
create trigger profiles_prevent_role_escalation
  before update on public.profiles
  for each row execute function public.prevent_role_escalation();


-- ---------------------------------------------------------------------------
-- source: supabase/migrations/20260803090200_leads.sql
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0003 — leads
--
-- Column groups:
--   identity      business_name .. source
--   pipeline      status, timestamps, follow-up scheduling
--   research      the enrichment fields produced before drafting
--   outreach      subject_line / draft_email
--   bookkeeping   dedupe_key, import provenance, audit columns
-- ---------------------------------------------------------------------------

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),

  -- identity -----------------------------------------------------------------
  business_name text not null,
  website       text,
  email         text,
  phone         text,
  city          text,
  country       text,
  niche         text,   -- vertical: "Dental Clinics", "Travel Agencies", ...
  category      text,   -- qualification bucket: "Needs Automation", "Skip", ...
  source        text,   -- provenance, e.g. 'Leads.xlsx:Sheet2'

  -- pipeline -----------------------------------------------------------------
  status public.lead_status not null default 'new',

  -- research -----------------------------------------------------------------
  research_summary                  text,
  website_observations              text,
  automation_opportunities          text,
  ai_chatbot_opportunities          text,
  website_improvement_opportunities text,
  personalization                   text,
  interesting_facts                 text,
  outreach_angle                    text,
  social_links                      jsonb not null default '{}'::jsonb,
  researched_at                     timestamptz,

  -- outreach -----------------------------------------------------------------
  subject_line text,
  draft_email  text,
  drafted_at   timestamptz,

  -- operator notes -----------------------------------------------------------
  notes text,

  -- scheduling ---------------------------------------------------------------
  last_contacted_at timestamptz,
  next_followup_at  timestamptz,

  -- bookkeeping --------------------------------------------------------------
  -- Stable identity for the record, derived by the importer:
  --   email:<normalised email>  ->  preferred
  --   site:<normalised host+path>
  --   name:<business name>|<city>
  -- The UNIQUE constraint is what makes re-running the import a no-op.
  dedupe_key      text not null,
  import_batch_id uuid,
  imported_at     timestamptz,

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Full-text search over the non-sensitive identity fields. 'simple' (rather
  -- than a language config) keeps it immutable, which a generated column needs.
  search_vector tsvector generated always as (
    to_tsvector(
      'simple',
      coalesce(business_name, '') || ' ' ||
      coalesce(city, '')          || ' ' ||
      coalesce(country, '')       || ' ' ||
      coalesce(niche, '')         || ' ' ||
      coalesce(website, '')
    )
  ) stored,

  constraint leads_business_name_not_blank
    check (length(btrim(business_name)) between 1 and 300),
  constraint leads_dedupe_key_not_blank
    check (length(btrim(dedupe_key)) > 0),
  constraint leads_email_format
    check (email is null or email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$'),
  constraint leads_website_scheme
    check (website is null or website ~* '^https?://'),
  constraint leads_social_links_is_object
    check (jsonb_typeof(social_links) = 'object')
);

comment on table public.leads is
  'Cold-outreach prospects. Admin-only at the row level; viewers read the public.dashboard_* views instead.';
comment on column public.leads.dedupe_key is
  'Import identity (email > website > business name+city). UNIQUE — makes imports idempotent.';

create unique index if not exists leads_dedupe_key_key on public.leads (dedupe_key);

create index if not exists leads_status_idx        on public.leads (status);
create index if not exists leads_country_idx       on public.leads (country);
create index if not exists leads_niche_idx         on public.leads (niche);
create index if not exists leads_category_idx      on public.leads (category);
create index if not exists leads_created_at_idx    on public.leads (created_at desc);
create index if not exists leads_email_lower_idx   on public.leads (lower(email)) where email is not null;
create index if not exists leads_search_vector_idx on public.leads using gin (search_vector);

-- Partial index: the sending worker only ever scans leads that are actually due.
create index if not exists leads_next_followup_due_idx
  on public.leads (next_followup_at)
  where next_followup_at is not null and status not in ('archived', 'invalid', 'replied');

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- source: supabase/migrations/20260803090300_templates_and_campaigns.sql
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0004 — templates, campaigns, and the lead -> campaign link.
-- ---------------------------------------------------------------------------

create table if not exists public.templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  subject    text not null,
  body       text not null,
  -- Placeholder tokens the body expects, e.g. '{business_name, city}'. Purely
  -- descriptive for now; the renderer in a later prompt can validate against it.
  variables  text[] not null default '{}',
  is_active  boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint templates_name_not_blank check (length(btrim(name)) > 0)
);

comment on table public.templates is
  'Reusable email templates. Admin-only — viewers must never see template bodies.';

create unique index if not exists templates_name_key on public.templates (lower(name));

drop trigger if exists templates_set_updated_at on public.templates;
create trigger templates_set_updated_at
  before update on public.templates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------

create table if not exists public.campaigns (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  active      boolean not null default false,
  daily_limit integer not null default 50,
  template_id uuid references public.templates (id) on delete set null,
  starts_at   timestamptz,
  ends_at     timestamptz,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint campaigns_name_not_blank check (length(btrim(name)) > 0),
  constraint campaigns_daily_limit_sane check (daily_limit between 0 and 10000),
  constraint campaigns_window_ordered
    check (starts_at is null or ends_at is null or starts_at < ends_at)
);

comment on table public.campaigns is
  'Sending campaigns. Aggregate stats are exposed to viewers via public.dashboard_campaign_stats.';

create unique index if not exists campaigns_name_key on public.campaigns (lower(name));
create index if not exists campaigns_active_idx on public.campaigns (active) where active;
create index if not exists campaigns_template_id_idx on public.campaigns (template_id);

drop trigger if exists campaigns_set_updated_at on public.campaigns;
create trigger campaigns_set_updated_at
  before update on public.campaigns
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- A lead belongs to at most one campaign at a time. Added here rather than in
-- the leads migration because it depends on public.campaigns existing.
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists campaign_id uuid references public.campaigns (id) on delete set null;

create index if not exists leads_campaign_id_idx on public.leads (campaign_id);


-- ---------------------------------------------------------------------------
-- source: supabase/migrations/20260803090400_email_logs_and_replies.sql
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0005 — email_logs and replies (the append-only side of the system).
-- ---------------------------------------------------------------------------

create table if not exists public.email_logs (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.leads (id) on delete cascade,
  campaign_id uuid references public.campaigns (id) on delete set null,
  template_id uuid references public.templates (id) on delete set null,

  status   public.email_log_status not null default 'queued',
  provider text,   -- 'smtp', 'resend', 'sendgrid', ...

  -- Provider-side id, used to reconcile webhooks back to this row.
  message_id text,
  subject    text,

  sent_at    timestamptz,
  error      text,

  sent_by    uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.email_logs is
  'One row per send attempt. Append-only in practice; admins may correct rows, viewers see aggregates only.';

create index if not exists email_logs_lead_id_idx     on public.email_logs (lead_id);
create index if not exists email_logs_campaign_id_idx on public.email_logs (campaign_id);
create index if not exists email_logs_status_idx      on public.email_logs (status);
create index if not exists email_logs_sent_at_idx     on public.email_logs (sent_at desc);

-- A provider message id must map to exactly one log row so webhook handlers can
-- upsert safely. Partial: message_id is absent until the provider accepts it.
create unique index if not exists email_logs_message_id_key
  on public.email_logs (provider, message_id)
  where message_id is not null;

-- ---------------------------------------------------------------------------

create table if not exists public.replies (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references public.leads (id) on delete cascade,
  email_log_id uuid references public.email_logs (id) on delete set null,

  reply_text  text,
  sentiment   public.reply_sentiment,
  -- 0..1 confidence from whatever classifier produced `sentiment`.
  confidence  numeric(4, 3),
  is_handled  boolean not null default false,
  received_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),

  constraint replies_confidence_range
    check (confidence is null or confidence between 0 and 1)
);

comment on table public.replies is
  'Inbound responses. reply_text is prospect content — admin-only; viewers get counts via public.dashboard_reply_stats.';

create index if not exists replies_lead_id_idx     on public.replies (lead_id);
create index if not exists replies_received_at_idx on public.replies (received_at desc);
create index if not exists replies_sentiment_idx   on public.replies (sentiment);
create index if not exists replies_unhandled_idx   on public.replies (received_at desc) where not is_handled;


-- ---------------------------------------------------------------------------
-- source: supabase/migrations/20260803090500_settings.sql
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0006 — settings
--
-- Key/value rather than one wide row: the brief calls for "future configuration
-- values", and a jsonb value column lets later prompts add keys without a
-- migration. `is_sensitive` marks rows (SMTP credentials) that must never be
-- returned to the browser, even for admins.
-- ---------------------------------------------------------------------------

create table if not exists public.settings (
  key          text primary key,
  value        jsonb not null,
  description  text,
  is_sensitive boolean not null default false,
  updated_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint settings_key_format check (key ~ '^[a-z0-9]+(\.[a-z0-9_]+)*$')
);

comment on table public.settings is
  'Admin-only application configuration. Never expose is_sensitive rows to the client.';

drop trigger if exists settings_set_updated_at on public.settings;
create trigger settings_set_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Defaults. ON CONFLICT DO NOTHING so re-running never clobbers live config.
-- ---------------------------------------------------------------------------
insert into public.settings (key, value, description, is_sensitive) values
  ('sending.daily_limit',      '50'::jsonb,
   'Maximum outbound emails per day across all campaigns.', false),

  ('sending.working_hours',
   '{"timezone":"UTC","start":"09:00","end":"17:00","days":[1,2,3,4,5]}'::jsonb,
   'Window in which the sender is allowed to run. days: 1=Mon .. 7=Sun.', false),

  ('sending.min_gap_seconds',  '90'::jsonb,
   'Minimum delay between two consecutive sends, to look human.', false),

  ('sending.paused',           'false'::jsonb,
   'Global kill switch — when true no email leaves the system.', false),

  ('email.default_signature',
   '"Best regards,\nAutomation Squad\nhttps://automationsquad.example"'::jsonb,
   'Signature appended to drafts that do not define their own.', false),

  ('email.default_from_name',  '"Automation Squad"'::jsonb,
   'Display name on outbound email.', false),

  ('email.default_from_address', '""'::jsonb,
   'Envelope-from address. Must be a domain you control.', false),

  ('email.reply_to',           '""'::jsonb,
   'Reply-To header; leave empty to reuse the from address.', false),

  ('followup.default_delay_days', '4'::jsonb,
   'Days after a send before next_followup_at is proposed.', false),

  ('ai.default_model',         '"claude-sonnet-5"'::jsonb,
   'Model used for research and draft generation.', false),

  ('ai.temperature',           '0.7'::jsonb,
   'Sampling temperature for draft generation.', false),

  ('ai.max_tokens',            '2048'::jsonb,
   'Output token ceiling per draft generation call.', false),

  -- SMTP placeholders. Values stay empty here; the real credentials belong in
  -- environment variables / a secret manager, not in a database row.
  ('smtp.host',                '""'::jsonb, 'SMTP hostname (placeholder).',  true),
  ('smtp.port',                '587'::jsonb, 'SMTP port (587 STARTTLS, 465 TLS).', true),
  ('smtp.secure',              'false'::jsonb, 'True for implicit TLS on port 465.', true),
  ('smtp.username',            '""'::jsonb, 'SMTP username (placeholder).',  true),
  ('smtp.password_ref',        '""'::jsonb,
   'Name of the env var / secret holding the SMTP password. Never the password itself.', true),
  ('provider.name',            '"smtp"'::jsonb,
   'Active delivery provider: smtp | resend | sendgrid.', false)
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- source: supabase/migrations/20260803090600_dashboard_views.sql
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0007 — Dashboard views (the viewer role's ONLY window onto the data).
--
-- Why views instead of RLS policies on the base tables:
--   RLS is row-level. It cannot say "this role may read leads.status but not
--   leads.email". Viewers therefore get *no* row access to leads / templates /
--   replies / email_logs / settings at all, and read these aggregate views
--   instead.
--
--   Each view is created WITHOUT security_invoker, so it executes with the
--   privileges of its owner and bypasses the base tables' RLS. That is exactly
--   what makes them readable by viewers — which is also why every view below
--   must be audited for what it exposes. The rules:
--     * no email addresses, no phone numbers
--     * no research, personalization, drafts, subject lines or reply bodies
--     * counts, rates and non-sensitive identity fields only
--
--   `where public.is_app_user()` keeps anonymous/profile-less tokens out even
--   if a GRANT is ever loosened by mistake.
-- ---------------------------------------------------------------------------

-- Headline counters -----------------------------------------------------------
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
where public.is_app_user();

comment on view public.dashboard_overview is
  'Single-row KPI counters. Safe for viewers: aggregates only.';

-- Pipeline breakdown ----------------------------------------------------------
create or replace view public.dashboard_lead_status_counts
with (security_invoker = false) as
select
  l.status,
  count(*)::bigint as lead_count,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_total
from public.leads l
where public.is_app_user()
group by l.status;

-- Geography -------------------------------------------------------------------
create or replace view public.dashboard_leads_by_country
with (security_invoker = false) as
select
  coalesce(nullif(btrim(l.country), ''), 'Unknown') as country,
  count(*)::bigint                                              as lead_count,
  count(*) filter (where l.status = 'sent')::bigint             as sent_count,
  count(*) filter (where l.status = 'replied')::bigint          as replied_count,
  count(*) filter (where l.draft_email is not null)::bigint     as drafted_count
from public.leads l
where public.is_app_user()
group by 1;

-- Vertical --------------------------------------------------------------------
create or replace view public.dashboard_leads_by_niche
with (security_invoker = false) as
select
  coalesce(nullif(btrim(l.niche), ''), 'Unknown') as niche,
  count(*)::bigint                                            as lead_count,
  count(*) filter (where l.status = 'replied')::bigint        as replied_count
from public.leads l
where public.is_app_user()
group by 1;

-- Qualification bucket --------------------------------------------------------
create or replace view public.dashboard_leads_by_category
with (security_invoker = false) as
select
  coalesce(nullif(btrim(l.category), ''), 'Uncategorised') as category,
  count(*)::bigint as lead_count
from public.leads l
where public.is_app_user()
group by 1;

-- Intake over time ------------------------------------------------------------
create or replace view public.dashboard_leads_created_daily
with (security_invoker = false) as
select
  date_trunc('day', l.created_at)::date as day,
  count(*)::bigint                      as leads_added
from public.leads l
where public.is_app_user()
  and l.created_at >= now() - interval '180 days'
group by 1;

-- Campaign performance --------------------------------------------------------
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
where public.is_app_user()
group by c.id, c.name, c.active, c.daily_limit, c.starts_at, c.ends_at;

comment on view public.dashboard_campaign_stats is
  'Per-campaign counts and rates. No recipient identities.';

-- Sending activity ------------------------------------------------------------
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
where public.is_app_user()
  and coalesce(el.sent_at, el.created_at) >= now() - interval '180 days'
group by 1;

-- Reply statistics ------------------------------------------------------------
create or replace view public.dashboard_reply_stats
with (security_invoker = false) as
select
  coalesce(r.sentiment::text, 'unclassified') as sentiment,
  count(*)::bigint                            as reply_count,
  count(*) filter (where r.is_handled)::bigint     as handled_count,
  count(*) filter (where not r.is_handled)::bigint as unhandled_count,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_replies
from public.replies r
where public.is_app_user()
group by 1;

comment on view public.dashboard_reply_stats is
  'Reply counts by sentiment. Deliberately excludes replies.reply_text.';

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
where public.is_app_user()
  and r.received_at >= now() - interval '180 days'
group by 1;

-- Non-sensitive per-lead list -------------------------------------------------
-- Lets a viewer dashboard show "recent activity" without leaking anything.
-- Column list is allow-listed on purpose: adding a column here is a security
-- decision, so `select *` is never used.
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
where public.is_app_user();

comment on view public.dashboard_leads_safe is
  'Per-lead list with contact details, research and drafts stripped. Safe for viewers.';

-- ---------------------------------------------------------------------------
-- Grants: signed-in users only. Never anon.
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  foreach v in array array[
    'dashboard_overview',
    'dashboard_lead_status_counts',
    'dashboard_leads_by_country',
    'dashboard_leads_by_niche',
    'dashboard_leads_by_category',
    'dashboard_leads_created_daily',
    'dashboard_campaign_stats',
    'dashboard_email_activity_daily',
    'dashboard_reply_stats',
    'dashboard_reply_activity_daily',
    'dashboard_leads_safe'
  ]
  loop
    execute format('revoke all on public.%I from anon', v);
    execute format('grant select on public.%I to authenticated', v);
  end loop;
end
$$;


-- ---------------------------------------------------------------------------
-- source: supabase/migrations/20260803090700_rls_policies.sql
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0008 — Row Level Security.
--
-- Model:
--   admin   full CRUD on every table.
--   viewer  NO row access to any base table. Statistics reach them through the
--           public.dashboard_* views from migration 0007.
--   anon    nothing.
--
-- Every table below has RLS enabled AND at least one policy. A table with RLS
-- enabled and no matching policy denies by default, which is the behaviour we
-- rely on for viewers.
--
-- Note: the service_role key bypasses RLS entirely — that is what the import
-- and seed scripts use, and why that key must never reach the browser.
-- ---------------------------------------------------------------------------

alter table public.profiles   enable row level security;
alter table public.leads      enable row level security;
alter table public.campaigns  enable row level security;
alter table public.templates  enable row level security;
alter table public.email_logs enable row level security;
alter table public.replies    enable row level security;
alter table public.settings   enable row level security;

-- Deliberately NOT using FORCE ROW LEVEL SECURITY.
--
-- The dashboard_* views in migration 0007 run with their owner's privileges and
-- depend on that owner bypassing RLS on these base tables. FORCE would subject
-- the owner to RLS too, and since every policy here requires is_admin(), it
-- would silently return zero rows to viewers — blanking out every dashboard.
-- Table-level grants below plus the policies are the real gate.

-- Anonymous visitors get nothing anywhere; signed-in users get table access
-- shaped by the policies that follow. These grants are explicit rather than
-- relying on Supabase's default privileges.
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'leads', 'campaigns', 'templates', 'email_logs', 'replies', 'settings'
  ]
  loop
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- profiles
--
-- A user may always read their own profile — the app needs it to resolve the
-- role after sign-in. Admins may read and administer everyone.
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select_self  on public.profiles;
drop policy if exists profiles_select_admin on public.profiles;
drop policy if exists profiles_update_self  on public.profiles;
drop policy if exists profiles_update_admin on public.profiles;
drop policy if exists profiles_insert_admin on public.profiles;
drop policy if exists profiles_delete_admin on public.profiles;

create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy profiles_select_admin on public.profiles
  for select to authenticated
  using (public.is_admin());

-- Self-service edits are allowed, but the role column is guarded by the
-- prevent_role_escalation trigger from migration 0002.
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy profiles_update_admin on public.profiles
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy profiles_insert_admin on public.profiles
  for insert to authenticated
  with check (public.is_admin());

create policy profiles_delete_admin on public.profiles
  for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- leads / campaigns / templates / email_logs / replies / settings
--
-- Same shape for all six: admin-only, all four verbs. Generated in a loop so a
-- table can never be added to the list and then forgotten in one of the verbs.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'leads', 'campaigns', 'templates', 'email_logs', 'replies', 'settings'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select_admin', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_admin', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_admin', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_admin', t);

    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_admin())',
      t || '_select_admin', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.is_admin())',
      t || '_insert_admin', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())',
      t || '_update_admin', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.is_admin())',
      t || '_delete_admin', t);
  end loop;
end
$$;

comment on table public.leads is
  'Cold-outreach prospects. RLS: admin-only. Viewers read public.dashboard_* views.';


-- ---------------------------------------------------------------------------
-- source: supabase/migrations/20260803100000_restrict_viewer_dashboards.sql
-- ---------------------------------------------------------------------------

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


-- ---------------------------------------------------------------------------
-- source: supabase/migrations/20260803100100_integrations.sql
-- ---------------------------------------------------------------------------

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


-- ---------------------------------------------------------------------------
-- source: supabase/migrations/20260803110000_remove_n8n_add_sheet_writeback.sql
-- ---------------------------------------------------------------------------

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


-- ---------------------------------------------------------------------------
-- source: supabase/migrations/20260803120000_review_pipeline_and_versions.sql
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0012 — Admin review workflow: email versioning, outreach lifecycle, activity.
--
-- Three new tables and the machinery that keeps them honest:
--
--   email_versions   every draft ever produced, never overwritten. Exactly one
--                    row per (lead, type) may be `active`; that is the one the
--                    UI shows and the sender uses.
--   lead_pipeline    one row per lead describing where it sits in the outreach
--                    lifecycle. Stage and Next Step are DERIVED, never typed in.
--   lead_activity    append-only audit of what an admin did to a lead.
--
-- Design rule that everything below follows: the pipeline is a *projection* of
-- facts (an email exists, a draft was approved, a send happened, a reply
-- arrived), not a status field somebody remembers to update. Triggers derive it
-- so the CRM UI, the cron sender and any future integration all agree without
-- re-implementing the rules.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Which of the three emails in the sequence a draft belongs to.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'email_type') then
    create type public.email_type as enum ('initial', 'followup1', 'followup2');
  end if;
end
$$;

-- Review state of a single version. Rejecting keeps the row: the point of
-- versioning is that nothing is ever destroyed.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'email_version_status') then
    create type public.email_version_status as enum ('draft', 'approved', 'rejected');
  end if;
end
$$;

-- Where the lead currently sits. Ordered from earliest to latest so a plain
-- enum comparison sorts a board correctly.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'pipeline_stage') then
    create type public.pipeline_stage as enum (
      'need_email',         -- no address at all
      'need_verification',  -- address present, deliverability unproven
      'research',           -- verified, nothing researched yet
      'draft',              -- research done, no draft
      'review',             -- draft exists, awaiting a human
      'approved',           -- signed off, not yet sent
      'initial_sent',
      'followup1_sent',
      'followup2_sent',
      'replied',
      'closed'
    );
  end if;
end
$$;

-- The single action the operator (or the automation) should take next.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'pipeline_next_step') then
    create type public.pipeline_next_step as enum (
      'need_email',
      'need_verification',
      'research_lead',
      'generate_draft',
      'approve_draft',
      'send_initial_email',
      'await_followup1',    -- sent, follow-up 1 scheduled but not due
      'send_followup1',
      'await_followup2',
      'send_followup2',
      'close_workflow',     -- replied, or the sequence is exhausted
      'complete'
    );
  end if;
end
$$;

-- What the activity feed records. Kept as an enum so the feed cannot fill up
-- with free-text verbs that no query can filter on.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'activity_kind') then
    create type public.activity_kind as enum (
      'research_edited',
      'personalization_edited',
      'draft_edited',
      'draft_regenerated',
      'draft_approved',
      'draft_rejected',
      'version_activated',
      'stage_completed',
      'notes_edited',
      'status_changed',
      'email_sent',
      'reply_received',
      'sheet_synced'
    );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Small helpers for reading configuration out of public.settings inside a
-- trigger. `value` is jsonb; `#>> '{}'` extracts a scalar as text without the
-- surrounding quotes that ::text would leave on a json string.
-- ---------------------------------------------------------------------------
create or replace function public.setting_int(p_key text, p_default integer)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select nullif(s.value #>> '{}', '')::integer from public.settings s where s.key = p_key),
    p_default
  );
$$;

create or replace function public.setting_bool(p_key text, p_default boolean)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select nullif(s.value #>> '{}', '')::boolean from public.settings s where s.key = p_key),
    p_default
  );
$$;

comment on function public.setting_int(text, integer) is
  'Read an integer from public.settings. SECURITY DEFINER so triggers can read it past RLS.';

-- ---------------------------------------------------------------------------
-- email_versions
--
-- Regenerating a draft INSERTS; it never updates. Old versions stay readable
-- and any one of them can be re-activated.
-- ---------------------------------------------------------------------------
create table if not exists public.email_versions (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid not null references public.leads (id) on delete cascade,
  type           public.email_type not null,

  -- Assigned by the set_email_version_number trigger when left null, so callers
  -- never race each other computing max()+1 in application code.
  version_number integer not null,

  subject        text,
  content        text not null,

  status         public.email_version_status not null default 'draft',
  -- The version shown by default and used by the sender. At most one per
  -- (lead, type) — enforced by a partial unique index below.
  active         boolean not null default false,

  -- Provenance: 'manual', 'import', 'template', 'ollama:<model>', ...
  generated_by   text not null default 'manual',

  created_by     uuid references auth.users (id) on delete set null,
  reviewed_by    uuid references auth.users (id) on delete set null,
  reviewed_at    timestamptz,
  review_note    text,
  created_at     timestamptz not null default now(),

  constraint email_versions_content_not_blank check (length(btrim(content)) > 0),
  constraint email_versions_version_positive  check (version_number > 0),
  constraint email_versions_lead_type_version unique (lead_id, type, version_number)
);

comment on table public.email_versions is
  'Immutable draft history. Regenerate inserts a new row; nothing is overwritten. Admin-only.';
comment on column public.email_versions.active is
  'The version shown by default and sent. Partial unique index guarantees at most one per (lead, type).';

create unique index if not exists email_versions_single_active_idx
  on public.email_versions (lead_id, type)
  where active;

create index if not exists email_versions_lead_idx    on public.email_versions (lead_id, type, version_number desc);
create index if not exists email_versions_created_idx on public.email_versions (created_at desc);
create index if not exists email_versions_status_idx  on public.email_versions (status);

-- Fill in the next version number for this (lead, type) when the caller did not
-- supply one. The unique constraint remains the real guard against a race.
create or replace function public.set_email_version_number()
returns trigger
language plpgsql
as $$
begin
  if new.version_number is null then
    select coalesce(max(v.version_number), 0) + 1
      into new.version_number
      from public.email_versions v
     where v.lead_id = new.lead_id
       and v.type = new.type;
  end if;
  return new;
end;
$$;

drop trigger if exists email_versions_set_version_number on public.email_versions;
create trigger email_versions_set_version_number
  before insert on public.email_versions
  for each row execute function public.set_email_version_number();

-- Activating a version deactivates its siblings.
--
-- BEFORE, not AFTER: email_versions_single_active_idx is a plain unique index,
-- which Postgres checks the instant the row hits the heap. An AFTER trigger
-- would never run — the insert would already have failed with 23505. Clearing
-- the sibling first is what makes "activate this version" a single statement
-- for the caller.
--
-- The sibling UPDATE re-enters this trigger with new.active = false, which the
-- WHEN clause excludes, so there is no recursion.
create or replace function public.enforce_single_active_version()
returns trigger
language plpgsql
as $$
begin
  update public.email_versions
     set active = false
   where lead_id = new.lead_id
     and type = new.type
     and id is distinct from new.id
     and active;
  return new;
end;
$$;

drop trigger if exists email_versions_single_active on public.email_versions;
create trigger email_versions_single_active
  before insert or update of active on public.email_versions
  for each row when (new.active) execute function public.enforce_single_active_version();

-- ---------------------------------------------------------------------------
-- Mirror the active INITIAL version onto leads.subject_line / draft_email.
--
-- Why keep the copy: the sender, the Google Sheet write-back and the
-- dashboard_* views all read those two columns and predate versioning. Mirroring
-- means none of them had to change, and the sheet keeps showing the live draft.
-- email_versions stays the system of record; leads holds a derived copy.
-- ---------------------------------------------------------------------------
create or replace function public.mirror_active_initial_draft()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.active and new.type = 'initial' then
    update public.leads
       set subject_line = new.subject,
           draft_email  = new.content,
           drafted_at   = coalesce(drafted_at, new.created_at)
     where id = new.lead_id;
  end if;
  return null;
end;
$$;

drop trigger if exists email_versions_mirror_initial on public.email_versions;
create trigger email_versions_mirror_initial
  after insert or update of active, subject, content on public.email_versions
  for each row when (new.active and new.type = 'initial')
  execute function public.mirror_active_initial_draft();

-- ---------------------------------------------------------------------------
-- lead_pipeline
--
-- current_stage is never written by the application: a BEFORE trigger derives
-- it from the flags and timestamps on the same row.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_pipeline (
  lead_id uuid primary key references public.leads (id) on delete cascade,

  current_stage public.pipeline_stage not null default 'need_email',

  -- Gate flags. Each carries the moment it became true, so "average approval
  -- time" and friends are answerable without a separate event table.
  email_found           boolean not null default false,
  email_found_at        timestamptz,
  email_verified        boolean not null default false,
  email_verified_at     timestamptz,
  research_complete     boolean not null default false,
  research_completed_at timestamptz,
  draft_ready           boolean not null default false,
  draft_ready_at        timestamptz,
  approved              boolean not null default false,
  approved_at           timestamptz,

  -- Sequence timestamps. `_due` is computed on send; `_sent` is set by the
  -- email_logs trigger, so a send recorded by any path updates the pipeline.
  first_email_sent timestamptz,
  followup1_due    timestamptz,
  followup1_sent   timestamptz,
  followup2_due    timestamptz,
  followup2_sent   timestamptz,

  replied       timestamptz,
  closed        timestamptz,
  closed_reason text,

  -- Per-lead opt out of the automatic follow-up sender, without touching the
  -- global switch.
  auto_followups boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.lead_pipeline is
  'Outreach lifecycle projection, one row per lead. current_stage is derived by trigger; next step by public.compute_next_step().';

create index if not exists lead_pipeline_stage_idx      on public.lead_pipeline (current_stage);
create index if not exists lead_pipeline_followup1_idx  on public.lead_pipeline (followup1_due)
  where followup1_due is not null and followup1_sent is null and replied is null and closed is null;
create index if not exists lead_pipeline_followup2_idx  on public.lead_pipeline (followup2_due)
  where followup2_due is not null and followup2_sent is null and replied is null and closed is null;
create index if not exists lead_pipeline_approved_idx   on public.lead_pipeline (approved_at)
  where approved and first_email_sent is null;

drop trigger if exists lead_pipeline_set_updated_at on public.lead_pipeline;
create trigger lead_pipeline_set_updated_at
  before update on public.lead_pipeline
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Stage and Next Step — the two derivations the whole product hangs on.
--
-- Both take the row, not a lead id, so they can be applied inside a trigger on
-- NEW before it is written, and inside a view over many rows, with no extra
-- lookup. Latest fact wins: the CASE arms are ordered newest-first.
-- ---------------------------------------------------------------------------
create or replace function public.compute_pipeline_stage(p public.lead_pipeline)
returns public.pipeline_stage
language sql
immutable
as $$
  select (case
    when p.closed          is not null then 'closed'
    when p.replied         is not null then 'replied'
    when p.followup2_sent  is not null then 'followup2_sent'
    when p.followup1_sent  is not null then 'followup1_sent'
    when p.first_email_sent is not null then 'initial_sent'
    when p.approved                    then 'approved'
    when p.draft_ready                 then 'review'
    when p.research_complete           then 'draft'
    when p.email_verified              then 'research'
    when p.email_found                 then 'need_verification'
    else 'need_email'
  end)::public.pipeline_stage;
$$;

comment on function public.compute_pipeline_stage(public.lead_pipeline) is
  'Derives current_stage from the row. The ONE definition — do not re-implement in application code.';

-- STABLE, not IMMUTABLE: the follow-up arms compare a due date against now().
create or replace function public.compute_next_step(p public.lead_pipeline)
returns public.pipeline_next_step
language sql
stable
as $$
  select (case
    when p.closed is not null  then 'complete'
    when p.replied is not null then 'close_workflow'
    when p.followup2_sent is not null then 'close_workflow'
    when p.followup1_sent is not null then
      case when p.followup2_due is not null and p.followup2_due <= now()
           then 'send_followup2' else 'await_followup2' end
    when p.first_email_sent is not null then
      case when p.followup1_due is not null and p.followup1_due <= now()
           then 'send_followup1' else 'await_followup1' end
    when p.approved          then 'send_initial_email'
    when p.draft_ready       then 'approve_draft'
    when p.research_complete then 'generate_draft'
    when p.email_verified    then 'research_lead'
    when p.email_found       then 'need_verification'
    else 'need_email'
  end)::public.pipeline_next_step;
$$;

comment on function public.compute_next_step(public.lead_pipeline) is
  'Derives the next action. STABLE because the follow-up arms compare against now().';

-- Keep current_stage in step with the row on every write.
create or replace function public.set_pipeline_stage()
returns trigger
language plpgsql
as $$
begin
  new.current_stage := public.compute_pipeline_stage(new);

  -- Stamp the "became true at" columns exactly once, so timing analytics stay
  -- meaningful if a flag is toggled off and on again.
  if new.email_found       and new.email_found_at        is null then new.email_found_at        := now(); end if;
  if new.email_verified    and new.email_verified_at     is null then new.email_verified_at     := now(); end if;
  if new.research_complete and new.research_completed_at is null then new.research_completed_at := now(); end if;
  if new.draft_ready       and new.draft_ready_at        is null then new.draft_ready_at        := now(); end if;
  if new.approved          and new.approved_at           is null then new.approved_at           := now(); end if;

  return new;
end;
$$;

drop trigger if exists lead_pipeline_derive_stage on public.lead_pipeline;
create trigger lead_pipeline_derive_stage
  before insert or update on public.lead_pipeline
  for each row execute function public.set_pipeline_stage();

-- ---------------------------------------------------------------------------
-- Keeping the pipeline in step with the lead itself.
--
-- Direction of travel: evidence only ever turns a flag ON. A blank research
-- field does not un-complete research, because an admin may have marked the
-- stage complete deliberately — only an explicit UPDATE from the review UI
-- clears a flag. Getting this backwards would make the "Mark complete" button
-- silently undo itself on the next save.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_lead()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  has_email    boolean := new.email is not null and length(btrim(new.email)) > 0;
  has_research boolean := new.research_summary is not null and length(btrim(new.research_summary)) > 0;
  has_draft    boolean := new.draft_email is not null and length(btrim(new.draft_email)) > 0;
  is_approved  boolean := new.status in ('approved', 'sending', 'sent', 'replied');
begin
  insert into public.lead_pipeline as p (
    lead_id, email_found, research_complete, draft_ready, approved
  )
  values (new.id, has_email, has_research, has_draft, is_approved)
  on conflict (lead_id) do update
    set email_found       = p.email_found       or excluded.email_found,
        research_complete = p.research_complete or excluded.research_complete,
        draft_ready       = p.draft_ready       or excluded.draft_ready,
        approved          = p.approved          or excluded.approved;

  return null;
end;
$$;

drop trigger if exists leads_sync_pipeline on public.leads;
create trigger leads_sync_pipeline
  after insert or update of email, research_summary, draft_email, status on public.leads
  for each row execute function public.sync_pipeline_from_lead();

-- ---------------------------------------------------------------------------
-- A draft existing is what makes a lead "draft ready"; an approved active
-- version is what makes it "approved". Both are recorded on the version, so the
-- projection is driven from there rather than from a status field.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_version()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.lead_pipeline as p (lead_id, draft_ready, approved)
  values (
    new.lead_id,
    new.type = 'initial',
    new.type = 'initial' and new.active and new.status = 'approved'
  )
  on conflict (lead_id) do update
    set draft_ready = p.draft_ready or excluded.draft_ready,
        approved    = p.approved    or excluded.approved;

  return null;
end;
$$;

drop trigger if exists email_versions_sync_pipeline on public.email_versions;
create trigger email_versions_sync_pipeline
  after insert or update of status, active on public.email_versions
  for each row execute function public.sync_pipeline_from_version();

-- ---------------------------------------------------------------------------
-- A recorded send advances the sequence and schedules what comes after it.
--
--   initial   -> first_email_sent, followup1_due = sent + outreach.followup1_delay_days (7)
--   followup1 -> followup1_sent,   followup2_due = sent + outreach.followup2_delay_days (3)
--   followup2 -> followup2_sent    (sequence exhausted; next step is close)
--
-- Driven by email_logs so that ANY path which records a send — the Send button,
-- the cron sender, a future webhook reconciliation — advances the pipeline
-- identically. The email service never has to remember to do it.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_email_log()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sent_at timestamptz := coalesce(new.sent_at, now());
  d1 integer := public.setting_int('outreach.followup1_delay_days', 7);
  d2 integer := public.setting_int('outreach.followup2_delay_days', 3);
begin
  if new.status not in ('sent', 'delivered', 'opened', 'clicked') then
    return null;
  end if;

  insert into public.lead_pipeline (lead_id) values (new.lead_id)
  on conflict (lead_id) do nothing;

  if new.email_type = 'initial' then
    update public.lead_pipeline
       set first_email_sent = coalesce(first_email_sent, sent_at),
           followup1_due    = coalesce(followup1_due, sent_at + make_interval(days => d1))
     where lead_id = new.lead_id;

  elsif new.email_type = 'followup1' then
    update public.lead_pipeline
       set followup1_sent = coalesce(followup1_sent, sent_at),
           followup2_due  = coalesce(followup2_due, sent_at + make_interval(days => d2))
     where lead_id = new.lead_id;

  elsif new.email_type = 'followup2' then
    update public.lead_pipeline
       set followup2_sent = coalesce(followup2_sent, sent_at)
     where lead_id = new.lead_id;
  end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- A reply stops the sequence. `replied` alone moves Next Step to
-- "close_workflow"; closing stays an explicit act so a reply that turns out to
-- be an auto-responder can be undone without losing the record.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_reply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.lead_pipeline as p (lead_id, replied)
  values (new.lead_id, new.received_at)
  on conflict (lead_id) do update
    -- Keep the FIRST reply's timestamp; a later message does not reset it.
    set replied = coalesce(p.replied, excluded.replied);
  return null;
end;
$$;

drop trigger if exists replies_sync_pipeline on public.replies;
create trigger replies_sync_pipeline
  after insert on public.replies
  for each row execute function public.sync_pipeline_from_reply();

-- ---------------------------------------------------------------------------
-- lead_activity — the feed behind "Recent Activity" and the per-lead audit.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_activity (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.leads (id) on delete cascade,
  kind       public.activity_kind not null,
  summary    text not null,
  detail     text,
  actor_id   uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint lead_activity_summary_not_blank check (length(btrim(summary)) > 0)
);

comment on table public.lead_activity is
  'Append-only record of admin actions on a lead. Admin-only: summaries can quote draft content.';

create index if not exists lead_activity_lead_idx    on public.lead_activity (lead_id, created_at desc);
create index if not exists lead_activity_created_idx on public.lead_activity (created_at desc);
create index if not exists lead_activity_kind_idx    on public.lead_activity (kind, created_at desc);

-- ---------------------------------------------------------------------------
-- email_logs gains the sequence position.
--
-- Without it a send cannot tell the pipeline which step it satisfied, and
-- follow-up conversion analytics have nothing to group by. Existing rows are
-- initial sends by definition — nothing else existed when they were written.
-- ---------------------------------------------------------------------------
alter table public.email_logs
  add column if not exists email_type       public.email_type not null default 'initial',
  add column if not exists email_version_id uuid references public.email_versions (id) on delete set null;

create index if not exists email_logs_email_type_idx on public.email_logs (email_type, sent_at desc);

comment on column public.email_logs.email_type is
  'Which step of the sequence this attempt was. Drives lead_pipeline and follow-up analytics.';

-- Attached after the column exists, since the function reads new.email_type.
drop trigger if exists email_logs_sync_pipeline on public.email_logs;
create trigger email_logs_sync_pipeline
  after insert or update of status, sent_at on public.email_logs
  for each row execute function public.sync_pipeline_from_email_log();

-- ---------------------------------------------------------------------------
-- Admin-facing board view: the pipeline row plus its derived Next Step and the
-- lead identity needed to render a row. Admin-only (is_admin() inside the view);
-- the anonymous public dashboard uses the separate aggregate views in 0013.
--
-- Columns are listed explicitly, never `p.*`: a view built with * captures the
-- column list at creation time and silently goes stale after an ALTER TABLE.
-- ---------------------------------------------------------------------------
create or replace view public.pipeline_board
with (security_invoker = false) as
select
  p.lead_id,
  l.business_name,
  l.email,
  l.city,
  l.country,
  l.niche,
  l.status                       as lead_status,
  l.campaign_id,
  p.current_stage,
  public.compute_next_step(p)    as next_step,
  p.email_found,
  p.email_verified,
  p.research_complete,
  p.draft_ready,
  p.approved,
  p.approved_at,
  p.draft_ready_at,
  p.first_email_sent,
  p.followup1_due,
  p.followup1_sent,
  p.followup2_due,
  p.followup2_sent,
  p.replied,
  p.closed,
  p.closed_reason,
  p.auto_followups,
  p.updated_at
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where public.is_admin();

comment on view public.pipeline_board is
  'Admin-only pipeline rows with the derived next_step. Contains contact data — never grant to anon.';

-- ---------------------------------------------------------------------------
-- Row Level Security for the new tables. Same shape as migration 0008:
-- admin-only on all four verbs, anon revoked.
-- ---------------------------------------------------------------------------
alter table public.email_versions enable row level security;
alter table public.lead_pipeline  enable row level security;
alter table public.lead_activity  enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['email_versions', 'lead_pipeline', 'lead_activity']
  loop
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);

    execute format('drop policy if exists %I on public.%I', t || '_select_admin', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_admin', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_admin', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_admin', t);

    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_admin())',
      t || '_select_admin', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.is_admin())',
      t || '_insert_admin', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())',
      t || '_update_admin', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.is_admin())',
      t || '_delete_admin', t);
  end loop;
end
$$;

revoke all on public.pipeline_board from anon;
grant select on public.pipeline_board to authenticated;

-- setting_int / setting_bool are SECURITY DEFINER and therefore read
-- public.settings past RLS. Functions are executable by PUBLIC by default,
-- which would hand an anonymous token a way to probe configuration values one
-- key at a time. The triggers that need them are themselves SECURITY DEFINER
-- and run as the owner, so revoking costs nothing.
revoke all on function public.setting_int(text, integer) from public;
revoke all on function public.setting_bool(text, boolean) from public;
grant execute on function public.setting_int(text, integer) to authenticated;
grant execute on function public.setting_bool(text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Configuration for generation and the automatic sender.
--
-- auto_send_initial defaults to FALSE deliberately: follow-ups go to people who
-- already agreed to be contacted once, but a first touch firing without a human
-- ever looking at it is how a cold-outreach system becomes a spam cannon.
-- ---------------------------------------------------------------------------
insert into public.settings (key, value, description, is_sensitive) values
  ('outreach.auto_followups', 'true'::jsonb,
   'Let the scheduled sender deliver follow-ups that are due.', false),
  ('outreach.auto_send_initial', 'false'::jsonb,
   'Let the scheduled sender deliver APPROVED initial emails without a further click.', false),
  ('outreach.followup1_delay_days', '7'::jsonb,
   'Days after the initial send before follow-up 1 is due.', false),
  ('outreach.followup2_delay_days', '3'::jsonb,
   'Days after follow-up 1 before follow-up 2 is due.', false),
  ('outreach.require_verified_email', 'true'::jsonb,
   'The scheduled sender only touches leads whose address is marked verified.', false),
  ('outreach.followup_requires_approval', 'false'::jsonb,
   'Hold follow-ups for human approval instead of sending them when due. Follow-ups go to people already contacted once, so this is off by default.', false),
  ('outreach.max_sends_per_run', '25'::jsonb,
   'Ceiling on emails sent by a single scheduled run.', false),

  ('ai.provider', '"template"'::jsonb,
   'Draft generator: template (deterministic, no model) or ollama (local model).', false),
  ('ai.ollama_url', '"http://localhost:11434"'::jsonb,
   'Base URL of the Ollama server used when ai.provider = ollama.', false),
  ('ai.ollama_model', '"llama3.1:8b"'::jsonb,
   'Model tag pulled in Ollama, e.g. llama3.1:8b, qwen2.5:14b.', false),
  ('ai.timeout_seconds', '120'::jsonb,
   'How long to wait for a generation before giving up.', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Backfill.
--
-- Order matters: versions first, so that the pipeline rows created afterwards
-- already see a draft and land on the right stage.
-- ---------------------------------------------------------------------------

-- Every lead that already carries a draft gets version 1, marked as coming from
-- the import rather than pretending a model wrote it.
insert into public.email_versions (lead_id, type, version_number, subject, content, status, active, generated_by, created_at)
select
  l.id,
  'initial'::public.email_type,
  1,
  l.subject_line,
  l.draft_email,
  case when l.status in ('approved', 'sending', 'sent', 'replied')
       then 'approved'::public.email_version_status
       else 'draft'::public.email_version_status
  end,
  true,
  'import',
  coalesce(l.drafted_at, l.created_at)
from public.leads l
where l.draft_email is not null
  and length(btrim(l.draft_email)) > 0
  and not exists (
    select 1 from public.email_versions v where v.lead_id = l.id and v.type = 'initial'
  );

-- One pipeline row per lead. The flags come from the data that already exists;
-- email_verified stays false everywhere because nothing has verified anything
-- yet, and claiming otherwise would send mail to unproven addresses.
insert into public.lead_pipeline (
  lead_id, email_found, research_complete, draft_ready, approved,
  first_email_sent, replied
)
select
  l.id,
  l.email is not null and length(btrim(l.email)) > 0,
  l.research_summary is not null and length(btrim(l.research_summary)) > 0,
  l.draft_email is not null and length(btrim(l.draft_email)) > 0,
  l.status in ('approved', 'sending', 'sent', 'replied'),
  case when l.status in ('sent', 'replied') then l.last_contacted_at else null end,
  case when l.status = 'replied' then coalesce(l.last_contacted_at, l.updated_at) else null end
from public.leads l
on conflict (lead_id) do nothing;


-- ---------------------------------------------------------------------------
-- source: supabase/migrations/20260803120100_public_stats_views.sql
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0013 — Public statistics: the ONLY objects in this schema readable by anon.
--
-- READ THIS BEFORE TOUCHING ANY VIEW BELOW.
--
-- Migrations 0007 and 0009 established that no anonymous token can read
-- anything: every table has RLS with admin-only policies, and every dashboard_*
-- view carries `where public.is_admin()`. That invariant is deliberately broken
-- here, for these five views and nothing else, because the product requires a
-- login-free statistics page.
--
-- The rules these views live under:
--
--   * Aggregates only. Never a lead id, business name, website, email address,
--     phone number, city, note, research paragraph, draft, subject line or
--     reply body. Not even indirectly — a count grouped by business_name is a
--     list of business names with extra steps.
--   * Campaign NAMES are ours, not the prospects'. They are the one identifier
--     that appears here, and only because "Campaign Performance" is explicitly
--     part of the public brief.
--   * Column lists are written out. `select *` over a base table is how a
--     column added six months from now quietly becomes public.
--   * No `where public.is_admin()`: that is what makes them readable, and it is
--     why every column had to be justified above.
--
-- Adding a column to any view in this file is a disclosure decision. If you are
-- not certain it is aggregate-only, it does not belong here — put it in a
-- dashboard_* view instead, where is_admin() applies.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Headline counters + rates. One row.
-- ---------------------------------------------------------------------------
create or replace view public.public_stats_overview
with (security_invoker = false) as
select
  (select count(*) from public.lead_pipeline)::bigint                                          as total_leads,
  (select count(*) from public.lead_pipeline where current_stage = 'need_email')::bigint       as need_email,
  (select count(*) from public.lead_pipeline where current_stage = 'need_verification')::bigint as need_verification,
  (select count(*) from public.lead_pipeline where current_stage = 'research')::bigint         as researching,
  (select count(*) from public.lead_pipeline where current_stage = 'draft')::bigint            as awaiting_draft,
  (select count(*) from public.lead_pipeline where current_stage = 'review')::bigint           as draft_ready,
  (select count(*) from public.lead_pipeline where current_stage = 'approved')::bigint         as approved,
  (select count(*) from public.lead_pipeline where closed is not null)::bigint                 as closed,

  (select count(*) from public.email_logs
    where status in ('sent', 'delivered', 'opened', 'clicked'))::bigint                        as emails_sent,
  (select count(*) from public.email_logs)::bigint                                             as emails_attempted,
  (select count(*) from public.email_logs where status = 'bounced')::bigint                    as emails_bounced,
  (select count(*) from public.email_logs where email_type = 'initial'
     and status in ('sent', 'delivered', 'opened', 'clicked'))::bigint                         as initial_sent,
  (select count(*) from public.email_logs where email_type = 'followup1'
     and status in ('sent', 'delivered', 'opened', 'clicked'))::bigint                         as followup1_sent,
  (select count(*) from public.email_logs where email_type = 'followup2'
     and status in ('sent', 'delivered', 'opened', 'clicked'))::bigint                         as followup2_sent,

  (select count(*) from public.replies)::bigint                                                as replies,
  (select count(*) from public.replies where sentiment = 'positive')::bigint                   as positive_replies,
  (select count(*) from public.replies where sentiment = 'negative')::bigint                   as negative_replies,
  (select count(*) from public.replies where sentiment = 'neutral')::bigint                    as neutral_replies,

  -- Bounce rate is measured against every attempt, reply rate against
  -- successful sends: you cannot get a reply to a message that never left.
  round(
    100.0 * (select count(*) from public.email_logs where status = 'bounced')
    / nullif((select count(*) from public.email_logs), 0), 2
  )                                                                                            as bounce_rate_pct,
  round(
    100.0 * (select count(*) from public.replies)
    / nullif((select count(*) from public.email_logs
               where status in ('sent', 'delivered', 'opened', 'clicked')), 0), 2
  )                                                                                            as reply_rate_pct,

  -- Average hours between the message that prompted a reply and the reply
  -- itself. Prefers the log the reply is explicitly linked to; otherwise the
  -- most recent send to that lead before the reply arrived.
  (
    select round(avg(extract(epoch from (r.received_at - sent.sent_at)) / 3600.0)::numeric, 1)
    from public.replies r
    join lateral (
      select el.sent_at
      from public.email_logs el
      where el.sent_at is not null
        and (
          el.id = r.email_log_id
          or (r.email_log_id is null and el.lead_id = r.lead_id and el.sent_at <= r.received_at)
        )
      order by el.sent_at desc
      limit 1
    ) sent on true
  )                                                                                            as avg_response_hours;

comment on view public.public_stats_overview is
  'PUBLIC (anon-readable). Aggregate counters and rates only — no lead identity of any kind.';

-- ---------------------------------------------------------------------------
-- Stage distribution — the funnel chart.
-- ---------------------------------------------------------------------------
create or replace view public.public_stats_stages
with (security_invoker = false) as
select
  p.current_stage::text as stage,
  count(*)::bigint      as lead_count,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_total
from public.lead_pipeline p
group by p.current_stage;

comment on view public.public_stats_stages is
  'PUBLIC (anon-readable). Lead counts per pipeline stage.';

-- ---------------------------------------------------------------------------
-- Status distribution. Mirrors dashboard_lead_status_counts without the
-- is_admin() gate — a bare enum label and a count.
-- ---------------------------------------------------------------------------
create or replace view public.public_stats_statuses
with (security_invoker = false) as
select
  l.status::text   as status,
  count(*)::bigint as lead_count
from public.leads l
group by l.status;

comment on view public.public_stats_statuses is
  'PUBLIC (anon-readable). Lead counts per status enum value.';

-- ---------------------------------------------------------------------------
-- Daily sending / reply activity, 90 days. Feeds the public trend charts.
--
-- Emails and replies are aggregated separately and then full-joined on the day,
-- so a day with replies but no sends (or the reverse) still appears.
-- ---------------------------------------------------------------------------
create or replace view public.public_stats_activity_daily
with (security_invoker = false) as
with emails as (
  select
    date_trunc('day', coalesce(el.sent_at, el.created_at))::date as day,
    count(*) filter (where el.status in ('sent', 'delivered', 'opened', 'clicked'))::bigint as emails_sent,
    count(*) filter (where el.status = 'bounced')::bigint as emails_bounced
  from public.email_logs el
  where coalesce(el.sent_at, el.created_at) >= now() - interval '90 days'
  group by 1
),
inbound as (
  select
    date_trunc('day', r.received_at)::date as day,
    count(*)::bigint                                          as replies,
    count(*) filter (where r.sentiment = 'positive')::bigint  as positive_replies,
    count(*) filter (where r.sentiment = 'negative')::bigint  as negative_replies
  from public.replies r
  where r.received_at >= now() - interval '90 days'
  group by 1
)
select
  coalesce(e.day, i.day)            as day,
  coalesce(e.emails_sent, 0)        as emails_sent,
  coalesce(e.emails_bounced, 0)     as emails_bounced,
  coalesce(i.replies, 0)            as replies,
  coalesce(i.positive_replies, 0)   as positive_replies,
  coalesce(i.negative_replies, 0)   as negative_replies
from emails e
full outer join inbound i on i.day = e.day;

comment on view public.public_stats_activity_daily is
  'PUBLIC (anon-readable). Per-day send and reply counts for the last 90 days.';

-- ---------------------------------------------------------------------------
-- Campaign performance. Campaign names are our own labels, not prospect data.
-- Deliberately omits daily_limit and the schedule window — operational detail
-- with no reason to be public.
-- ---------------------------------------------------------------------------
create or replace view public.public_stats_campaigns
with (security_invoker = false) as
select
  c.name           as campaign_name,
  c.active,
  count(distinct l.id)::bigint as leads_assigned,
  count(distinct el.id) filter (
    where el.status in ('sent', 'delivered', 'opened', 'clicked')
  )::bigint                    as emails_sent,
  count(distinct el.id) filter (where el.status = 'bounced')::bigint as emails_bounced,
  count(distinct r.id)::bigint as replies_received,
  round(
    100.0 * count(distinct r.id)
    / nullif(count(distinct el.id) filter (
        where el.status in ('sent', 'delivered', 'opened', 'clicked')
      ), 0), 2
  )                            as reply_rate_pct,
  round(
    100.0 * count(distinct el.id) filter (where el.status = 'bounced')
    / nullif(count(distinct el.id), 0), 2
  )                            as bounce_rate_pct
from public.campaigns c
left join public.leads      l  on l.campaign_id = c.id
left join public.email_logs el on el.campaign_id = c.id
left join public.replies    r  on r.lead_id = l.id
group by c.id, c.name, c.active;

comment on view public.public_stats_campaigns is
  'PUBLIC (anon-readable). Per-campaign counts and rates. Campaign names are ours; no prospect data.';

-- ---------------------------------------------------------------------------
-- Grants.
--
-- This is the exception to "anon gets nothing". It is limited to these five
-- views; every table and every dashboard_* view stays closed.
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  foreach v in array array[
    'public_stats_overview',
    'public_stats_stages',
    'public_stats_statuses',
    'public_stats_activity_daily',
    'public_stats_campaigns'
  ]
  loop
    execute format('grant select on public.%I to anon, authenticated', v);
    -- Read-only, categorically: a view is not updatable through a grant we
    -- never issue, and stating it makes the intent unmistakable.
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', v);
  end loop;
end
$$;


-- ---------------------------------------------------------------------------
-- source: supabase/migrations/20260803120200_analytics_views.sql
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0014 — Admin analytics views.
--
-- Same contract as the dashboard_* family from 0007/0009: security_invoker is
-- off so the view reads past the base tables' admin-only RLS, and
-- `where public.is_admin()` inside the body is the actual gate. A viewer or an
-- anonymous token selecting from any of these gets zero rows.
--
-- These are NOT the public views. Anything anon may read lives in 0013 and is
-- named public_stats_*.
--
-- Everything the analytics pages show is computed here rather than in
-- TypeScript, so a number cannot mean one thing on the dashboard and something
-- else on the analytics page.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Sending volume at three resolutions.
--
-- date_trunc keeps the bucket a real timestamp, so ordering and range filters
-- work without parsing formatted labels back into dates.
-- ---------------------------------------------------------------------------
create or replace view public.analytics_email_weekly
with (security_invoker = false) as
select
  date_trunc('week', coalesce(el.sent_at, el.created_at))::date as week_start,
  count(*)::bigint                                                                        as attempts,
  count(*) filter (where el.status in ('sent', 'delivered', 'opened', 'clicked'))::bigint as sent,
  count(*) filter (where el.status = 'bounced')::bigint                                   as bounced,
  count(*) filter (where el.status = 'failed')::bigint                                    as failed
from public.email_logs el
where public.is_admin()
  and coalesce(el.sent_at, el.created_at) >= now() - interval '52 weeks'
group by 1;

create or replace view public.analytics_email_monthly
with (security_invoker = false) as
select
  date_trunc('month', coalesce(el.sent_at, el.created_at))::date as month_start,
  count(*)::bigint                                                                        as attempts,
  count(*) filter (where el.status in ('sent', 'delivered', 'opened', 'clicked'))::bigint as sent,
  count(*) filter (where el.status = 'bounced')::bigint                                   as bounced,
  count(*) filter (where el.status = 'failed')::bigint                                    as failed
from public.email_logs el
where public.is_admin()
  and coalesce(el.sent_at, el.created_at) >= now() - interval '24 months'
group by 1;

-- ---------------------------------------------------------------------------
-- Reply rate over time.
--
-- The rate is replies received on a day over emails sent on the same day. That
-- is a rate of *activity*, not a cohort conversion — a reply on Tuesday usually
-- belongs to Monday's send. Cohort attribution lives in
-- analytics_followup_conversion, which tracks the actual sequence.
-- ---------------------------------------------------------------------------
create or replace view public.analytics_reply_rate_daily
with (security_invoker = false) as
with emails as (
  select
    date_trunc('day', coalesce(el.sent_at, el.created_at))::date as day,
    count(*) filter (where el.status in ('sent', 'delivered', 'opened', 'clicked'))::bigint as sent
  from public.email_logs el
  where coalesce(el.sent_at, el.created_at) >= now() - interval '180 days'
  group by 1
),
inbound as (
  select date_trunc('day', r.received_at)::date as day, count(*)::bigint as replies
  from public.replies r
  where r.received_at >= now() - interval '180 days'
  group by 1
)
select
  coalesce(e.day, i.day)     as day,
  coalesce(e.sent, 0)        as sent,
  coalesce(i.replies, 0)     as replies,
  round(100.0 * coalesce(i.replies, 0) / nullif(coalesce(e.sent, 0), 0), 2) as reply_rate_pct
from emails e
full outer join inbound i on i.day = e.day
where public.is_admin();

-- ---------------------------------------------------------------------------
-- Funnel timing. One row; every figure in hours.
--
-- Each average only counts leads that actually passed through both ends of the
-- interval, so a lead still waiting for approval does not drag the average
-- down as if it took zero hours.
-- ---------------------------------------------------------------------------
-- FILTER binds to the AGGREGATE, never to a function wrapping it. Writing
-- `round(avg(x), 1) filter (...)` fails with 42809 "round is not an aggregate
-- function" — the parentheses below put the filter on avg() and the cast on its
-- result, which is what Postgres expects.
create or replace view public.analytics_funnel_timing
with (security_invoker = false) as
select
  round((avg(extract(epoch from (p.approved_at - p.draft_ready_at)) / 3600.0)
    filter (where p.approved_at is not null and p.draft_ready_at is not null
                  and p.approved_at >= p.draft_ready_at))::numeric, 1)         as avg_approval_hours,
  round((avg(extract(epoch from (p.first_email_sent - p.approved_at)) / 3600.0)
    filter (where p.first_email_sent is not null and p.approved_at is not null
                  and p.first_email_sent >= p.approved_at))::numeric, 1)       as avg_send_delay_hours,
  round((avg(extract(epoch from (p.replied - p.first_email_sent)) / 3600.0)
    filter (where p.replied is not null and p.first_email_sent is not null
                  and p.replied >= p.first_email_sent))::numeric, 1)           as avg_reply_hours,
  round((avg(extract(epoch from (p.draft_ready_at - p.research_completed_at)) / 3600.0)
    filter (where p.draft_ready_at is not null and p.research_completed_at is not null
                  and p.draft_ready_at >= p.research_completed_at))::numeric, 1) as avg_drafting_hours,
  count(*) filter (where p.approved_at is not null and p.draft_ready_at is not null)::bigint
                                                                               as approved_sample,
  count(*) filter (where p.first_email_sent is not null and p.approved_at is not null)::bigint
                                                                               as sent_sample
from public.lead_pipeline p
where public.is_admin();

-- ---------------------------------------------------------------------------
-- Template performance.
--
-- A send records template_id only when one was chosen explicitly; otherwise the
-- campaign's template is the one that produced the copy, so coalesce covers
-- both. Templates that have never been sent still appear, with zeroes — an
-- unused template is a finding, not a row to hide.
-- ---------------------------------------------------------------------------
create or replace view public.analytics_template_performance
with (security_invoker = false) as
with attributed as (
  select
    coalesce(el.template_id, c.template_id) as template_id,
    el.id                                   as log_id,
    el.lead_id,
    el.status
  from public.email_logs el
  left join public.campaigns c on c.id = el.campaign_id
)
select
  t.id                     as template_id,
  t.name                   as template_name,
  t.is_active,
  count(distinct a.log_id) filter (
    where a.status in ('sent', 'delivered', 'opened', 'clicked')
  )::bigint                as emails_sent,
  count(distinct a.log_id) filter (where a.status = 'bounced')::bigint as emails_bounced,
  count(distinct r.id)::bigint as replies_received,
  round(
    100.0 * count(distinct r.id)
    / nullif(count(distinct a.log_id) filter (
        where a.status in ('sent', 'delivered', 'opened', 'clicked')
      ), 0), 2
  )                        as reply_rate_pct
from public.templates t
left join attributed a on a.template_id = t.id
left join public.replies r on r.lead_id = a.lead_id
where public.is_admin()
group by t.id, t.name, t.is_active;

-- ---------------------------------------------------------------------------
-- Industry (niche) performance.
-- ---------------------------------------------------------------------------
create or replace view public.analytics_industry_performance
with (security_invoker = false) as
select
  coalesce(nullif(btrim(l.niche), ''), 'Unknown') as industry,
  count(distinct l.id)::bigint                    as leads,
  count(distinct el.id) filter (
    where el.status in ('sent', 'delivered', 'opened', 'clicked')
  )::bigint                                       as emails_sent,
  count(distinct r.id)::bigint                    as replies_received,
  count(distinct r.id) filter (where r.sentiment = 'positive')::bigint as positive_replies,
  round(
    100.0 * count(distinct r.id)
    / nullif(count(distinct el.id) filter (
        where el.status in ('sent', 'delivered', 'opened', 'clicked')
      ), 0), 2
  )                                               as reply_rate_pct
from public.leads l
left join public.email_logs el on el.lead_id = l.id
left join public.replies    r  on r.lead_id = l.id
where public.is_admin()
group by 1;

-- ---------------------------------------------------------------------------
-- Stage distribution (admin copy of the public one, so an admin page never has
-- to read from a public_stats_* view and blur the boundary between them).
-- ---------------------------------------------------------------------------
create or replace view public.analytics_stage_distribution
with (security_invoker = false) as
select
  p.current_stage::text as stage,
  count(*)::bigint      as lead_count,
  round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 2) as pct_of_total
from public.lead_pipeline p
where public.is_admin()
group by p.current_stage;

-- ---------------------------------------------------------------------------
-- Follow-up conversion.
--
-- A reply is attributed to the LAST step that had been sent when it arrived —
-- the only attribution the data actually supports. `sent` counts leads that
-- reached the step, not raw messages, so the rate is "of the people who got
-- this email, how many answered".
-- ---------------------------------------------------------------------------
create or replace view public.analytics_followup_conversion
with (security_invoker = false) as
with steps as (
  select
    'initial' as step, 1 as step_order,
    count(*) filter (where p.first_email_sent is not null)::bigint as sent,
    count(*) filter (
      where p.replied is not null
        and p.first_email_sent is not null
        and p.replied >= p.first_email_sent
        and (p.followup1_sent is null or p.replied < p.followup1_sent)
    )::bigint as replies
  from public.lead_pipeline p

  union all
  select
    'followup1', 2,
    count(*) filter (where p.followup1_sent is not null)::bigint,
    count(*) filter (
      where p.replied is not null
        and p.followup1_sent is not null
        and p.replied >= p.followup1_sent
        and (p.followup2_sent is null or p.replied < p.followup2_sent)
    )::bigint
  from public.lead_pipeline p

  union all
  select
    'followup2', 3,
    count(*) filter (where p.followup2_sent is not null)::bigint,
    count(*) filter (
      where p.replied is not null
        and p.followup2_sent is not null
        and p.replied >= p.followup2_sent
    )::bigint
  from public.lead_pipeline p
)
select
  s.step,
  s.step_order,
  s.sent,
  s.replies,
  round(100.0 * s.replies / nullif(s.sent, 0), 2) as reply_rate_pct
from steps s
where public.is_admin();

-- ---------------------------------------------------------------------------
-- Draft regeneration activity — "how much are we rewriting, and by what".
-- ---------------------------------------------------------------------------
create or replace view public.analytics_generation_daily
with (security_invoker = false) as
select
  date_trunc('day', v.created_at)::date as day,
  v.generated_by,
  count(*)::bigint                                        as versions_created,
  count(*) filter (where v.status = 'approved')::bigint   as approved,
  count(*) filter (where v.status = 'rejected')::bigint   as rejected
from public.email_versions v
where public.is_admin()
  and v.created_at >= now() - interval '180 days'
group by 1, 2;

-- ---------------------------------------------------------------------------
-- Grants: signed-in users only. is_admin() inside each body is the real gate.
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  foreach v in array array[
    'analytics_email_weekly',
    'analytics_email_monthly',
    'analytics_reply_rate_daily',
    'analytics_funnel_timing',
    'analytics_template_performance',
    'analytics_industry_performance',
    'analytics_stage_distribution',
    'analytics_followup_conversion',
    'analytics_generation_daily'
  ]
  loop
    execute format('revoke all on public.%I from anon', v);
    execute format('grant select on public.%I to authenticated', v);
  end loop;
end
$$;


-- ---------------------------------------------------------------------------
-- source: supabase/migrations/20260804120000_verification_versions_and_public_leads.sql
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0015 — Email verification, draft-version repair, and opt-in public leads.
--
-- Fixes three things the live data exposed, plus one new feature.
--
-- BUG 1 — 145 leads have leads.draft_email but no email_versions row.
--   The 0012 backfill was a one-time INSERT. After the leads were purged and
--   re-synced from the sheet, drafts arrived again but nothing created versions
--   for them, so the review workspace reported "no draft yet" for leads that
--   plainly had one. Fixed by a trigger, so it can never drift again.
--
-- BUG 2 — 58 leads are status='sent' but lead_pipeline.first_email_sent is
--   NULL, because they were sent by the upstream n8n pipeline and the sheet's
--   "Date Sent" column is empty. Their stage read 'approved' and follow-up
--   conversion counted zero sends.
--
-- BUG 3 — analytics_industry_performance counted email_logs rows, which only
--   ever contain sends made BY THIS CRM. With every send done upstream it
--   reported 0 while the status counts said 58. Rebased on lead_pipeline, which
--   records that a lead was emailed regardless of who did it.
--
-- NEW — email verification state (NeverBounce and friends), and an opt-in,
--   admin-controlled public lead list.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Verification state.
--
-- A boolean cannot express what a verifier actually returns. `accept_all` means
-- the domain accepts every address, so the check proves nothing either way;
-- `unknown` means the verifier gave up. Collapsing those into true or false
-- throws away exactly the distinction that decides whether it is safe to send.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'email_verification_status') then
    create type public.email_verification_status as enum (
      'unverified',  -- never checked
      'valid',       -- deliverable
      'invalid',     -- hard bounce guaranteed; needs a new address
      'accept_all',  -- catch-all domain: unverifiable, not necessarily bad
      'unknown'      -- verifier could not decide
    );
  end if;
end
$$;

alter table public.lead_pipeline
  add column if not exists email_verification_status public.email_verification_status
    not null default 'unverified',
  add column if not exists email_verification_source text,   -- 'neverbounce', 'manual', ...
  add column if not exists email_checked_at timestamptz;

comment on column public.lead_pipeline.email_verification_status is
  'Result from an email verifier. invalid sends the lead back to the need_email stage.';

create index if not exists lead_pipeline_verification_idx
  on public.lead_pipeline (email_verification_status);

-- ---------------------------------------------------------------------------
-- Stage derivation now understands a dead address.
--
-- An address that hard-bounces is worse than no address: it looks actionable
-- and is not. Such a lead goes back to 'need_email' so it surfaces in the
-- "Leads Missing Email" queue and someone finds a new one. leads.email is kept
-- — the record of what was tried has value.
-- ---------------------------------------------------------------------------
create or replace function public.compute_pipeline_stage(p public.lead_pipeline)
returns public.pipeline_stage
language sql
immutable
as $$
  select (case
    when p.closed          is not null then 'closed'
    when p.replied         is not null then 'replied'
    when p.followup2_sent  is not null then 'followup2_sent'
    when p.followup1_sent  is not null then 'followup1_sent'
    when p.first_email_sent is not null then 'initial_sent'
    when p.approved                    then 'approved'
    when p.draft_ready                 then 'review'
    when p.research_complete           then 'draft'
    when p.email_verified              then 'research'
    -- A proven-dead address needs replacing before anything else can happen.
    when p.email_verification_status = 'invalid' then 'need_email'
    when p.email_found                 then 'need_verification'
    else 'need_email'
  end)::public.pipeline_stage;
$$;

create or replace function public.compute_next_step(p public.lead_pipeline)
returns public.pipeline_next_step
language sql
stable
as $$
  select (case
    when p.closed is not null  then 'complete'
    when p.replied is not null then 'close_workflow'
    when p.followup2_sent is not null then 'close_workflow'
    when p.followup1_sent is not null then
      case when p.followup2_due is not null and p.followup2_due <= now()
           then 'send_followup2' else 'await_followup2' end
    when p.first_email_sent is not null then
      case when p.followup1_due is not null and p.followup1_due <= now()
           then 'send_followup1' else 'await_followup1' end
    when p.approved          then 'send_initial_email'
    when p.draft_ready       then 'approve_draft'
    when p.research_complete then 'generate_draft'
    when p.email_verified    then 'research_lead'
    when p.email_verification_status = 'invalid' then 'need_email'
    when p.email_found       then 'need_verification'
    else 'need_email'
  end)::public.pipeline_next_step;
$$;

-- ---------------------------------------------------------------------------
-- Keep email_verified in step with the verification result.
--
-- Only 'valid' proves deliverability. 'accept_all' and 'unknown' are left for a
-- human to decide, because auto-verifying a catch-all domain is how a bounce
-- rate quietly climbs.
-- ---------------------------------------------------------------------------
create or replace function public.set_pipeline_stage()
returns trigger
language plpgsql
as $$
begin
  if new.email_verification_status = 'valid' then
    new.email_verified := true;
  elsif new.email_verification_status = 'invalid' then
    new.email_verified := false;
  end if;

  new.current_stage := public.compute_pipeline_stage(new);

  if new.email_found       and new.email_found_at        is null then new.email_found_at        := now(); end if;
  if new.email_verified    and new.email_verified_at     is null then new.email_verified_at     := now(); end if;
  if new.research_complete and new.research_completed_at is null then new.research_completed_at := now(); end if;
  if new.draft_ready       and new.draft_ready_at        is null then new.draft_ready_at        := now(); end if;
  if new.approved          and new.approved_at           is null then new.approved_at           := now(); end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- BUG 1 — a draft on the lead always produces a version.
--
-- Drafts arrive on leads.draft_email from the sheet sync and the workbook
-- importer, neither of which knows about versioning. This turns that column
-- into a version automatically.
--
-- The content comparison is what makes it safe: mirror_active_initial_draft()
-- writes the active version's text back onto the lead, and without the
-- comparison that write would create another identical version, and so on
-- forever. Identical content is a no-op; genuinely new upstream text becomes
-- the next version, which is exactly the behaviour you want from a sheet that
-- someone keeps editing.
-- ---------------------------------------------------------------------------
create or replace function public.version_lead_draft()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  active_content text;
begin
  if new.draft_email is null or length(btrim(new.draft_email)) = 0 then
    return null;
  end if;

  select v.content into active_content
    from public.email_versions v
   where v.lead_id = new.id and v.type = 'initial' and v.active
   limit 1;

  -- Already the active text: this is the mirror writing back. Stop.
  if active_content is not distinct from new.draft_email then
    return null;
  end if;

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
    true,
    -- These are produced by the n8n + Ollama pipeline outside this CRM. Naming
    -- the real origin keeps "which generator performed" answerable later.
    'ollama:external'
  );

  return null;
end;
$$;

drop trigger if exists leads_version_draft on public.leads;
create trigger leads_version_draft
  after insert or update of draft_email, subject_line on public.leads
  for each row execute function public.version_lead_draft();

-- ---------------------------------------------------------------------------
-- BUG 2 — a lead the sheet reports as sent has been sent.
--
-- Recorded on the pipeline rather than as a fabricated email_logs row:
-- email_logs means "this CRM sent this", and inventing entries there would
-- corrupt the one table that is supposed to be evidence of our own sending.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_lead()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  has_email    boolean := new.email is not null and length(btrim(new.email)) > 0;
  has_research boolean := new.research_summary is not null and length(btrim(new.research_summary)) > 0;
  has_draft    boolean := new.draft_email is not null and length(btrim(new.draft_email)) > 0;
  is_approved  boolean := new.status in ('approved', 'sending', 'sent', 'replied');
  was_sent     boolean := new.status in ('sent', 'replied');
begin
  insert into public.lead_pipeline as p (
    lead_id, email_found, research_complete, draft_ready, approved, first_email_sent
  )
  values (
    new.id, has_email, has_research, has_draft, is_approved,
    -- No Date Sent in the sheet for these, so fall back to when we learned of
    -- it. coalesce never overwrites a real send timestamp recorded by the
    -- email_logs trigger.
    case when was_sent then coalesce(new.last_contacted_at, new.imported_at, now()) else null end
  )
  on conflict (lead_id) do update
    set email_found       = p.email_found       or excluded.email_found,
        research_complete = p.research_complete or excluded.research_complete,
        draft_ready       = p.draft_ready       or excluded.draft_ready,
        approved          = p.approved          or excluded.approved,
        first_email_sent  = coalesce(p.first_email_sent, excluded.first_email_sent);

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- BUG 3 — industry analytics measured the wrong thing.
--
-- `email_logs` answers "what did this CRM send". `lead_pipeline` answers "was
-- this lead emailed", which is the question a per-industry breakdown is asking
-- and the only one that stays correct while sending happens upstream.
--
-- DROP before CREATE, not CREATE OR REPLACE.
--
-- Replace can only APPEND columns to a view. This definition inserts
-- `followups_sent` between `emails_sent` and `replies_received`, which Postgres
-- reads as renaming the fourth column and refuses:
--
--   42P16: cannot change name of view column "replies_received" to "followups_sent"
--
-- Nothing depends on this view — it is a leaf read by the analytics page — so
-- dropping it is safe and needs no CASCADE.
-- ---------------------------------------------------------------------------
drop view if exists public.analytics_industry_performance;

create view public.analytics_industry_performance
with (security_invoker = false) as
select
  coalesce(nullif(btrim(l.niche), ''), 'Unknown') as industry,
  count(*)::bigint                                                        as leads,
  count(*) filter (where p.first_email_sent is not null)::bigint          as emails_sent,
  count(*) filter (where p.followup1_sent is not null)::bigint            as followups_sent,
  count(*) filter (where p.replied is not null)::bigint                   as replies_received,
  count(*) filter (
    where p.replied is not null
      and exists (select 1 from public.replies r
                   where r.lead_id = l.id and r.sentiment = 'positive')
  )::bigint                                                               as positive_replies,
  round(
    100.0 * count(*) filter (where p.replied is not null)
    / nullif(count(*) filter (where p.first_email_sent is not null), 0), 2
  )                                                                       as reply_rate_pct
from public.leads l
join public.lead_pipeline p on p.lead_id = l.id
where public.is_admin()
group by 1;

comment on view public.analytics_industry_performance is
  'Per-industry counts from lead_pipeline, so upstream sends are included. email_logs would only show sends made by this CRM.';

-- ---------------------------------------------------------------------------
-- Opt-in public lead list.
--
-- Default-denied twice over: the master switch is off, and the allowed-stage
-- list is empty. Turning the switch on with an empty list still discloses
-- nothing.
--
-- The column list is the entire security boundary here, so it is spelled out
-- and deliberately short: business name, city, country, industry, stage. No
-- email, no phone, no website, no research, no draft, no notes, no id.
-- ---------------------------------------------------------------------------
insert into public.settings (key, value, description, is_sensitive) values
  ('public.show_leads', 'false'::jsonb,
   'Master switch for the public lead list on /stats. Off by default.', false),
  ('public.lead_stages', '[]'::jsonb,
   'Which pipeline stages may appear publicly, e.g. ["replied"]. Empty discloses nothing.', false),
  ('public.lead_limit', '50'::jsonb,
   'Maximum rows in the public lead list.', false)
on conflict (key) do nothing;

create or replace view public.public_stats_leads
with (security_invoker = false) as
select
  l.business_name,
  l.city,
  l.country,
  coalesce(nullif(btrim(l.niche), ''), 'Unknown') as industry,
  p.current_stage::text                          as stage
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where
  -- Settings are read as inline sub-selects rather than through the
  -- setting_bool() helper: that helper is SECURITY DEFINER and its EXECUTE
  -- grant is deliberately withheld from anon.
  coalesce(
    (select (s.value #>> '{}')::boolean from public.settings s where s.key = 'public.show_leads'),
    false
  )
  and p.current_stage::text in (
    select jsonb_array_elements_text(
      coalesce((select s.value from public.settings s where s.key = 'public.lead_stages'), '[]'::jsonb)
    )
  )
  and l.status not in ('invalid', 'archived')
order by l.business_name
limit (
  select coalesce(
    (select (s.value #>> '{}')::integer from public.settings s where s.key = 'public.lead_limit'),
    50
  )
);

comment on view public.public_stats_leads is
  'PUBLIC (anon-readable) and OFF by default. Name, city, country, industry and stage only — never contact details, research, drafts or notes.';

grant select on public.public_stats_leads to anon, authenticated;
revoke insert, update, delete on public.public_stats_leads from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Backfill. Order matters: versions first, then the sent timestamps, so the
-- stage recomputation at the end sees both.
-- ---------------------------------------------------------------------------

-- BUG 1: every lead holding a draft with no version gets one.
insert into public.email_versions (lead_id, type, version_number, subject, content, status, active, generated_by, created_at)
select
  l.id,
  'initial'::public.email_type,
  1,
  l.subject_line,
  l.draft_email,
  case when l.status in ('sent', 'replied') then 'approved'::public.email_version_status
       else 'draft'::public.email_version_status end,
  true,
  'ollama:external',
  coalesce(l.drafted_at, l.imported_at, l.created_at)
from public.leads l
where l.draft_email is not null
  and length(btrim(l.draft_email)) > 0
  and not exists (select 1 from public.email_versions v where v.lead_id = l.id and v.type = 'initial');

-- BUG 2: sheet-reported sends land on the pipeline.
update public.lead_pipeline p
   set first_email_sent = coalesce(l.last_contacted_at, l.imported_at, l.created_at)
  from public.leads l
 where l.id = p.lead_id
   and p.first_email_sent is null
   and l.status in ('sent', 'replied');

-- Force every row through set_pipeline_stage() so current_stage reflects the
-- new rules and the backfilled timestamps.
update public.lead_pipeline set updated_at = updated_at;

