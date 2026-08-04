-- ---------------------------------------------------------------------------
-- 0012 — Admin review workflow: email versioning, outreach lifecycle, activity.
--
-- Three new tables and the machinery that keeps them honest:
--
--   email_versions   every draft ever produced, never overwritten. Exactly one
--                    row per (lead, type) may be `active`; that is the one the
--                    UI shows and the sender uses.
--   lead_pipeline    one row per lead describing where it sits in the outreach
--                    lifecycle. Stage and Next Step are DERIVED, never typed in.
--   lead_activity    append-only audit of what an admin did to a lead.
--
-- Design rule that everything below follows: the pipeline is a *projection* of
-- facts (an email exists, a draft was approved, a send happened, a reply
-- arrived), not a status field somebody remembers to update. Triggers derive it
-- so the CRM UI, the cron sender and any future integration all agree without
-- re-implementing the rules.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Which of the three emails in the sequence a draft belongs to.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'email_type') then
    create type public.email_type as enum ('initial', 'followup1', 'followup2');
  end if;
end
$$;

-- Review state of a single version. Rejecting keeps the row: the point of
-- versioning is that nothing is ever destroyed.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'email_version_status') then
    create type public.email_version_status as enum ('draft', 'approved', 'rejected');
  end if;
end
$$;

-- Where the lead currently sits. Ordered from earliest to latest so a plain
-- enum comparison sorts a board correctly.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'pipeline_stage') then
    create type public.pipeline_stage as enum (
      'need_email',         -- no address at all
      'need_verification',  -- address present, deliverability unproven
      'research',           -- verified, nothing researched yet
      'draft',              -- research done, no draft
      'review',             -- draft exists, awaiting a human
      'approved',           -- signed off, not yet sent
      'initial_sent',
      'followup1_sent',
      'followup2_sent',
      'replied',
      'closed'
    );
  end if;
end
$$;

-- The single action the operator (or the automation) should take next.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'pipeline_next_step') then
    create type public.pipeline_next_step as enum (
      'need_email',
      'need_verification',
      'research_lead',
      'generate_draft',
      'approve_draft',
      'send_initial_email',
      'await_followup1',    -- sent, follow-up 1 scheduled but not due
      'send_followup1',
      'await_followup2',
      'send_followup2',
      'close_workflow',     -- replied, or the sequence is exhausted
      'complete'
    );
  end if;
end
$$;

-- What the activity feed records. Kept as an enum so the feed cannot fill up
-- with free-text verbs that no query can filter on.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'activity_kind') then
    create type public.activity_kind as enum (
      'research_edited',
      'personalization_edited',
      'draft_edited',
      'draft_regenerated',
      'draft_approved',
      'draft_rejected',
      'version_activated',
      'stage_completed',
      'notes_edited',
      'status_changed',
      'email_sent',
      'reply_received',
      'sheet_synced'
    );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Small helpers for reading configuration out of public.settings inside a
-- trigger. `value` is jsonb; `#>> '{}'` extracts a scalar as text without the
-- surrounding quotes that ::text would leave on a json string.
-- ---------------------------------------------------------------------------
create or replace function public.setting_int(p_key text, p_default integer)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select nullif(s.value #>> '{}', '')::integer from public.settings s where s.key = p_key),
    p_default
  );
$$;

create or replace function public.setting_bool(p_key text, p_default boolean)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select nullif(s.value #>> '{}', '')::boolean from public.settings s where s.key = p_key),
    p_default
  );
$$;

comment on function public.setting_int(text, integer) is
  'Read an integer from public.settings. SECURITY DEFINER so triggers can read it past RLS.';

