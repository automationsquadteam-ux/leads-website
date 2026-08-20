-- ---------------------------------------------------------------------------
-- 0032 ,social_links normalizes to an OBJECT before leads_social_links_is_object
-- sees it.
--
-- MUST be pasted AFTER 0031 (20260810110000_normalize_blank_leads_fields.sql).
-- Both use `create or replace function public.normalize_blank_lead_fields()`
-- on the SAME function name ,this migration's version below is a superset
-- (adds the social_links branch, keeps every existing branch unchanged), but a
-- trigger always runs whatever the function currently resolves to, not a
-- snapshot from when the trigger was created. Paste 0031 then 0032, in that
-- order, or 0031 pasted second would silently overwrite this one and the
-- social_links fix would vanish having appeared to apply cleanly.
--
-- Root cause: `leads.social_links` is `jsonb not null default '{}'::jsonb`
-- with `check (jsonb_typeof(social_links) = 'object')` ,an empty object is
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
    -- Array, number, boolean, or a bare JSON null literal ,no sensible
    -- object reading, so it is dropped to empty rather than rejected.
    new.social_links := '{}'::jsonb;
  end if;

  return new;
end;
$$;

comment on function public.normalize_blank_lead_fields() is
  'Turns an empty/whitespace-only string into NULL for the optional identity fields (0031), and normalizes social_links to a jsonb OBJECT (0032) ,a JSON-object-shaped string is unwrapped, other text survives under "_raw", anything else with no sensible object reading becomes {}. Protects any direct writer (n8n) whose shape does not already match what leads_email_format / leads_website_scheme / leads_social_links_is_object require.';

-- Trigger already exists from 0031 (before insert or update, same function) —
-- recreated here too so this migration is self-sufficient regardless of
-- paste order relative to 0031 having already run.
drop trigger if exists leads_normalize_blank_fields on public.leads;
create trigger leads_normalize_blank_fields
  before insert or update on public.leads
  for each row execute function public.normalize_blank_lead_fields();
