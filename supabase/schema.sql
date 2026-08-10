-- GENERATED: every migration in filename order. Regenerate after adding one.

-- --- source: supabase/migrations/20260803090000_init_enums_and_helpers.sql
-- ---------------------------------------------------------------------------
-- 0001 Extensions, enums and shared helper functions.
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

-- --- source: supabase/migrations/20260803090100_profiles.sql
-- ---------------------------------------------------------------------------
-- 0002 profiles + the role helpers every RLS policy is built on.
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

-- --- source: supabase/migrations/20260803090200_leads.sql
-- ---------------------------------------------------------------------------
-- 0003 leads
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
  'Import identity (email > website > business name+city). UNIQUE makes imports idempotent.';

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

-- --- source: supabase/migrations/20260803090300_templates_and_campaigns.sql
-- ---------------------------------------------------------------------------
-- 0004 templates, campaigns, and the lead -> campaign link.
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
  'Reusable email templates. Admin-only viewers must never see template bodies.';

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

-- --- source: supabase/migrations/20260803090400_email_logs_and_replies.sql
-- ---------------------------------------------------------------------------
-- 0005 email_logs and replies (the append-only side of the system).
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
  'Inbound responses. reply_text is prospect content admin-only; viewers get counts via public.dashboard_reply_stats.';

create index if not exists replies_lead_id_idx     on public.replies (lead_id);
create index if not exists replies_received_at_idx on public.replies (received_at desc);
create index if not exists replies_sentiment_idx   on public.replies (sentiment);
create index if not exists replies_unhandled_idx   on public.replies (received_at desc) where not is_handled;

-- --- source: supabase/migrations/20260803090500_settings.sql
-- ---------------------------------------------------------------------------
-- 0006 settings
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
   'Global kill switch when true no email leaves the system.', false),

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

-- --- source: supabase/migrations/20260803090600_dashboard_views.sql
-- ---------------------------------------------------------------------------
-- 0007 Dashboard views (the viewer role's ONLY window onto the data).
--
-- Why views instead of RLS policies on the base tables:
--   RLS is row-level. It cannot say "this role may read leads.status but not
--   leads.email". Viewers therefore get *no* row access to leads / templates /
--   replies / email_logs / settings at all, and read these aggregate views
--   instead.
--
--   Each view is created WITHOUT security_invoker, so it executes with the
--   privileges of its owner and bypasses the base tables' RLS. That is exactly
--   what makes them readable by viewers which is also why every view below
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

-- --- source: supabase/migrations/20260803090700_rls_policies.sql
-- ---------------------------------------------------------------------------
-- 0008 Row Level Security.
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
-- Note: the service_role key bypasses RLS entirely that is what the import
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
-- would silently return zero rows to viewers blanking out every dashboard.
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
-- A user may always read their own profile the app needs it to resolve the
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

-- --- source: supabase/migrations/20260803100000_restrict_viewer_dashboards.sql
-- ---------------------------------------------------------------------------
-- 0009 Restrict the dashboard views to admins.
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
-- authenticated grant stays is_admin() inside the view is the actual gate.
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

-- --- source: supabase/migrations/20260803100100_integrations.sql
-- ---------------------------------------------------------------------------
-- 0010 Integration plumbing: n8n, Google Sheets ingestion, email providers.
--
-- NOTE: the n8n parts of this migration are removed again by 0011. This file is
-- left as-is because it has already been applied to the live database, and an
-- applied migration must never be edited the follow-up migration is the
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
  'Encrypted integration credentials. Service-role only never exposed to any browser token.';

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

-- --- source: supabase/migrations/20260803110000_remove_n8n_add_sheet_writeback.sql
-- ---------------------------------------------------------------------------
-- 0011 Drop the n8n integration; add Google Sheets write-back.
--
-- n8n is no longer called from the CRM. Migration 0010 created its settings
-- keys and they have already been applied to the live database, so they are
-- removed here rather than by editing 0010 an applied migration must stay
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

-- --- source: supabase/migrations/20260803120000_review_pipeline_and_versions.sql
-- ---------------------------------------------------------------------------
-- 0012 Admin review workflow: email versioning, outreach lifecycle, activity.
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
  -- (lead, type) enforced by a partial unique index below.
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
-- would never run the insert would already have failed with 23505. Clearing
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
-- Stage and Next Step the two derivations the whole product hangs on.
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
  'Derives current_stage from the row. The ONE definition do not re-implement in application code.';

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
-- stage complete deliberately only an explicit UPDATE from the review UI
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
-- Driven by email_logs so that ANY path which records a send the Send button,
-- the cron sender, a future webhook reconciliation advances the pipeline
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
-- lead_activity the feed behind "Recent Activity" and the per-lead audit.
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
-- initial sends by definition nothing else existed when they were written.
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
  'Admin-only pipeline rows with the derived next_step. Contains contact data never grant to anon.';

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

-- --- source: supabase/migrations/20260803120100_public_stats_views.sql
-- ---------------------------------------------------------------------------
-- 0013 Public statistics: the ONLY objects in this schema readable by anon.
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
--     reply body. Not even indirectly a count grouped by business_name is a
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
-- not certain it is aggregate-only, it does not belong here put it in a
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
  'PUBLIC (anon-readable). Aggregate counters and rates only no lead identity of any kind.';

-- ---------------------------------------------------------------------------
-- Stage distribution the funnel chart.
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
-- is_admin() gate a bare enum label and a count.
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
-- Deliberately omits daily_limit and the schedule window operational detail
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

-- --- source: supabase/migrations/20260803120200_analytics_views.sql
-- ---------------------------------------------------------------------------
-- 0014 Admin analytics views.
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
-- is a rate of *activity*, not a cohort conversion a reply on Tuesday usually
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
-- function" the parentheses below put the filter on avg() and the cast on its
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
-- both. Templates that have never been sent still appear, with zeroes an
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
-- Draft regeneration activity "how much are we rewriting, and by what".
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

-- --- source: supabase/migrations/20260804120000_verification_versions_and_public_leads.sql
-- ---------------------------------------------------------------------------
-- 0015 Email verification, draft-version repair, and opt-in public leads.
--
-- Fixes three things the live data exposed, plus one new feature.
--
-- BUG 1 145 leads have leads.draft_email but no email_versions row.
--   The 0012 backfill was a one-time INSERT. After the leads were purged and
--   re-synced from the sheet, drafts arrived again but nothing created versions
--   for them, so the review workspace reported "no draft yet" for leads that
--   plainly had one. Fixed by a trigger, so it can never drift again.
--
-- BUG 2 58 leads are status='sent' but lead_pipeline.first_email_sent is
--   NULL, because they were sent by the upstream n8n pipeline and the sheet's
--   "Date Sent" column is empty. Their stage read 'approved' and follow-up
--   conversion counted zero sends.
--
-- BUG 3 analytics_industry_performance counted email_logs rows, which only
--   ever contain sends made BY THIS CRM. With every send done upstream it
--   reported 0 while the status counts said 58. Rebased on lead_pipeline, which
--   records that a lead was emailed regardless of who did it.
--
-- NEW email verification state (NeverBounce and friends), and an opt-in,
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
-- the record of what was tried has value.
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
-- BUG 1 a draft on the lead always produces a version.
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
-- BUG 2 a lead the sheet reports as sent has been sent.
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
-- BUG 3 industry analytics measured the wrong thing.
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
-- Nothing depends on this view it is a leaf read by the analytics page so
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
  'PUBLIC (anon-readable) and OFF by default. Name, city, country, industry and stage only never contact details, research, drafts or notes.';

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

-- --- source: supabase/migrations/20260804140000_inbound_messages.sql
-- ---------------------------------------------------------------------------
-- 0016 — Inbound mail: staging, matching, and the auto-reply trigger fix.
--
-- Two things here.
--
-- FIRST, a latent bug that would have bitten the moment inbound mail started
-- arriving. sync_pipeline_from_reply() sets lead_pipeline.replied on ANY row
-- inserted into public.replies. Out-of-office notices are the single most
-- common thing that comes back from cold outreach, so ingesting them as replies
-- would mark those leads as having answered and permanently stop their
-- follow-up sequence. The trigger now ignores 'auto_reply'.
--
-- SECOND, public.inbound_messages: everything that arrives, whether or not we
-- can attribute it.
--
-- Why a staging table instead of relaxing replies.lead_id to nullable:
--
--   * public.replies drives lead_pipeline.replied, reply rate, average response
--     time and follow-up conversion. It has to mean "a real person at a known
--     lead answered us". Bounces and autoresponders in there would corrupt
--     every one of those figures.
--   * An unattributable message still needs to be seen, kept and assignable by
--     hand. That is a different lifecycle from a reply and deserves its own row.
--
-- So: inbound_messages is the log of what arrived; public.replies stays the
-- record of genuine replies, created when a message is matched.
-- ---------------------------------------------------------------------------

-- What kind of thing arrived. Decided by the classifier, not by the sender.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'inbound_kind') then
    create type public.inbound_kind as enum (
      'reply',       -- a human answering
      'auto_reply',  -- out of office, ticket autoresponder
      'bounce',      -- delivery status notification
      'other'        -- unrelated mail that reached the address
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'inbound_match_status') then
    create type public.inbound_match_status as enum (
      'matched',    -- attributed to a lead
      'unmatched',  -- arrived, nobody knows whose it is
      'ignored'     -- deliberately set aside
    );
  end if;
end
$$;

-- How the attribution was made. Worth recording: if From-address matching turns
-- out to be producing wrong answers, this is the column that proves it.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'inbound_match_method') then
    create type public.inbound_match_method as enum (
      'threading',     -- In-Reply-To / References hit an email_logs.message_id
      'from_address',  -- sender's address matched leads.email
      'manual'         -- an admin picked the lead
    );
  end if;
end
$$;

create table if not exists public.inbound_messages (
  id uuid primary key default gen_random_uuid(),

  -- Envelope and headers -----------------------------------------------------
  from_address text not null,
  from_name    text,
  to_address   text,
  subject      text,
  body_text    text,

  -- Threading. message_id is the sender's own Message-ID; in_reply_to and
  -- references_header are what let us attribute this to something we sent.
  message_id        text,
  in_reply_to       text,
  references_header text,

  received_at timestamptz not null default now(),

  -- Classification and attribution -------------------------------------------
  kind         public.inbound_kind not null default 'other',
  match_status public.inbound_match_status not null default 'unmatched',
  match_method public.inbound_match_method,

  lead_id      uuid references public.leads (id) on delete set null,
  email_log_id uuid references public.email_logs (id) on delete set null,
  -- The reply row this produced, when it produced one.
  reply_id     uuid references public.replies (id) on delete set null,

  sentiment  public.reply_sentiment,
  confidence numeric(4, 3),

  matched_at      timestamptz,
  matched_by      uuid references auth.users (id) on delete set null,
  is_handled      boolean not null default false,

  created_at timestamptz not null default now(),

  constraint inbound_messages_from_not_blank check (length(btrim(from_address)) > 0),
  constraint inbound_messages_confidence_range
    check (confidence is null or confidence between 0 and 1)
);