-- ---------------------------------------------------------------------------
-- email_versions
--
-- Regenerating a draft INSERTS; it never updates. Old versions stay readable
-- and any one of them can be re-activated.
-- ---------------------------------------------------------------------------
create table if not exists public.email_versions (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid not null references public.leads (id) on delete cascade,
  type           public.email_type not null,

  -- Assigned by the set_email_version_number trigger when left null, so callers
  -- never race each other computing max()+1 in application code.
  version_number integer not null,

  subject        text,
  content        text not null,

  status         public.email_version_status not null default 'draft',
  -- The version shown by default and used by the sender. At most one per
  -- (lead, type) — enforced by a partial unique index below.
  active         boolean not null default false,

  -- Provenance: 'manual', 'import', 'template', 'ollama:<model>', ...
  generated_by   text not null default 'manual',

  created_by     uuid references auth.users (id) on delete set null,
  reviewed_by    uuid references auth.users (id) on delete set null,
  reviewed_at    timestamptz,
  review_note    text,
  created_at     timestamptz not null default now(),

  constraint email_versions_content_not_blank check (length(btrim(content)) > 0),
  constraint email_versions_version_positive  check (version_number > 0),
  constraint email_versions_lead_type_version unique (lead_id, type, version_number)
);

comment on table public.email_versions is
  'Immutable draft history. Regenerate inserts a new row; nothing is overwritten. Admin-only.';
comment on column public.email_versions.active is
  'The version shown by default and sent. Partial unique index guarantees at most one per (lead, type).';

create unique index if not exists email_versions_single_active_idx
  on public.email_versions (lead_id, type)
  where active;

create index if not exists email_versions_lead_idx    on public.email_versions (lead_id, type, version_number desc);
create index if not exists email_versions_created_idx on public.email_versions (created_at desc);
create index if not exists email_versions_status_idx  on public.email_versions (status);

-- Fill in the next version number for this (lead, type) when the caller did not
-- supply one. The unique constraint remains the real guard against a race.
create or replace function public.set_email_version_number()
returns trigger
language plpgsql
as $$
begin
  if new.version_number is null then
    select coalesce(max(v.version_number), 0) + 1
      into new.version_number
      from public.email_versions v
     where v.lead_id = new.lead_id
       and v.type = new.type;
  end if;
  return new;
end;
$$;

drop trigger if exists email_versions_set_version_number on public.email_versions;
create trigger email_versions_set_version_number
  before insert on public.email_versions
  for each row execute function public.set_email_version_number();

-- Activating a version deactivates its siblings.
--
-- BEFORE, not AFTER: email_versions_single_active_idx is a plain unique index,
-- which Postgres checks the instant the row hits the heap. An AFTER trigger
-- would never run — the insert would already have failed with 23505. Clearing
-- the sibling first is what makes "activate this version" a single statement
-- for the caller.
--
-- The sibling UPDATE re-enters this trigger with new.active = false, which the
-- WHEN clause excludes, so there is no recursion.
create or replace function public.enforce_single_active_version()
returns trigger
language plpgsql
as $$
begin
  update public.email_versions
     set active = false
   where lead_id = new.lead_id
     and type = new.type
     and id is distinct from new.id
     and active;
  return new;
end;
$$;

drop trigger if exists email_versions_single_active on public.email_versions;
create trigger email_versions_single_active
  before insert or update of active on public.email_versions
  for each row when (new.active) execute function public.enforce_single_active_version();

-- ---------------------------------------------------------------------------
-- Mirror the active INITIAL version onto leads.subject_line / draft_email.
--
-- Why keep the copy: the sender, the Google Sheet write-back and the
-- dashboard_* views all read those two columns and predate versioning. Mirroring
-- means none of them had to change, and the sheet keeps showing the live draft.
-- email_versions stays the system of record; leads holds a derived copy.
-- ---------------------------------------------------------------------------
create or replace function public.mirror_active_initial_draft()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.active and new.type = 'initial' then
    update public.leads
       set subject_line = new.subject,
           draft_email  = new.content,
           drafted_at   = coalesce(drafted_at, new.created_at)
     where id = new.lead_id;
  end if;
  return null;
end;
$$;

drop trigger if exists email_versions_mirror_initial on public.email_versions;
create trigger email_versions_mirror_initial
  after insert or update of active, subject, content on public.email_versions
  for each row when (new.active and new.type = 'initial')
  execute function public.mirror_active_initial_draft();

