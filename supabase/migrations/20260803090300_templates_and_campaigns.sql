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
