import { createClient } from '@/lib/supabase/server';
import { getIntegrationConfig } from '@/lib/services/config';
import { dayBoundsUtc, DISPLAY_TIME_ZONE } from '@/lib/utils';

/**
 * A 14-day forward projection of what the scheduled sender will do.
 *
 * Not a second scheduler — everything here reads what `findDueWork()`
 * (`lib/services/outreach/scheduler.ts`) and its dashboard mirror,
 * `getSendQueuePreview()`, already read: `followup1_due` / `followup2_due`
 * already stored on each lead (0042/0043, whole calendar days in
 * DISPLAY_TIME_ZONE), and the current pool of approved-and-verified initial
 * candidates. The only thing genuinely NEW here is spreading that same
 * priority order — follow-up 2, then follow-up 1, then initial — across
 * multiple days instead of one, with a day's leftover backlog rolling into
 * the next day exactly the way "overdue" already works today.
 *
 * Deliberately does NOT simulate a follow-up 1 sent on day N spawning a new
 * follow-up 2 due on day N + `followup2_delay_days`. That is a real thing
 * the scheduler will do, but simulating it compounds a projection on top of
 * a projection — a day-14 number would depend on every guess this function
 * made about days 1 through 13. What is shown is squarely "what is already
 * scheduled, spread across the daily cap" — accurate to the data that
 * exists right now, not a guess about drafts nobody has approved yet.
 */

export interface ScheduleDay {
  /** YYYY-MM-DD in DISPLAY_TIME_ZONE. */
  date: string;
  followup2: number;
  followup1: number;
  initial: number;
  /** False when this date falls outside sending.working_hours.days — always 0/0/0. */
  isWorkingDay: boolean;
}

export interface EmailScheduleForecast {
  days: ScheduleDay[];
  dailyLimit: number;
  /** Sending is off entirely, or one/both categories are switched off. */
  paused: boolean;
  autoFollowups: boolean;
  autoSendInitial: boolean;
  /** Follow-ups (either step) still due beyond the 14-day window shown. */
  followupBacklogRemaining: number;
  /** Approved+verified initial candidates still waiting beyond the window. */
  initialBacklogRemaining: number;
  error: string | null;
}

