-- ---------------------------------------------------------------------------
-- 0019 ,The sheet's "Date Sent" is authoritative for upstream sends.
--
-- Migration 0015 backfilled first_email_sent from imported_at, because the
-- sheet's Date Sent column was empty at the time. It has since been filled in
-- with the real dates, but the sync could not use them: the ON CONFLICT clause
-- in sync_pipeline_from_lead() used
--
--     first_email_sent = coalesce(p.first_email_sent, excluded.first_email_sent)
--
-- which never overwrites. So the schedule stayed anchored to the import date,
-- and every follow-up would have fired a week after we happened to import the
-- lead rather than a week after the prospect was actually emailed.
--
-- The rule this establishes:
--
--   * A send THIS CRM made (an email_logs row with a sent_at) is authoritative.
--     Nothing from the sheet may move it.
--   * Otherwise the sheet's Date Sent wins, because for upstream sends it is
--     the only record that exists.
--
-- followup1_due is re-derived alongside it, or correcting the send date would
-- leave the schedule pointing at the old one.
-- ---------------------------------------------------------------------------

create or replace function public.sync_pipeline_from_lead()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  has_email    boolean := new.email is not null and length(btrim(new.email)) > 0;
  has_research boolean := new.research_summary is not null and length(btrim(new.research_summary)) > 0;
  has_draft    boolean := new.draft_email is not null and length(btrim(new.draft_email)) > 0;
  is_approved  boolean := new.status in ('approved', 'sending', 'sent', 'replied');
  was_sent     boolean := new.status in ('sent', 'replied');
  d1           integer := public.setting_int('outreach.followup1_delay_days', 7);

  -- The sheet's Date Sent, when it has one.
  sheet_sent   timestamptz := new.last_contacted_at;

  -- Used when inserting a fresh row: a date is better than nothing, and
  -- imported_at at least bounds when the send must have happened.
  assumed_sent timestamptz := coalesce(new.last_contacted_at, new.imported_at, now());

  -- Did WE send this? If so the sheet does not get to move the date.
  crm_sent boolean := exists (
    select 1 from public.email_logs el
     where el.lead_id = new.id and el.sent_at is not null
  );

  -- Only then may the sheet overwrite an existing value.
  sheet_wins boolean := was_sent and sheet_sent is not null and not crm_sent;
begin
  insert into public.lead_pipeline as p (
    lead_id, email_found, research_complete, draft_ready, approved,
    first_email_sent, followup1_due
  )
  values (
    new.id, has_email, has_research, has_draft, is_approved,
    case when was_sent then assumed_sent else null end,
    case when was_sent then assumed_sent + make_interval(days => d1) else null end
  )
  on conflict (lead_id) do update
    set email_found       = p.email_found       or excluded.email_found,
        research_complete = p.research_complete or excluded.research_complete,
        draft_ready       = p.draft_ready       or excluded.draft_ready,
        approved          = p.approved          or excluded.approved,

        first_email_sent =
          case when sheet_wins then sheet_sent
               else coalesce(p.first_email_sent, excluded.first_email_sent) end,

        -- Re-derived from whichever date won, and never moved once the
        -- follow-up has actually gone out.
        followup1_due =
          case when sheet_wins and p.followup1_sent is null
               then sheet_sent + make_interval(days => d1)
               else coalesce(p.followup1_due, excluded.followup1_due) end;

  return null;
end;
$$;

comment on function public.sync_pipeline_from_lead() is
  'Projects lead columns onto the pipeline. The sheet Date Sent is authoritative for upstream sends; a send this CRM recorded is never overwritten.';

-- ---------------------------------------------------------------------------
-- Re-anchor the leads already carrying a guessed date.
--
-- Only where the CRM has no send of its own, and only where the sheet actually
-- disagrees, so this is a no-op on a second run.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set first_email_sent = l.last_contacted_at,
       followup1_due = case
         when p.followup1_sent is null
         then l.last_contacted_at
              + make_interval(days => public.setting_int('outreach.followup1_delay_days', 7))
         else p.followup1_due
       end
  from public.leads l
 where l.id = p.lead_id
   and l.last_contacted_at is not null
   and p.first_email_sent is distinct from l.last_contacted_at
   and not exists (
     select 1 from public.email_logs el
      where el.lead_id = l.id and el.sent_at is not null
   );
