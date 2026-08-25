import { createClient } from '@/lib/supabase/server';
import { getIntegrationConfig } from '@/lib/services/config';
import { dayBoundsUtc, DISPLAY_TIME_ZONE } from '@/lib/utils';

/**
 * A 14-day forward projection of what the scheduled sender will do.
 *
 * Not a second scheduler ,the STARTING state reads exactly what
 * `findDueWork()` reads: `followup1_due` / `followup2_due` already stored on
 * each lead (0042/0043, whole calendar days in DISPLAY_TIME_ZONE), and the
 * current pool of approved-and-verified initial candidates.
 *
 * From there it DOES simulate forward (revised after direct feedback that a
 * non-cascading version "wasn't what I imagined" ,correctly: a send today
 * is a real event with real downstream consequences, and a 14-day window is
 * long enough for those consequences to land inside it). An initial sent on
 * simulated day X schedules a follow-up 1 on day X + `followup1DelayDays`; a
 * follow-up 1 sent on day X schedules a follow-up 2 on day X +
 * `followup2DelayDays` ,both read from settings, never hardcoded. Whatever
 * a day's 60-item cap leaves unsent stays in the backlog and keeps its
 * priority over anything that becomes due later, exactly like "overdue"
 * already works for a single day today, just carried across the whole
 * window. Priority is two-level: OLDER due dates before newer ones, and
 * within any one day, follow-up 2 before follow-up 1 before initial ,the
 * same order `findDueWork()` uses, just applied across days instead of one.
 *
 * The initial pool is deliberately NOT treated as infinite or self-
 * refilling. It is exactly the leads that are approved-and-verified RIGHT
 * NOW; once the simulation spends them, "Initial" reads 0 for the rest of
 * the window, because nothing here can predict a draft nobody has approved
 * yet. A cascade from today's sends is a certainty already set in motion; a
 * future approval is a guess, and this function does not make that one.
 *
 * Every draw assumes success ,nothing is discounted by a predicted failure
 * rate (see `drawDay()`'s own comment for why that used to make the 14-day
 * total quietly add up to less than the pool it started from). Today (day 0)
 * is `alreadySentToday` (a fact, from `email_logs`) plus a `drawDay()` pass
 * over whatever capacity the sending window has left for the rest of today
 * ,so it reads as one settled number like every other row instead of
 * shrinking through the day as real sends move it out of Tomorrow's bucket
 * one at a time. A real failure among today's actual attempts is surfaced
 * separately as `todayFailedCount` rather than folded into any total; see
 * `/send-failures` for why each one happened.
 */

export interface ScheduleDay {
  /** YYYY-MM-DD in DISPLAY_TIME_ZONE. */
  date: string;
  followup2: number;
  followup1: number;
  initial: number;
  /** False when this date falls outside sending.working_hours.days ,always 0/0/0. */
  isWorkingDay: boolean;
  /**
   * True for today's row only. The figures in it are `alreadySentToday` (a
   * fact, from email_logs) plus whatever the rest of today's sending window
   * would still draw, assumed successful ,see the module comment. Not a
   * signal that the whole row is history; it just marks "this is today."
   */
  isActual: boolean;
  /**
   * Cap minus what the day already drew (follow-up 2 + follow-up 1 +
   * initial) ,room left in that day's send count that nothing currently
   * claims. Only ever nonzero once the initial pool (or the follow-up
   * backlogs) run dry before the cap does; while there's enough queued to
   * fill every day, this reads 0 everywhere. `undefined` on a `pastDays` row
   * ,a day that already happened has no "room left", only what happened.
   */
  spareInitialCapacity?: number;
}