comment on table public.inbound_messages is
  'Everything that arrives at the outreach address. public.replies holds only the genuine, attributed ones.';

-- Idempotency. The Worker will retry on any non-2xx, and a duplicate POST must
-- not create a second row or a second reply. Partial because a message with no
-- Message-ID header is malformed but should still be stored.
create unique index if not exists inbound_messages_message_id_key
  on public.inbound_messages (message_id)
  where message_id is not null;

create index if not exists inbound_messages_received_idx on public.inbound_messages (received_at desc);
create index if not exists inbound_messages_lead_idx     on public.inbound_messages (lead_id);
create index if not exists inbound_messages_unmatched_idx
  on public.inbound_messages (received_at desc)
  where match_status = 'unmatched';

alter table public.inbound_messages enable row level security;

revoke all on public.inbound_messages from anon;
grant select, insert, update, delete on public.inbound_messages to authenticated;

drop policy if exists inbound_messages_select_admin on public.inbound_messages;
drop policy if exists inbound_messages_insert_admin on public.inbound_messages;
drop policy if exists inbound_messages_update_admin on public.inbound_messages;
drop policy if exists inbound_messages_delete_admin on public.inbound_messages;

create policy inbound_messages_select_admin on public.inbound_messages
  for select to authenticated using (public.is_admin());
create policy inbound_messages_insert_admin on public.inbound_messages
  for insert to authenticated with check (public.is_admin());
create policy inbound_messages_update_admin on public.inbound_messages
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy inbound_messages_delete_admin on public.inbound_messages
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- THE TRIGGER FIX.
--
-- An out-of-office is not an answer. Marking the lead as replied would stop the
-- sequence for someone who has not read a word, and every rate that counts
-- replies would include a robot.
--
-- Under the design above an auto-reply never reaches public.replies at all, so
-- this is belt and braces — but the trigger is what enforces it, and a rule
-- enforced only by the code that happens to call it is not enforced.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_reply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.sentiment = 'auto_reply' then
    return null;
  end if;

  insert into public.lead_pipeline as p (lead_id, replied)
  values (new.lead_id, new.received_at)
  on conflict (lead_id) do update
    -- Keep the FIRST reply's timestamp; a later message does not reset it.
    set replied = coalesce(p.replied, excluded.replied);
  return null;
end;
$$;

comment on function public.sync_pipeline_from_reply() is
  'Marks the lead as replied. Ignores auto_reply: an out-of-office must not stop a follow-up sequence.';

-- ---------------------------------------------------------------------------
-- Undo the damage if any auto-replies were already recorded.
--
-- Clears lead_pipeline.replied for leads whose ONLY replies are automatic. A
-- lead with both a real reply and an autoresponder keeps its replied stamp.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set replied = null
 where p.replied is not null
   and exists (
     select 1 from public.replies r where r.lead_id = p.lead_id and r.sentiment = 'auto_reply'
   )
   and not exists (
     select 1 from public.replies r
      where r.lead_id = p.lead_id
        and (r.sentiment is distinct from 'auto_reply')
   );

-- ---------------------------------------------------------------------------
-- Admin-facing view: an inbound message plus the lead it belongs to.
--
-- Columns listed explicitly, never p.* — a view built with * captures its
-- column list at creation and silently goes stale after an ALTER TABLE.
-- ---------------------------------------------------------------------------
create or replace view public.inbound_inbox
with (security_invoker = false) as
select
  m.id,
  m.from_address,
  m.from_name,
  m.subject,
  m.body_text,
  m.received_at,
  m.kind,
  m.match_status,
  m.match_method,
  m.sentiment,
  m.is_handled,
  m.lead_id,
  m.reply_id,
  l.business_name,
  l.city,
  l.country
from public.inbound_messages m
left join public.leads l on l.id = m.lead_id
where public.is_admin();

comment on view public.inbound_inbox is
  'Admin-only. Inbound mail joined to its lead. Contains sender addresses and message bodies — never grant to anon.';

revoke all on public.inbound_inbox from anon;
grant select on public.inbound_inbox to authenticated;

-- --- source: supabase/migrations/20260804160000_verify_on_send_and_board.sql
-- ---------------------------------------------------------------------------
-- 0017 — A delivered email verifies the address; expose that on the board.
--
-- Three parts.
--
-- 1. A successful send is evidence. The relay accepted the address and no
--    bounce came back, which is stronger proof than any verifier offers,
--    because it is a real delivery rather than a probe. Those leads are now
--    marked verified automatically.
--
--    The self-correcting half matters: migration 0016 makes a hard bounce set
--    'invalid'. So "accepted, therefore valid" is a claim the system revises
--    the moment reality disagrees, which is what makes it safe to assert.
--
--    An existing 'invalid' is never overwritten. A verifier that says the
--    address is dead outranks a relay that merely agreed to try.
--
-- 2. Backfill the leads already sent to.
--
-- 3. pipeline_board gains the verification columns so the leads list can show
--    and filter on them. Appended at the END of the view — CREATE OR REPLACE
--    can only append, and inserting mid-list raises 42P16.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Verify on a successful send.
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

  -- The address accepted a real message. Upgrade unverified / unknown /
  -- accept_all, but never contradict a verifier that returned 'invalid'.
  update public.lead_pipeline
     set email_verification_status = 'valid',
         email_verification_source = 'delivered',
         email_checked_at          = coalesce(email_checked_at, sent_at)
   where lead_id = new.lead_id
     and email_verification_status <> 'invalid'
     and email_verification_status <> 'valid';

  return null;
end;
$$;

comment on function public.sync_pipeline_from_email_log() is
  'Advances the sequence on a recorded send and treats acceptance as proof the address works. A later hard bounce (0016) revises that to invalid.';

-- ---------------------------------------------------------------------------
-- 2. Backfill: everything already sent to counts as verified.
--
-- Covers sends made upstream too, since those land on
-- lead_pipeline.first_email_sent rather than in email_logs.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set email_verification_status = 'valid',
       email_verification_source = 'delivered',
       email_checked_at          = coalesce(p.email_checked_at, p.first_email_sent, now())
 where p.first_email_sent is not null
   and p.email_verification_status not in ('valid', 'invalid');

-- A recorded bounce is the opposite evidence; make sure it wins regardless of
-- the order these migrations ran in.
update public.lead_pipeline p
   set email_verification_status = 'invalid',
       email_verification_source = coalesce(p.email_verification_source, 'bounce')
  from public.leads l
 where l.id = p.lead_id
   and l.status = 'bounced'
   and p.email_verification_status <> 'invalid';

-- ---------------------------------------------------------------------------
-- 3. pipeline_board: append the verification columns.
--
-- Columns are listed explicitly, never p.* — a view built with * captures its
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
  p.updated_at,
  -- Appended. Anything new goes here, at the end, for the reason in the header.
  p.email_verification_status,
  p.email_verification_source,
  p.email_checked_at
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where public.is_admin();

comment on view public.pipeline_board is
  'Admin-only pipeline rows with the derived next_step and verification state. Contains contact data — never grant to anon.';

-- --- source: supabase/migrations/20260804180000_schedule_followups_for_backfilled_sends.sql
-- ---------------------------------------------------------------------------
-- 0018 — Two faults that between them meant the sender could never send.
--
-- FAULT 1: sends recorded from the sheet never scheduled a follow-up.
--
--   followup1_due is set by the email_logs trigger. The 58 leads sent by the
--   upstream n8n pipeline have no email_logs rows at all — migration 0015 wrote
--   first_email_sent directly — so their followup1_due stayed NULL.
--
--   compute_next_step() then reads "sent, but no due date" as await_followup1,
--   forever. The scheduler looks for `followup1_due <= now()` and finds
--   nothing. Those leads would have sat in Awaiting Follow-up 1 permanently
--   while the cron ran happily every hour reporting nothing to do.
--
-- FAULT 2: two different definitions of "approved".
--
--   lead_pipeline.approved comes from leads.status via sync_pipeline_from_lead.
--   The scheduler, before sending an initial email, instead requires the ACTIVE
--   email_versions row to have status = 'approved'.
--
--   Those can disagree, and they did: 58 leads had pipeline.approved = true
--   while 0 active initial versions were approved. The dashboard would have
--   said "Ready to Send: N" and the sender would have skipped every one of them
--   with "waiting for approval".
--
--   Approving must set both. Fixed here for existing rows, and in
--   lib/actions/leads.ts for the bulk-approve path that only set the status.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- FAULT 1a — a sheet-reported send now schedules follow-up 1 as well.
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
  sent_at      timestamptz := coalesce(new.last_contacted_at, new.imported_at, now());
  d1           integer := public.setting_int('outreach.followup1_delay_days', 7);
begin
  insert into public.lead_pipeline as p (
    lead_id, email_found, research_complete, draft_ready, approved,
    first_email_sent, followup1_due
  )
  values (
    new.id, has_email, has_research, has_draft, is_approved,
    case when was_sent then sent_at else null end,
    -- Without this the lead reaches 'initial_sent' with no due date, and
    -- compute_next_step() parks it on await_followup1 for good.
    case when was_sent then sent_at + make_interval(days => d1) else null end
  )
  on conflict (lead_id) do update
    set email_found       = p.email_found       or excluded.email_found,
        research_complete = p.research_complete or excluded.research_complete,
        draft_ready       = p.draft_ready       or excluded.draft_ready,
        approved          = p.approved          or excluded.approved,
        first_email_sent  = coalesce(p.first_email_sent, excluded.first_email_sent),
        followup1_due     = coalesce(p.followup1_due, excluded.followup1_due);

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- FAULT 1b — backfill the leads already stuck.
--
-- Dated from the send, not from now(), so a lead sent three weeks ago is
-- immediately due rather than waiting another week from today.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set followup1_due = p.first_email_sent
                       + make_interval(days => public.setting_int('outreach.followup1_delay_days', 7))
 where p.first_email_sent is not null
   and p.followup1_due is null
   and p.followup1_sent is null
   and p.replied is null
   and p.closed is null;

-- Same for the second step, where the first has gone but nothing scheduled the
-- second.
update public.lead_pipeline p
   set followup2_due = p.followup1_sent
                       + make_interval(days => public.setting_int('outreach.followup2_delay_days', 3))
 where p.followup1_sent is not null
   and p.followup2_due is null
   and p.followup2_sent is null
   and p.replied is null
   and p.closed is null;

-- ---------------------------------------------------------------------------
-- FAULT 2 — make the two definitions of "approved" agree.
--
-- Only for leads already sent: the message went out, so it was approved
-- upstream whatever this database recorded. Drafts still awaiting review are
-- left strictly alone — auto-approving 270 unreviewed drafts because a status
-- column implied it would be exactly the accident this system exists to
-- prevent.
-- ---------------------------------------------------------------------------
update public.email_versions v
   set status = 'approved'
  from public.lead_pipeline p
 where p.lead_id = v.lead_id
   and v.type = 'initial'
   and v.active
   and v.status = 'draft'
   and p.first_email_sent is not null;

