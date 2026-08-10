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
