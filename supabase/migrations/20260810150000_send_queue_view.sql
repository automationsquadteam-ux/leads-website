-- ---------------------------------------------------------------------------
-- 0035 ,the scheduled sender could not see a single lead. Nothing has
-- auto-sent an initial email since 0028.
--
-- Symptom: the cron fires every 3 minutes and reports "Nothing is due,
-- considered: 0", while 20 leads sit approved, verified, unsent and visibly
-- Ready to Send on the dashboard.
--
-- Cause: 0028 moved the initial-send query in findDueWork() from the
-- `lead_pipeline` TABLE to the `pipeline_board` VIEW, because the new
-- `send_priority` is computed by the view. But `pipeline_board` ends in
--
--     where public.is_admin()
--
-- and the scheduler runs on the SERVICE-ROLE key, which has no JWT and no
-- auth.uid(). `is_admin()` is therefore false, and the view returns ZERO ROWS
-- to it ,always, for every lead. Verified against the live database:
-- `pipeline_board` returns 0 rows to the service-role client while
-- `lead_pipeline` returns all 809.
--
-- Service-role BYPASSES RLS on a table, which is why every other query in the
-- scheduler works. It does NOT satisfy an `is_admin()` predicate written into
-- a view body, because that is an ordinary WHERE clause, not a policy. The
-- distinction is easy to miss and this is the second time it has bitten:
-- lib/services/sync/index.ts carried a comment about exactly this trap
-- ("pipeline_board is gated on is_admin(), and the service-role client is not
-- an admin JWT so this is null in practice for server-side callers") while the
-- scheduler made the same mistake three files away.
--
-- Fix: a view for machine callers, gated by GRANTS instead of by a predicate.
--
--   * No `is_admin()` in the body, so the service-role client can read it.
--   * SELECT revoked from anon and authenticated, so no browser token can —
--     the same shape as `integration_secrets`, which is protected by having no
--     grants rather than by a policy.
--   * Archived leads are excluded here rather than in a follow-up query, so
--     the sender inherits the 0034 rule for free and the extra round trip
--     findDueWork() was doing for follow-ups goes away.
--
-- `pipeline_board` is deliberately left exactly as it is: it feeds the admin
-- UI, where `is_admin()` is doing real work.
-- ---------------------------------------------------------------------------

create or replace view public.lead_send_queue
with (security_invoker = false) as
select
  p.lead_id,
  l.status                          as lead_status,
  p.current_stage,
  p.approved,
  p.approved_at,
  p.email_found,
  p.email_verified,
  p.email_verification_status,
  p.email_verifier_status,
  p.first_email_sent,
  p.followup1_due,
  p.followup1_sent,
  p.followup2_due,
  p.followup2_sent,
  p.replied,
  p.closed,
  p.auto_followups,
  public.compute_send_priority(p)   as send_priority
from public.lead_pipeline p
join public.leads l on l.id = p.lead_id
where l.status <> 'archived';

comment on view public.lead_send_queue is
  'Machine-facing send queue for the scheduler. Protected by GRANTS, not by an is_admin() predicate, because the scheduler runs on the service-role key which satisfies no such predicate ,that is what made pipeline_board return zero rows to it and stopped every automatic initial send after 0028. Archived leads are already excluded. Never grant this to anon or authenticated.';

-- Grants are the whole security model for this view.
revoke all on public.lead_send_queue from anon, authenticated;
grant select on public.lead_send_queue to service_role;