export interface EmailScheduleForecast {
  /** The 7 calendar days before today, oldest first ,what actually sent, read from email_logs. */
  pastDays: ScheduleDay[];
  days: ScheduleDay[];
  dailyLimit: number;
  followup1DelayDays: number;
  followup2DelayDays: number;
  /** Sent so far today, in DISPLAY_TIME_ZONE ,what's already spent of day one's cap. */
  alreadySentToday: number;
  /**
   * Failed send ATTEMPTS today (any refusal or provider rejection ,see
   * `/send-failures`), in DISPLAY_TIME_ZONE. Today's row assumes the rest of
   * the day succeeds, so a real failure would otherwise just vanish from every
   * total on this page; this is how it stays visible instead ,named here
   * rather than subtracted from the count.
   */
  todayFailedCount: number;
  /** The initial pool the simulation started from ,approved, verified, unsent, right now. */
  initialPoolStart: number;
  /** Sending is off entirely, or one/both categories are switched off. */
  paused: boolean;
  autoFollowups: boolean;
  autoSendInitial: boolean;
  /** Follow-up backlog still pending past the 14-day window ,real due dates only, not projected cascades. */
  followupBacklogRemaining: number;
  /** Approved+verified initial candidates the simulation never got to. */
  initialBacklogRemaining: number;
  error: string | null;
}

const FORECAST_DAYS = 14;

/** How many days of actual history to show before Today's row. */
const PAST_DAYS = 7;

/**
 * PostgREST caps a response at 1000 rows on this project, SERVER-side —
 * `.limit(5000)` does not lift it and nothing errors, you just silently get
 * 1000. That exact trap produced the "Ready to Send 79 vs 138" bug; see the
 * comment on `getDashboardWidgets().readyToSend`. Anything here that can
 * plausibly exceed 1000 rows (the follow-up queues, the initial pool) must
 * page through `.range()` rather than trust one big select.
 */
const PAGE = 1000;

/**
 * `count` calendar dates in `zone`, starting `startOffsetDays` away from
 * today (0 = today, -7 = a week ago), as YYYY-MM-DD strings.
 */
function relativeDates(startOffsetDays: number, count: number, zone: string): string[] {
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
  const [y, m, d] = todayStr.split('-').map(Number) as [number, number, number];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(new Date(Date.UTC(y, m - 1, d + startOffsetDays + i)).toISOString().slice(0, 10));
  }
  return out;
}

/** The next `count` calendar dates in `zone`, starting today, as YYYY-MM-DD strings. */
function nextDates(count: number, zone: string): string[] {
  return relativeDates(0, count, zone);
}

/** Mon=1 .. Sun=7, matching sending.working_hours.days and scheduler.ts's localClock(). */
function weekdayOf(dateStr: string): number {
  // Noon, not midnight: keeps this a day away from any DST edge in a zone
  // that has one, even though DISPLAY_TIME_ZONE (Asia/Karachi) does not.
  const jsDay = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return ((jsDay + 6) % 7) + 1;
}

/** Minutes since midnight, right now, in `zone`. Same shape as scheduler.ts's localClock(). */
function minutesNowIn(zone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return hour * 60 + minute;
  } catch {
    // An invalid IANA name must not stop the forecast; fall back to the host clock.
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }
}

/** "HH:MM" -> minutes since midnight. */
function toMinutes(value: string): number {
  const [h, m] = value.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * One day's draw against the three backlogs, in priority order (follow-up 2,
 * then follow-up 1, then initial) ,the same order `findDueWork()` sends in.
 *
 * Every queued item is assumed to send successfully. This used to be
 * discounted by an observed failure rate (`successesFrom`/`drawnFor`), which
 * silently removed a few items from every backlog on every projected day
 * without the removal ever being shown anywhere on this page ,it just made
 * the 14-day total, plus the "still waiting" backlog badge, add up to less
 * than the pool actually started at. A real failure is now surfaced
 * separately instead (`todayFailedCount`, today only ,it is the only day
 * anything has actually been attempted).
 */
function drawDay(
  capacity: number,
  f2Backlog: number,
  f1Backlog: number,
  initialRemaining: number,
): {
  followup2: number;
  followup1: number;
  initial: number;
  f2BacklogAfter: number;
  f1BacklogAfter: number;
  initialRemainingAfter: number;
  /** Capacity minus what got drawn ,see ScheduleDay.spareInitialCapacity. */
  spareCapacity: number;
} {
  let remaining = capacity;

  const followup2 = Math.min(remaining, f2Backlog);
  remaining -= followup2;

  const followup1 = Math.min(remaining, f1Backlog);
  remaining -= followup1;

  const initial = Math.min(remaining, initialRemaining);
  remaining -= initial;

  return {
    followup2,
    followup1,
    initial,
    f2BacklogAfter: f2Backlog - followup2,
    f1BacklogAfter: f1Backlog - followup1,
    initialRemainingAfter: initialRemaining - initial,
    spareCapacity: remaining,
  };
}