-- ---------------------------------------------------------------------------
-- lead_pipeline
--
-- current_stage is never written by the application: a BEFORE trigger derives
-- it from the flags and timestamps on the same row.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_pipeline (
  lead_id uuid primary key references public.leads (id) on delete cascade,

  current_stage public.pipeline_stage not null default 'need_email',

  -- Gate flags. Each carries the moment it became true, so "average approval
  -- time" and friends are answerable without a separate event table.
  email_found           boolean not null default false,
  email_found_at        timestamptz,
  email_verified        boolean not null default false,
  email_verified_at     timestamptz,
  research_complete     boolean not null default false,
  research_completed_at timestamptz,
  draft_ready           boolean not null default false,
  draft_ready_at        timestamptz,
  approved              boolean not null default false,
  approved_at           timestamptz,

  -- Sequence timestamps. `_due` is computed on send; `_sent` is set by the
  -- email_logs trigger, so a send recorded by any path updates the pipeline.
  first_email_sent timestamptz,
  followup1_due    timestamptz,
  followup1_sent   timestamptz,
  followup2_due    timestamptz,
  followup2_sent   timestamptz,

  replied       timestamptz,
  closed        timestamptz,
  closed_reason text,

  -- Per-lead opt out of the automatic follow-up sender, without touching the
  -- global switch.
  auto_followups boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.lead_pipeline is
  'Outreach lifecycle projection, one row per lead. current_stage is derived by trigger; next step by public.compute_next_step().';

create index if not exists lead_pipeline_stage_idx      on public.lead_pipeline (current_stage);
create index if not exists lead_pipeline_followup1_idx  on public.lead_pipeline (followup1_due)
  where followup1_due is not null and followup1_sent is null and replied is null and closed is null;
create index if not exists lead_pipeline_followup2_idx  on public.lead_pipeline (followup2_due)
  where followup2_due is not null and followup2_sent is null and replied is null and closed is null;
create index if not exists lead_pipeline_approved_idx   on public.lead_pipeline (approved_at)
  where approved and first_email_sent is null;

drop trigger if exists lead_pipeline_set_updated_at on public.lead_pipeline;
create trigger lead_pipeline_set_updated_at
  before update on public.lead_pipeline
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Stage and Next Step — the two derivations the whole product hangs on.
--
-- Both take the row, not a lead id, so they can be applied inside a trigger on
-- NEW before it is written, and inside a view over many rows, with no extra
-- lookup. Latest fact wins: the CASE arms are ordered newest-first.
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
    when p.email_found                 then 'need_verification'
    else 'need_email'
  end)::public.pipeline_stage;
$$;

comment on function public.compute_pipeline_stage(public.lead_pipeline) is
  'Derives current_stage from the row. The ONE definition — do not re-implement in application code.';

-- STABLE, not IMMUTABLE: the follow-up arms compare a due date against now().
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
    when p.email_found       then 'need_verification'
    else 'need_email'
  end)::public.pipeline_next_step;
$$;

comment on function public.compute_next_step(public.lead_pipeline) is
  'Derives the next action. STABLE because the follow-up arms compare against now().';

-- Keep current_stage in step with the row on every write.
create or replace function public.set_pipeline_stage()
returns trigger
language plpgsql
as $$
begin
  new.current_stage := public.compute_pipeline_stage(new);

  -- Stamp the "became true at" columns exactly once, so timing analytics stay
  -- meaningful if a flag is toggled off and on again.
  if new.email_found       and new.email_found_at        is null then new.email_found_at        := now(); end if;
  if new.email_verified    and new.email_verified_at     is null then new.email_verified_at     := now(); end if;
  if new.research_complete and new.research_completed_at is null then new.research_completed_at := now(); end if;
  if new.draft_ready       and new.draft_ready_at        is null then new.draft_ready_at        := now(); end if;
  if new.approved          and new.approved_at           is null then new.approved_at           := now(); end if;

  return new;
end;
$$;

drop trigger if exists lead_pipeline_derive_stage on public.lead_pipeline;
create trigger lead_pipeline_derive_stage
  before insert or update on public.lead_pipeline
  for each row execute function public.set_pipeline_stage();

