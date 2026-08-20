import { PauseCircle } from 'lucide-react';

import { PageHeader } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/table';
import { requireAdmin } from '@/lib/auth/session';
import { getEmailScheduleForecast } from '@/lib/data/email-schedule';
import { DISPLAY_TIME_ZONE_LABEL, formatNumber } from '@/lib/utils';

export const metadata = { title: 'Email Schedule' };
export const dynamic = 'force-dynamic';

/** "Today" / "Tomorrow" / "Thu, 27 Aug" — index 0 and 1 are always the two most-asked-about days. */
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
 * `findDueWork()` sends from, spread across the next 14 days under the same
 * priority order (follow-up 2, then follow-up 1, then initial) and the same
 * daily cap. See getEmailScheduleForecast()'s own comment for exactly what
 * this does and does not simulate.
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
        description={`Next 14 days, in the order they'll actually send — follow-up 2, then follow-up 1, then initial, up to ${formatNumber(forecast.dailyLimit)}/day`}
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
                      {!day.isWorkingDay ? (
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

        <p className="text-xs text-muted-foreground">
          Dates are calendar days in {DISPLAY_TIME_ZONE_LABEL}. Built from what is already due or
          approved right now — a lead approved tomorrow, or a follow-up 1 sent today that schedules
          its own follow-up 2 down the line, will not appear here until that happens. If today&rsquo;s
          row looks light, some of today&rsquo;s cap may already be spent — see Email Logs.
        </p>
      </div>
    </>
  );
}
