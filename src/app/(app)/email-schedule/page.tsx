import Link from 'next/link';
import { AlertTriangle, PauseCircle } from 'lucide-react';

import { PageHeader } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/table';
import { requireAdmin } from '@/lib/auth/session';
import { getEmailScheduleForecast } from '@/lib/data/email-schedule';
import { DISPLAY_TIME_ZONE_LABEL, formatNumber } from '@/lib/utils';

export const metadata = { title: 'Email Schedule' };
export const dynamic = 'force-dynamic';

/** "Today" / "Tomorrow" / "Thu, 27 Aug" ,index 0 and 1 are always the two most-asked-about days. */
function formatScheduleDate(dateStr: string, index: number): string {
  if (index === 0) return 'Today';
  if (index === 1) return 'Tomorrow';
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).format(
    new Date(Date.UTC(y, m - 1, d, 12)),
  );
}

/**
 * "Whenever will the next 100 emails actually go out" (asked for directly).
 *
 * Reads the same due dates and the same approved-candidate pool
 * `findDueWork()` sends from, then simulates forward across 14 days under
 * the same priority order (follow-up 2, then follow-up 1, then initial), the
 * same daily cap, AND the real knock-on effect of a send: an initial sent on
 * a simulated day schedules its own follow-up 1 `followup1DelayDays` later,
 * and a follow-up 1 sent schedules its own follow-up 2 `followup2DelayDays`
 * later ,both read from settings. See getEmailScheduleForecast()'s own
 * comment for exactly what this does and does not simulate (the initial pool
 * is a fixed, depleting starting count ,never treated as self-refilling).
 */