-- ---------------------------------------------------------------------------
-- Keeping the pipeline in step with the lead itself.
--
-- Direction of travel: evidence only ever turns a flag ON. A blank research
-- field does not un-complete research, because an admin may have marked the
-- stage complete deliberately — only an explicit UPDATE from the review UI
-- clears a flag. Getting this backwards would make the "Mark complete" button
-- silently undo itself on the next save.
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
begin
  insert into public.lead_pipeline as p (
    lead_id, email_found, research_complete, draft_ready, approved
  )
  values (new.id, has_email, has_research, has_draft, is_approved)
  on conflict (lead_id) do update
    set email_found       = p.email_found       or excluded.email_found,
        research_complete = p.research_complete or excluded.research_complete,
        draft_ready       = p.draft_ready       or excluded.draft_ready,
        approved          = p.approved          or excluded.approved;

  return null;
end;
$$;

drop trigger if exists leads_sync_pipeline on public.leads;
create trigger leads_sync_pipeline
  after insert or update of email, research_summary, draft_email, status on public.leads
  for each row execute function public.sync_pipeline_from_lead();

-- ---------------------------------------------------------------------------
-- A draft existing is what makes a lead "draft ready"; an approved active
-- version is what makes it "approved". Both are recorded on the version, so the
-- projection is driven from there rather than from a status field.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_version()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.lead_pipeline as p (lead_id, draft_ready, approved)
  values (
    new.lead_id,
    new.type = 'initial',
    new.type = 'initial' and new.active and new.status = 'approved'
  )
  on conflict (lead_id) do update
    set draft_ready = p.draft_ready or excluded.draft_ready,
        approved    = p.approved    or excluded.approved;

  return null;
end;
$$;

drop trigger if exists email_versions_sync_pipeline on public.email_versions;
create trigger email_versions_sync_pipeline
  after insert or update of status, active on public.email_versions
  for each row execute function public.sync_pipeline_from_version();

-- ---------------------------------------------------------------------------
-- A recorded send advances the sequence and schedules what comes after it.
--
--   initial   -> first_email_sent, followup1_due = sent + outreach.followup1_delay_days (7)
--   followup1 -> followup1_sent,   followup2_due = sent + outreach.followup2_delay_days (3)
--   followup2 -> followup2_sent    (sequence exhausted; next step is close)
--
-- Driven by email_logs so that ANY path which records a send — the Send button,
-- the cron sender, a future webhook reconciliation — advances the pipeline
-- identically. The email service never has to remember to do it.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_email_log()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sent_at timestamptz := coalesce(new.sent_at, now());
  d1 integer := public.setting_int('outreach.followup1_delay_days', 7);
  d2 integer := public.setting_int('outreach.followup2_delay_days', 3);
begin
  if new.status not in ('sent', 'delivered', 'opened', 'clicked') then
    return null;
  end if;

  insert into public.lead_pipeline (lead_id) values (new.lead_id)
  on conflict (lead_id) do nothing;

  if new.email_type = 'initial' then
    update public.lead_pipeline
       set first_email_sent = coalesce(first_email_sent, sent_at),
           followup1_due    = coalesce(followup1_due, sent_at + make_interval(days => d1))
     where lead_id = new.lead_id;

  elsif new.email_type = 'followup1' then
    update public.lead_pipeline
       set followup1_sent = coalesce(followup1_sent, sent_at),
           followup2_due  = coalesce(followup2_due, sent_at + make_interval(days => d2))
     where lead_id = new.lead_id;

  elsif new.email_type = 'followup2' then
    update public.lead_pipeline
       set followup2_sent = coalesce(followup2_sent, sent_at)
     where lead_id = new.lead_id;
  end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- A reply stops the sequence. `replied` alone moves Next Step to
-- "close_workflow"; closing stays an explicit act so a reply that turns out to
-- be an auto-responder can be undone without losing the record.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_reply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.lead_pipeline as p (lead_id, replied)
  values (new.lead_id, new.received_at)
  on conflict (lead_id) do update
    -- Keep the FIRST reply's timestamp; a later message does not reset it.
    set replied = coalesce(p.replied, excluded.replied);
  return null;
end;
$$;