const FORECAST_DAYS = 14;

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
  const endOfWindow = dayBoundsUtc(dates[dates.length - 1]!)?.end ?? new Date().toISOString();

  /*
   * Sent today already counts against today's cap — this mirrors
   * `runOutreachCycle()`'s own `dailyRemaining = dailyLimit - alreadySent`,
   * so day one of the forecast reads "how many MORE go out today", not "how
   * many go out today" double-counting ones already gone.
   */
  const todayBounds = dayBoundsUtc(dates[0]!);
  const { count: alreadySentToday } = await supabase
    .from('email_logs')
    .select('*', { count: 'exact', head: true })
    .in('status', ['sent', 'delivered', 'opened', 'clicked'])
    .gte('sent_at', todayBounds?.start ?? new Date().toISOString())
    .lte('sent_at', todayBounds?.end ?? new Date().toISOString());

  const base = () =>
    supabase
      .from('pipeline_board')
      .select('*')
      .neq('lead_status', 'archived')
      .is('replied', null)
      .is('closed', null)
      .eq('auto_followups', true);

  // Every pending follow-up due within the window, oldest first — including
  // whatever is already overdue, which sorts first automatically. Capped
  // generously above what 14 days at the daily limit could ever consume.
  const capacityCeiling = config.sending.dailyLimit * FORECAST_DAYS + 500;

  const followup2Query = config.outreach.autoFollowups
    ? base()
        .not('followup1_sent', 'is', null)
        .is('followup2_sent', null)
        .not('followup2_due', 'is', null)
        .lte('followup2_due', endOfWindow)
        .order('followup2_due', { ascending: true })
        .limit(capacityCeiling)
    : Promise.resolve({ data: [], count: null, error: null } as const);

  const followup1Query = config.outreach.autoFollowups
    ? base()
        .not('first_email_sent', 'is', null)
        .is('followup1_sent', null)
        .not('followup1_due', 'is', null)
        .lte('followup1_due', endOfWindow)
        .order('followup1_due', { ascending: true })
        .limit(capacityCeiling)
    : Promise.resolve({ data: [], count: null, error: null } as const);

  let initialQueryBuilder = base()
    .eq('approved', true)
    .is('first_email_sent', null)
    .lt('send_priority', 9)
    .order('send_priority', { ascending: true })
    .order('approved_at', { ascending: true, nullsFirst: false })
    .limit(capacityCeiling);
  if (config.outreach.requireVerifiedEmail) {
    initialQueryBuilder = initialQueryBuilder.eq('email_verified', true);
  }
  const initialQuery = config.outreach.autoSendInitial
    ? initialQueryBuilder
    : Promise.resolve({ data: [], count: null, error: null } as const);

  // Also count how much follow-up backlog exists PAST the window, so the
  // page can say "+N more waiting" instead of implying the queue is empty
  // once day 14 runs out — a plain count, no need to fetch the rows. A
  // separate query rather than layering onto base(): base() already fixed
  // its own `.select('*')`, and a builder only accepts one.
  const followupBacklogPastWindow = config.outreach.autoFollowups
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
    : Promise.resolve({ count: 0, error: null } as const);

  const [f2Result, f1Result, initialResult, backlogResult] = await Promise.all([
    followup2Query,
    followup1Query,
    initialQuery,
    followupBacklogPastWindow,
  ]);

  const firstError =
    f2Result.error?.message ?? f1Result.error?.message ?? initialResult.error?.message ?? null;
  if (firstError) return { ...empty, error: firstError };

  // Initial candidates need the same "does the active version actually say
  // approved" cross-check getSendQueuePreview() does — lead_pipeline.approved
  // can go stale (0039's exact bug class) and this page must not promise a
  // send the real scheduler would refuse.
  const initialRows = initialResult.data ?? [];
  const initialIds = initialRows.map((row) => row.lead_id);
  const { data: approvedVersions } =
    initialIds.length > 0
      ? await supabase
          .from('email_versions')
          .select('lead_id')
          .in('lead_id', initialIds)
          .eq('type', 'initial')
          .eq('active', true)
          .eq('status', 'approved')
      : { data: [] as Array<{ lead_id: string }> };
  const signedOff = new Set((approvedVersions ?? []).map((row) => row.lead_id));
  const initialQueue = initialRows.filter((row) => signedOff.has(row.lead_id));

  const f2Queue = (f2Result.data ?? [])
    .map((row) => row.followup2_due)
    .filter((v): v is string => v !== null);
  const f1Queue = (f1Result.data ?? [])
    .map((row) => row.followup1_due)
    .filter((v): v is string => v !== null);

  let f2Index = 0;
  let f1Index = 0;
  let initialRemaining = initialQueue.length;

  const days: ScheduleDay[] = dates.map((date, dayNumber) => {
    const bounds = dayBoundsUtc(date);
    const endOfDay = bounds?.end ?? date;
    const isWorkingDay = config.sending.workingHours.days.includes(weekdayOf(date));

    if (!isWorkingDay || config.sending.paused) {
      return { date, followup2: 0, followup1: 0, initial: 0, isWorkingDay };
    }

    let remaining =
      config.sending.dailyLimit - (dayNumber === 0 ? (alreadySentToday ?? 0) : 0);
    remaining = Math.max(0, remaining);

    let followup2 = 0;
    while (remaining > 0 && f2Index < f2Queue.length && f2Queue[f2Index]! <= endOfDay) {
      followup2 += 1;
      remaining -= 1;
      f2Index += 1;
    }

    let followup1 = 0;
    while (remaining > 0 && f1Index < f1Queue.length && f1Queue[f1Index]! <= endOfDay) {
      followup1 += 1;
      remaining -= 1;
      f1Index += 1;
    }

    const initial = Math.min(remaining, initialRemaining);
    initialRemaining -= initial;

    return { date, followup2, followup1, initial, isWorkingDay };
  });

  // Whatever the queues still hold past the 14th day: due dates beyond the
  // window plus anything the daily cap pushed past it, in one count.
  const followupBacklogRemaining =
    (f2Queue.length - f2Index) + (f1Queue.length - f1Index) + (backlogResult.count ?? 0);
  const initialBacklogRemaining = initialRemaining;

  return {
    days,
    dailyLimit: config.sending.dailyLimit,
    paused: config.sending.paused,
    autoFollowups: config.outreach.autoFollowups,
    autoSendInitial: config.outreach.autoSendInitial,
    followupBacklogRemaining,
    initialBacklogRemaining,
    error: null,
  };
}
