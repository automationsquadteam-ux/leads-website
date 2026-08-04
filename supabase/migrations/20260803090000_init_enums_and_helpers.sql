-- ---------------------------------------------------------------------------
-- 0001 Extensions, enums and shared helper functions.
--
-- Everything downstream depends on this file, so it must stay first.
-- ---------------------------------------------------------------------------

-- gen_random_uuid() lives in pgcrypto on older servers; on PG13+ it is core.
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Exactly two roles, as per the product spec. Anything not 'admin' is treated
-- as read-only by every policy in this schema.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type public.app_role as enum ('admin', 'viewer');
  end if;
end
$$;

-- Lifecycle of a single lead through the outreach pipeline.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'lead_status') then
    create type public.lead_status as enum (
      'new',          -- freshly imported, nothing done yet
      'researching',  -- research in progress / partially enriched
      'ready',        -- research + draft exist, awaiting human approval
      'approved',     -- a human signed off on the draft
      'sending',      -- handed to the sending worker
      'sent',         -- delivered to the provider successfully
      'replied',      -- prospect responded
      'bounced',      -- hard/soft bounce reported by the provider
      'invalid',      -- unusable record (bad email, closed business, ...)
      'archived'      -- intentionally removed from the working set
    );
  end if;
end
$$;

-- Per-attempt outcome recorded in email_logs.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'email_log_status') then
    create type public.email_log_status as enum (
      'queued',
      'sent',
      'delivered',
      'opened',
      'clicked',
      'bounced',
      'complained',
      'failed'
    );
  end if;
end
$$;

-- Classification applied to an inbound reply.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'reply_sentiment') then
    create type public.reply_sentiment as enum (
      'positive',
      'neutral',
      'negative',
      'unsubscribe',
      'auto_reply'
    );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Helper: keep updated_at honest without trusting the client.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger function: stamps updated_at with the server clock.';
