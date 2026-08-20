-- ===========================================================================
-- Schema update 31 - publish the UI's tables to Supabase Realtime.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-30 first. Re-runnable throughout.
--
-- Adds the eight tables the admin UI reads to the `supabase_realtime`
-- publication, so an open page can be told a row changed and re-run its own
-- server-side query instead of waiting for somebody to press refresh.
-- Security is inherited from the existing is_admin() RLS - no new policy.
-- Replica identity is deliberately left at the default; see the migration.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0041 ,publish the tables the UI reads, so a change reaches an open page
-- without somebody pressing refresh.
--
-- Asked for as: "data is updated automatically instead of a refresh".
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
--
-- Supabase Realtime streams `postgres_changes` from a Postgres logical
-- replication publication named `supabase_realtime`. A table not IN that
-- publication emits nothing, which is why this is a migration and not a
-- settings toggle in the app.
--
-- The application side uses these events as a SIGNAL ONLY ,"something you
-- are looking at changed" ,and then calls Next's router.refresh(), which
-- re-runs the server components and therefore the real data functions in
-- src/lib/data/. It does NOT patch changed rows into client state.
--
-- That is the whole design, and it is deliberate. Those data functions carry
-- rules that exist in exactly one place on purpose: archived leads are
-- excluded (0034), `send_priority < 9` gates Ready to Send, an initial send
-- needs its ACTIVE version to be approved (0039), the send queue has a
-- three-part ordering that mirrors findDueWork(). Rebuilding any of that in
-- a browser to patch a row would be a second implementation of a rule this
-- project has already been burned by duplicating ,the same argument the
-- comment on compute_pipeline_stage() makes ("the ONE definition ,do not
-- re-implement in application code"). A refresh costs one re-query and keeps
-- one definition.
--
-- ---------------------------------------------------------------------------
-- SECURITY: INHERITED, NOT REBUILT
--
-- Realtime applies RLS per subscriber for INSERT and UPDATE, and every table
-- below already carries `for select to authenticated using (public.is_admin())`
-- from 0008/0012. So an admin's browser receives events, a viewer's receives
-- nothing, and anon (revoked entirely) cannot subscribe at all. No new policy,
-- no new grant, no second security model to keep in step with the first.
--
-- One honest caveat: for DELETE, Postgres emits only the primary key of the
-- old row, so Realtime cannot evaluate an RLS policy against it and delivers
-- deletes to every subscriber of the table. That is acceptable here precisely
-- BECAUSE the client treats events as a signal ,it reads no column off the
-- payload, so the most anyone learns is "a row with this id went away", and
-- the pages that subscribe are admin-only at the middleware AND at
-- requireAdmin() anyway.
--
-- ---------------------------------------------------------------------------
-- REPLICA IDENTITY IS LEFT ALONE ON PURPOSE
--
-- `replica identity full` would put the entire old row in the WAL for every
-- update and delete. It is what you need when a client diffs old-vs-new to
-- patch its own state ,which is exactly what this design does not do. The
-- default (primary key) is enough to say "this changed", so the WAL stays
-- small and a bulk update of 500 leads does not multiply into 500 full-row
-- WAL records for the sake of a signal we would throw away.
--
-- ---------------------------------------------------------------------------
-- Re-runnable, like every migration here. Postgres has no
-- `alter publication ... add table if not exists`, so the guard is explicit.
-- ---------------------------------------------------------------------------

-- Supabase creates this publication on every project, but a local `db reset`
-- or a self-hosted instance may not have it yet.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    -- The lead itself: name, address, status. Drives the leads list and the
    -- lead page.
    'leads',
    -- Every derived stage, verification verdict, due date and sent flag. This
    -- is the table that moves when almost anything happens, so it is the one
    -- that makes the dashboard tiles live.
    'lead_pipeline',
    -- Sends and, since 0040, refusals ,Email Logs and Send Failures.
    'email_logs',
    -- Draft history and approvals. Drives the approval queue and the draft
    -- workspace.
    'email_versions',
    -- Inbound: a prospect answering is the single most time-sensitive event
    -- this app has, and the one most worth not having to press refresh for.
    'replies',
    'inbound_messages',
    -- The dashboard activity feed.
    'lead_activity',
    -- So a cron or a "Run now" finishing updates the Settings run status
    -- while the page is open.
    'integration_runs'
  ]
  loop
    if not exists (
      select 1
        from pg_publication_tables
       where pubname    = 'supabase_realtime'
         and schemaname = 'public'
         and tablename  = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
