-- ===========================================================================
-- Schema update 26 - the public page counts businesses reached, not messages.
--
-- GENERATED FILE. Regenerate from supabase/migrations/, do not hand-edit.
-- Apply updates 1-25 first. Re-runnable throughout.
--
-- Ten businesses in a full three-step sequence read as "25 emails sent" on the
-- front page. Adds `leads_contacted` (distinct non-archived leads with an
-- initial send) and re-bases `reply_rate_pct` on it. `emails_sent` and the
-- bounce figures stay as raw message counts.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0036 ,the public page counts BUSINESSES REACHED, not messages sent.
--
-- `emails_sent` counts rows in email_logs, so a lead that got an initial plus
-- two follow-ups counts three times. Ten businesses in a full three-step
-- sequence read as "25 emails sent" on the front page, which describes our
-- activity rather than our reach ,and reply rate inherited the same
-- denominator, so it was "replies per message" and fell as we followed up
-- more, even though every reply came from the same ten conversations.
--
-- Adds `leads_contacted`: distinct non-archived leads with an initial send
-- recorded. `reply_rate_pct` now divides by it, which turns the number into
-- "of the businesses we reached, how many answered" ,the only reply rate a
-- cold-outreach funnel should publish.
--
-- Counted from `lead_pipeline.first_email_sent`, NOT from
-- `email_logs where email_type = 'initial'`, for two reasons:
--   1. It is one row per lead, so it is distinct by construction.
--   2. Sends made upstream (the sheet era) have NO email_logs row at all —
--      0015/0018 write first_email_sent directly. Counting logs would silently
--      drop every lead emailed before this CRM started recording sends.
--
-- `emails_sent`, `emails_attempted` and `emails_bounced` are deliberately left
-- as MESSAGE counts. Bounce rate is a per-message property of the sending
-- domain and would be wrong measured per business. The two live side by side
-- on purpose: one says how far we reached, the other how much mail we sent.
-- ---------------------------------------------------------------------------

create or replace view public.public_stats_overview
with (security_invoker = false) as
with active as (
  select p.*
  from public.lead_pipeline p
  join public.leads l on l.id = p.lead_id
  where l.status <> 'archived'
)
select
  (select count(*) from active)::bigint                                                       as total_leads,
  (select count(*) from active where current_stage = 'need_email')::bigint                    as need_email,
  (select count(*) from active where current_stage = 'need_verification')::bigint             as need_verification,
  (select count(*) from active where current_stage = 'research')::bigint                      as researching,
  (select count(*) from active where current_stage = 'draft')::bigint                         as awaiting_draft,
  (select count(*) from active where current_stage = 'review')::bigint                        as draft_ready,
  (select count(*) from active where current_stage = 'approved')::bigint                      as approved,
  (select count(*) from active where closed is not null)::bigint                              as closed,

  (select count(*) from public.email_logs
    where status in ('sent', 'delivered', 'opened', 'clicked'))::bigint                        as emails_sent,
  (select count(*) from public.email_logs)::bigint                                             as emails_attempted,
  (select count(*) from public.email_logs where status = 'bounced')::bigint                    as emails_bounced,
  (select count(*) from public.email_logs where email_type = 'initial'
     and status in ('sent', 'delivered', 'opened', 'clicked'))::bigint                         as initial_sent,
  (select count(*) from public.email_logs where email_type = 'followup1'
     and status in ('sent', 'delivered', 'opened', 'clicked'))::bigint                         as followup1_sent,
  (select count(*) from public.email_logs where email_type = 'followup2'
     and status in ('sent', 'delivered', 'opened', 'clicked'))::bigint                         as followup2_sent,

  (select count(*) from public.replies)::bigint                                                as replies,
  (select count(*) from public.replies where sentiment = 'positive')::bigint                   as positive_replies,
  (select count(*) from public.replies where sentiment = 'negative')::bigint                   as negative_replies,
  (select count(*) from public.replies where sentiment = 'neutral')::bigint                    as neutral_replies,

  -- Bounce rate stays per MESSAGE: it is a property of the sending domain and
  -- of individual addresses, not of how many businesses we reached.
  round(
    100.0 * (select count(*) from public.email_logs where status = 'bounced')
    / nullif((select count(*) from public.email_logs), 0), 2
  )                                                                                            as bounce_rate_pct,

  -- Reply rate is now per BUSINESS REACHED. Divided by message count it fell
  -- every time a follow-up went out, which reads as the campaign getting worse
  -- when nothing about the conversations changed.
  round(
    100.0 * (select count(*) from public.replies)
    / nullif((select count(*) from active where first_email_sent is not null), 0), 2
  )                                                                                            as reply_rate_pct,

  (
    select round(avg(extract(epoch from (r.received_at - sent.sent_at)) / 3600.0)::numeric, 1)
    from public.replies r
    join lateral (
      select el.sent_at
      from public.email_logs el
      where el.sent_at is not null
        and (
          el.id = r.email_log_id
          or (r.email_log_id is null and el.lead_id = r.lead_id and el.sent_at <= r.received_at)
        )
      order by el.sent_at desc
      limit 1
    ) sent on true
  )                                                                                            as avg_response_hours,

  (select count(*) from active where current_stage = 'dead_email')::bigint                     as dead_email,

  -- Appended. CREATE OR REPLACE can only add columns at the END.
  (select count(*) from active where first_email_sent is not null)::bigint                     as leads_contacted;

comment on view public.public_stats_overview is
  'PUBLIC (anon-readable). Aggregate counters and rates only - no lead identity of any kind. `leads_contacted` is distinct businesses reached and is what the front page headlines; `emails_sent` remains a raw message count. Lead counts exclude archived; email_logs / replies figures do not, because a sent message stays sent.';