drop trigger if exists replies_sync_pipeline on public.replies;
create trigger replies_sync_pipeline
  after insert on public.replies
  for each row execute function public.sync_pipeline_from_reply();

-- ---------------------------------------------------------------------------
-- lead_activity — the feed behind "Recent Activity" and the per-lead audit.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_activity (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.leads (id) on delete cascade,
  kind       public.activity_kind not null,
  summary    text not null,
  detail     text,
  actor_id   uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint lead_activity_summary_not_blank check (length(btrim(summary)) > 0)
);

comment on table public.lead_activity is
  'Append-only record of admin actions on a lead. Admin-only: summaries can quote draft content.';

create index if not exists lead_activity_lead_idx    on public.lead_activity (lead_id, created_at desc);
create index if not exists lead_activity_created_idx on public.lead_activity (created_at desc);
create index if not exists lead_activity_kind_idx    on public.lead_activity (kind, created_at desc);

-- ---------------------------------------------------------------------------
-- email_logs gains the sequence position.
--
-- Without it a send cannot tell the pipeline which step it satisfied, and
-- follow-up conversion analytics have nothing to group by. Existing rows are
-- initial sends by definition — nothing else existed when they were written.
-- ---------------------------------------------------------------------------
alter table public.email_logs
  add column if not exists email_type       public.email_type not null default 'initial',
  add column if not exists email_version_id uuid references public.email_versions (id) on delete set null;

create index if not exists email_logs_email_type_idx on public.email_logs (email_type, sent_at desc);

comment on column public.email_logs.email_type is
  'Which step of the sequence this attempt was. Drives lead_pipeline and follow-up analytics.';

-- Attached after the column exists, since the function reads new.email_type.
drop trigger if exists email_logs_sync_pipeline on public.email_logs;
create trigger email_logs_sync_pipeline
  after insert or update of status, sent_at on public.email_logs
  for each row execute function public.sync_pipeline_from_email_log();

-- ---------------------------------------------------------------------------
-- Admin-facing board view: the pipeline row plus its derived Next Step and the
-- lead identity needed to render a row. Admin-only (is_admin() inside the view);
-- the anonymous public dashboard uses the separate aggregate views in 0013.
--
-- Columns are listed explicitly, never `p.*`: a view built with * captures the
-- column list at creation time and silently goes stale after an ALTER TABLE.
-- ---------------------------------------------------------------------------
create or replace view public.pipeline_board
with (security_invoker = false) as
select
  p.lead_id,
  l.business_name,
  l.email,
  l.city,
  l.country,
  l.niche,
  l.status                       as lead_status,
  l.campaign_id,
  p.current_stage,
  public.compute_next_step(p)    as next_step,
  p.email_found,
  p.email_verified,
  p.research_complete,
  p.draft_ready,
  p.approved,
  p.approved_at,
  p.draft_ready_at,
  p.first_email_sent,
  p.followup1_due,
  p.followup1_sent,
  p.followup2_due,
  p.followup2_sent,
  p.replied,
  p.closed,
  p.closed_reason,
  p.auto_followups,
  p.updated_at
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where public.is_admin();

comment on view public.pipeline_board is
  'Admin-only pipeline rows with the derived next_step. Contains contact data — never grant to anon.';

-- ---------------------------------------------------------------------------
-- Row Level Security for the new tables. Same shape as migration 0008:
-- admin-only on all four verbs, anon revoked.
-- ---------------------------------------------------------------------------
alter table public.email_versions enable row level security;
alter table public.lead_pipeline  enable row level security;
alter table public.lead_activity  enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['email_versions', 'lead_pipeline', 'lead_activity']
  loop
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);

    execute format('drop policy if exists %I on public.%I', t || '_select_admin', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_admin', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_admin', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_admin', t);

    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_admin())',
      t || '_select_admin', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.is_admin())',
      t || '_insert_admin', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())',
      t || '_update_admin', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.is_admin())',
      t || '_delete_admin', t);
  end loop;
end
$$;

revoke all on public.pipeline_board from anon;
grant select on public.pipeline_board to authenticated;

