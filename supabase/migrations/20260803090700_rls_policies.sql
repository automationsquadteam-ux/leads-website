-- ---------------------------------------------------------------------------
-- 0008 Row Level Security.
--
-- Model:
--   admin   full CRUD on every table.
--   viewer  NO row access to any base table. Statistics reach them through the
--           public.dashboard_* views from migration 0007.
--   anon    nothing.
--
-- Every table below has RLS enabled AND at least one policy. A table with RLS
-- enabled and no matching policy denies by default, which is the behaviour we
-- rely on for viewers.
--
-- Note: the service_role key bypasses RLS entirely that is what the import
-- and seed scripts use, and why that key must never reach the browser.
-- ---------------------------------------------------------------------------

alter table public.profiles   enable row level security;
alter table public.leads      enable row level security;
alter table public.campaigns  enable row level security;
alter table public.templates  enable row level security;
alter table public.email_logs enable row level security;
alter table public.replies    enable row level security;
alter table public.settings   enable row level security;

-- Deliberately NOT using FORCE ROW LEVEL SECURITY.
--
-- The dashboard_* views in migration 0007 run with their owner's privileges and
-- depend on that owner bypassing RLS on these base tables. FORCE would subject
-- the owner to RLS too, and since every policy here requires is_admin(), it
-- would silently return zero rows to viewers blanking out every dashboard.
-- Table-level grants below plus the policies are the real gate.

-- Anonymous visitors get nothing anywhere; signed-in users get table access
-- shaped by the policies that follow. These grants are explicit rather than
-- relying on Supabase's default privileges.
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'leads', 'campaigns', 'templates', 'email_logs', 'replies', 'settings'
  ]
  loop
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- profiles
--
-- A user may always read their own profile the app needs it to resolve the
-- role after sign-in. Admins may read and administer everyone.
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select_self  on public.profiles;
drop policy if exists profiles_select_admin on public.profiles;
drop policy if exists profiles_update_self  on public.profiles;
drop policy if exists profiles_update_admin on public.profiles;
drop policy if exists profiles_insert_admin on public.profiles;
drop policy if exists profiles_delete_admin on public.profiles;

create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy profiles_select_admin on public.profiles
  for select to authenticated
  using (public.is_admin());

-- Self-service edits are allowed, but the role column is guarded by the
-- prevent_role_escalation trigger from migration 0002.
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy profiles_update_admin on public.profiles
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy profiles_insert_admin on public.profiles
  for insert to authenticated
  with check (public.is_admin());

create policy profiles_delete_admin on public.profiles
  for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- leads / campaigns / templates / email_logs / replies / settings
--
-- Same shape for all six: admin-only, all four verbs. Generated in a loop so a
-- table can never be added to the list and then forgotten in one of the verbs.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'leads', 'campaigns', 'templates', 'email_logs', 'replies', 'settings'
  ]
  loop
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

comment on table public.leads is
  'Cold-outreach prospects. RLS: admin-only. Viewers read public.dashboard_* views.';
