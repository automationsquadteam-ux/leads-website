-- ---------------------------------------------------------------------------
-- 0046 — outreach in the lead's own language.
--
-- Asked for directly: emails to a list of countries should go out in that
-- country's language. The design that came out of the constraints:
--
--   * NO language model anywhere in this application. Ollama runs on the
--     operator's machine and is not exposed to Vercel, and the operator was
--     explicit that translation must be done by "the website's code, not
--     Ollama". So every piece of prose the CRM itself writes (the follow-up
--     scaffolding) is a static, hand-written translation in
--     lib/services/ai/languages.ts, and nothing here calls out to anything.
--
--   * The INITIAL email is written by n8n, which does have Ollama. Its prompt
--     now writes the email natively, and this migration gives it three things:
--     a column to record which language it wrote in, a column for a native
--     one-line "angle" the follow-ups can quote, and a view that hands it
--     exactly the leads that still need a native initial — so n8n never has
--     to know the rule, and re-running the batch is safe.
--
--   * LANGUAGE IS LOCKED ON THE FIRST EMAIL. Follow-ups read the language of
--     the initial version that is active for the lead, never the country. A
--     lead first contacted in English keeps getting English — 406 live leads
--     in non-English countries are already mid-sequence in English, and a
--     switch halfway through a thread is worse than either language alone.
--     Every existing version row defaults to 'en', which encodes that lock
--     for all of them at once.
--
--   * A native regeneration INHERITS an earlier approval. The operator
--     reviewed and approved the English initial; the native version of the
--     same email carries that approval so the review queue does not refill
--     with 361 drafts the operator cannot read. Scoped tightly: only a version
--     whose language matches what the country calls for, and only when an
--     approved initial already exists. An English re-generation still queues
--     for review exactly as before.
--
--   * The sender HOLDS an initial whose language is not the lead's target
--     (setting `outreach.require_native_language`, default on), so nothing
--     ships in the wrong language while n8n catches up. A hold, not a
--     failure: no email_logs row, so it does not trip the block-until-fixed
--     gate, and the lead is released the moment its native version lands.
--
-- Re-runnable throughout.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Which language each version is written in, and the native angle.
--
-- `language` is a bare ISO 639-1 code as text, not an enum: adding a language
-- must be a settings/data change, never a migration (see 0026/0027 for what an
-- enum costs when it has to grow). The default is what makes the lock work for
-- every row that predates this.
--
-- `angle` is the one-or-two-sentence note the follow-ups quote ("here is the
-- note I made when I looked you up: ..."). It lives on the VERSION rather than
-- overwriting leads.outreach_angle, so the English research the operator
-- reads on the lead page stays English, and the angle travels with the
-- language it was written in.
-- ---------------------------------------------------------------------------
alter table public.email_versions
  add column if not exists language text not null default 'en',
  add column if not exists angle    text;

comment on column public.email_versions.language is
  'ISO 639-1 code of the language this version is written in. Follow-ups are generated in the language of the ACTIVE INITIAL version, never from the country ,language is locked on the first email. Pre-0046 rows default to en.';
comment on column public.email_versions.angle is
  'Native-language one-liner naming the specific opportunity, written by n8n alongside the initial. The follow-up templates quote it. Null on versions n8n did not write.';

-- ---------------------------------------------------------------------------
-- 2. Country → language. One table, three readers (this schema, the app, and
-- n8n via the view below), so the mapping cannot drift between them.
--
-- Native tongue everywhere it is unambiguous; English where English IS the
-- business language (SG, ZA, IE, CA and the anglophone countries) and for any
-- country not listed. Switzerland → German and Belgium → Dutch are the
-- majority-language calls and are the two most likely to want changing.
-- ---------------------------------------------------------------------------
create table if not exists public.country_languages (
  country        text primary key,
  language       text not null,
  language_name  text not null
);

comment on table public.country_languages is
  'Country name (exactly as stored on leads.country) → outreach language. A country absent here means English. Edit rows to change the mapping; nothing in code needs to change.';

insert into public.country_languages (country, language, language_name) values
  ('Germany',        'de', 'German'),
  ('Austria',        'de', 'German'),
  ('Switzerland',    'de', 'German'),
  ('Netherlands',    'nl', 'Dutch'),
  ('Belgium',        'nl', 'Dutch'),
  ('France',         'fr', 'French'),
  ('Italy',          'it', 'Italian'),
  ('Spain',          'es', 'Spanish'),
  ('Mexico',         'es', 'Spanish'),
  ('Portugal',       'pt', 'Portuguese'),
  ('Brazil',         'pt', 'Portuguese'),
  ('Norway',         'no', 'Norwegian'),
  ('Denmark',        'da', 'Danish'),
  ('Sweden',         'sv', 'Swedish'),
  ('Poland',         'pl', 'Polish'),
  ('Czech Republic', 'cs', 'Czech'),
  ('Hungary',        'hu', 'Hungarian'),
  ('Greece',         'el', 'Greek'),
  ('Bulgaria',       'bg', 'Bulgarian'),
  ('Turkey',         'tr', 'Turkish'),
  ('Japan',          'ja', 'Japanese'),
  ('Indonesia',      'id', 'Indonesian'),
  ('Malaysia',       'ms', 'Malay'),
  ('UAE',            'ar', 'Arabic'),
  ('Saudi Arabia',   'ar', 'Arabic'),
  ('Qatar',          'ar', 'Arabic'),
  ('Kuwait',         'ar', 'Arabic')
on conflict (country) do nothing;

create or replace function public.language_for_country(p_country text)
returns text
language sql
stable
as $$
  select coalesce(
    (select cl.language from public.country_languages cl where cl.country = btrim(p_country)),
    'en'
  );
$$;

create or replace function public.language_name(p_language text)
returns text
language sql
stable
as $$
  select coalesce(
    (select cl.language_name from public.country_languages cl where cl.language = p_language limit 1),
    'English'
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. A native initial inherits the approval of the English one it replaces.
--
-- BEFORE INSERT, because it sets a value ON THE INCOMING ROW (new.status) and
-- nothing else — it touches no sibling, so it is not subject to the partial
-- unique-index trap that makes enforce_single_active_version() a BEFORE
-- trigger for a different reason. It runs before email_versions_sync_pipeline
-- (AFTER), which therefore sees approved + active and keeps lead_pipeline
-- .approved true, and before enforce_single_active_version() (also BEFORE,
-- later alphabetically) demotes the English row.
--
-- The WHEN clause keeps this off every ordinary insert: only a non-English
-- draft initial is even examined, and the body then requires that its
-- language be the one the country calls for AND that an approved initial
-- already exists. Anything else — an English regeneration, a lead never
-- approved, a language nobody asked for — is left exactly as it arrived.
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
begin
  select public.language_for_country(l.country) into target
    from public.leads l
   where l.id = new.lead_id;

  if target is null or new.language is distinct from target then
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
      'Approval inherited from the earlier approved initial (native-language regeneration, 0046).'
    );
  end if;

  return new;
end;
$$;

comment on function public.inherit_initial_approval() is
  'A native-language initial written for a lead whose English initial was already approved lands approved, so the review queue does not refill with drafts the reviewer cannot read. Only when the version language matches language_for_country(lead.country).';

drop trigger if exists email_versions_inherit_approval on public.email_versions;
create trigger email_versions_inherit_approval
  before insert on public.email_versions
  for each row
  when (new.type = 'initial' and new.status = 'draft' and new.language <> 'en')
  execute function public.inherit_initial_approval();

-- ---------------------------------------------------------------------------
-- 4. The queue n8n reads: leads that still need a native-language initial.
--
-- Same protection model as lead_send_queue (0035): GRANTS, not an is_admin()
-- predicate, because n8n runs on the service-role key, which satisfies no
-- such predicate — that is exactly how pipeline_board once returned zero
-- rows to the scheduler. Never granted to anon or authenticated.
--
-- Self-emptying and therefore safe to re-run: a lead drops out the moment an
-- active initial exists in its target language. The condition is "not yet
-- contacted" (no first_email_sent), never "status = approved" — the 8 leads
-- that are unsent but not yet approved need a native draft just as much, and
-- their English one was not approved either.
--
-- Every research column n8n's prompt reads is exposed here, because the
-- research nodes are disconnected for this batch and the prompt must be fed
-- from the stored row instead.
-- ---------------------------------------------------------------------------
create or replace view public.leads_needing_native_initial
with (security_invoker = false) as
select
  l.id,
  l.business_name,
  l.niche,
  l.city,
  l.country,
  public.language_for_country(l.country)                       as language,
  public.language_name(public.language_for_country(l.country)) as language_name,
  l.website,
  l.research_summary,
  l.website_observations,
  l.automation_opportunities,
  l.ai_chatbot_opportunities,
  l.website_improvement_opportunities,
  l.personalization,
  l.interesting_facts,
  l.outreach_angle,
  l.social_links
from public.leads l
left join public.lead_pipeline p on p.lead_id = l.id
where l.status <> 'archived'
  and p.first_email_sent is null
  and public.language_for_country(l.country) <> 'en'
  and not exists (
    select 1 from public.email_versions v
     where v.lead_id  = l.id
       and v.type     = 'initial'
       and v.active
       and v.language = public.language_for_country(l.country)
  );

comment on view public.leads_needing_native_initial is
  'Machine-facing queue for n8n: not-yet-contacted leads in a non-English country with no active initial in that language. Self-empties as native versions land. Protected by GRANTS (service_role only), same reasoning as lead_send_queue.';

revoke all on public.leads_needing_native_initial from anon, authenticated;
grant select on public.leads_needing_native_initial to service_role;

-- ---------------------------------------------------------------------------
-- 5. lead_send_queue learns two columns, appended so CREATE OR REPLACE VIEW
-- accepts it: what language the lead SHOULD get, and what language its active
-- initial actually IS. findDueWork() compares them; the hold lives in code so
-- it can be switched off from Settings without a migration.
-- ---------------------------------------------------------------------------
create or replace view public.lead_send_queue
with (security_invoker = false) as
select
  p.lead_id,
  l.status                          as lead_status,
  p.current_stage,
  p.approved,
  p.approved_at,
  p.email_found,
  p.email_verified,
  p.email_verification_status,
  p.email_verifier_status,
  p.first_email_sent,
  p.followup1_due,
  p.followup1_sent,
  p.followup2_due,
  p.followup2_sent,
  p.replied,
  p.closed,
  p.auto_followups,
  public.compute_send_priority(p)   as send_priority,
  public.language_for_country(l.country) as target_language,
  coalesce(
    (select v.language from public.email_versions v
      where v.lead_id = p.lead_id and v.type = 'initial' and v.active
      limit 1),
    'en'
  ) as initial_language
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where l.status <> 'archived';

-- ---------------------------------------------------------------------------
-- 6. The hold is a setting. updateSettings() does UPDATE ... WHERE key, not an
-- upsert, so the row must exist or a later toggle writes nothing (0037, 0045).
-- ---------------------------------------------------------------------------
insert into public.settings (key, value)
values ('outreach.require_native_language', 'true'::jsonb)
on conflict (key) do nothing;
