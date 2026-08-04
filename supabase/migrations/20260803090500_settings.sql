-- ---------------------------------------------------------------------------
-- 0006 — settings
--
-- Key/value rather than one wide row: the brief calls for "future configuration
-- values", and a jsonb value column lets later prompts add keys without a
-- migration. `is_sensitive` marks rows (SMTP credentials) that must never be
-- returned to the browser, even for admins.
-- ---------------------------------------------------------------------------

create table if not exists public.settings (
  key          text primary key,
  value        jsonb not null,
  description  text,
  is_sensitive boolean not null default false,
  updated_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint settings_key_format check (key ~ '^[a-z0-9]+(\.[a-z0-9_]+)*$')
);

comment on table public.settings is
  'Admin-only application configuration. Never expose is_sensitive rows to the client.';

drop trigger if exists settings_set_updated_at on public.settings;
create trigger settings_set_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Defaults. ON CONFLICT DO NOTHING so re-running never clobbers live config.
-- ---------------------------------------------------------------------------
insert into public.settings (key, value, description, is_sensitive) values
  ('sending.daily_limit',      '50'::jsonb,
   'Maximum outbound emails per day across all campaigns.', false),

  ('sending.working_hours',
   '{"timezone":"UTC","start":"09:00","end":"17:00","days":[1,2,3,4,5]}'::jsonb,
   'Window in which the sender is allowed to run. days: 1=Mon .. 7=Sun.', false),

  ('sending.min_gap_seconds',  '90'::jsonb,
   'Minimum delay between two consecutive sends, to look human.', false),

  ('sending.paused',           'false'::jsonb,
   'Global kill switch — when true no email leaves the system.', false),

  ('email.default_signature',
   '"Best regards,\nAutomation Squad\nhttps://automationsquad.example"'::jsonb,
   'Signature appended to drafts that do not define their own.', false),

  ('email.default_from_name',  '"Automation Squad"'::jsonb,
   'Display name on outbound email.', false),

  ('email.default_from_address', '""'::jsonb,
   'Envelope-from address. Must be a domain you control.', false),

  ('email.reply_to',           '""'::jsonb,
   'Reply-To header; leave empty to reuse the from address.', false),

  ('followup.default_delay_days', '4'::jsonb,
   'Days after a send before next_followup_at is proposed.', false),

  ('ai.default_model',         '"claude-sonnet-5"'::jsonb,
   'Model used for research and draft generation.', false),

  ('ai.temperature',           '0.7'::jsonb,
   'Sampling temperature for draft generation.', false),

  ('ai.max_tokens',            '2048'::jsonb,
   'Output token ceiling per draft generation call.', false),

  -- SMTP placeholders. Values stay empty here; the real credentials belong in
  -- environment variables / a secret manager, not in a database row.
  ('smtp.host',                '""'::jsonb, 'SMTP hostname (placeholder).',  true),
  ('smtp.port',                '587'::jsonb, 'SMTP port (587 STARTTLS, 465 TLS).', true),
  ('smtp.secure',              'false'::jsonb, 'True for implicit TLS on port 465.', true),
  ('smtp.username',            '""'::jsonb, 'SMTP username (placeholder).',  true),
  ('smtp.password_ref',        '""'::jsonb,
   'Name of the env var / secret holding the SMTP password. Never the password itself.', true),
  ('provider.name',            '"smtp"'::jsonb,
   'Active delivery provider: smtp | resend | sendgrid.', false)
on conflict (key) do nothing;