comment on function public.sync_pipeline_from_lead() is
  'Projects lead columns onto the pipeline. A sheet-reported send also schedules follow-up 1, otherwise the lead parks on await_followup1 forever.';

-- --- source: supabase/migrations/20260804200000_sheet_date_sent_is_authoritative.sql
-- ---------------------------------------------------------------------------
-- 0019 — The sheet's "Date Sent" is authoritative for upstream sends.
--
-- Migration 0015 backfilled first_email_sent from imported_at, because the
-- sheet's Date Sent column was empty at the time. It has since been filled in
-- with the real dates, but the sync could not use them: the ON CONFLICT clause
-- in sync_pipeline_from_lead() used
--
--     first_email_sent = coalesce(p.first_email_sent, excluded.first_email_sent)
--
-- which never overwrites. So the schedule stayed anchored to the import date,
-- and every follow-up would have fired a week after we happened to import the
-- lead rather than a week after the prospect was actually emailed.
--
-- The rule this establishes:
--
--   * A send THIS CRM made (an email_logs row with a sent_at) is authoritative.
--     Nothing from the sheet may move it.
--   * Otherwise the sheet's Date Sent wins, because for upstream sends it is
--     the only record that exists.
--
-- followup1_due is re-derived alongside it, or correcting the send date would
-- leave the schedule pointing at the old one.
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
  d1           integer := public.setting_int('outreach.followup1_delay_days', 7);

  -- The sheet's Date Sent, when it has one.
  sheet_sent   timestamptz := new.last_contacted_at;

  -- Used when inserting a fresh row: a date is better than nothing, and
  -- imported_at at least bounds when the send must have happened.
  assumed_sent timestamptz := coalesce(new.last_contacted_at, new.imported_at, now());

  -- Did WE send this? If so the sheet does not get to move the date.
  crm_sent boolean := exists (
    select 1 from public.email_logs el
     where el.lead_id = new.id and el.sent_at is not null
  );

  -- Only then may the sheet overwrite an existing value.
  sheet_wins boolean := was_sent and sheet_sent is not null and not crm_sent;
begin
  insert into public.lead_pipeline as p (
    lead_id, email_found, research_complete, draft_ready, approved,
    first_email_sent, followup1_due
  )
  values (
    new.id, has_email, has_research, has_draft, is_approved,
    case when was_sent then assumed_sent else null end,
    case when was_sent then assumed_sent + make_interval(days => d1) else null end
  )
  on conflict (lead_id) do update
    set email_found       = p.email_found       or excluded.email_found,
        research_complete = p.research_complete or excluded.research_complete,
        draft_ready       = p.draft_ready       or excluded.draft_ready,
        approved          = p.approved          or excluded.approved,

        first_email_sent =
          case when sheet_wins then sheet_sent
               else coalesce(p.first_email_sent, excluded.first_email_sent) end,

        -- Re-derived from whichever date won, and never moved once the
        -- follow-up has actually gone out.
        followup1_due =
          case when sheet_wins and p.followup1_sent is null
               then sheet_sent + make_interval(days => d1)
               else coalesce(p.followup1_due, excluded.followup1_due) end;

  return null;
end;
$$;

comment on function public.sync_pipeline_from_lead() is
  'Projects lead columns onto the pipeline. The sheet Date Sent is authoritative for upstream sends; a send this CRM recorded is never overwritten.';

-- ---------------------------------------------------------------------------
-- Re-anchor the leads already carrying a guessed date.
--
-- Only where the CRM has no send of its own, and only where the sheet actually
-- disagrees, so this is a no-op on a second run.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set first_email_sent = l.last_contacted_at,
       followup1_due = case
         when p.followup1_sent is null
         then l.last_contacted_at
              + make_interval(days => public.setting_int('outreach.followup1_delay_days', 7))
         else p.followup1_due
       end
  from public.leads l
 where l.id = p.lead_id
   and l.last_contacted_at is not null
   and p.first_email_sent is distinct from l.last_contacted_at
   and not exists (
     select 1 from public.email_logs el
      where el.lead_id = l.id and el.sent_at is not null
   );

-- --- source: supabase/migrations/20260804220000_outreach_run_budget.sql
-- ---------------------------------------------------------------------------
-- 0020 — How long one scheduled run may take.
--
-- The sender waits out `sending.min_gap_seconds` between emails, and that wait
-- happens inside the HTTP request the cron service made. The ceiling is
-- therefore the hosting platform's function timeout, not ours: Vercel Hobby
-- kills a function at 60s, Pro allows up to 300.
--
-- 50s is the safe default. With a 90s gap that means exactly one email per run,
-- which is fine — the CRON FREQUENCY is what paces bulk sending, not the length
-- of any single run. Raise this towards 280 on Pro to fit several gap waits
-- into one invocation.
--
-- Made a setting rather than a constant because getting it wrong has two very
-- different symptoms (runs killed mid-send, or a queue that drains far too
-- slowly) and the right value depends entirely on the plan you are on.
-- ---------------------------------------------------------------------------
insert into public.settings (key, value, description, is_sensitive) values
  ('outreach.max_runtime_seconds', '50'::jsonb,
   'Wall-clock ceiling for one scheduled send run, including time spent waiting out the minimum gap. Keep below your platform function timeout (Vercel Hobby 60s, Pro 300s).',
   false)
on conflict (key) do nothing;

-- --- source: supabase/migrations/20260805100000_research_complete_any_field.sql
-- ---------------------------------------------------------------------------
-- 0021 — Research is done when ANY research field is filled in.
--
-- research_complete was driven by `research_summary` alone. But the upstream
-- enrichment writes seven separate fields, and the summary is only one of them
-- — often the one that is missing:
--
--     research_summary                   452
--     website_observations               685
--     automation_opportunities           673
--     ai_chatbot_opportunities           674
--     website_improvement_opportunities  680
--     outreach_angle                     675
--     interesting_facts                  614
--
--     leads with ANY research field      691
--     leads with a summary               452
--     research but NO summary            239   <- wrongly parked at "Researching"
--
-- 239 leads had genuine research and were reported as still needing it, which
-- also meant the next step said "Research Lead" for work already done.
--
-- `personalization` is deliberately NOT in the list. It is the one-line hook
-- used in the draft, not research, and 688 of 698 leads have it — including it
-- would make the flag true for essentially everything and stop it meaning
-- anything at all.
-- ---------------------------------------------------------------------------

create or replace function public.sync_pipeline_from_lead()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  has_email    boolean := new.email is not null and length(btrim(new.email)) > 0;

  -- Any one of these is evidence the lead has been researched.
  has_research boolean := (
       coalesce(length(btrim(new.research_summary)), 0) > 0
    or coalesce(length(btrim(new.website_observations)), 0) > 0
    or coalesce(length(btrim(new.automation_opportunities)), 0) > 0
    or coalesce(length(btrim(new.ai_chatbot_opportunities)), 0) > 0
    or coalesce(length(btrim(new.website_improvement_opportunities)), 0) > 0
    or coalesce(length(btrim(new.outreach_angle)), 0) > 0
    or coalesce(length(btrim(new.interesting_facts)), 0) > 0
  );

  has_draft    boolean := new.draft_email is not null and length(btrim(new.draft_email)) > 0;
  is_approved  boolean := new.status in ('approved', 'sending', 'sent', 'replied');
  was_sent     boolean := new.status in ('sent', 'replied');
  d1           integer := public.setting_int('outreach.followup1_delay_days', 7);

  sheet_sent   timestamptz := new.last_contacted_at;
  assumed_sent timestamptz := coalesce(new.last_contacted_at, new.imported_at, now());

  crm_sent boolean := exists (
    select 1 from public.email_logs el
     where el.lead_id = new.id and el.sent_at is not null
  );
  sheet_wins boolean := was_sent and sheet_sent is not null and not crm_sent;
begin
  insert into public.lead_pipeline as p (
    lead_id, email_found, research_complete, draft_ready, approved,
    first_email_sent, followup1_due
  )
  values (
    new.id, has_email, has_research, has_draft, is_approved,
    case when was_sent then assumed_sent else null end,
    case when was_sent then assumed_sent + make_interval(days => d1) else null end
  )
  on conflict (lead_id) do update
    set email_found       = p.email_found       or excluded.email_found,
        research_complete = p.research_complete or excluded.research_complete,
        draft_ready       = p.draft_ready       or excluded.draft_ready,
        approved          = p.approved          or excluded.approved,

        first_email_sent =
          case when sheet_wins then sheet_sent
               else coalesce(p.first_email_sent, excluded.first_email_sent) end,

        followup1_due =
          case when sheet_wins and p.followup1_sent is null
               then sheet_sent + make_interval(days => d1)
               else coalesce(p.followup1_due, excluded.followup1_due) end;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- The trigger has to WATCH those columns too.
--
-- It previously fired on (email, research_summary, draft_email, status), so a
-- sync that filled in website_observations and nothing else would not have
-- re-evaluated the flag no matter what the function said.
-- ---------------------------------------------------------------------------
drop trigger if exists leads_sync_pipeline on public.leads;
create trigger leads_sync_pipeline
  after insert or update of
    email, status, draft_email, last_contacted_at,
    research_summary, website_observations, automation_opportunities,
    ai_chatbot_opportunities, website_improvement_opportunities,
    outreach_angle, interesting_facts
  on public.leads
  for each row execute function public.sync_pipeline_from_lead();

-- ---------------------------------------------------------------------------
-- Backfill the 239 leads that were researched but reported otherwise.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set research_complete = true,
       research_completed_at = coalesce(p.research_completed_at, l.researched_at, l.imported_at, now())
  from public.leads l
 where l.id = p.lead_id
   and p.research_complete = false
   and (
        coalesce(length(btrim(l.research_summary)), 0) > 0
     or coalesce(length(btrim(l.website_observations)), 0) > 0
     or coalesce(length(btrim(l.automation_opportunities)), 0) > 0
     or coalesce(length(btrim(l.ai_chatbot_opportunities)), 0) > 0
     or coalesce(length(btrim(l.website_improvement_opportunities)), 0) > 0
     or coalesce(length(btrim(l.outreach_angle)), 0) > 0
     or coalesce(length(btrim(l.interesting_facts)), 0) > 0
   );

comment on function public.sync_pipeline_from_lead() is
  'Projects lead columns onto the pipeline. Research counts as done when ANY of the seven research fields is filled, not just the summary.';

