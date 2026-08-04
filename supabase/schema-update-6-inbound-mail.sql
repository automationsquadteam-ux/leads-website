-- ===========================================================================
-- Schema update 6 - inbound mail staging and the auto-reply trigger fix.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
--
-- Apply updates 1-5 first. Paste this into the Supabase SQL editor and Run.
-- Re-runnable: create-if-not-exists, create-or-replace, and the corrective
-- UPDATE is idempotent.
--
-- Contains a fix for a latent bug worth understanding before you run it:
-- sync_pipeline_from_reply() previously set lead_pipeline.replied for ANY row
-- in public.replies. Out-of-office notices are the most common thing cold
-- outreach gets back, so once inbound mail started arriving, every one of them
-- would have marked a lead as having answered and permanently stopped its
-- follow-up sequence. The trigger now ignores auto_reply, and the UPDATE at the
-- end clears the flag for any lead whose only replies were automatic.
-- ===========================================================================
-- ---------------------------------------------------------------------------
-- 0016 — Inbound mail: staging, matching, and the auto-reply trigger fix.
--
-- Two things here.
--
-- FIRST, a latent bug that would have bitten the moment inbound mail started
-- arriving. sync_pipeline_from_reply() sets lead_pipeline.replied on ANY row
-- inserted into public.replies. Out-of-office notices are the single most
-- common thing that comes back from cold outreach, so ingesting them as replies
-- would mark those leads as having answered and permanently stop their
-- follow-up sequence. The trigger now ignores 'auto_reply'.
--
-- SECOND, public.inbound_messages: everything that arrives, whether or not we
-- can attribute it.
--
-- Why a staging table instead of relaxing replies.lead_id to nullable:
--
--   * public.replies drives lead_pipeline.replied, reply rate, average response
--     time and follow-up conversion. It has to mean "a real person at a known
--     lead answered us". Bounces and autoresponders in there would corrupt
--     every one of those figures.
--   * An unattributable message still needs to be seen, kept and assignable by
--     hand. That is a different lifecycle from a reply and deserves its own row.
--
-- So: inbound_messages is the log of what arrived; public.replies stays the
-- record of genuine replies, created when a message is matched.
-- ---------------------------------------------------------------------------

-- What kind of thing arrived. Decided by the classifier, not by the sender.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'inbound_kind') then
    create type public.inbound_kind as enum (
      'reply',       -- a human answering
      'auto_reply',  -- out of office, ticket autoresponder
      'bounce',      -- delivery status notification
      'other'        -- unrelated mail that reached the address
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'inbound_match_status') then
    create type public.inbound_match_status as enum (
      'matched',    -- attributed to a lead
      'unmatched',  -- arrived, nobody knows whose it is
      'ignored'     -- deliberately set aside
    );
  end if;
end
$$;

-- How the attribution was made. Worth recording: if From-address matching turns
-- out to be producing wrong answers, this is the column that proves it.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'inbound_match_method') then
    create type public.inbound_match_method as enum (
      'threading',     -- In-Reply-To / References hit an email_logs.message_id
      'from_address',  -- sender's address matched leads.email
      'manual'         -- an admin picked the lead
    );
  end if;
end
$$;

create table if not exists public.inbound_messages (
  id uuid primary key default gen_random_uuid(),

  -- Envelope and headers -----------------------------------------------------
  from_address text not null,
  from_name    text,
  to_address   text,
  subject      text,
  body_text    text,

  -- Threading. message_id is the sender's own Message-ID; in_reply_to and
  -- references_header are what let us attribute this to something we sent.
  message_id        text,
  in_reply_to       text,
  references_header text,

  received_at timestamptz not null default now(),

  -- Classification and attribution -------------------------------------------
  kind         public.inbound_kind not null default 'other',
  match_status public.inbound_match_status not null default 'unmatched',
  match_method public.inbound_match_method,

  lead_id      uuid references public.leads (id) on delete set null,
  email_log_id uuid references public.email_logs (id) on delete set null,
  -- The reply row this produced, when it produced one.
  reply_id     uuid references public.replies (id) on delete set null,

  sentiment  public.reply_sentiment,
  confidence numeric(4, 3),

  matched_at      timestamptz,
  matched_by      uuid references auth.users (id) on delete set null,
  is_handled      boolean not null default false,

  created_at timestamptz not null default now(),

  constraint inbound_messages_from_not_blank check (length(btrim(from_address)) > 0),
  constraint inbound_messages_confidence_range
    check (confidence is null or confidence between 0 and 1)
);

