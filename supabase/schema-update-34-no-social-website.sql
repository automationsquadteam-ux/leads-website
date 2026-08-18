-- ===========================================================================
-- Schema update 34 - a social-media profile link is not a website.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-33 first. Re-runnable throughout.
--
-- Extends normalize_blank_lead_fields() (0031) so a Facebook/Instagram/etc.
-- profile URL written to leads.website is nulled out the same way a blank
-- string already is, then backfills every existing lead already carrying
-- one. See supabase/migrations/20260818130000_website_rejects_social_media_links.sql
-- for the full reasoning.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0044 — website rejects social-media links, at insert/update and once
-- retroactively.
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
  'Turns an empty/whitespace-only string into NULL for the optional identity fields, and a social-media profile URL into NULL for website specifically (0044), before leads_email_format / leads_website_scheme (and dedupe key computation) see the row. Protects any direct writer that sends "" for "no value" instead of omitting the field or sending null — n8n''s direct-insert workflow being the reason this exists — and stops a Facebook/Instagram/etc. profile link from being read as the business''s own site anywhere downstream.';

-- ---------------------------------------------------------------------------
-- Backfill: leads already carrying a social-media link as their "website".
-- ---------------------------------------------------------------------------
update public.leads
   set website = null
 where website ~* '^https?://([a-z0-9-]+\.)*(facebook\.com|fb\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|tiktok\.com|pinterest\.com|youtube\.com|youtu\.be|threads\.net|snapchat\.com|whatsapp\.com|wa\.me|t\.me|telegram\.me|telegram\.org)(/|$)';
