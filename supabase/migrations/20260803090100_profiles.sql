-- ---------------------------------------------------------------------------
-- 0002 profiles + the role helpers every RLS policy is built on.
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  role       public.app_role not null default 'viewer',
  full_name  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'One row per auth user. `role` is the single source of truth for authorization.';

create index if not exists profiles_role_idx on public.profiles (role);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Role helpers.
--
-- SECURITY DEFINER so they can read public.profiles from inside a policy that
-- is itself defined *on* public.profiles without recursing. search_path is
-- pinned so a caller cannot shadow `profiles` with their own relation.
-- ---------------------------------------------------------------------------

create or replace function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid();
$$;

comment on function public.current_app_role() is
  'Role of the calling user, or NULL when unauthenticated / profile missing.';

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select p.role = 'admin' from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

comment on function public.is_admin() is
  'True only for signed-in users whose profile role is admin. Fails closed.';

-- Any signed-in user with a profile. Dashboard views are gated on this.
create or replace function public.is_app_user()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid());
$$;

revoke all on function public.current_app_role() from public;
revoke all on function public.is_admin() from public;
revoke all on function public.is_app_user() from public;
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_app_user() to authenticated;

-- ---------------------------------------------------------------------------
-- Auto-provision a profile whenever an auth user is created.
--
-- The role is read from app_metadata (which only the service role can set), so
-- a user signing themselves up can never mint an admin profile: the COALESCE
-- falls through to 'viewer'.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_role text := new.raw_app_meta_data ->> 'role';
begin
  insert into public.profiles (id, role, full_name)
  values (
    new.id,
    case when requested_role = 'admin' then 'admin'::public.app_role
         else 'viewer'::public.app_role
    end,
    nullif(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Privilege-escalation guard.
--
-- The profiles UPDATE policy lets a user edit their own row (display name), so
-- the role column needs its own gate: only an admin may change it. WITH CHECK
-- cannot see the OLD row, hence a trigger.
-- ---------------------------------------------------------------------------
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Trusted callers: an admin acting through the API, or a trusted server-side
  -- session (migrations, the seed script running on the service role) where
  -- there is no end-user JWT to check in the first place.
  is_privileged boolean := public.is_admin()
    or auth.uid() is null
    or current_user in ('postgres', 'supabase_admin', 'service_role');
begin
  if new.role is distinct from old.role and not is_privileged then
    raise exception 'Only an admin may change a profile role'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_prevent_role_escalation on public.profiles;
create trigger profiles_prevent_role_escalation
  before update on public.profiles
  for each row execute function public.prevent_role_escalation();