export async function getEmailScheduleForecast(): Promise<EmailScheduleForecast> {
  const empty: EmailScheduleForecast = {
    pastDays: [],
    days: [],
    dailyLimit: 0,
    followup1DelayDays: 0,
    followup2DelayDays: 0,
    alreadySentToday: 0,
    todayFailedCount: 0,
    initialPoolStart: 0,
    paused: true,
    autoFollowups: false,
    autoSendInitial: false,
    followupBacklogRemaining: 0,
    initialBacklogRemaining: 0,
    error: null,
  };

  const supabase = await createClient();
  const config = await getIntegrationConfig();

  const dates = nextDates(FORECAST_DAYS, DISPLAY_TIME_ZONE);
  const dayEnds = dates.map((d) => dayBoundsUtc(d)?.end ?? new Date().toISOString());
  const endOfWindow = dayEnds[dayEnds.length - 1]!;

  /** First day index whose end-of-day is >= the given instant, or null if beyond the window. */
  function dayIndexFor(instant: string): number | null {
    const idx = dayEnds.findIndex((end) => instant <= end);
    return idx === -1 ? null : idx;
  }

  const todayBounds = dayBoundsUtc(dates[0]!);
  const todayStart = todayBounds?.start ?? new Date().toISOString();
  const todayEnd = todayBounds?.end ?? new Date().toISOString();

  /*
   * The 7 calendar days before today ,plain history, read from email_logs,
   * same as today's own actual figure. `relativeDates` gives them oldest
   * first, so `pastDates[0]` is 7 days ago and `pastDates[6]` is yesterday;
   * their combined span is contiguous with `todayStart` (each day's bounds
   * are computed independently in DISPLAY_TIME_ZONE, so day N's end and day
   * N+1's start tile exactly, no gap or overlap to double-count across).
   */
  const pastDates = relativeDates(-PAST_DAYS, PAST_DAYS, DISPLAY_TIME_ZONE);
  const pastStart = dayBoundsUtc(pastDates[0]!)?.start ?? todayStart;
  const pastEnd = dayBoundsUtc(pastDates[pastDates.length - 1]!)?.end ?? todayStart;

  /*
   * (A) TODAY IS "WHAT ALREADY SENT" PLUS "WHAT THE REST OF THE DAY WOULD
   * SEND, ASSUMING SUCCESS" ,not a bare read of the log.
   *
   * The real mix that already went out is a fact sitting in email_logs, and
   * that part is never re-derived. But treating the WHOLE of today as
   * history made the row shrink through the day and dumped whatever was
   * still due-but-unsent wholesale into Tomorrow ,work the cron was still
   * going to attempt before the sending window closed tonight, displayed as
   * if it had already rolled over. Today is now folded into the same
   * day-by-day draw every later day gets (below), seeded with whatever
   * capacity is left after `alreadySentToday`, so it reads as a completed
   * day like every other row ,and a failed attempt is surfaced via
   * `todayFailedCount` instead of just quietly not being counted anywhere.
   */
  const [{ data: todaySendRows }, { count: todayFailedCount }, { data: pastSendRows }] = await Promise.all([
    supabase
      .from('email_logs')
      .select('email_type')
      .in('status', ['sent', 'delivered', 'opened', 'clicked'])
      .gte('sent_at', todayStart)
      .lte('sent_at', todayEnd)
      .limit(PAGE),
    // `created_at`, not `sent_at` ,a failed row never gets sent_at set (same
    // reasoning as getEmailLogs()'s own date filter in lib/data/misc.ts).
    supabase
      .from('email_logs')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'failed')
      .gte('created_at', todayStart)
      .lte('created_at', todayEnd),
    // `PAST_DAYS * dailyLimit` is comfortably under the 1000-row cap (see the
    // note on PAGE) for any sane daily limit, so one page is enough.
    supabase
      .from('email_logs')
      .select('email_type, sent_at')
      .in('status', ['sent', 'delivered', 'opened', 'clicked'])
      .gte('sent_at', pastStart)
      .lte('sent_at', pastEnd)
      .limit(PAGE),
  ]);

  const todayActual = { followup2: 0, followup1: 0, initial: 0 };
  for (const row of todaySendRows ?? []) {
    if (row.email_type === 'followup2') todayActual.followup2 += 1;
    else if (row.email_type === 'followup1') todayActual.followup1 += 1;
    else if (row.email_type === 'initial') todayActual.initial += 1;
  }
  const alreadySentToday = todayActual.followup2 + todayActual.followup1 + todayActual.initial;

  const pastIndexByDate = new Map(pastDates.map((d, i) => [d, i]));
  const pastCounts = pastDates.map(() => ({ followup2: 0, followup1: 0, initial: 0 }));
  for (const row of pastSendRows ?? []) {
    const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: DISPLAY_TIME_ZONE }).format(
      new Date(row.sent_at!),
    );
    const idx = pastIndexByDate.get(dateStr);
    if (idx === undefined) continue; // a row landing outside the window by a rounding edge, not this week's
    if (row.email_type === 'followup2') pastCounts[idx]!.followup2 += 1;
    else if (row.email_type === 'followup1') pastCounts[idx]!.followup1 += 1;
    else if (row.email_type === 'initial') pastCounts[idx]!.initial += 1;
  }
  const pastDays: ScheduleDay[] = pastDates.map((date, i) => ({
    date,
    followup2: pastCounts[i]!.followup2,
    followup1: pastCounts[i]!.followup1,
    initial: pastCounts[i]!.initial,
    isWorkingDay: config.sending.workingHours.days.includes(weekdayOf(date)),
    isActual: true,
  }));

  /**
   * Page through every row of a due-date query.
   *
   * `.limit(bigNumber)` is NOT a substitute ,PostgREST's 1000-row cap is
   * server-side and silent. See the note on PAGE.
   */
  async function allDueDates(
    column: 'followup1_due' | 'followup2_due',
    sentColumn: 'followup1_sent' | 'followup2_sent',
    prerequisite: 'first_email_sent' | 'followup1_sent',
  ): Promise<string[]> {
    if (!config.outreach.autoFollowups) return [];
    const out: string[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('pipeline_board')
        .select(column)
        .neq('lead_status', 'archived')
        .is('replied', null)
        .is('closed', null)
        .eq('auto_followups', true)
        .not(prerequisite, 'is', null)
        .is(sentColumn, null)
        .not(column, 'is', null)
        .lte(column, endOfWindow)
        .order(column, { ascending: true })
        .range(from, from + PAGE - 1);

      // A failed page must not read as "no more rows" ,that would silently
      // under-forecast, which is the same class of quiet wrongness the
      // 1000-row cap already caused once.
      if (error) throw new Error(error.message);

      const batch = data ?? [];
      for (const row of batch) {
        const value = (row as Record<string, string | null>)[column];
        if (value) out.push(value);
      }
      if (batch.length < PAGE) break;
    }
    return out;
  }

  /** The initial pool, paged, with the same approved-active-draft cross-check the sender applies. */
  async function initialPool(): Promise<number> {
    if (!config.outreach.autoSendInitial) return 0;
    const candidateIds: string[] = [];
    for (let from = 0; ; from += PAGE) {
      let query = supabase
        .from('pipeline_board')
        .select('lead_id')
        .neq('lead_status', 'archived')
        .is('replied', null)
        .is('closed', null)
        .eq('auto_followups', true)
        .eq('approved', true)
        .is('first_email_sent', null)
        .lt('send_priority', 9)
        .order('send_priority', { ascending: true })
        .order('approved_at', { ascending: true, nullsFirst: false })
        .range(from, from + PAGE - 1);
      if (config.outreach.requireVerifiedEmail) query = query.eq('email_verified', true);

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const batch = data ?? [];
      candidateIds.push(...batch.map((row) => row.lead_id));
      if (batch.length < PAGE) break;
    }
    if (candidateIds.length === 0) return 0;

    // Bounded by the candidate list and chunked ,never a whole-table scan,
    // which is what the readyToSend tile got wrong (79 vs 138).
    const signedOff = new Set<string>();
    for (let i = 0; i < candidateIds.length; i += 300) {
      const { data } = await supabase
        .from('email_versions')
        .select('lead_id')
        .in('lead_id', candidateIds.slice(i, i + 300))
        .eq('type', 'initial')
        .eq('active', true)
        .eq('status', 'approved');
      for (const version of data ?? []) signedOff.add(version.lead_id);
    }
    return candidateIds.filter((id) => signedOff.has(id)).length;
  }

  let f2Dates: string[];
  let f1Dates: string[];
  let initialPoolStart: number;
  let backlogResult: { count: number | null };
  try {
    [f2Dates, f1Dates, initialPoolStart, backlogResult] = await Promise.all([
      allDueDates('followup2_due', 'followup2_sent', 'followup1_sent'),
      allDueDates('followup1_due', 'followup1_sent', 'first_email_sent'),
      initialPool(),
      // Real follow-up backlog past the window ,a plain count, no rows needed.
      config.outreach.autoFollowups
        ? supabase
            .from('pipeline_board')
            .select('*', { count: 'exact', head: true })
            .neq('lead_status', 'archived')
            .is('replied', null)
            .is('closed', null)
            .eq('auto_followups', true)
            .or(
              `and(followup1_sent.not.is.null,followup2_sent.is.null,followup2_due.gt.${endOfWindow}),` +
                `and(first_email_sent.not.is.null,followup1_sent.is.null,followup1_due.gt.${endOfWindow})`,
            )
        : Promise.resolve({ count: 0, error: null } as const),
    ]);
  } catch (cause) {
    return { ...empty, error: cause instanceof Error ? cause.message : 'Could not read the queue.' };
  }

  /*
   * (C) DUE DATES ALREADY IN THE DATABASE ARE NOT RE-SIMULATED.
   *
   * When an email is sent, `sync_pipeline_from_email_log()` immediately
   * writes the next step's due date. So every consequence of every send that
   * has ALREADY happened ,including today's ,is sitting in these columns
   * before this function runs. Verified live: today's 51 follow-up 1 sends
   * appear as 50 rows of `followup2_due` on today+2, and today's 7 initial
   * sends appear as 7 rows of `followup1_due` on today+7. Cascading today's
   * row again in the loop below would double-count every one of them, which
   * is why the loop cascades only the days it PROJECTS.
   */
  const f2DueOnDay = new Map<number, number>();
  const f1DueOnDay = new Map<number, number>();
  for (const due of f2Dates) {
    const idx = dayIndexFor(due);
    if (idx !== null) f2DueOnDay.set(idx, (f2DueOnDay.get(idx) ?? 0) + 1);
  }
  for (const due of f1Dates) {
    const idx = dayIndexFor(due);
    if (idx !== null) f1DueOnDay.set(idx, (f1DueOnDay.get(idx) ?? 0) + 1);
  }

  let f2Backlog = 0;
  let f1Backlog = 0;
  let initialRemaining = initialPoolStart;
  let cascadeOverflow = 0;

  const days: ScheduleDay[] = [];
  for (let dayIndex = 0; dayIndex < FORECAST_DAYS; dayIndex++) {
    const date = dates[dayIndex]!;
    const isWorkingDay = config.sending.workingHours.days.includes(weekdayOf(date));

    // Newly-due items join the backlog regardless of whether today is a
    // working day ,a due date does not un-happen because sending paused
    // that day, it just piles up, same as a real overdue backlog does.
    f2Backlog += f2DueOnDay.get(dayIndex) ?? 0;
    f1Backlog += f1DueOnDay.get(dayIndex) ?? 0;

    /*
     * Day 0: what already sent, PLUS what the rest of today would still
     * send, assuming success ,drawn from the same `drawDay()` every later
     * day uses, seeded with whatever's left of today's cap.
     *
     * Capacity is 0 (nothing more projected) once the sending window has
     * actually closed for today, is paused, or today isn't a sending day at
     * all ,at that point the row genuinely is pure history, same as before.
     * Otherwise the still-due backlog gets drawn down here instead of
     * rolling untouched into Tomorrow, which is what made Tomorrow visibly
     * shrink by exactly `alreadySentToday` every time this page was
     * reloaded later in the day (2026-08-23 changelog).
     */
    if (dayIndex === 0) {
      const wh = config.sending.workingHours;
      const windowClosedToday = minutesNowIn(wh.timezone) >= toMinutes(wh.end);
      const remainingToday =
        config.sending.paused || !isWorkingDay || windowClosedToday
          ? 0
          : Math.max(0, config.sending.dailyLimit - alreadySentToday);

      const rest = drawDay(remainingToday, f2Backlog, f1Backlog, initialRemaining);
      f2Backlog = rest.f2BacklogAfter;
      f1Backlog = rest.f1BacklogAfter;
      initialRemaining = rest.initialRemainingAfter;

      // Only the PROJECTED remainder cascades ,today's real sends already
      // wrote their own next-due-date rows via the trigger, which are
      // already sitting in f2Dates/f1Dates read above (see the module
      // comment on why already-happened cascades are never re-simulated).
      if (rest.initial > 0) {
        const f1Day = dayIndex + config.outreach.followup1DelayDays;
        if (f1Day < FORECAST_DAYS) f1DueOnDay.set(f1Day, (f1DueOnDay.get(f1Day) ?? 0) + rest.initial);
        else cascadeOverflow += rest.initial;
      }
      if (rest.followup1 > 0) {
        const f2Day = dayIndex + config.outreach.followup2DelayDays;
        if (f2Day < FORECAST_DAYS) f2DueOnDay.set(f2Day, (f2DueOnDay.get(f2Day) ?? 0) + rest.followup1);
        else cascadeOverflow += rest.followup1;
      }

      days.push({
        date,
        followup2: todayActual.followup2 + rest.followup2,
        followup1: todayActual.followup1 + rest.followup1,
        initial: todayActual.initial + rest.initial,
        isWorkingDay,
        isActual: true,
        spareInitialCapacity: rest.spareCapacity,
      });
      continue;
    }

    if (!isWorkingDay || config.sending.paused) {
      days.push({
        date,
        followup2: 0,
        followup1: 0,
        initial: 0,
        isWorkingDay,
        isActual: false,
        spareInitialCapacity: 0,
      });
      continue;
    }

    const drawn = drawDay(config.sending.dailyLimit, f2Backlog, f1Backlog, initialRemaining);
    f2Backlog = drawn.f2BacklogAfter;
    f1Backlog = drawn.f1BacklogAfter;
    initialRemaining = drawn.initialRemainingAfter;
    const { followup2, followup1, initial } = drawn;

    /*
     * Cascade forward from what this day PROJECTS sending, on the assumption
     * every one of them succeeds (see drawDay()'s own comment on why nothing
     * here is discounted for failure).
     * Landing beyond the window is tallied, not tracked further; see the
     * module comment on why the lookahead stops there.
     */
    if (initial > 0) {
      const f1Day = dayIndex + config.outreach.followup1DelayDays;
      if (f1Day < FORECAST_DAYS) f1DueOnDay.set(f1Day, (f1DueOnDay.get(f1Day) ?? 0) + initial);
      else cascadeOverflow += initial;
    }
    if (followup1 > 0) {
      const f2Day = dayIndex + config.outreach.followup2DelayDays;
      if (f2Day < FORECAST_DAYS) f2DueOnDay.set(f2Day, (f2DueOnDay.get(f2Day) ?? 0) + followup1);
      else cascadeOverflow += followup1;
    }

    days.push({
      date,
      followup2,
      followup1,
      initial,
      isWorkingDay,
      isActual: false,
      spareInitialCapacity: drawn.spareCapacity,
    });
  }

  return {
    pastDays,
    days,
    dailyLimit: config.sending.dailyLimit,
    followup1DelayDays: config.outreach.followup1DelayDays,
    followup2DelayDays: config.outreach.followup2DelayDays,
    alreadySentToday,
    todayFailedCount: todayFailedCount ?? 0,
    initialPoolStart,
    paused: config.sending.paused,
    autoFollowups: config.outreach.autoFollowups,
    autoSendInitial: config.outreach.autoSendInitial,
    followupBacklogRemaining: (backlogResult.count ?? 0) + cascadeOverflow,
    initialBacklogRemaining: initialRemaining,
    error: null,
  };
}
