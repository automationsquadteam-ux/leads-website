-- ---------------------------------------------------------------------------
-- 0042 — a follow-up's due date is a whole calendar day, not a timestamp.
--
-- Reported as: "even if the mail is 3 days old at 3pm, its still 3 days old,
-- being that concise would have issues down the line, so its supposed to be
-- sent out when the day count is over... not counting till minutes."
-- ---------------------------------------------------------------------------
-- WHAT ACTUALLY HAPPENED
--
-- followup1_due / followup2_due were computed as
--
--   sent_at + make_interval(days => N)
--
-- — exact timestamp arithmetic, so a follow-up became due at the same
-- MINUTE the previous step went out, N days later. That minute is not a
-- deliberate choice; it is whatever instant the scheduler happened to reach
-- that lead at, and since the scheduler paces sends a few minutes apart
-- (0037's `*/3 * * * *` pacing), a whole day's cohort of due dates ends up
-- scattered across the day at 3-minute intervals — confirmed live: today's
-- follow-up 1s were due starting 14:45 and follow-up 2s starting 15:18, both
-- stepping by exactly 3 minutes, a direct fossil of whatever pace the
-- ORIGINAL sends happened to land at, days earlier.
--
-- That is precisely the "issues down the line" this was reported to head
-- off: "3 days old" read as an exact instant rather than a day count makes
-- two emails sent 40 seconds apart in the original batch drift into a
-- visibly different due MOMENT three send-steps later, for no reason that
-- has anything to do with the business rule ("wait 3 days"). The day count
-- is the rule; the minute was always incidental.
-- ---------------------------------------------------------------------------
-- THE FIX, AND WHY BOTH FUNCTIONS
--
-- Truncate to the calendar day before adding the delay, then land on
-- midnight of the resulting day:
--
--   ((sent_at at time zone tz)::date + N) at time zone tz
--
-- `sent_at at time zone tz` converts the instant to a plain (zoneless)
-- wall-clock timestamp in `tz`; `::date` drops the time-of-day, keeping only
-- the calendar day; `+ N` advances N whole days; `at time zone tz` on a date
-- re-anchors that date's midnight as an instant IN `tz`, producing the
-- timestamptz that actually gets stored. Net effect: "the Nth day after the
-- day this happened, from its start" — a lead sent at 21:59 and one sent at
-- 09:03 the same calendar day both become due at the SAME midnight, N days
-- later, which is the whole point: the rule is a day count, so leads that
-- satisfy it on the same day should become due together.
--
-- Two functions compute this, not one, and both need the same fix or the
-- app and n8n gain two disagreeing definitions of "N days" — exactly the
-- class of bug this project keeps finding (0018, 0022, 0039):
--
--   sync_pipeline_from_email_log() — fires when THIS APP records a send
--     (the Send button, the cron sender). Sets followup1_due on 'initial'
--     and followup2_due on 'followup1'.
--
--   sync_pipeline_from_lead() — fires when a lead's INITIAL send is
--     reported by a direct write to `leads` (n8n, the only other writer
--     since Google Sheets was retired — 0033). Only ever sets
--     followup1_due; every follow-up is sent BY this app, so
--     followup2_due always comes from the function above. Two call sites
--     inside it compute the same thing (the INSERT and the sheet-wins
--     UPDATE branch), both fixed here.
--
-- What actually determines the SEND time is unchanged: the scheduler still
-- only fires within `sending.working_hours`, still paces sends by
-- `sending.min_gap_seconds`, and a lead due at midnight simply waits, same
-- as an overdue one always has, until the next run inside the window picks
-- it up. This migration only changes when something starts counting as
-- due, not when the sender is allowed to act on it.
--
-- `tz` is a literal 'Asia/Karachi', matching this app's own display-timezone
-- default (`DISPLAY_TIME_ZONE` in lib/utils.ts) — deliberately NOT
-- `sending.working_hours.timezone`, which is a different, independently
-- configurable setting (live value on this project: 'UTC') answering a
-- different question ("when is the business open to send"), not "what does
-- a calendar day mean when counting how many have passed." A Postgres
-- trigger cannot read the same env var the app does, so the zone is a
-- literal here the same way it is already a literal in this project's own
-- cron-job.org schedule notes.
-- ---------------------------------------------------------------------------
-- DELIBERATELY NOT RETROACTIVE
--
-- Both functions only ever SET these columns guarded by `coalesce(existing,
-- ...)` — once a due date is written, neither function touches it again. So
-- this migration only changes the computation for the NEXT time each column
-- gets set: a lead whose initial has not sent yet, or whose follow-up 1 has
-- not sent yet. Every due date already sitting in the table today keeps its
-- current (minute-precise) value; nothing already scheduled silently jumps
-- to a new time. A backfill onto the existing backlog is a separate,
-- explicit follow-up if wanted — recomputing pending due dates changes
-- real, currently-scheduled send times and should not happen as a side
-- effect of a function replacement.
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
  -- See header: this app's display timezone, not sending.working_hours' own
  -- (independently configurable, currently 'UTC') timezone setting.
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
             ((sent_at at time zone tz)::date + d1) at time zone tz)
     where lead_id = new.lead_id;

  elsif new.email_type = 'followup1' then
    update public.lead_pipeline
       set followup1_sent = coalesce(followup1_sent, sent_at),
           followup2_due  = coalesce(followup2_due,
             ((sent_at at time zone tz)::date + d2) at time zone tz)
     where lead_id = new.lead_id;

  elsif new.email_type = 'followup2' then
    update public.lead_pipeline
       set followup2_sent = coalesce(followup2_sent, sent_at)
     where lead_id = new.lead_id;
  end if;

  -- The address accepted a real message. Upgrade unverified / unknown /
  -- accept_all, but never contradict a verifier that returned 'invalid'.
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
  'Advances the sequence on a recorded send and treats acceptance as proof the address works. Follow-up due dates land on midnight (Asia/Karachi) of the Nth calendar day after the triggering send, not N days from its exact minute (0042) — a day count is a day count, regardless of what minute the previous send happened to land on. A later hard bounce (0016) revises verification to invalid.';

-- ---------------------------------------------------------------------------
-- 2. sync_pipeline_from_lead() — an initial send reported by a direct write
--    to `leads` (n8n). Same day-granular rule, same reason: this is the
--    other path that can set followup1_due, and it must agree with the one
--    above or an n8n-sent lead's follow-up would land on a different kind
--    of due date than one sent through this app.
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

  -- Deliberately NOT is_approved. See 0025's header.
  was_sent     boolean := new.status in ('sent', 'replied');
  d1           integer := public.setting_int('outreach.followup1_delay_days', 7);
  -- See this migration's header: same display-timezone literal as the
  -- function above, so the two paths agree on what "a day" means.
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
    case when was_sent then ((assumed_sent at time zone tz)::date + d1) at time zone tz else null end
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
               then ((sheet_sent at time zone tz)::date + d1) at time zone tz
               else coalesce(p.followup1_due, excluded.followup1_due) end;

  return null;
end;
$$;

comment on function public.sync_pipeline_from_lead() is
  'Projects lead columns onto the pipeline. Research is complete when the sheet says so (researched_at) OR when any research field is filled. Does NOT touch `approved` — email_versions owns that. followup1_due lands on midnight (Asia/Karachi) of the Nth calendar day after the send, matching sync_pipeline_from_email_log() (0042).';