export default async function EmailSchedulePage() {
  await requireAdmin();

  const forecast = await getEmailScheduleForecast();

  const totals = forecast.days.reduce(
    (acc, day) => ({
      followup2: acc.followup2 + day.followup2,
      followup1: acc.followup1 + day.followup1,
      initial: acc.initial + day.initial,
    }),
    { followup2: 0, followup1: 0, initial: 0 },
  );
  const grandTotal = totals.followup2 + totals.followup1 + totals.initial;

  return (
    <>
      <PageHeader
        title="Email Schedule"
        description={`Next 14 days, in the order they'll actually send ,follow-up 2, then follow-up 1, then initial, up to ${formatNumber(forecast.dailyLimit)}/day`}
      />

      <div className="space-y-4 p-4 sm:p-6">
        {forecast.error ? (
          <p className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger">
            Could not build the forecast: {forecast.error}
          </p>
        ) : null}

        {forecast.paused ? (
          <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2.5 text-sm text-warning">
            <PauseCircle className="size-4 shrink-0" aria-hidden="true" />
            Sending is paused (sending.paused). Every row below would read zero until it&rsquo;s
            switched back on.
          </div>
        ) : null}

        {forecast.todayFailedCount > 0 ? (
          <Link
            href="/send-failures"
            className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger hover:border-danger/50"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            {formatNumber(forecast.todayFailedCount)} email{forecast.todayFailedCount === 1 ? '' : 's'} failed to
            send today &mdash; Today&rsquo;s row below assumes the rest succeed. View why &rarr;
          </Link>
        ) : null}

        {!forecast.autoFollowups || !forecast.autoSendInitial ? (
          <p className="rounded-md border border-border bg-muted px-3 py-2.5 text-xs text-muted-foreground">
            {!forecast.autoFollowups ? 'Automatic follow-ups are switched off, so Follow-up 1 and 2 read zero below. ' : ''}
            {!forecast.autoSendInitial ? 'Automatic initial sending is switched off, so Initial reads zero below.' : ''}
          </p>
        ) : null}

        <TableWrap>
          <Table style={{ minWidth: 480 }}>
            <THead>
              <tr>
                <TH style={{ width: 140 }}>Date</TH>
                <TH className="text-right" style={{ width: 100 }}>
                  Follow-up 2
                </TH>
                <TH className="text-right" style={{ width: 100 }}>
                  Follow-up 1
                </TH>
                <TH className="text-right" style={{ width: 90 }}>
                  Initial
                </TH>
                <TH className="text-right">Total</TH>
              </tr>
            </THead>
            <TBody>
              {forecast.days.map((day, index) => {
                const dayTotal = day.followup2 + day.followup1 + day.initial;
                return (
                  <TR key={day.date}>
                    <TD className="font-medium">
                      {formatScheduleDate(day.date, index)}
                      {day.isActual ? (
                        <span className="ml-1.5 text-xs font-normal text-success">sent</span>
                      ) : null}
                      {!day.isWorkingDay && !day.isActual ? (
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                          not a sending day
                        </span>
                      ) : null}
                    </TD>
                    <TD className="tabular text-right">{day.followup2 > 0 ? formatNumber(day.followup2) : '—'}</TD>
                    <TD className="tabular text-right">{day.followup1 > 0 ? formatNumber(day.followup1) : '—'}</TD>
                    <TD className="tabular text-right">{day.initial > 0 ? formatNumber(day.initial) : '—'}</TD>
                    <TD className="tabular text-right font-medium">
                      {dayTotal > 0 ? formatNumber(dayTotal) : '—'}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
            <tfoot>
              <TR className="hover:bg-transparent">
                <TD className="font-medium text-muted-foreground">14-day total</TD>
                <TD className="tabular text-right font-medium">{formatNumber(totals.followup2)}</TD>
                <TD className="tabular text-right font-medium">{formatNumber(totals.followup1)}</TD>
                <TD className="tabular text-right font-medium">{formatNumber(totals.initial)}</TD>
                <TD className="tabular text-right font-semibold">{formatNumber(grandTotal)}</TD>
              </TR>
            </tfoot>
          </Table>
        </TableWrap>

        {forecast.followupBacklogRemaining > 0 || forecast.initialBacklogRemaining > 0 ? (
          <p className="text-xs text-muted-foreground">
            Still waiting beyond day 14:{' '}
            {forecast.followupBacklogRemaining > 0 ? (
              <Badge tone="warning">{formatNumber(forecast.followupBacklogRemaining)} follow-up(s)</Badge>
            ) : null}{' '}
            {forecast.initialBacklogRemaining > 0 ? (
              <Badge tone="neutral">{formatNumber(forecast.initialBacklogRemaining)} initial</Badge>
            ) : null}
          </p>
        ) : null}

        <div className="space-y-1.5 text-xs text-muted-foreground">
          <p>
            <strong className="text-foreground">Today&rsquo;s row assumes the rest of the day sends
            successfully.</strong> {formatNumber(forecast.alreadySentToday)} of{' '}
            {formatNumber(forecast.dailyLimit)}{' '}  have actually gone out so far, for real; the rest
            of today&rsquo;s number is what the remaining capacity would still send. If anything
            fails, it&rsquo;s called out above rather than quietly missing from the total.
          </p>
          <p>
            <strong className="text-foreground">Follow-ups cascade.</strong> An initial sent
            schedules its own follow-up 1 {forecast.followup1DelayDays} day
            {forecast.followup1DelayDays === 1 ? '' : 's'} later; a follow-up 1 sent schedules its
            own follow-up 2 {forecast.followup2DelayDays} day
            {forecast.followup2DelayDays === 1 ? '' : 's'} later. Both appear in this table once
            they land. Sends that already happened had their next step written to the database at
            the time, so they are counted from there rather than re-simulated.
          </p>
          <p>
            Dates are calendar days in {DISPLAY_TIME_ZONE_LABEL}. The initial pool started at{' '}
            <strong className="text-foreground">{formatNumber(forecast.initialPoolStart)}</strong>{' '}.
          </p>
        </div>
      </div>
    </>
  );
}