-- --- source: supabase/migrations/20260805120000_reconcile_approved_versions.sql
-- ---------------------------------------------------------------------------
-- 0022 — Finish reconciling the two records of "approved".
--
-- Migration 0018 aligned them only for leads that had ALREADY been sent. The
-- rest were left, and the sender has been rejecting them ever since:
--
--     approved & unsent & open                              6
--     ...with an APPROVED active initial version            0
--
--     10:36:06  success  0 sent, 6 skipped (of 6 due)
--     10:33:05  success  0 sent, 6 skipped (of 6 due)
--
-- Every run picked the same six leads and refused all six. lead_pipeline.
-- approved was true (it is derived from leads.status), the active email_versions
-- row was still 'draft', and the send path requires the version.
--
-- Those leads reached status='approved' because a human pressed Approve: the
-- sheet importer never produces that status (deriveStatus only ever returns
-- new / researching / ready / sent / replied), so the only paths are the bulk
-- action and the status dropdown. Both are deliberate acts of approval, which
-- is why signing off the version here honours the intent rather than inventing
-- it.
--
-- Going forward the mismatch cannot recur: bulkApproveDrafts() approves the
-- version, and findDueWork() now requires it, so the queue no longer offers
-- work the sender will refuse.
-- ---------------------------------------------------------------------------

update public.email_versions v
   set status = 'approved',
       reviewed_at = coalesce(v.reviewed_at, now())
  from public.lead_pipeline p
 where p.lead_id = v.lead_id
   and v.type = 'initial'
   and v.active
   and v.status = 'draft'
   and p.approved = true;

-- ---------------------------------------------------------------------------
-- Leads whose status says approved but which have no draft at all cannot be
-- sent and should stop claiming otherwise. Back to 'ready' so they surface in
-- the drafting queue instead of sitting in a Ready to Send count that can never
-- move.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set approved = false,
       approved_at = null
 where p.approved = true
   and p.first_email_sent is null
   and not exists (
     select 1 from public.email_versions v
      where v.lead_id = p.lead_id and v.type = 'initial' and v.active
   );

update public.leads l
   set status = 'ready'
  from public.lead_pipeline p
 where p.lead_id = l.id
   and l.status = 'approved'
   and p.approved = false;

-- --- source: supabase/migrations/20260805140000_manual_verification_is_a_verdict.sql
-- ---------------------------------------------------------------------------
-- 0023 — Ticking "Email verified" IS a verdict.
--
-- The relationship between the flag and the status was one-directional:
--
--     email_verification_status = 'valid'   ->  email_verified := true
--     email_verification_status = 'invalid' ->  email_verified := false
--
-- so a verifier result updated both, but an admin ticking the box on the lead
-- page set only `email_verified`. The status stayed `unverified`, the leads
-- table kept showing "Never checked", and the lead stayed in the export — being
-- re-billed to a verifier for an address a human had already confirmed.
--
-- Made bidirectional. Which side wins is decided by WHICH ONE CHANGED in this
-- statement, so neither can quietly overwrite the other:
--
--   status changed  -> a verifier (or a bounce) spoke. It drives the flag.
--   flag changed    -> a human spoke. It drives the status, recorded as
--                      source 'manual' so the origin stays auditable.
--
-- An `invalid` status is never softened by unticking the box: a hard bounce is
-- evidence, and "I am no longer sure" is not a reason to discard it.
-- ---------------------------------------------------------------------------
create or replace function public.set_pipeline_stage()
returns trigger
language plpgsql
as $$
declare
  status_changed boolean;
  flag_changed   boolean;
begin
  -- On INSERT there is no OLD, so treat the incoming status as authoritative
  -- and let it drive the flag, which is the pre-existing behaviour.
  if tg_op = 'INSERT' then
    status_changed := true;
    flag_changed := false;
  else
    status_changed := new.email_verification_status is distinct from old.email_verification_status;
    flag_changed   := new.email_verified is distinct from old.email_verified;
  end if;

  if status_changed then
    if new.email_verification_status = 'valid' then
      new.email_verified := true;
    elsif new.email_verification_status = 'invalid' then
      new.email_verified := false;
    end if;

  elsif flag_changed then
    if new.email_verified and new.email_verification_status <> 'valid' then
      -- The operator checked this address themselves. Record it as a real
      -- verdict so the lead stops appearing in the verifier export.
      new.email_verification_status := 'valid';
      new.email_verification_source := 'manual';
      new.email_checked_at := now();

    elsif not new.email_verified and new.email_verification_status = 'valid' then
      -- Withdrawing a manual confirmation returns the address to unchecked,
      -- NOT to invalid: unticking means "no longer sure", not "proved dead".
      new.email_verification_status := 'unverified';
      new.email_verification_source := null;
      new.email_checked_at := null;
    end if;
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

comment on function public.set_pipeline_stage() is
  'Derives current_stage and keeps email_verified in step with email_verification_status in BOTH directions: a verifier result drives the flag, a human ticking the flag records a manual verdict.';

-- ---------------------------------------------------------------------------
-- Catch up the leads someone already ticked by hand: flag true, status still
-- claiming nobody has checked.
-- ---------------------------------------------------------------------------
update public.lead_pipeline
   set email_verification_status = 'valid',
       email_verification_source = coalesce(email_verification_source, 'manual'),
       email_checked_at = coalesce(email_checked_at, email_verified_at, now())
 where email_verified = true
   and email_verification_status in ('unverified', 'unknown', 'accept_all');

-- --- source: supabase/migrations/20260805160000_sheet_research_status_and_drop_category.sql
-- ---------------------------------------------------------------------------
-- 0024 — The sheet's "research status" column decides whether research is done.
--
-- Migration 0021 inferred it from whether any of seven research fields was
-- filled in. That was a big improvement on "does research_summary exist", but
-- it is still a guess about someone else's process: the upstream pipeline knows
-- perfectly well whether it finished, and says so in a column.
--
-- `leads.researched_at` becomes the carrier. The importer stamps it when the
-- sheet reports research done (see lib/import/mapping.ts), and the trigger
-- treats a non-null value as authoritative.
--
-- Field presence is KEPT as a fallback rather than replaced. A lead with a full
-- page of website observations has plainly been researched whatever the status
-- column says, and dropping that check would push hundreds of finished leads
-- back into the research queue the moment a column went blank.
--
-- So: research is complete when the sheet says so, OR when the evidence says
-- so. Both are true signals; requiring both would be strictly worse than
-- either.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_lead()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  has_email    boolean := new.email is not null and length(btrim(new.email)) > 0;

  -- The sheet's own verdict, carried on researched_at.
  sheet_says_researched boolean := new.researched_at is not null;

  -- Evidence, as a fallback. personalization is excluded: it is the hook line
  -- used in the draft rather than research, and 691 of 698 leads have it, which
  -- would make the flag true for everything.
  has_research_fields boolean := (
       coalesce(length(btrim(new.research_summary)), 0) > 0
    or coalesce(length(btrim(new.website_observations)), 0) > 0
    or coalesce(length(btrim(new.automation_opportunities)), 0) > 0
    or coalesce(length(btrim(new.ai_chatbot_opportunities)), 0) > 0
    or coalesce(length(btrim(new.website_improvement_opportunities)), 0) > 0
    or coalesce(length(btrim(new.outreach_angle)), 0) > 0
    or coalesce(length(btrim(new.interesting_facts)), 0) > 0
  );

  has_research boolean := sheet_says_researched or has_research_fields;

  has_draft    boolean := new.draft_email is not null and length(btrim(new.draft_email)) > 0;
  is_approved  boolean := new.status in ('approved', 'sending', 'sent', 'replied');
  was_sent     boolean := new.status in ('sent', 'replied');
  d1           integer := public.setting_int('outreach.followup1_delay_days', 7);

  sheet_sent   timestamptz := new.last_contacted_at;
  assumed_sent timestamptz := coalesce(new.last_contacted_at, new.imported_at, now());

  crm_sent boolean := exists (
    select 1 from public.email_logs el
     where el.lead_id = new.id and el.sent_at is not null
  );
  sheet_wins boolean := was_sent and sheet_sent is not null and not crm_sent;
begin
  insert into public.lead_pipeline as p (
    lead_id, email_found, research_complete, draft_ready, approved,
    first_email_sent, followup1_due
  )
  values (
    new.id, has_email, has_research, has_draft, is_approved,
    case when was_sent then assumed_sent else null end,
    case when was_sent then assumed_sent + make_interval(days => d1) else null end
  )
  on conflict (lead_id) do update
    set email_found       = p.email_found       or excluded.email_found,
        research_complete = p.research_complete or excluded.research_complete,
        draft_ready       = p.draft_ready       or excluded.draft_ready,
        approved          = p.approved          or excluded.approved,

        first_email_sent =
          case when sheet_wins then sheet_sent
               else coalesce(p.first_email_sent, excluded.first_email_sent) end,

        followup1_due =
          case when sheet_wins and p.followup1_sent is null
               then sheet_sent + make_interval(days => d1)
               else coalesce(p.followup1_due, excluded.followup1_due) end;

  return null;
end;
$$;

-- researched_at must be watched, or a sync that sets only that column would not
-- re-evaluate the flag however the function is written.
drop trigger if exists leads_sync_pipeline on public.leads;
create trigger leads_sync_pipeline
  after insert or update of
    email, status, draft_email, last_contacted_at, researched_at,
    research_summary, website_observations, automation_opportunities,
    ai_chatbot_opportunities, website_improvement_opportunities,
    outreach_angle, interesting_facts
  on public.leads
  for each row execute function public.sync_pipeline_from_lead();

comment on function public.sync_pipeline_from_lead() is
  'Projects lead columns onto the pipeline. Research is complete when the sheet says so (researched_at) OR when any research field is filled.';

-- ---------------------------------------------------------------------------
-- Anything already carrying research evidence is marked complete, so the queue
-- reflects reality immediately rather than after the next sync.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set research_complete = true,
       research_completed_at = coalesce(p.research_completed_at, l.researched_at, l.imported_at, now())
  from public.leads l
 where l.id = p.lead_id
   and p.research_complete = false
   and (
        l.researched_at is not null
     or coalesce(length(btrim(l.research_summary)), 0) > 0
     or coalesce(length(btrim(l.website_observations)), 0) > 0
     or coalesce(length(btrim(l.automation_opportunities)), 0) > 0
     or coalesce(length(btrim(l.ai_chatbot_opportunities)), 0) > 0
     or coalesce(length(btrim(l.website_improvement_opportunities)), 0) > 0
     or coalesce(length(btrim(l.outreach_angle)), 0) > 0
     or coalesce(length(btrim(l.interesting_facts)), 0) > 0
   );

