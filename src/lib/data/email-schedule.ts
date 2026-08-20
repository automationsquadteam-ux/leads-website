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
   * True for today's row only: these are SENDS THAT ACTUALLY HAPPENED, read
   * from email_logs, not a projection. Today is already partly (or fully)
   * spent by the time anyone loads this page, so projecting it would be
   * predicting the past ,and predicting it wrong, since the real day's mix
   * is a fact sitting in the database.
   */
  isActual: boolean;
}

export interface EmailScheduleForecast {
  days: ScheduleDay[];
  dailyLimit: number;
  followup1DelayDays: number;
  followup2DelayDays: number;
  /** Sent so far today, in DISPLAY_TIME_ZONE ,what's already spent of day one's cap. */
  alreadySentToday: number;
  /**
   * Observed share of send ATTEMPTS that failed over the recent window, as a
   * fraction (0.003 = 0.3%). Applied to future days only.
   */
  failureRate: number;
  /** How many days of history `failureRate` was measured over. */
  failureRateWindowDays: number;
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

/** How far back to measure the send-failure rate applied to future days. */
const FAILURE_WINDOW_DAYS = 14;

/**
 * PostgREST caps a response at 1000 rows on this project, SERVER-side —
 * `.limit(5000)` does not lift it and nothing errors, you just silently get
 * 1000. That exact trap produced the "Ready to Send 79 vs 138" bug; see the
 * comment on `getDashboardWidgets().readyToSend`. Anything here that can
 * plausibly exceed 1000 rows (the follow-up queues, the initial pool) must
 * page through `.range()` rather than trust one big select.
 */
const PAGE = 1000;

/** The next `count` calendar dates in `zone`, starting today, as YYYY-MM-DD strings. */
function nextDates(count: number, zone: string): string[] {
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
  const [y, m, d] = todayStr.split('-').map(Number) as [number, number, number];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
  }
  return out;
}

/** Mon=1 .. Sun=7, matching sending.working_hours.days and scheduler.ts's localClock(). */
function weekdayOf(dateStr: string): number {
  // Noon, not midnight: keeps this a day away from any DST edge in a zone
  // that has one, even though DISPLAY_TIME_ZONE (Asia/Karachi) does not.
  const jsDay = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return ((jsDay + 6) % 7) + 1;
}

