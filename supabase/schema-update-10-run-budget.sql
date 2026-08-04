-- ===========================================================================
-- Schema update 10 - how long one scheduled send run may take.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-9 first. One INSERT with ON CONFLICT DO NOTHING.
--
-- Pairs with a real fix in the sender: the minimum gap between emails used to
-- be silently capped at 10 seconds, so a 90-second setting waited 10. It now
-- honours the configured value and measures it against the last email that
-- actually left, so the gap holds across separate runs and manual triggers too.
--
-- Because that wait happens inside the cron request, the run needs a time
-- budget below the platform function timeout. 50s suits Vercel Hobby (killed at
-- 60s); raise towards 280 on Pro.
-- ===========================================================================
-- ---------------------------------------------------------------------------
-- 0020 — How long one scheduled run may take.
--
-- The sender waits out `sending.min_gap_seconds` between emails, and that wait
-- happens inside the HTTP request the cron service made. The ceiling is
-- therefore the hosting platform's function timeout, not ours: Vercel Hobby
-- kills a function at 60s, Pro allows up to 300.
--
-- 50s is the safe default. With a 90s gap that means exactly one email per run,
-- which is fine — the CRON FREQUENCY is what paces bulk sending, not the length
-- of any single run. Raise this towards 280 on Pro to fit several gap waits
-- into one invocation.
--
-- Made a setting rather than a constant because getting it wrong has two very
-- different symptoms (runs killed mid-send, or a queue that drains far too
-- slowly) and the right value depends entirely on the plan you are on.
-- ---------------------------------------------------------------------------
insert into public.settings (key, value, description, is_sensitive) values
  ('outreach.max_runtime_seconds', '50'::jsonb,
   'Wall-clock ceiling for one scheduled send run, including time spent waiting out the minimum gap. Keep below your platform function timeout (Vercel Hobby 60s, Pro 300s).',
   false)
on conflict (key) do nothing;