-- ---------------------------------------------------------------------------
-- `category` is being retired from the sheet.
--
-- The COLUMN IS DEPRECATED, NOT DROPPED. It currently holds a real
-- qualification signal on every lead — 348 "Skip", 241 "Needs Automation",
-- 112 "No Website" — and dropping it would destroy that with no way back.
-- Nothing reads or writes it any more: the importer no longer maps it, the
-- Sheets write-back no longer sends it, and it is gone from the UI.
--
-- To drop it for real, once you are sure the "Skip" marks are not needed:
--
--   drop view if exists public.dashboard_leads_by_category;
--   alter table public.leads drop column category;
--
-- The view has to go first, because it selects the column.
-- ---------------------------------------------------------------------------
comment on column public.leads.category is
  'DEPRECATED 2026-08-05. Removed from the sheet and from all CRM code paths. Retained because it still holds qualification marks (Skip / Needs Automation / No Website). Safe to drop once those are confirmed unnecessary.';

-- --- source: supabase/migrations/20260805180000_stage_is_the_first_unmet_gate.sql
-- ---------------------------------------------------------------------------
-- 0025 — The stage names what is BLOCKING a lead, not the last thing that
--        happened to it. Plus the cleanup that follows from it.
--
-- Both derivations were ordered newest-fact-first, so the CASE returned the
-- LAST gate that had been satisfied. That reads well until the gates stop being
-- satisfied in order, which is exactly what this dataset does — the upstream
-- pipeline researches and drafts for leads it never found an address for:
--
--     leads with no email address                307
--     ...of which reading 'need_email'             2
--     ...with research already done              304
--     ...with a draft awaiting review            159
--     ...with an APPROVED draft                   62
--
-- So 305 leads with nowhere to send anything read "Draft Ready" or "Approved",
-- and the queues built on those stages promised work that could never ship:
-- Approval Queue 351, of which 172 were unsendable; Ready to Send 111, of which
-- 96 were unsendable.
--
-- Reordered to FIRST UNMET GATE. A stage now answers "what is stopping this
-- lead", which is the question every queue on the dashboard is really asking.
--
-- Facts stay pinned above the gates. A lead that has been emailed reads
-- 'initial_sent' even if its address later goes dead, because the email did
-- leave and no reordering can un-send it.
--
-- Nothing is destroyed. The 497 leads that move backwards keep their research,
-- their drafts and their approvals; the moment an address is found and verified
-- they arrive at 'approved' with the work already done.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The two derivations. They must stay in step: compute_next_step is the
--    same ladder, answering "so what do I do about it".
-- ---------------------------------------------------------------------------
create or replace function public.compute_pipeline_stage(p public.lead_pipeline)
returns public.pipeline_stage
language sql
immutable
as $$
  select (case
    -- Facts, newest first. These cannot be undone by a later gate failing.
    when p.closed           is not null then 'closed'
    when p.replied          is not null then 'replied'
    when p.followup2_sent   is not null then 'followup2_sent'
    when p.followup1_sent   is not null then 'followup1_sent'
    when p.first_email_sent is not null then 'initial_sent'

    -- Gates, in the order they have to be cleared. The FIRST unmet one wins.
    when not p.email_found                        then 'need_email'
    when p.email_verification_status = 'invalid'  then 'need_email'
    when not p.email_verified                     then 'need_verification'
    when not p.research_complete                  then 'research'
    when not p.draft_ready                        then 'draft'
    when not p.approved                           then 'review'
    else 'approved'
  end)::public.pipeline_stage;
$$;

comment on function public.compute_pipeline_stage(public.lead_pipeline) is
  'Derives current_stage as the FIRST unmet gate, so a stage names what is blocking the lead. Sent leads stay pinned. The ONE definition — do not re-implement in application code.';

-- STABLE, not IMMUTABLE: the follow-up arms compare a due date against now().
create or replace function public.compute_next_step(p public.lead_pipeline)
returns public.pipeline_next_step
language sql
stable
as $$
  select (case
    when p.closed         is not null then 'complete'
    when p.replied        is not null then 'close_workflow'
    when p.followup2_sent is not null then 'close_workflow'
    when p.followup1_sent is not null then
      case when p.followup2_due is not null and p.followup2_due <= now()
           then 'send_followup2' else 'await_followup2' end
    when p.first_email_sent is not null then
      case when p.followup1_due is not null and p.followup1_due <= now()
           then 'send_followup1' else 'await_followup1' end

    when not p.email_found                       then 'need_email'
    when p.email_verification_status = 'invalid' then 'need_email'
    when not p.email_verified                    then 'need_verification'
    when not p.research_complete                 then 'research_lead'
    when not p.draft_ready                       then 'generate_draft'
    when not p.approved                          then 'approve_draft'
    else 'send_initial_email'
  end)::public.pipeline_next_step;
$$;

comment on function public.compute_next_step(public.lead_pipeline) is
  'The same ladder as compute_pipeline_stage, answering what to DO about the first unmet gate. STABLE because the follow-up arms compare against now().';

-- ---------------------------------------------------------------------------
-- 2. A verification result decides the flag, in every direction.
--
-- The rule used to be one-way-ish: 'valid' set the flag true, 'invalid' set it
-- false, and everything else LEFT IT ALONE. So moving a lead from Verified to
-- Catch-all or Unknown kept email_verified = true, and the lead stayed in Ready
-- to Send on the strength of a verdict that had just been withdrawn. With the
-- five-state control on the lead page that stops being a corner case.
--
-- Now: the flag simply IS "the verifier said valid". Nothing else counts,
-- which is what the column has always claimed to mean.
--
-- The human branch below is unchanged: ticking the flag by hand still records a
-- real 'manual' verdict, and unticking returns to 'unverified' rather than to
-- 'invalid', because "no longer sure" is not "proved dead".
-- ---------------------------------------------------------------------------
create or replace function public.set_pipeline_stage()
returns trigger
language plpgsql
as $$
declare
  status_changed boolean;
  flag_changed   boolean;
begin
  if tg_op = 'INSERT' then
    status_changed := true;
    flag_changed := false;
  else
    status_changed := new.email_verification_status is distinct from old.email_verification_status;
    flag_changed   := new.email_verified is distinct from old.email_verified;
  end if;

  if status_changed then
    new.email_verified := (new.email_verification_status = 'valid');

  elsif flag_changed then
    if new.email_verified and new.email_verification_status <> 'valid' then
      new.email_verification_status := 'valid';
      new.email_verification_source := 'manual';
      new.email_checked_at := now();

    elsif not new.email_verified and new.email_verification_status = 'valid' then
      new.email_verification_status := 'unverified';
      new.email_verification_source := null;
      new.email_checked_at := null;
    end if;
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

comment on function public.set_pipeline_stage() is
  'Derives current_stage and keeps email_verified in step with email_verification_status in BOTH directions. A verifier result decides the flag outright (verified means valid, nothing else); a human ticking the flag records a manual verdict.';

-- ---------------------------------------------------------------------------
-- 3. leads.status stops deciding whether a lead is approved.
--
-- `approved` was OR'd in from `status in ('approved','sending','sent','replied')`,
-- which made a label somebody types a second source of truth for a gate that
-- email_versions already owns. That is the coupling behind the whole
-- two-definitions-of-approved saga (0018, 0022): the flag said yes, the active
-- version still said draft, and the sender refused work the dashboard had
-- promised. sync_pipeline_from_version() is the one writer now.
--
-- The `was_sent` half STAYS. The sheet's "Email sent status" column reaches the
-- CRM as status='sent', and for the 89 leads n8n emailed that is the only
-- record the send ever happened — there is no email_logs row. Removing it would
-- lose them.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_lead()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  has_email    boolean := new.email is not null and length(btrim(new.email)) > 0;

  sheet_says_researched boolean := new.researched_at is not null;

  has_research_fields boolean := (
       coalesce(length(btrim(new.research_summary)), 0) > 0
    or coalesce(length(btrim(new.website_observations)), 0) > 0
    or coalesce(length(btrim(new.automation_opportunities)), 0) > 0
    or coalesce(length(btrim(new.ai_chatbot_opportunities)), 0) > 0
    or coalesce(length(btrim(new.website_improvement_opportunities)), 0) > 0
    or coalesce(length(btrim(new.outreach_angle)), 0) > 0
    or coalesce(length(btrim(new.interesting_facts)), 0) > 0
  );

  has_research boolean := sheet_says_researched or has_research_fields;
  has_draft    boolean := new.draft_email is not null and length(btrim(new.draft_email)) > 0;

  -- Deliberately NOT is_approved. See the header.
  was_sent     boolean := new.status in ('sent', 'replied');
  d1           integer := public.setting_int('outreach.followup1_delay_days', 7);

  sheet_sent   timestamptz := new.last_contacted_at;
  assumed_sent timestamptz := coalesce(new.last_contacted_at, new.imported_at, now());

  crm_sent boolean := exists (
    select 1 from public.email_logs el
     where el.lead_id = new.id and el.sent_at is not null
  );
  sheet_wins boolean := was_sent and sheet_sent is not null and not crm_sent;
begin
  insert into public.lead_pipeline as p (
    lead_id, email_found, research_complete, draft_ready,
    first_email_sent, followup1_due
  )
  values (
    new.id, has_email, has_research, has_draft,
    case when was_sent then assumed_sent else null end,
    case when was_sent then assumed_sent + make_interval(days => d1) else null end
  )
  on conflict (lead_id) do update
    set email_found       = p.email_found       or excluded.email_found,
        research_complete = p.research_complete or excluded.research_complete,
        draft_ready       = p.draft_ready       or excluded.draft_ready,

        first_email_sent =
          case when sheet_wins then sheet_sent
               else coalesce(p.first_email_sent, excluded.first_email_sent) end,

        followup1_due =
          case when sheet_wins and p.followup1_sent is null
               then sheet_sent + make_interval(days => d1)
               else coalesce(p.followup1_due, excluded.followup1_due) end;

  return null;
end;
$$;

comment on function public.sync_pipeline_from_lead() is
  'Projects lead columns onto the pipeline. Research is complete when the sheet says so (researched_at) OR when any research field is filled. Does NOT touch `approved` — email_versions owns that.';

-- ---------------------------------------------------------------------------
-- 4. Recompute the stored stage.
--
-- current_stage is a STORED column filled by the BEFORE trigger, so changing
-- the function above does nothing to the 701 rows already written. A no-op
-- UPDATE fires lead_pipeline_derive_stage and every row is re-derived.
-- ---------------------------------------------------------------------------
update public.lead_pipeline set updated_at = now();

-- ---------------------------------------------------------------------------
-- 5. Campaigns and templates are removed.
--
-- Every one of the 701 leads has campaign_id = NULL, so the campaign lookup in
-- lib/services/ai/index.ts has never found a template and the generator has
-- always fallen through to its built-in default. Deleting this changes no
-- behaviour; it removes two pages, two tables and three views that only ever
-- reported zeroes.
--
-- Order matters: views before the columns they select, columns before the
-- tables they reference.
-- ---------------------------------------------------------------------------
drop view if exists public.dashboard_campaign_stats;
drop view if exists public.public_stats_campaigns;
drop view if exists public.analytics_template_performance;

