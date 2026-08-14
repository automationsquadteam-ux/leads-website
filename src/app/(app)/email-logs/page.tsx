import { Mail } from 'lucide-react';

import { PageHeader } from '@/components/shell/app-shell';
import { EmptyState } from '@/components/empty-state';
import { MetricCard } from '@/components/metric-card';
import { EmailStatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/table';
import { EMAIL_TYPE_LABELS } from '@/lib/pipeline/labels';
import { requireAdmin } from '@/lib/auth/session';
import { getEmailLogs } from '@/lib/data/misc';
import { parsePageNumber, parsePageSize } from '@/lib/pagination';
import { formatDateTime, formatNumber } from '@/lib/utils';
import { DateRangeFilter } from './date-range-filter';
import { LogPagination } from './log-pagination';

export const metadata = { title: 'Email Logs' };

/** A bare `YYYY-MM-DD`, or '' — anything else is a hand-edited URL, ignored. */
function parseDateParam(raw: string | undefined): string {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

export default async function EmailLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; size?: string; from?: string; to?: string }>;
}) {
  await requireAdmin();

  const { page: pageParam, size: sizeParam, from: fromParam, to: toParam } = await searchParams;
  const page = parsePageNumber(pageParam);

  /*
   * Every attempt ever made is in this table and reachable — the query has no
   * date filter and never had one. What was missing was any way to leave page 1,
   * so on a day with a full send quota the newest 50 rows WERE that day and the
   * log looked like it only kept today.
   */
  const pageSize = parsePageSize(sizeParam);

  const from = parseDateParam(fromParam);
  const to = parseDateParam(toParam);
  const hasDateFilter = Boolean(from || to);

  const { rows, total, stats, error } = await getEmailLogs(page, pageSize, { from, to });

  return (
    <>
      <PageHeader
        title="Email Logs"
        description={
          hasDateFilter
            ? `${formatNumber(total)} send attempt${total === 1 ? '' : 's'} in the selected ${from && to ? 'period' : 'day'}`
            : total > 0
              ? `${formatNumber(total)} send attempt${total === 1 ? '' : 's'} recorded, newest first`
              : 'Every send attempt is recorded here'
        }
      />

      <div className="space-y-3 p-4 sm:p-6">
        <DateRangeFilter from={from} to={to} />

        {/*
          One row, same population the list below shows — every attempt in
          the selected range, not just the ones that succeeded. Neither date
          set means all time, so this reads the same as the page always has.
        */}
        <section aria-label="Send stats" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard label="Total" value={formatNumber(stats.total)} icon={Mail} />
          <MetricCard label={EMAIL_TYPE_LABELS.initial} value={formatNumber(stats.initial)} />
          <MetricCard label={EMAIL_TYPE_LABELS.followup1} value={formatNumber(stats.followup1)} />
          <MetricCard label={EMAIL_TYPE_LABELS.followup2} value={formatNumber(stats.followup2)} />
        </section>

        {error ? (
          <p className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger">
            Could not load email logs: {error}
          </p>
        ) : null}

        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          {rows.length === 0 ? (
            <EmptyState
              icon={Mail}
              title="No emails sent yet"
              description="Email delivery is not connected. Once the sending worker runs, every attempt delivered, bounced or failed is logged here, with which step of the sequence it was."
            />
          ) : (
            <>
              {/*
                Two renderings of one list, not a table that tries to be both.

                Seven columns cannot be squeezed into a phone: under
                `table-fixed` they end up ~45px each and every cell becomes an
                ellipsis, which is the "congested" complaint. Horizontal
                scrolling would keep the data but makes the reader drag
                sideways to answer "did this one bounce?" — the single most
                common question of this page.

                So below `md` each attempt is a card with the same facts in
                reading order, and the table returns at `md` where it fits.
                Both render the same `rows`; there is no second query and no
                second definition of what a log row is.
              */}
              <ul className="divide-y divide-border md:hidden">
                {rows.map((log) => (
                  <li key={log.id} className="space-y-1.5 px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 wrap-break-word text-sm font-medium">
                        {log.businessName ?? '—'}
                      </span>
                      <EmailStatusBadge status={log.status} />
                    </div>

                    <p className="text-sm wrap-break-word text-muted-foreground">{log.subject ?? '—'}</p>

                    <p className="font-mono text-xs break-all text-muted-foreground">
                      {log.recipient ?? '—'}
                    </p>

                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      <Badge tone={log.email_type === 'initial' ? 'primary' : 'neutral'}>
                        {EMAIL_TYPE_LABELS[log.email_type]}
                      </Badge>
                      <span className="tabular text-xs text-muted-foreground">
                        {formatDateTime(log.sent_at ?? log.created_at)}
                      </span>
                    </div>

                    {/*
                      Not truncated here. On the table an error is a hint that
                      something went wrong and the row can be widened; on a
                      phone there is nowhere to widen to, and a clipped error
                      message is the one field where the tail carries the
                      answer.
                    */}
                    {log.error ? (
                      <p className="text-xs wrap-break-word text-danger">{log.error}</p>
                    ) : null}
                  </li>
                ))}
              </ul>

              <div className="hidden md:block">
                <TableWrap>
                  <Table style={{ minWidth: 1000 }}>
                    <THead>
                      <tr>
                        <TH style={{ width: 200 }}>Recipient</TH>
                        <TH style={{ width: 180 }}>Business</TH>
                        <TH style={{ width: 240 }}>Subject</TH>
                        <TH style={{ width: 110 }}>Step</TH>
                        <TH style={{ width: 110 }}>Status</TH>
                        <TH style={{ width: 180 }}>Date</TH>
                        <TH>Error</TH>
                      </tr>
                    </THead>
                    <TBody>
                      {rows.map((log) => (
                        <TR key={log.id}>
                          <TD className="font-mono text-xs">{log.recipient ?? '—'}</TD>
                          <TD>{log.businessName ?? '—'}</TD>
                          <TD>{log.subject ?? '—'}</TD>
                          {/*
                            Which email this was, not which relay carried it. The
                            provider is the same string on every row (one provider is
                            configured at a time), so the column was a constant taking
                            up space, while "was this the first email or a follow-up"
                            is the thing you actually want when reading a send log.
                            The provider is still on the row and in the message id if
                            a delivery ever needs chasing.
                          */}
                          <TD>
                            <Badge tone={log.email_type === 'initial' ? 'primary' : 'neutral'}>
                              {EMAIL_TYPE_LABELS[log.email_type]}
                            </Badge>
                          </TD>
                          <TD>
                            <EmailStatusBadge status={log.status} />
                          </TD>
                          <TD className="tabular text-muted-foreground">
                            {formatDateTime(log.sent_at ?? log.created_at)}
                          </TD>
                          <TD className="text-danger">{log.error ?? ''}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableWrap>
              </div>
            </>
          )}

          {total > 0 ? <LogPagination page={page} pageSize={pageSize} total={total} /> : null}
        </div>
      </div>
    </>
  );
}