-- setting_int / setting_bool are SECURITY DEFINER and therefore read
-- public.settings past RLS. Functions are executable by PUBLIC by default,
-- which would hand an anonymous token a way to probe configuration values one
-- key at a time. The triggers that need them are themselves SECURITY DEFINER
-- and run as the owner, so revoking costs nothing.
revoke all on function public.setting_int(text, integer) from public;
revoke all on function public.setting_bool(text, boolean) from public;
grant execute on function public.setting_int(text, integer) to authenticated;
grant execute on function public.setting_bool(text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Configuration for generation and the automatic sender.
--
-- auto_send_initial defaults to FALSE deliberately: follow-ups go to people who
-- already agreed to be contacted once, but a first touch firing without a human
-- ever looking at it is how a cold-outreach system becomes a spam cannon.
-- ---------------------------------------------------------------------------
insert into public.settings (key, value, description, is_sensitive) values
  ('outreach.auto_followups', 'true'::jsonb,
   'Let the scheduled sender deliver follow-ups that are due.', false),
  ('outreach.auto_send_initial', 'false'::jsonb,
   'Let the scheduled sender deliver APPROVED initial emails without a further click.', false),
  ('outreach.followup1_delay_days', '7'::jsonb,
   'Days after the initial send before follow-up 1 is due.', false),
  ('outreach.followup2_delay_days', '3'::jsonb,
   'Days after follow-up 1 before follow-up 2 is due.', false),
  ('outreach.require_verified_email', 'true'::jsonb,
   'The scheduled sender only touches leads whose address is marked verified.', false),
  ('outreach.followup_requires_approval', 'false'::jsonb,
   'Hold follow-ups for human approval instead of sending them when due. Follow-ups go to people already contacted once, so this is off by default.', false),
  ('outreach.max_sends_per_run', '25'::jsonb,
   'Ceiling on emails sent by a single scheduled run.', false),

  ('ai.provider', '"template"'::jsonb,
   'Draft generator: template (deterministic, no model) or ollama (local model).', false),
  ('ai.ollama_url', '"http://localhost:11434"'::jsonb,
   'Base URL of the Ollama server used when ai.provider = ollama.', false),
  ('ai.ollama_model', '"llama3.1:8b"'::jsonb,
   'Model tag pulled in Ollama, e.g. llama3.1:8b, qwen2.5:14b.', false),
  ('ai.timeout_seconds', '120'::jsonb,
   'How long to wait for a generation before giving up.', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Backfill.
--
-- Order matters: versions first, so that the pipeline rows created afterwards
-- already see a draft and land on the right stage.
-- ---------------------------------------------------------------------------

-- Every lead that already carries a draft gets version 1, marked as coming from
-- the import rather than pretending a model wrote it.
insert into public.email_versions (lead_id, type, version_number, subject, content, status, active, generated_by, created_at)
select
  l.id,
  'initial'::public.email_type,
  1,
  l.subject_line,
  l.draft_email,
  case when l.status in ('approved', 'sending', 'sent', 'replied')
       then 'approved'::public.email_version_status
       else 'draft'::public.email_version_status
  end,
  true,
  'import',
  coalesce(l.drafted_at, l.created_at)
from public.leads l
where l.draft_email is not null
  and length(btrim(l.draft_email)) > 0
  and not exists (
    select 1 from public.email_versions v where v.lead_id = l.id and v.type = 'initial'
  );

-- One pipeline row per lead. The flags come from the data that already exists;
-- email_verified stays false everywhere because nothing has verified anything
-- yet, and claiming otherwise would send mail to unproven addresses.
insert into public.lead_pipeline (
  lead_id, email_found, research_complete, draft_ready, approved,
  first_email_sent, replied
)
select
  l.id,
  l.email is not null and length(btrim(l.email)) > 0,
  l.research_summary is not null and length(btrim(l.research_summary)) > 0,
  l.draft_email is not null and length(btrim(l.draft_email)) > 0,
  l.status in ('approved', 'sending', 'sent', 'replied'),
  case when l.status in ('sent', 'replied') then l.last_contacted_at else null end,
  case when l.status = 'replied' then coalesce(l.last_contacted_at, l.updated_at) else null end
from public.leads l
on conflict (lead_id) do nothing;