-- ---------------------------------------------------------------------------
-- 6. Views nothing reads.
--
-- The five that only lib/data/dashboard.ts consumed — a module imported by
-- nothing — plus one that never had a consumer at all, plus the category view
-- that stands between us and dropping the column.
-- ---------------------------------------------------------------------------
drop view if exists public.dashboard_overview;
drop view if exists public.dashboard_leads_by_country;
drop view if exists public.dashboard_leads_by_niche;
drop view if exists public.dashboard_reply_activity_daily;
drop view if exists public.dashboard_reply_stats;
drop view if exists public.dashboard_leads_created_daily;
drop view if exists public.dashboard_leads_by_category;

-- ---------------------------------------------------------------------------
-- 7. Two surviving views select columns that are about to disappear.
--
-- CREATE OR REPLACE cannot drop a column from a view (42P16), so both are
-- dropped and rebuilt. dashboard_leads_safe is kept even though nothing reads
-- it yet: it is the shape a viewer role would be given, and that scope is still
-- an open product question.
-- ---------------------------------------------------------------------------
drop view if exists public.dashboard_leads_safe;
create view public.dashboard_leads_safe
with (security_invoker = false) as
select
  l.id,
  l.business_name,
  l.city,
  l.country,
  l.niche,
  l.status,
  l.created_at,
  l.last_contacted_at,
  (l.research_summary is not null) as has_research,
  (l.draft_email is not null)      as has_draft
from public.leads l
where public.is_admin();

comment on view public.dashboard_leads_safe is
  'Per-lead list with contact details, research and drafts stripped. Safe for viewers, currently read by nothing.';

drop view if exists public.pipeline_board;
create view public.pipeline_board
with (security_invoker = false) as
select
  p.lead_id,
  l.business_name,
  l.email,
  l.city,
  l.country,
  l.niche,
  l.status                       as lead_status,
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
  p.updated_at,
  p.email_verification_status,
  p.email_verification_source,
  p.email_checked_at
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where public.is_admin();

comment on view public.pipeline_board is
  'Admin-only pipeline rows with the derived next_step and verification state. Contains contact data — never grant to anon.';

grant select on public.pipeline_board to authenticated;
grant select on public.dashboard_leads_safe to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Now the columns and the tables.
--
-- `category` held 348 Skip / 241 Needs Automation / 112 No Website. Migration
-- 0024 kept it on the theory that the Skip marks were a real qualification
-- signal; the user has since confirmed they are stale, so it goes.
--
-- `next_followup_at` was never written by anything and was NULL on all 701 rows.
-- ---------------------------------------------------------------------------
alter table public.leads      drop column if exists campaign_id;
alter table public.leads      drop column if exists category;
alter table public.leads      drop column if exists next_followup_at;
alter table public.email_logs drop column if exists campaign_id;
alter table public.email_logs drop column if exists template_id;

drop table if exists public.campaigns;
drop table if exists public.templates;

-- ---------------------------------------------------------------------------
-- 9. Settings rows nothing reads.
--
-- Seeded by 0006 and never wired to anything: lib/services/config.ts does not
-- mention them and neither does any UI. `ai.default_model` is especially
-- misleading, since it names a model this project never calls.
-- ---------------------------------------------------------------------------
delete from public.settings
 where key in ('ai.default_model', 'provider.name', 'followup.default_delay_days');

-- --- source: supabase/migrations/20260805200000_add_dead_email_stage_value.sql
-- ---------------------------------------------------------------------------
-- 0026 — Add the `dead_email` stage value. NOTHING ELSE.
--
-- This migration is one statement on purpose. Postgres will not let a new enum
-- value be USED in the same transaction that added it:
--
--     ERROR: unsafe use of new value "dead_email" of enum type pipeline_stage
--     HINT:  New enum values must be committed before they can be used.
--
-- so the function that returns it and the backfill that stores it have to be a
-- separate script. 0027 is that script. Run this one first, on its own, and let
-- it commit.
--
-- Why the split is worth it: `need_email` was answering two questions at once.
-- 307 leads never had an address; 19 had one a verifier proved dead. Both need
-- an address FOUND, so both landed on the same stage — and the dashboard, which
-- splits them because the work is different, then disagreed with the stage
-- filter: tiles reading 307 and 19 against a filter reading 326.
--
-- One stage per tile, no arithmetic.
-- ---------------------------------------------------------------------------
alter type public.pipeline_stage add value if not exists 'dead_email' after 'need_email';

-- --- source: supabase/migrations/20260805210000_dead_email_stage_and_status_views.sql
-- ---------------------------------------------------------------------------
-- 0027 — Use the `dead_email` stage, and retire the last two views that report
--        leads.status.
--
-- **Run 0026 first and let it commit.** This script uses the enum value that
-- one adds; running them together fails with "unsafe use of new value".
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. A dead address is its own stage.
--
-- Order inside the gates matters. `not email_found` comes first because a lead
-- with no address has nothing that could have been proved dead; `invalid` then
-- catches the ones that had an address and lost it.
-- ---------------------------------------------------------------------------
create or replace function public.compute_pipeline_stage(p public.lead_pipeline)
returns public.pipeline_stage
language sql
immutable
as $$
  select (case
    -- Facts, newest first. These cannot be undone by a later gate failing.
    when p.closed           is not null then 'closed'
    when p.replied          is not null then 'replied'
    when p.followup2_sent   is not null then 'followup2_sent'
    when p.followup1_sent   is not null then 'followup1_sent'
    when p.first_email_sent is not null then 'initial_sent'

    -- Gates, in the order they have to be cleared. The FIRST unmet one wins.
    when not p.email_found                        then 'need_email'
    when p.email_verification_status = 'invalid'  then 'dead_email'
    when not p.email_verified                     then 'need_verification'
    when not p.research_complete                  then 'research'
    when not p.draft_ready                        then 'draft'
    when not p.approved                           then 'review'
    else 'approved'
  end)::public.pipeline_stage;
$$;

comment on function public.compute_pipeline_stage(public.lead_pipeline) is
  'Derives current_stage as the FIRST unmet gate, so a stage names what is blocking the lead. Sent leads stay pinned. The ONE definition — do not re-implement in application code.';

-- ---------------------------------------------------------------------------
-- The NEXT STEP for both is identical: go and find an address. So
-- pipeline_next_step gains no value — two stages, one action, which is the
-- honest answer and saves a second enum migration.
-- ---------------------------------------------------------------------------
create or replace function public.compute_next_step(p public.lead_pipeline)
returns public.pipeline_next_step
language sql
stable
as $$
  select (case
    when p.closed         is not null then 'complete'
    when p.replied        is not null then 'close_workflow'
    when p.followup2_sent is not null then 'close_workflow'
    when p.followup1_sent is not null then
      case when p.followup2_due is not null and p.followup2_due <= now()
           then 'send_followup2' else 'await_followup2' end
    when p.first_email_sent is not null then
      case when p.followup1_due is not null and p.followup1_due <= now()
           then 'send_followup1' else 'await_followup1' end

    when not p.email_found                       then 'need_email'
    when p.email_verification_status = 'invalid' then 'need_email'
    when not p.email_verified                    then 'need_verification'
    when not p.research_complete                 then 'research_lead'
    when not p.draft_ready                       then 'generate_draft'
    when not p.approved                          then 'approve_draft'
    else 'send_initial_email'
  end)::public.pipeline_next_step;
$$;

-- Re-derive the stored column. current_stage is written by the BEFORE trigger,
-- so a no-op UPDATE is what moves the 19 dead addresses onto their new stage.
update public.lead_pipeline set updated_at = now();

-- ---------------------------------------------------------------------------
-- 2. Stage counts for the leads list, honouring the archived filter.
--
-- The filter panel read `analytics_stage_distribution`, which counts every
-- pipeline row. The leads list hides archived leads by default. So the facet
-- said `initial_sent 94` and the page it opened showed 93 — one of the two
-- archived leads sits at that stage.
--
-- Both figures, from one view, so the number on the chip and the number of rows
-- you get are the same question asked once. analytics_stage_distribution stays
-- as it is: /analytics is reporting on everything, deliberately.
-- ---------------------------------------------------------------------------
create or replace view public.lead_stage_counts
with (security_invoker = false) as
select
  p.current_stage::text                                        as stage,
  count(*) filter (where l.status <> 'archived')::bigint       as lead_count,
  count(*)::bigint                                             as lead_count_all
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where public.is_admin()
group by p.current_stage;

comment on view public.lead_stage_counts is
  'Stage counts for the leads filter panel. lead_count excludes archived (what the default list shows); lead_count_all includes them.';

grant select on public.lead_stage_counts to authenticated;


-- ---------------------------------------------------------------------------
-- 4. The public overview counts the new stage.
--
-- Its `need_email` counter reads `current_stage = 'need_email'`, so splitting
-- dead addresses out silently dropped 19 leads from every stage counter on the
-- public page. The whole body is restated because CREATE OR REPLACE VIEW needs
-- an identical leading column list; only the last column is new.
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
  )                                                                                            as avg_response_hours,

  -- Appended. CREATE OR REPLACE can only add columns at the END, so anything
  -- new goes here.
  (select count(*) from public.lead_pipeline where current_stage = 'dead_email')::bigint as dead_email;

comment on view public.public_stats_overview is
  'PUBLIC (anon-readable). Aggregate counters and rates only - no lead identity of any kind.';

-- ---------------------------------------------------------------------------
-- 5. The last two views reporting leads.status are retired.
--
-- Since 0025 the stage is the truth and leads.status is an inbound label from
-- the sheet. These two published the label: `dashboard_lead_status_counts` fed
-- a Lead-status table on /analytics and `public_stats_statuses` a breakdown on
-- the public page — each sitting next to a stage chart that answered the same
-- question correctly. 472 leads read `researching` while 695 have research
-- complete, so the two charts contradicted each other on screen.
--
-- `dashboard_leads_safe` goes with them: nothing has ever read it, and the
-- viewer role it was shaped for still has no scope. A future viewer feature
-- should start from a deliberate decision, not from this guess.
-- ---------------------------------------------------------------------------
drop view if exists public.dashboard_lead_status_counts;
drop view if exists public.public_stats_statuses;
drop view if exists public.dashboard_leads_safe;

