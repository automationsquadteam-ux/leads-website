-- ===========================================================================
-- Schema update 33 - fix 0042's date/timezone ambiguity bug.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-32 first. Re-runnable throughout.
--
-- 0042's `date AT TIME ZONE zone` formula was genuinely ambiguous in
-- Postgres (implicit casts to BOTH timestamp and timestamptz exist for
-- `date`) and silently resolved to the wrong one - round-tripping through
-- the session's UTC default twice, a 10-hour (2x5h PKT) error. Fixed with
-- an explicit ::timestamp cast that removes the ambiguity, plus a tightly
-- scoped repair for the one pending row already computed wrong live.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0043 — 0042's day-truncation formula was wrong: `date AT TIME ZONE zone`
-- is genuinely ambiguous in Postgres, and it silently resolved to the wrong
-- meaning.
--
-- Reported as: "didn't we change followups to be due by date, not the exact
-- minute — so why does one still say due in 5 hours and 3 hours?" Checked
-- live and the picture was worse than "not applied yet": 0042 WAS applied,
-- but a fresh throwaway lead sent at a known, deliberately odd instant
-- (16 Aug, 21:47:13 PKT) computed a due date of **23 Aug, 10:00:00 PKT** —
-- neither the old exact-minute behaviour NOR the intended midnight.
-- ---------------------------------------------------------------------------
-- ROOT CAUSE
--
-- 0042's formula was:
--
--   ((sent_at at time zone tz)::date + d1) at time zone tz
--
-- The first `at time zone` is fine — `sent_at` is unambiguously `timestamptz`,
-- so `timestamptz AT TIME ZONE zone -> timestamp` is the only possible
-- reading. The SECOND one is the bug: by that point the expression
-- `(...)::date + d1` is a bare `date`, and Postgres has BOTH `date ->
-- timestamp` AND `date -> timestamptz` registered as IMPLICIT casts. `AT TIME
-- ZONE` is overloaded on both `timestamp` and `timestamptz`, so a bare
-- `date` operand is genuinely ambiguous between them, and Postgres did not
-- resolve it to the one this migration meant.
--
-- What it actually did, worked out from the observed 10-hour (2×5h) offset
-- and confirmed by hand-tracing the arithmetic:
--
--   1. `date '2026-08-23'` implicit-cast to `timestamptz`, using the
--      SESSION's default timezone (UTC on this project) to interpret
--      midnight -> `2026-08-23 00:00:00 UTC`.
--   2. `AT TIME ZONE 'Asia/Karachi'` on THAT (now resolved as the
--      `timestamptz -> timestamp` overload) converts it to Karachi wall
--      clock -> plain timestamp `2026-08-23 05:00:00`.
--   3. Assigning that plain timestamp to the `timestamptz` COLUMN
--      `followup1_due` implicit-casts it back to `timestamptz`, AGAIN via
--      the session's UTC default, interpreting `05:00:00` as UTC wall clock
--      -> final stored instant `2026-08-23T05:00:00Z` = 10:00 PKT.
--
-- Two silent implicit casts through UTC, in a row, is exactly a double
-- application of the +5:00 offset — which is exactly the 10-hour gap
-- observed. Neither `tsc` nor a browser could ever have caught this; it is
-- purely a Postgres operator-resolution quirk, invisible until the DDL is
-- actually executed — which this machine cannot do, so it went unverified
-- and shipped wrong. Owning that plainly rather than glossing over it.
-- ---------------------------------------------------------------------------
-- THE FIX
--
-- Force the correct overload with an EXPLICIT `::timestamp` cast before the
-- final `AT TIME ZONE`, so there is no `date` operand left for Postgres to
-- resolve ambiguously — only `timestamp AT TIME ZONE zone -> timestamptz`
-- can apply once the type is exactly `timestamp`:
--
--   (((sent_at at time zone tz)::date + d1)::timestamp) at time zone tz
--
-- Same principle 0042 already stated (day-granular, midnight of the Nth
-- day, same two functions, same 'Asia/Karachi' literal for the reasons
-- given there) — only the one cast changes.
-- ---------------------------------------------------------------------------
-- REPAIR, SCOPED TIGHTLY
--
-- Exactly one pending row was found live with the buggy signature. A pending
-- due date can only be in one of three states: (a) the pre-0042 pattern,
-- exactly `sent_at + N days` — deliberately left alone, same as 0042 itself
-- chose; (b) already correct, landing on 00:00:00 PKT; or (c) neither, which
-- can only mean the buggy 0042 formula touched it. The repair below matches
-- state (c) only, so it cannot touch a row 0042 never got the chance to
-- compute wrong, and cannot touch one already right.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. sync_pipeline_from_email_log() — sends this app records.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_email_log()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sent_at timestamptz := coalesce(new.sent_at, now());
  d1 integer := public.setting_int('outreach.followup1_delay_days', 7);
  d2 integer := public.setting_int('outreach.followup2_delay_days', 3);
  tz constant text := 'Asia/Karachi';