export async function getEmailScheduleForecast(): Promise<EmailScheduleForecast> {
  const empty: EmailScheduleForecast = {
    days: [],
    dailyLimit: 0,
    followup1DelayDays: 0,
    followup2DelayDays: 0,
    alreadySentToday: 0,
    failureRate: 0,
    failureRateWindowDays: FAILURE_WINDOW_DAYS,
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
   * (A) TODAY IS READ, NOT PROJECTED.
   *
   * By the time anyone loads this page today is already partly or entirely
   * spent, and the real mix that went out is a fact sitting in email_logs.
   * Projecting it would be predicting the past ,and predicting it wrong,
   * since the projection would re-derive a queue that has already been
   * drained. Verified live: today's row reads 2 follow-up 2, 51 follow-up 1,
   * 7 initial, which is exactly what the send log holds.
   */
  const { data: todaySendRows } = await supabase
    .from('email_logs')
    .select('email_type')
    .in('status', ['sent', 'delivered', 'opened', 'clicked'])
    .gte('sent_at', todayStart)
    .lte('sent_at', todayEnd)
    .limit(PAGE);

  const todayActual = { followup2: 0, followup1: 0, initial: 0 };
  for (const row of todaySendRows ?? []) {
    if (row.email_type === 'followup2') todayActual.followup2 += 1;
    else if (row.email_type === 'followup1') todayActual.followup1 += 1;
    else if (row.email_type === 'initial') todayActual.initial += 1;
  }
  const alreadySentToday = todayActual.followup2 + todayActual.followup1 + todayActual.initial;

  /*
   * (B) SEND FAILURES, MEASURED RATHER THAN ASSUMED.
   *
   * Applied to FUTURE days only ,today is read from the log, so its
   * failures are already reflected in what did or didn't send.
   *
   * The mechanic that matters: a failed send does NOT consume the daily
   * cap. `sendsToday()` counts only sent/delivered/opened/clicked, so the
   * scheduler keeps going until it has `dailyLimit` SUCCESSES. What a
   * failure consumes is a QUEUE ITEM ,so the pool drains slightly faster
   * than the send count suggests, rather than the day sending less.
   */
  const failureSince = new Date(Date.now() - FAILURE_WINDOW_DAYS * 86_400_000).toISOString();
  const [{ count: okCount }, { count: failedCount }] = await Promise.all([
    supabase
      .from('email_logs')
      .select('*', { count: 'exact', head: true })
      .in('status', ['sent', 'delivered', 'opened', 'clicked'])
      .gte('created_at', failureSince),
    supabase
      .from('email_logs')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'failed')
      .gte('created_at', failureSince),
  ]);
  const attempts = (okCount ?? 0) + (failedCount ?? 0);
  const failureRate = attempts > 0 ? (failedCount ?? 0) / attempts : 0;

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
     * Day 0 is history, not a forecast: report what the send log actually
     * holds and move on. Its consequences are already in the due-date
     * columns read above, so nothing is cascaded from it here ,doing so
     * would double-count today's 51 follow-up 1 sends against the 50
     * `followup2_due` rows they already created.
     *
     * The backlog it drained is likewise already reflected: a follow-up
     * sent today has `followup*_sent` set, so it never appeared in the
     * pending queries in the first place.
     */
    if (dayIndex === 0) {
      days.push({
        date,
        followup2: todayActual.followup2,
        followup1: todayActual.followup1,
        initial: todayActual.initial,
        isWorkingDay,
        isActual: true,
      });
      continue;
    }

    if (!isWorkingDay || config.sending.paused) {
      days.push({ date, followup2: 0, followup1: 0, initial: 0, isWorkingDay, isActual: false });
      continue;
    }

    let remaining = config.sending.dailyLimit;

    /*
     * Failures cost a QUEUE ITEM, not a slot in the day's cap.
     *
     * `successesFrom` is how many sends a queue of N can actually produce
     * at the observed failure rate; `drawnFor` is how many items that
     * consumes. Rounded, not floored: with a 0.3% rate a queue of 23 should
     * still read 23, since the expected number of failures in it is 0.07 —
     * flooring would invent a failure that the measurement does not
     * support. The distinction only starts to bite at real volume, which is
     * exactly when it should.
     */
    const successesFrom = (queue: number) =>
      failureRate > 0 ? Math.round(queue * (1 - failureRate)) : queue;
    const drawnFor = (sends: number, queue: number) =>
      failureRate > 0 && failureRate < 1
        ? Math.min(queue, Math.ceil(sends / (1 - failureRate)))
        : sends;

    const followup2 = Math.min(remaining, successesFrom(f2Backlog));
    f2Backlog -= drawnFor(followup2, f2Backlog);
    remaining -= followup2;

    const followup1 = Math.min(remaining, successesFrom(f1Backlog));
    f1Backlog -= drawnFor(followup1, f1Backlog);
    remaining -= followup1;

    const initial = Math.min(remaining, successesFrom(initialRemaining));
    initialRemaining -= drawnFor(initial, initialRemaining);

    /*
     * Cascade forward from what this day PROJECTS sending. Only successful
     * sends schedule a next step ,a failed send never writes a due date,
     * which is why these use the send counts and not the drawn counts.
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

    days.push({ date, followup2, followup1, initial, isWorkingDay, isActual: false });
  }

  return {
    days,
    dailyLimit: config.sending.dailyLimit,
    followup1DelayDays: config.outreach.followup1DelayDays,
    followup2DelayDays: config.outreach.followup2DelayDays,
    alreadySentToday,
    failureRate,
    failureRateWindowDays: FAILURE_WINDOW_DAYS,
    initialPoolStart,
    paused: config.sending.paused,
    autoFollowups: config.outreach.autoFollowups,
    autoSendInitial: config.outreach.autoSendInitial,
    followupBacklogRemaining: (backlogResult.count ?? 0) + cascadeOverflow,
    initialBacklogRemaining: initialRemaining,
    error: null,
  };
}