-- --- source: supabase/migrations/20260806120000_verdicts_belong_to_an_address.sql
-- ---------------------------------------------------------------------------
-- 0028 — A verdict belongs to an ADDRESS, and so does a lead's identity.
--
-- Two bugs with one root cause: changing `leads.email` left everything that was
-- true of the OLD address attached to the lead.
--
-- ---------------------------------------------------------------------------
-- BUG 1 — editing an email created a duplicate lead on the next sync.
--
-- `dedupe_key` is computed once at import and nothing recomputed it. So:
--
--   1. lead exists with dedupe_key = 'email:info@apatchicars.com'
--   2. an admin corrects the address to showroom@apatchicars.com
--   3. write-back pushes the new address to the sheet row
--   4. the next sync reads that row, computes 'email:showroom@apatchicars.com',
--      finds no lead with that key -> INSERTS A NEW LEAD
--
-- Found in the live data as EIGHT sheet rows claimed by two leads each, three of
-- them email-to-email pairs that could only have come from this path:
--
--   row 686  Ali & Sons    email:ascon@ali-sons.com   || email:last@ali-sons.com
--   row 723  Apatchi Cars  email:showroom@apatchi...  || email:info@apatchi...
--   row 121  Modern Mart   email:contact@gmail.com    || email:info@modernmart.lk
--
-- plus four leads whose stored key no longer matched their own address, caught
-- mid-drift before the sync had run again.
--
-- The fix is to recompute the key AT THE MOMENT OF THE EDIT, in a trigger, so
-- every path behaves the same. GUIDE.md warns against recomputing keys, and that
-- warning was about a bulk backfill over every row at once, where a collision
-- fails an entire sync with nothing to show for it. One row at a time is the
-- opposite case: a collision means "another lead already owns that address",
-- which is a true and useful thing to say to whoever just typed it.
--
-- ---------------------------------------------------------------------------
-- BUG 2 — the verification verdict transferred to an address it was never about.
--
-- NeverBounce judged info@abc.com. Someone corrects a typo to info@abd.com. The
-- verdict stayed:
--
--   valid   -> the NEW, unchecked address is marked verified and passes the send
--              gate. An address nobody has ever checked gets mailed.
--   invalid -> the NEW, correct address is marked dead, blocked from sending
--              for ever, and counted in Dead Addresses.
--
-- Changing the address now resets the verdict to 'unverified'. That is what
-- makes "a verifier said invalid -> never send" safe to enforce: it applies only
-- while the address is the one that was judged, so correcting a typo genuinely
-- clears the history instead of needing an override that could be misused.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Remember what the VERIFIER said, separately from what a human said.
--
-- One status column could not answer "was this catch-all before you confirmed
-- it", because the manual verdict overwrote the verifier's. That question is the
-- whole basis of send priority: an address NeverBounce called valid deserves to
-- go before one that came back catch-all and was rescued by hand.
--
-- Only non-manual sources write here. `email_checked_address` records WHICH
-- address every verdict was about, which is what makes the reset below possible.
-- ---------------------------------------------------------------------------
alter table public.lead_pipeline
  add column if not exists email_verifier_status public.email_verification_status,
  add column if not exists email_checked_address text;

comment on column public.lead_pipeline.email_verifier_status is
  'The last verdict from a NON-manual source (a verifier, a bounce, a delivery). Survives a human override, so send priority can tell "NeverBounce said valid" from "NeverBounce said catch-all and a human confirmed it". NULL means no machine ever judged the current address.';

comment on column public.lead_pipeline.email_checked_address is
  'The address the current verdict is about. When leads.email changes to something else the verdict is reset, because it was never about the new address.';

-- Backfill: every verdict on record came from a verifier unless it says manual.
update public.lead_pipeline p
   set email_verifier_status = p.email_verification_status
 where p.email_verifier_status is null
   and p.email_verification_source is not null
   and p.email_verification_source <> 'manual';

-- And record which address each existing verdict was about.
update public.lead_pipeline p
   set email_checked_address = lower(btrim(l.email))
  from public.leads l
 where l.id = p.lead_id
   and p.email_checked_address is null
   and p.email_verification_status <> 'unverified'
   and l.email is not null;

-- ---------------------------------------------------------------------------
-- 2. The verdict trigger also records the verifier's own opinion.
--
-- Same bidirectional rule as 0023/0025, with one addition: a status arriving
-- from anything other than a human is remembered in email_verifier_status, and a
-- human's override leaves that column alone. That is the entire mechanism behind
-- send priority.
-- ---------------------------------------------------------------------------
create or replace function public.set_pipeline_stage()
returns trigger
language plpgsql
as $$
declare
  status_changed boolean;
  flag_changed   boolean;
begin
  if tg_op = 'INSERT' then
    status_changed := true;
    flag_changed := false;
  else
    status_changed := new.email_verification_status is distinct from old.email_verification_status;
    flag_changed   := new.email_verified is distinct from old.email_verified;
  end if;

  if status_changed then
    new.email_verified := (new.email_verification_status = 'valid');

    -- A machine spoke. Remember it, because a later human override must not
    -- erase what the verifier actually found.
    if new.email_verification_source is not null
       and new.email_verification_source <> 'manual'
       and new.email_verification_status <> 'unverified' then
      new.email_verifier_status := new.email_verification_status;
    end if;

  elsif flag_changed then
    if new.email_verified and new.email_verification_status <> 'valid' then
      new.email_verification_status := 'valid';
      new.email_verification_source := 'manual';
      new.email_checked_at := now();

    elsif not new.email_verified and new.email_verification_status = 'valid' then
      new.email_verification_status := 'unverified';
      new.email_verification_source := null;
      new.email_checked_at := null;
    end if;
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

comment on function public.set_pipeline_stage() is
  'Derives current_stage, keeps email_verified in step with email_verification_status in both directions, and records the verifier''s own verdict separately from a human override.';

-- ---------------------------------------------------------------------------
-- 3. Changing the address resets everything that was true of the old one.
--
-- BEFORE, on leads, so the recomputed dedupe_key is written in the same
-- statement rather than in a second round trip that could interleave.
--
-- The key is only recomputed when it was ALREADY email-based. A lead keyed
-- `site:` or `name:` keeps that identity: those keys were chosen because there
-- was no address at import, and switching identity scheme underneath a lead
-- that the sheet still matches by site would create the very duplicate this is
-- here to prevent.
-- ---------------------------------------------------------------------------
create or replace function public.rekey_lead_on_email_change()
returns trigger
language plpgsql
as $$
declare
  old_email text := lower(btrim(coalesce(old.email, '')));
  new_email text := lower(btrim(coalesce(new.email, '')));
begin
  if old_email is not distinct from new_email then
    return new;
  end if;

  if new.dedupe_key like 'email:%' and new_email <> '' then
    new.dedupe_key := 'email:' || new_email;
  end if;

  return new;
end;
$$;

comment on function public.rekey_lead_on_email_change() is
  'Keeps dedupe_key in step with the address it names. Without this, correcting an email made the next sheet sync insert a second lead for the same row.';

drop trigger if exists leads_rekey_on_email_change on public.leads;
create trigger leads_rekey_on_email_change
  before update of email on public.leads
  for each row execute function public.rekey_lead_on_email_change();

-- ---------------------------------------------------------------------------
-- 4. ...and the verification verdict resets with it.
--
-- AFTER, because it writes to a different table. Guarded on the address it was
-- actually about: a sync that rewrites the same address with different
-- whitespace or casing must not throw away a verdict.
-- ---------------------------------------------------------------------------
create or replace function public.reset_verification_on_email_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_email text := lower(btrim(coalesce(new.email, '')));
begin
  update public.lead_pipeline p
     set email_verification_status = 'unverified',
         email_verification_source = null,
         email_verifier_status     = null,
         email_checked_at          = null,
         email_checked_address     = null,
         email_verified_at         = null
   where p.lead_id = new.id
     -- Only when the verdict was about a DIFFERENT address. A NULL
     -- email_checked_address means a pre-0028 verdict of unknown provenance;
     -- those are left alone rather than silently discarded.
     and p.email_checked_address is not null
     and p.email_checked_address is distinct from nullif(new_email, '');

  return null;
end;
$$;

comment on function public.reset_verification_on_email_change() is
  'A verdict is about an address. When leads.email changes to a different one the verdict, its source, the verifier''s own verdict and the timestamps all reset to unverified.';

drop trigger if exists leads_reset_verification_on_email_change on public.leads;
create trigger leads_reset_verification_on_email_change
  after update of email on public.leads
  for each row execute function public.reset_verification_on_email_change();

-- ---------------------------------------------------------------------------
-- 5. Send priority.
--
-- Tier 1 goes out before any tier 2, tier 2 before any tier 3. Ordering only —
-- nothing is gated, because an address a human confirmed from the company's own
-- website is worth mailing; it just goes after the ones a verifier proved.
--
--   1  a verifier said valid, or a real email was already delivered
--   2  a human confirmed it, and no machine had said anything negative
--      (catch-all, or never checked at all)
--   3  a human confirmed it after the verifier tried and gave up (unknown)
--   9  not sendable
--
-- `invalid` is 9 even when a human has since marked it valid, BECAUSE the
-- verdict now resets on an address change: if the address is the same one that
-- bounced, no override should rescue it, and if it has been corrected the
-- verifier status is already NULL and the lead is nowhere near this branch.
-- ---------------------------------------------------------------------------
create or replace function public.compute_send_priority(p public.lead_pipeline)
returns integer
language sql
immutable
as $$
  select (case
    when p.email_verifier_status = 'invalid'                    then 9
    when not p.email_verified                                   then 9
    when p.email_verification_source = 'delivered'              then 1
    when p.email_verifier_status = 'valid'                      then 1
    when p.email_verifier_status = 'unknown'                    then 3
    else 2
  end);
$$;

comment on function public.compute_send_priority(public.lead_pipeline) is
  'Send order for initial emails: 1 = a verifier proved it, 2 = a human confirmed it with no negative machine signal, 3 = a human confirmed it after the verifier gave up, 9 = not sendable. Ordering only, never a gate.';

-- ---------------------------------------------------------------------------
-- 6. Expose it on the board, appended at the end (CREATE OR REPLACE can only
--    add columns there — inserting mid-list raises 42P16).
-- ---------------------------------------------------------------------------
drop view if exists public.pipeline_board;
create view public.pipeline_board
with (security_invoker = false) as
select
  p.lead_id,
  l.business_name,
  l.email,
  l.city,
  l.country,
  l.niche,
  l.status                       as lead_status,
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
  p.updated_at,
  p.email_verification_status,
  p.email_verification_source,
  p.email_checked_at,
  p.email_verifier_status,
  p.email_checked_address,
  public.compute_send_priority(p) as send_priority
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where public.is_admin();

comment on view public.pipeline_board is
  'Admin-only pipeline rows with the derived next_step, verification state and send priority. Contains contact data — never grant to anon.';

grant select on public.pipeline_board to authenticated;

-- ---------------------------------------------------------------------------
-- 0029 — dedupe_key computes itself on INSERT.
--
-- Every existing writer (the workbook importer, the Google Sheet sync)
-- computes dedupe_key in TypeScript before the INSERT, via buildDedupeKey()
-- in lib/import/dedupe.ts. That was fine while Postgres was only ever reached
-- through those two paths. It stops being fine the moment something else
-- inserts a lead directly — n8n, writing straight to Supabase instead of the
-- Google Sheet the CRM used to sync from (2026-08-10: the sheet is being
-- retired as the ingestion layer).
--
-- leads.dedupe_key is NOT NULL with a CHECK that it is non-blank, so a direct
-- insert that leaves it out is simply rejected, and a direct insert that gets
-- the formula slightly wrong (different case, different trimming, a stray
-- www.) creates exactly the duplicate-key mess 0028 spent a migration
-- cleaning up — except this time nothing would ever notice, because there is
-- no sheet_row_number pairing to catch it by.
--
-- Mirrors buildDedupeKey()'s priority order exactly: email, then website,
-- then business name + city. Only fires when the caller left dedupe_key
-- blank (NULL or '') — every existing writer, which already computes its own
-- key, is untouched by this. Website normalization here is deliberately
-- simpler than the TypeScript version (strip scheme and www, drop a trailing
-- slash, no query string handling) — plpgsql has no URL type — but it agrees
-- with it on every plain "https://example.com" style website already in the
-- table, which is what matters: the two must never compute two different
-- keys for the same input.
-- ---------------------------------------------------------------------------

