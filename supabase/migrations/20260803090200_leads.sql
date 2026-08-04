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
