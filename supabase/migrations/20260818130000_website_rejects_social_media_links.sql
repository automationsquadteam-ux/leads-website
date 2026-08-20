-- ---------------------------------------------------------------------------
-- 0044 ,a social-media profile link is not a website, and leads.website was
-- treating it as one.
--
-- Reported directly: a batch of leads carry `website` values that are
-- actually Facebook or Instagram profile URLs (or another social platform) —
-- a scraper's fallback when the business has no real site of its own.
-- Nothing distinguished those from a genuine website anywhere downstream:
-- `missing.csv` (leads-missing-email export) would have called such a lead
-- "has a website" and sorted it ahead of ones with nothing at all, the
-- website cell on the leads table linked straight to someone's Instagram
-- profile as if it were the business's own site, and there was nowhere this
-- got caught on the way in.
--
-- Fixed at the one point every writer of `leads.website` already passes
-- through ,`normalize_blank_lead_fields()`, the same BEFORE trigger 0031
-- added to turn a blank string into NULL ,rather than in application code,
-- because application code is not the only writer: n8n inserts and updates
-- `leads` directly, and the workbook importer (`lib/import/normalize.ts`,
-- given the same check today as a courtesy for an early, visible warning at
-- import time) is a second, separate path. One rule, enforced once, in the
-- place every writer already goes through ,same reasoning as 0021, 0028,
-- 0031 and every other centralized gate in this project.
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
  -- A social-media profile is a stand-in for not having a website, not a
  -- website. `leads.social_links` is where a real profile link belongs;
  -- this column claims to be the business's own site and nothing downstream
  -- can tell the difference unless it is kept honest here.
  if new.website is not null and new.website ~* '^https?://([a-z0-9-]+\.)*(facebook\.com|fb\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|tiktok\.com|pinterest\.com|youtube\.com|youtu\.be|threads\.net|snapchat\.com|whatsapp\.com|wa\.me|t\.me|telegram\.me|telegram\.org)(/|$)' then
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
  'Turns an empty/whitespace-only string into NULL for the optional identity fields, and a social-media profile URL into NULL for website specifically (0044), before leads_email_format / leads_website_scheme (and dedupe key computation) see the row. Protects any direct writer that sends "" for "no value" instead of omitting the field or sending null ,n8n''s direct-insert workflow being the reason this exists ,and stops a Facebook/Instagram/etc. profile link from being read as the business''s own site anywhere downstream.';

-- ---------------------------------------------------------------------------
-- Backfill: leads already carrying a social-media link as their "website".
-- Same pattern as the trigger above, applied once to existing rows so the
-- fix does not wait on the next time each row happens to be written.
-- ---------------------------------------------------------------------------
update public.leads
   set website = null
 where website ~* '^https?://([a-z0-9-]+\.)*(facebook\.com|fb\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|tiktok\.com|pinterest\.com|youtube\.com|youtu\.be|threads\.net|snapchat\.com|whatsapp\.com|wa\.me|t\.me|telegram\.me|telegram\.org)(/|$)';
