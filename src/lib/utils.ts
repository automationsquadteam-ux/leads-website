import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge conditional classes, letting later Tailwind utilities win. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 1234 -> "1,234" */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

/** 12.345 -> "12.3%" */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/**
 * The timezone every displayed timestamp is rendered in.
 *
 * Pinned rather than left to the runtime. Without an explicit `timeZone`, Intl
 * uses whatever clock the code happens to be running on: UTC on Vercel for a
 * server component, the visitor's own zone for a client one. The same row could
 * therefore show two different times depending on which side rendered it, and
 * neither would be the operator's.
 *
 * This is DISPLAY only. Everything stored is UTC (timestamptz), and the sending
 * window in `sending.working_hours` keeps its own timezone setting, which is
 * deliberately separate: when the sender is allowed to run is a policy about
 * the recipients, not about who happens to be reading the screen.
 *
 * Written as a literal `process.env.NEXT_PUBLIC_*` read because Next inlines
 * those at build time by textual substitution ,destructuring breaks it.
 */
export const DISPLAY_TIME_ZONE =
  process.env.NEXT_PUBLIC_DISPLAY_TIMEZONE?.trim() || 'Asia/Karachi';

/**
 * Short label appended to times.
 *
 * Hardcoded rather than taken from `timeZoneName: 'short'`, which renders
 * Asia/Karachi as "GMT+5" ,accurate but not what anyone calls it, and easy to
 * misread as the UTC the sending window uses.
 */
export const DISPLAY_TIME_ZONE_LABEL =
  process.env.NEXT_PUBLIC_DISPLAY_TIMEZONE_LABEL?.trim() || 'PKT';

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/**
 * A timestamp in local time, labelled.
 *
 * The label is on by default: the app also shows a UTC sending window, and an
 * unlabelled "14:32" next to "09:00–17:00 UTC" is exactly the pair that gets
 * misread. Pass `{ zone: false }` where space is tight and the context already
 * makes it obvious.
 */
export function formatDateTime(
  value: string | null | undefined,
  options: { zone?: boolean } = {},
): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

  return options.zone === false ? formatted : `${formatted} ${DISPLAY_TIME_ZONE_LABEL}`;
}