create or replace function public.assign_dedupe_key_on_insert()
returns trigger
language plpgsql
as $$
declare
  email_norm   text := lower(btrim(coalesce(new.email, '')));
  website_norm text;
  name_norm    text;
  city_norm    text;
begin
  if new.dedupe_key is not null and length(btrim(new.dedupe_key)) > 0 then
    return new;
  end if;

  if email_norm <> '' then
    new.dedupe_key := 'email:' || email_norm;
    return new;
  end if;

  if new.website is not null and length(btrim(new.website)) > 0 then
    website_norm := lower(btrim(new.website));
    website_norm := regexp_replace(website_norm, '^https?://', '');
    website_norm := regexp_replace(website_norm, '^www\.', '');
    website_norm := regexp_replace(website_norm, '/+$', '');
    new.dedupe_key := 'site:' || website_norm;
    return new;
  end if;

  name_norm := lower(regexp_replace(coalesce(new.business_name, ''), '[^[:alnum:][:space:]]', ' ', 'g'));
  name_norm := btrim(regexp_replace(name_norm, '\s+', ' ', 'g'));
  city_norm := lower(regexp_replace(coalesce(new.city, ''), '[^[:alnum:][:space:]]', ' ', 'g'));
  city_norm := btrim(regexp_replace(city_norm, '\s+', ' ', 'g'));
  new.dedupe_key := 'name:' || name_norm || '|' || city_norm;
  return new;
end;
$$;

comment on function public.assign_dedupe_key_on_insert() is
  'Computes dedupe_key (email > website > name+city, same priority as buildDedupeKey() in lib/import/dedupe.ts) for any INSERT that leaves it blank — the case a direct writer like n8n hits that the sheet sync and the workbook importer never did, since both already set it themselves before the insert.';

drop trigger if exists leads_assign_dedupe_key on public.leads;
create trigger leads_assign_dedupe_key
  before insert on public.leads
  for each row execute function public.assign_dedupe_key_on_insert();

comment on trigger leads_assign_dedupe_key on public.leads is
  'Fires before leads_rekey_on_email_change (0028) on UPDATE and independently of it — this one only ever runs on INSERT.';

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

-- ---------------------------------------------------------------------------
-- 0031 — blank optional fields normalize to NULL before the CHECK constraints
-- see them.
--
-- A direct writer (n8n, since 2026-08-10) that has no value for an optional
-- field understandably sends an empty string rather than omitting the key or
-- explicitly sending null — that is what "no data" looks like coming out of
-- most upstream nodes and expressions. leads.email and leads.website both
-- have a format CHECK that only exempts NULL, not '':
--
--   leads_email_format    check (email   is null or email   ~* '...')
--   leads_website_scheme  check (website is null or website ~* '^https?://')
--
-- so an empty string trips the constraint with an opaque Postgres error and
-- the whole row is rejected. Observed live: n8n's very first lead with no
-- email failed the insert outright.
--
-- Every writer that goes through the application already avoids this —
-- cleanText() in lib/import/normalize.ts turns blank into null before
-- anything reaches Postgres. A direct writer has no such layer in front of
-- it, and asking every n8n expression, in every workflow, forever, to get
-- this right is the same mistake REFRESHABLE_FIELDS already avoids elsewhere
-- in this codebase: one rule, enforced once, in the one place every path
-- goes through.
--
-- business_name is deliberately NOT touched here. It is required; a blank
-- one should fail loudly against leads_business_name_not_blank, not silently
-- become NULL and fail against the column's NOT NULL constraint instead with
-- a less specific error.
-- ---------------------------------------------------------------------------

create or replace function public.normalize_blank_lead_fields()
returns trigger
language plpgsql
as $$
begin
  if new.email is not null and length(btrim(new.email)) = 0 then
    new.email := null;
  end if;
  if new.website is not null and length(btrim(new.website)) = 0 then
    new.website := null;
  end if;
  if new.phone is not null and length(btrim(new.phone)) = 0 then
    new.phone := null;
  end if;
  if new.city is not null and length(btrim(new.city)) = 0 then
    new.city := null;
  end if;
  if new.country is not null and length(btrim(new.country)) = 0 then
    new.country := null;
  end if;
  if new.niche is not null and length(btrim(new.niche)) = 0 then
    new.niche := null;
  end if;
  return new;
end;
$$;

comment on function public.normalize_blank_lead_fields() is
  'Turns an empty/whitespace-only string into NULL for the optional identity fields, before leads_email_format / leads_website_scheme (and dedupe key computation) see the row. Protects any direct writer that sends "" for "no value" instead of omitting the field or sending null — n8n''s direct-insert workflow being the reason this exists.';

drop trigger if exists leads_normalize_blank_fields on public.leads;
create trigger leads_normalize_blank_fields
  before insert or update on public.leads
  for each row execute function public.normalize_blank_lead_fields();

comment on trigger leads_normalize_blank_fields on public.leads is
  'Runs before leads_assign_dedupe_key and leads_rekey_on_email_change (trigger order does not matter between them — both already coalesce a null/blank email the same way), so email/website/phone/city/country/niche are already clean by the time either reads them.';

-- ---------------------------------------------------------------------------
-- 0032 — social_links normalizes to an OBJECT before leads_social_links_is_object
-- sees it.
--
-- MUST be pasted AFTER 0031 (20260810110000_normalize_blank_leads_fields.sql).
-- Both use `create or replace function public.normalize_blank_lead_fields()`
-- on the SAME function name — this migration's version below is a superset
-- (adds the social_links branch, keeps every existing branch unchanged), but a
-- trigger always runs whatever the function currently resolves to, not a
-- snapshot from when the trigger was created. Paste 0031 then 0032, in that
-- order, or 0031 pasted second would silently overwrite this one and the
-- social_links fix would vanish having appeared to apply cleanly.
--
-- Root cause: `leads.social_links` is `jsonb not null default '{}'::jsonb`
-- with `check (jsonb_typeof(social_links) = 'object')` — an empty object is
-- already fine, always was. What trips the constraint is anything that is
-- valid jsonb but NOT an object: n8n's "Update a row" node, or the AI step
-- feeding it, can hand this column a JSON STRING instead of a JSON OBJECT —
-- the literal characters `{}` serialized AS TEXT (`jsonb_typeof` reads that as
-- 'string', not 'object'), or the raw "Social Links" prose from the research
-- step passed straight through as a bare string. Either way Postgres accepts
-- it as valid jsonb and then the CHECK rejects the whole row.
--
-- Mirrors normalizeSocialLinks() in lib/import/normalize.ts exactly, so a
-- direct n8n write behaves the same as the sheet importer always has: a
-- string that parses as a JSON object is unwrapped and used; a string that
-- does not (real prose, a plain list of URLs) survives under a "_raw" key
-- rather than being discarded; blank, "{}", or anything else with no sensible
-- object reading (an array, a number, a bare JSON null) becomes {}.
-- ---------------------------------------------------------------------------

create or replace function public.normalize_blank_lead_fields()
returns trigger
language plpgsql
as $$
declare
  inner_text text;
  parsed     jsonb;
begin
  if new.email is not null and length(btrim(new.email)) = 0 then
    new.email := null;
  end if;
  if new.website is not null and length(btrim(new.website)) = 0 then
    new.website := null;
  end if;
  if new.phone is not null and length(btrim(new.phone)) = 0 then
    new.phone := null;
  end if;
  if new.city is not null and length(btrim(new.city)) = 0 then
    new.city := null;
  end if;
  if new.country is not null and length(btrim(new.country)) = 0 then
    new.country := null;
  end if;
  if new.niche is not null and length(btrim(new.niche)) = 0 then
    new.niche := null;
  end if;

  -- social_links: always end up as a jsonb OBJECT. The column is NOT NULL
  -- with a '{}'::jsonb default, so SQL NULL never reaches here through the
  -- normal insert path, but a caller that sends it explicitly is covered too.
  if new.social_links is null then
    new.social_links := '{}'::jsonb;

  elsif jsonb_typeof(new.social_links) = 'string' then
    inner_text := btrim(coalesce(new.social_links #>> '{}', ''));

    if inner_text = '' or inner_text = '{}' then
      new.social_links := '{}'::jsonb;
    else
      -- The string might itself be JSON text (a double-encoded object) —
      -- try it, and fall back to treating it as plain prose on any error.
      begin
        parsed := inner_text::jsonb;
      exception when others then
        parsed := null;
      end;

      if parsed is not null and jsonb_typeof(parsed) = 'object' then
        new.social_links := parsed;
      else
        new.social_links := jsonb_build_object('_raw', left(inner_text, 2000));
      end if;
    end if;

  elsif jsonb_typeof(new.social_links) <> 'object' then
    -- Array, number, boolean, or a bare JSON null literal — no sensible
    -- object reading, so it is dropped to empty rather than rejected.
    new.social_links := '{}'::jsonb;
  end if;

  return new;
end;
$$;

comment on function public.normalize_blank_lead_fields() is
  'Turns an empty/whitespace-only string into NULL for the optional identity fields (0031), and normalizes social_links to a jsonb OBJECT (0032) — a JSON-object-shaped string is unwrapped, other text survives under "_raw", anything else with no sensible object reading becomes {}. Protects any direct writer (n8n) whose shape does not already match what leads_email_format / leads_website_scheme / leads_social_links_is_object require.';

-- Trigger already exists from 0031 (before insert or update, same function) —
-- recreated here too so this migration is self-sufficient regardless of
-- paste order relative to 0031 having already run.
drop trigger if exists leads_normalize_blank_fields on public.leads;
create trigger leads_normalize_blank_fields
  before insert or update on public.leads
  for each row execute function public.normalize_blank_lead_fields();

-- ---------------------------------------------------------------------------
-- 0033 — the Google Sheet is retired.
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
-- the 0028 leak pairs — the pattern that grouping by email alone cannot see.
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
-- invalidate the service account — delete the key (or the whole service
-- account) in the Google Cloud console, and remove its share from the
-- spreadsheet. See GUIDE.md section 8.
-- ---------------------------------------------------------------------------
delete from public.integration_secrets
 where key in ('sheets.api_key', 'sheets.service_account_json');