comment on table public.inbound_messages is
  'Everything that arrives at the outreach address. public.replies holds only the genuine, attributed ones.';

-- Idempotency. The Worker will retry on any non-2xx, and a duplicate POST must
-- not create a second row or a second reply. Partial because a message with no
-- Message-ID header is malformed but should still be stored.
create unique index if not exists inbound_messages_message_id_key
  on public.inbound_messages (message_id)
  where message_id is not null;

create index if not exists inbound_messages_received_idx on public.inbound_messages (received_at desc);
create index if not exists inbound_messages_lead_idx     on public.inbound_messages (lead_id);
create index if not exists inbound_messages_unmatched_idx
  on public.inbound_messages (received_at desc)
  where match_status = 'unmatched';

alter table public.inbound_messages enable row level security;

revoke all on public.inbound_messages from anon;
grant select, insert, update, delete on public.inbound_messages to authenticated;

drop policy if exists inbound_messages_select_admin on public.inbound_messages;
drop policy if exists inbound_messages_insert_admin on public.inbound_messages;
drop policy if exists inbound_messages_update_admin on public.inbound_messages;
drop policy if exists inbound_messages_delete_admin on public.inbound_messages;

create policy inbound_messages_select_admin on public.inbound_messages
  for select to authenticated using (public.is_admin());
create policy inbound_messages_insert_admin on public.inbound_messages
  for insert to authenticated with check (public.is_admin());
create policy inbound_messages_update_admin on public.inbound_messages
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy inbound_messages_delete_admin on public.inbound_messages
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- THE TRIGGER FIX.
--
-- An out-of-office is not an answer. Marking the lead as replied would stop the
-- sequence for someone who has not read a word, and every rate that counts
-- replies would include a robot.
--
-- Under the design above an auto-reply never reaches public.replies at all, so
-- this is belt and braces — but the trigger is what enforces it, and a rule
-- enforced only by the code that happens to call it is not enforced.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_reply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.sentiment = 'auto_reply' then
    return null;
  end if;

  insert into public.lead_pipeline as p (lead_id, replied)
  values (new.lead_id, new.received_at)
  on conflict (lead_id) do update
    -- Keep the FIRST reply's timestamp; a later message does not reset it.
    set replied = coalesce(p.replied, excluded.replied);
  return null;
end;
$$;

comment on function public.sync_pipeline_from_reply() is
  'Marks the lead as replied. Ignores auto_reply: an out-of-office must not stop a follow-up sequence.';

-- ---------------------------------------------------------------------------
-- Undo the damage if any auto-replies were already recorded.
--
-- Clears lead_pipeline.replied for leads whose ONLY replies are automatic. A
-- lead with both a real reply and an autoresponder keeps its replied stamp.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set replied = null
 where p.replied is not null
   and exists (
     select 1 from public.replies r where r.lead_id = p.lead_id and r.sentiment = 'auto_reply'
   )
   and not exists (
     select 1 from public.replies r
      where r.lead_id = p.lead_id
        and (r.sentiment is distinct from 'auto_reply')
   );

-- ---------------------------------------------------------------------------
-- Admin-facing view: an inbound message plus the lead it belongs to.
--
-- Columns listed explicitly, never p.* — a view built with * captures its
-- column list at creation and silently goes stale after an ALTER TABLE.
-- ---------------------------------------------------------------------------
create or replace view public.inbound_inbox
with (security_invoker = false) as
select
  m.id,
  m.from_address,
  m.from_name,
  m.subject,
  m.body_text,
  m.received_at,
  m.kind,
  m.match_status,
  m.match_method,
  m.sentiment,
  m.is_handled,
  m.lead_id,
  m.reply_id,
  l.business_name,
  l.city,
  l.country
from public.inbound_messages m
left join public.leads l on l.id = m.lead_id
where public.is_admin();

comment on view public.inbound_inbox is
  'Admin-only. Inbound mail joined to its lead. Contains sender addresses and message bodies — never grant to anon.';

revoke all on public.inbound_inbox from anon;
grant select on public.inbound_inbox to authenticated;
