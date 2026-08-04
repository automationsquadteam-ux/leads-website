-- ---------------------------------------------------------------------------
-- 0015 — Email verification, draft-version repair, and opt-in public leads.
--
-- Fixes three things the live data exposed, plus one new feature.
--
-- BUG 1 — 145 leads have leads.draft_email but no email_versions row.
--   The 0012 backfill was a one-time INSERT. After the leads were purged and
--   re-synced from the sheet, drafts arrived again but nothing created versions
--   for them, so the review workspace reported "no draft yet" for leads that
--   plainly had one. Fixed by a trigger, so it can never drift again.
--
-- BUG 2 — 58 leads are status='sent' but lead_pipeline.first_email_sent is
--   NULL, because they were sent by the upstream n8n pipeline and the sheet's
--   "Date Sent" column is empty. Their stage read 'approved' and follow-up
--   conversion counted zero sends.
--
-- BUG 3 — analytics_industry_performance counted email_logs rows, which only
--   ever contain sends made BY THIS CRM. With every send done upstream it
--   reported 0 while the status counts said 58. Rebased on lead_pipeline, which
--   records that a lead was emailed regardless of who did it.
--
-- NEW — email verification state (NeverBounce and friends), and an opt-in,
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
-- — the record of what was tried has value.
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
-- BUG 1 — a draft on the lead always produces a version.
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
-- BUG 2 — a lead the sheet reports as sent has been sent.
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
-- BUG 3 — industry analytics measured the wrong thing.
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
-- Nothing depends on this view — it is a leaf read by the analytics page — so
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
  'PUBLIC (anon-readable) and OFF by default. Name, city, country, industry and stage only — never contact details, research, drafts or notes.';

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
