-- ===========================================================================
-- Schema update 37 - approval inheritance checks content, not just the code.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-36 first. Re-runnable throughout.
--
-- See supabase/migrations/20260913180000_inherit_approval_content_check.sql.
-- Redefines inherit_initial_approval() so a native initial only inherits
-- approval when it has no [placeholder], is in its language's script, and
-- does not open in English. Trigger definition unchanged.
--
-- PROBE: insert a throwaway initial for any non-English-country lead with
-- content 'Hola [Business Name]' and language matching the country -> it must
-- land status='draft' even though the lead has an approved initial. Then
-- delete it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0047 — approval inheritance checks the CONTENT, not just the language code.
--
-- 0046's inherit_initial_approval() approved 253 native initials in one
-- batch, and a live audit of them the same day found what a code-only check
-- lets through: 30 carried an unfilled [Business Name] / [Recipient] /
-- [Business Owner] placeholder, and 20 were written in English despite a
-- non-English language code — the model (llama3.1:8b) ignored the prompt's
-- language rule and the row said "es" anyway. The placeholder ones would have
-- failed at first send and blocked the lead; the English ones would have
-- SHIPPED, because the hold gate compares codes and the code was right.
--
-- So inheriting an approval now requires the text to pass two cheap, exact
-- checks. Both are things a human reviewer would have rejected on sight, and
-- both are the reason the review step existed before it was bypassed:
--
--   1. No square-bracket placeholder anywhere in subject or content. Same
--      convention 0040's findUnresolvedPlaceholders() catches at send time —
--      catching it here leaves the version a draft for the sweep / a re-run
--      instead of a failure row and a blocked lead.
--
--   2. The body is actually in the claimed language. Two signals, either one
--      fails it:
--        a. For a non-Latin-script language (Greek, Bulgarian, Arabic,
--           Japanese), the content must contain that script. Exact.
--        b. For ANY non-English language, the OPENING of the body (first
--           250 characters) must not be an English opener — "I came across",
--           "I noticed", "I've been researching". The opening is where the
--           language is decided; this is high-precision for Latin-script
--           languages where the script check cannot apply.
--
--           Deliberately NOT the sign-off. The first draft of this check also
--           matched "Best regards" and flagged 46 emails whose bodies were
--           perfectly native and merely ended with the English sign-off the
--           prompt insists on — a blemish, not a wrong-language email, and
--           not grounds to withhold approval.
--
-- A version that fails either stays 'draft', active as inserted — it simply
-- does not inherit. It is then visible in the review queue, and because the
-- hold gate sees a draft (not approved), it cannot send. The operator's
-- re-run with a corrected prompt replaces it.
--
-- Re-runnable: CREATE OR REPLACE on the function; the trigger definition is
-- unchanged from 0046 and is re-created identically.
-- ---------------------------------------------------------------------------
create or replace function public.inherit_initial_approval()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target       text;
  has_approved boolean;
  text_all     text := coalesce(new.subject, '') || E'\n' || coalesce(new.content, '');
  script_ok    boolean := true;
begin
  select public.language_for_country(l.country) into target
    from public.leads l
   where l.id = new.lead_id;

  if target is null or new.language is distinct from target then
    return new;
  end if;

  -- 1. An unfilled placeholder is a draft nobody finished.
  if text_all ~ '\[[^\]\n]{2,60}\]' then
    return new;
  end if;

  -- 2a. Non-Latin-script languages must actually contain that script.
  script_ok := case new.language
    when 'el' then new.content ~ '[Α-Ωα-ωΆ-ώ]'
    when 'bg' then new.content ~ '[А-Яа-я]'
    when 'ar' then new.content ~ '[؀-ۿ]'
    when 'ja' then new.content ~ '[぀-ヿ一-鿿]'
    else true
  end;
  if not script_ok then
    return new;
  end if;

  -- 2b. Any non-English language must not OPEN in English. Opening only —
  -- the sign-off is excluded on purpose (see the header note).
  if left(new.content, 250) ~* '(i came across|i noticed|i''ve been researching|i have been researching|i was impressed|i saw that you|i(?:''| a)m reaching out|hi, i )' then
    return new;
  end if;

  select exists (
    select 1 from public.email_versions v
     where v.lead_id = new.lead_id
       and v.type    = 'initial'
       and v.status  = 'approved'
  ) into has_approved;

  if has_approved then
    new.status      := 'approved';
    new.reviewed_at := coalesce(new.reviewed_at, now());
    new.review_note := coalesce(
      new.review_note,
      'Approval inherited from the earlier approved initial (native-language regeneration, 0046; content checks 0047).'
    );
  end if;

  return new;
end;
$$;

comment on function public.inherit_initial_approval() is
  'A native-language initial for a lead whose English initial was already approved lands approved — but only if it carries no [placeholder], is in the script its language uses, and does not contain the English sign-off/opener (0047). Anything failing those stays a draft for review.';

drop trigger if exists email_versions_inherit_approval on public.email_versions;
create trigger email_versions_inherit_approval
  before insert on public.email_versions
  for each row
  when (new.type = 'initial' and new.status = 'draft' and new.language <> 'en')
  execute function public.inherit_initial_approval();
