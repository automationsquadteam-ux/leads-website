-- ===========================================================================
-- Schema update 12 - finish reconciling the two records of "approved".
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-11 first. Re-runnable: every UPDATE is guarded.
--
-- Symptom this fixes, straight from the run log:
--
--     10:36:06  success  0 sent, 6 skipped (of 6 due)
--     10:33:05  success  0 sent, 6 skipped (of 6 due)
--
-- Every three minutes the sender picked the same six leads and refused all six.
-- lead_pipeline.approved was true (derived from leads.status) while the active
-- email_versions row was still 'draft', and the send path requires the version.
--
-- Update 8 aligned only leads that had already been sent. This does the rest,
-- and the scheduler now requires the approved version when BUILDING the queue,
-- so it can no longer offer work it will then reject.
-- ===========================================================================
-- ---------------------------------------------------------------------------
-- 0022 ,Finish reconciling the two records of "approved".
--
-- Migration 0018 aligned them only for leads that had ALREADY been sent. The
-- rest were left, and the sender has been rejecting them ever since:
--
--     approved & unsent & open                              6
--     ...with an APPROVED active initial version            0
--
--     10:36:06  success  0 sent, 6 skipped (of 6 due)
--     10:33:05  success  0 sent, 6 skipped (of 6 due)
--
-- Every run picked the same six leads and refused all six. lead_pipeline.
-- approved was true (it is derived from leads.status), the active email_versions
-- row was still 'draft', and the send path requires the version.
--
-- Those leads reached status='approved' because a human pressed Approve: the
-- sheet importer never produces that status (deriveStatus only ever returns
-- new / researching / ready / sent / replied), so the only paths are the bulk
-- action and the status dropdown. Both are deliberate acts of approval, which
-- is why signing off the version here honours the intent rather than inventing
-- it.
--
-- Going forward the mismatch cannot recur: bulkApproveDrafts() approves the
-- version, and findDueWork() now requires it, so the queue no longer offers
-- work the sender will refuse.
-- ---------------------------------------------------------------------------

update public.email_versions v
   set status = 'approved',
       reviewed_at = coalesce(v.reviewed_at, now())
  from public.lead_pipeline p
 where p.lead_id = v.lead_id
   and v.type = 'initial'
   and v.active
   and v.status = 'draft'
   and p.approved = true;

-- ---------------------------------------------------------------------------
-- Leads whose status says approved but which have no draft at all cannot be
-- sent and should stop claiming otherwise. Back to 'ready' so they surface in
-- the drafting queue instead of sitting in a Ready to Send count that can never
-- move.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set approved = false,
       approved_at = null
 where p.approved = true
   and p.first_email_sent is null
   and not exists (
     select 1 from public.email_versions v
      where v.lead_id = p.lead_id and v.type = 'initial' and v.active
   );

update public.leads l
   set status = 'ready'
  from public.lead_pipeline p
 where p.lead_id = l.id
   and l.status = 'approved'
   and p.approved = false;
