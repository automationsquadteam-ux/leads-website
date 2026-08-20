-- ===========================================================================
-- Schema update 19 - dedupe_key computes itself on INSERT.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-18 first. Re-runnable throughout.
--
-- Needed for n8n writing leads directly into Supabase (bypassing the Google
-- Sheet): every existing writer computed dedupe_key itself before the INSERT,
-- which a direct writer has no reason to replicate correctly. This computes
-- it in Postgres whenever a caller leaves it blank, using the same
-- email > website > name+city priority as buildDedupeKey().
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0029 ,dedupe_key computes itself on INSERT.
--
-- Every existing writer (the workbook importer, the Google Sheet sync)
-- computes dedupe_key in TypeScript before the INSERT, via buildDedupeKey()
-- in lib/import/dedupe.ts. That was fine while Postgres was only ever reached
-- through those two paths. It stops being fine the moment something else
-- inserts a lead directly ,n8n, writing straight to Supabase instead of the
-- Google Sheet the CRM used to sync from (2026-08-10: the sheet is being
-- retired as the ingestion layer).
--
-- leads.dedupe_key is NOT NULL with a CHECK that it is non-blank, so a direct
-- insert that leaves it out is simply rejected, and a direct insert that gets
-- the formula slightly wrong (different case, different trimming, a stray
-- www.) creates exactly the duplicate-key mess 0028 spent a migration
-- cleaning up ,except this time nothing would ever notice, because there is
-- no sheet_row_number pairing to catch it by.
--
-- Mirrors buildDedupeKey()'s priority order exactly: email, then website,
-- then business name + city. Only fires when the caller left dedupe_key
-- blank (NULL or '') ,every existing writer, which already computes its own
-- key, is untouched by this. Website normalization here is deliberately
-- simpler than the TypeScript version (strip scheme and www, drop a trailing
-- slash, no query string handling) ,plpgsql has no URL type ,but it agrees
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
  'Computes dedupe_key (email > website > name+city, same priority as buildDedupeKey() in lib/import/dedupe.ts) for any INSERT that leaves it blank ,the case a direct writer like n8n hits that the sheet sync and the workbook importer never did, since both already set it themselves before the insert.';

drop trigger if exists leads_assign_dedupe_key on public.leads;
create trigger leads_assign_dedupe_key
  before insert on public.leads
  for each row execute function public.assign_dedupe_key_on_insert();

comment on trigger leads_assign_dedupe_key on public.leads is
  'Fires before leads_rekey_on_email_change (0028) on UPDATE and independently of it ,this one only ever runs on INSERT.';
