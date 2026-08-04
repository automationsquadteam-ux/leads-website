-- ---------------------------------------------------------------------------
-- 0005 email_logs and replies (the append-only side of the system).
-- ---------------------------------------------------------------------------

create table if not exists public.email_logs (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.leads (id) on delete cascade,
  campaign_id uuid references public.campaigns (id) on delete set null,
  template_id uuid references public.templates (id) on delete set null,

  status   public.email_log_status not null default 'queued',
  provider text,   -- 'smtp', 'resend', 'sendgrid', ...

  -- Provider-side id, used to reconcile webhooks back to this row.
  message_id text,
  subject    text,

  sent_at    timestamptz,
  error      text,

  sent_by    uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.email_logs is
  'One row per send attempt. Append-only in practice; admins may correct rows, viewers see aggregates only.';

create index if not exists email_logs_lead_id_idx     on public.email_logs (lead_id);
create index if not exists email_logs_campaign_id_idx on public.email_logs (campaign_id);
create index if not exists email_logs_status_idx      on public.email_logs (status);
create index if not exists email_logs_sent_at_idx     on public.email_logs (sent_at desc);

-- A provider message id must map to exactly one log row so webhook handlers can
-- upsert safely. Partial: message_id is absent until the provider accepts it.
create unique index if not exists email_logs_message_id_key
  on public.email_logs (provider, message_id)
  where message_id is not null;

-- ---------------------------------------------------------------------------

create table if not exists public.replies (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references public.leads (id) on delete cascade,
  email_log_id uuid references public.email_logs (id) on delete set null,

  reply_text  text,
  sentiment   public.reply_sentiment,
  -- 0..1 confidence from whatever classifier produced `sentiment`.
  confidence  numeric(4, 3),
  is_handled  boolean not null default false,
  received_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),

  constraint replies_confidence_range
    check (confidence is null or confidence between 0 and 1)
);

comment on table public.replies is
  'Inbound responses. reply_text is prospect content admin-only; viewers get counts via public.dashboard_reply_stats.';

create index if not exists replies_lead_id_idx     on public.replies (lead_id);
create index if not exists replies_received_at_idx on public.replies (received_at desc);
create index if not exists replies_sentiment_idx   on public.replies (sentiment);
create index if not exists replies_unhandled_idx   on public.replies (received_at desc) where not is_handled;