begin
  if new.status not in ('sent', 'delivered', 'opened', 'clicked') then
    return null;
  end if;

  insert into public.lead_pipeline (lead_id) values (new.lead_id)
  on conflict (lead_id) do nothing;

  if new.email_type = 'initial' then
    update public.lead_pipeline
       set first_email_sent = coalesce(first_email_sent, sent_at),
           followup1_due    = coalesce(followup1_due,
             (((sent_at at time zone tz)::date + d1)::timestamp) at time zone tz)
     where lead_id = new.lead_id;

  elsif new.email_type = 'followup1' then
    update public.lead_pipeline
       set followup1_sent = coalesce(followup1_sent, sent_at),
           followup2_due  = coalesce(followup2_due,
             (((sent_at at time zone tz)::date + d2)::timestamp) at time zone tz)
     where lead_id = new.lead_id;

  elsif new.email_type = 'followup2' then
    update public.lead_pipeline
       set followup2_sent = coalesce(followup2_sent, sent_at)
     where lead_id = new.lead_id;
  end if;

  update public.lead_pipeline
     set email_verification_status = 'valid',
         email_verification_source = 'delivered',
         email_checked_at          = coalesce(email_checked_at, sent_at)
   where lead_id = new.lead_id
     and email_verification_status <> 'invalid'
     and email_verification_status <> 'valid';

  return null;
end;
$$;

comment on function public.sync_pipeline_from_email_log() is
  'Advances the sequence on a recorded send and treats acceptance as proof the address works. Follow-up due dates land on midnight (Asia/Karachi) of the Nth calendar day after the triggering send (0042), via an explicit ::timestamp cast before AT TIME ZONE so the date->timestamp/timestamptz cast ambiguity cannot silently pick the wrong overload again (0043). A later hard bounce (0016) revises verification to invalid.';

-- ---------------------------------------------------------------------------
-- 2. sync_pipeline_from_lead() — an initial send reported by a direct write
--    to `leads` (n8n). Same fix, same two call sites as 0042.
-- ---------------------------------------------------------------------------
create or replace function public.sync_pipeline_from_lead()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  has_email    boolean := new.email is not null and length(btrim(new.email)) > 0;

  sheet_says_researched boolean := new.researched_at is not null;

  has_research_fields boolean := (
       coalesce(length(btrim(new.research_summary)), 0) > 0
    or coalesce(length(btrim(new.website_observations)), 0) > 0
    or coalesce(length(btrim(new.automation_opportunities)), 0) > 0
    or coalesce(length(btrim(new.ai_chatbot_opportunities)), 0) > 0
    or coalesce(length(btrim(new.website_improvement_opportunities)), 0) > 0
    or coalesce(length(btrim(new.outreach_angle)), 0) > 0
    or coalesce(length(btrim(new.interesting_facts)), 0) > 0
  );

  has_research boolean := sheet_says_researched or has_research_fields;
  has_draft    boolean := new.draft_email is not null and length(btrim(new.draft_email)) > 0;

  was_sent     boolean := new.status in ('sent', 'replied');
  d1           integer := public.setting_int('outreach.followup1_delay_days', 7);
  tz           constant text := 'Asia/Karachi';

  sheet_sent   timestamptz := new.last_contacted_at;
  assumed_sent timestamptz := coalesce(new.last_contacted_at, new.imported_at, now());

  crm_sent boolean := exists (
    select 1 from public.email_logs el
     where el.lead_id = new.id and el.sent_at is not null
  );
  sheet_wins boolean := was_sent and sheet_sent is not null and not crm_sent;
begin
  insert into public.lead_pipeline as p (
    lead_id, email_found, research_complete, draft_ready,
    first_email_sent, followup1_due
  )
  values (
    new.id, has_email, has_research, has_draft,
    case when was_sent then assumed_sent else null end,
    case when was_sent then (((assumed_sent at time zone tz)::date + d1)::timestamp) at time zone tz else null end
  )
  on conflict (lead_id) do update
    set email_found       = p.email_found       or excluded.email_found,
        research_complete = p.research_complete or excluded.research_complete,
        draft_ready       = p.draft_ready       or excluded.draft_ready,

        first_email_sent =
          case when sheet_wins then sheet_sent
               else coalesce(p.first_email_sent, excluded.first_email_sent) end,

        followup1_due =
          case when sheet_wins and p.followup1_sent is null
               then (((sheet_sent at time zone tz)::date + d1)::timestamp) at time zone tz
               else coalesce(p.followup1_due, excluded.followup1_due) end;

  return null;
end;
$$;

comment on function public.sync_pipeline_from_lead() is
  'Projects lead columns onto the pipeline. Research is complete when the sheet says so (researched_at) OR when any research field is filled. Does NOT touch `approved` — email_versions owns that. followup1_due lands on midnight (Asia/Karachi) of the Nth calendar day after the send, via an explicit ::timestamp cast (0043) so it matches sync_pipeline_from_email_log() exactly.';

-- ---------------------------------------------------------------------------
-- 3. Repair the one pending row 0042 computed wrong before this ran.
-- ---------------------------------------------------------------------------
update public.lead_pipeline p
   set followup1_due =
         (((p.first_email_sent at time zone 'Asia/Karachi')::date
           + public.setting_int('outreach.followup1_delay_days', 7))::timestamp)
         at time zone 'Asia/Karachi'
 where p.followup1_sent is null
   and p.followup1_due is not null
   and p.first_email_sent is not null
   and p.followup1_due <> p.first_email_sent
       + make_interval(days => public.setting_int('outreach.followup1_delay_days', 7))
   and (p.followup1_due at time zone 'Asia/Karachi')::time <> time '00:00:00';

update public.lead_pipeline p
   set followup2_due =
         (((p.followup1_sent at time zone 'Asia/Karachi')::date
           + public.setting_int('outreach.followup2_delay_days', 3))::timestamp)
         at time zone 'Asia/Karachi'
 where p.followup2_sent is null
   and p.followup2_due is not null
   and p.followup1_sent is not null
   and p.followup2_due <> p.followup1_sent
       + make_interval(days => public.setting_int('outreach.followup2_delay_days', 3))
   and (p.followup2_due at time zone 'Asia/Karachi')::time <> time '00:00:00';