/** Time of day only, for compact rows. Always labelled. */
export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)} ${DISPLAY_TIME_ZONE_LABEL}`;
}

/**
 * Convert an HH:MM wall-clock time in one zone to the same instant in the
 * display zone. Used to show what a UTC sending window means locally.
 *
 * Returns null when either zone is unusable, so a bad setting degrades to
 * showing nothing rather than a wrong time.
 */
export function convertWallClock(
  time: string,
  fromZone: string,
  toZone: string = DISPLAY_TIME_ZONE,
): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;

  try {
    // Anchor on today's date so DST, where it applies, is handled by Intl
    // rather than by arithmetic on a fixed offset.
    const today = new Date();
    const stamp = `${today.toISOString().slice(0, 10)}T${match[1]}:${match[2]}:00`;

    // Find the UTC instant whose wall clock in `fromZone` is the given time.
    const guess = new Date(`${stamp}Z`);
    const asFrom = new Date(guess.toLocaleString('en-US', { timeZone: fromZone }));
    const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
    const instant = new Date(guess.getTime() + (asUtc.getTime() - asFrom.getTime()));

    return new Intl.DateTimeFormat('en-GB', {
      timeZone: toZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(instant);
  } catch {
    return null;
  }
}

/**
 * The UTC offset a zone carries on a given calendar date, as "+05:00".
 *
 * Anchored at noon UTC on that date rather than midnight, so a zone that
 * observes DST and happens to shift right around local midnight is not read
 * on the wrong side of the transition. `longOffset` is what makes this exact
 * rather than a lookup table: it asks Intl's own tz database, so it stays
 * correct if a zone's rules ever change.
 */
function zoneOffsetString(dateStr: string, zone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(`${dateStr}T12:00:00.000Z`));
    const raw = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const match = /GMT([+-]\d{2}):?(\d{2})?/.exec(raw);
    if (!match) return null;
    return `${match[1]}:${match[2] ?? '00'}`;
  } catch {
    return null;
  }
}

/**
 * Midnight-to-midnight for a calendar date, as UTC instants ,in
 * DISPLAY_TIME_ZONE by default, not the server's own clock.
 *
 * A `<input type="date">` value like "2026-08-12" carries no timezone of its
 * own. Every timestamp in this app is shown in DISPLAY_TIME_ZONE, so a date
 * typed into a filter means midnight-to-midnight THERE ,not in whatever
 * zone the server process happens to run in, which on Vercel is UTC. Getting
 * this wrong does not error, it just silently shifts the boundary by the
 * zone's offset: for Asia/Karachi (+05:00) that is five hours, enough to
 * drop the last few hours of a business day into "tomorrow" or pull the
 * first few hours of tomorrow into "today".
 *
 * Returns null for anything that is not a plain YYYY-MM-DD, so a filter
 * function can treat a malformed query param as "no filter" rather than
 * feeding `new Date(garbage)` into a query.
 */
export function dayBoundsUtc(
  dateStr: string,
  zone: string = DISPLAY_TIME_ZONE,
): { start: string; end: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const offset = zoneOffsetString(dateStr, zone);
  if (!offset) return null;
  const start = new Date(`${dateStr}T00:00:00.000${offset}`);
  const end = new Date(`${dateStr}T23:59:59.999${offset}`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Today's midnight-to-midnight, in DISPLAY_TIME_ZONE ,never falls back to
 * `now` on its own, so a caller cannot silently treat "no bounds" as "no
 * filter" the way `dayBoundsUtc()`'s null return invites.
 *
 * Factored out of `findDueWork()` and `getSendQueuePreview()`, which had this
 * exact three-line computation duplicated between them. Found while chasing
 * a live report ("23 follow-up 2s are due, but the send queue shows none and
 * nothing but initial emails went out"): a THIRD, independent spot —
 * `getDashboardWidgets()` ,had drifted from both,
 * using the server's own local clock via bare `Date.setHours(0,0,0,0)`
 * instead. On Vercel that is UTC, not Asia/Karachi, and the two clocks
 * disagree by up to five hours ,a follow-up due at Karachi midnight can
 * read as "due today" on a UTC clock a full day early). One function, so a
 * fourth call site cannot reintroduce the same drift.
 */
export function todayBoundsUtc(zone: string = DISPLAY_TIME_ZONE): { start: string; end: string } {
  const todayDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
  const bounds = dayBoundsUtc(todayDateStr, zone);
  // dayBoundsUtc only returns null for a malformed date string or an
  // unresolvable zone; todayDateStr is always well-formed (Intl guarantees
  // it) and DISPLAY_TIME_ZONE is a real, validated IANA name, so this can't
  // actually happen ,the fallback exists only so the return type stays
  // non-nullable for every caller.
  return bounds ?? { start: new Date().toISOString(), end: new Date().toISOString() };
}

/**
 * The calendar date an instant falls on in a zone, as [year, month, day].
 *
 * Month is 1-based, as Intl reports it ,callers doing arithmetic must pass
 * `month - 1` to `Date.UTC`, or a comparison that straddles a month boundary
 * silently gains or loses a day.
 */
function zoneCalendarDay(date: Date, zone: string): [number, number, number] | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const read = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const [year, month, day] = [read('year'), read('month'), read('day')];
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    return [year, month, day];
  } catch {
    return null;
  }
}

/**
 * "today" / "tomorrow" / "in 3 days" for a due DATE, never a due minute.
 *
 * A follow-up's due date is a whole calendar day (0042/0043): the schedule
 * lands it on midnight in DISPLAY_TIME_ZONE, and the rule it encodes is "this
 * email is three days old", not "this email is three days and four hours old".
 * `formatRelative()` reads the same value at minute precision, so a due date
 * eleven hours out rendered as "in 11 hours" and one three minutes out as
 * "in 3 minutes" ,a countdown to a boundary that carries no meaning, and
 * which invited the reading that a follow-up was about to go out at 00:03.
 *
 * Counted as a difference of CALENDAR DAYS in DISPLAY_TIME_ZONE, not as
 * elapsed milliseconds divided by 86,400,000. Those are different questions:
 * at 23:00 tonight, midnight tomorrow is one hour away and one day away, and
 * "tomorrow" is the true answer for a date. It also means the answer flips at
 * local midnight, the same boundary the scheduler's own day buckets use, so
 * this cannot disagree with them by a few hours.
 *
 * Legacy rows still carry the pre-0042 minute-precise value (those are
 * deliberately not rewritten), and this renders them at day granularity too —
 * which is the intended rule, just reached a few hours later by the sender.
 */
export function formatDueDay(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const due = zoneCalendarDay(date, DISPLAY_TIME_ZONE);
  const today = zoneCalendarDay(new Date(), DISPLAY_TIME_ZONE);
  if (!due || !today) return formatDate(value);

  const days = Math.round(
    (Date.UTC(due[0], due[1] - 1, due[2]) - Date.UTC(today[0], today[1] - 1, today[2])) / 86_400_000,
  );

  // Past a month "in 47 days" is less use than the date itself, matching
  // formatRelative()'s own cutoff.
  if (Math.abs(days) > 30) return formatDate(value);

  // `numeric: 'auto'` is what turns 0/1/-1 into today/tomorrow/yesterday.
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(days, 'day');
}

/** "3 days ago" / "in 2 hours" falls back to a date beyond a month. */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const diffMs = date.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (abs < minute) return 'just now';
  if (abs < hour) return rtf.format(Math.round(diffMs / minute), 'minute');
  if (abs < day) return rtf.format(Math.round(diffMs / hour), 'hour');
  if (abs < 30 * day) return rtf.format(Math.round(diffMs / day), 'day');
  return formatDate(value);
}

export function truncate(value: string | null | undefined, length: number): string {
  if (!value) return '';
  return value.length <= length ? value : `${value.slice(0, length).trimEnd()}…`;
}

/** Strip the scheme so tables can show "example.com/path" instead of the full URL. */
export function displayUrl(url: string | null | undefined): string {
  if (!url) return '';
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/**
 * A Google search for a business, narrowed by where it is.
 *
 * The location is what makes it usable: "Konyha Restaurant" alone returns every
 * restaurant of that name on earth, while "Konyha Restaurant Budapest Hungary"
 * returns the one you are looking at. Every lead in this database has both a
 * city and a country, so the query is always specific.
 *
 * Blank parts are dropped rather than producing double spaces, so this stays
 * correct if a future import leaves one out.
 */
export function googleSearchUrl(...parts: Array<string | null | undefined>): string {
  const query = parts
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ');
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

export function initials(value: string | null | undefined): string {
  if (!value) return '?';
  const parts = value.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  return (parts.slice(0, 2).map((p) => p[0]).join('') || value[0] || '?').toUpperCase();
}
