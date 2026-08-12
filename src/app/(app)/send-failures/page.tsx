import { MailWarning, ShieldCheck } from 'lucide-react';

import { PageHeader } from '@/components/shell/app-shell';
import { EmptyState } from '@/components/empty-state';
import { MetricCard } from '@/components/metric-card';
import { FailureReasonBadge, failureReasonLabel } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/table';
import { EMAIL_TYPE_LABELS } from '@/lib/pipeline/labels';
import { requireAdmin } from '@/lib/auth/session';
import { FAILURE_SUMMARY_WINDOW_DAYS, getEmailFailures } from '@/lib/data/misc';
import { parsePageNumber, parsePageSize } from '@/lib/pagination';
import { formatDateTime, formatNumber } from '@/lib/utils';
import { LogPagination } from '../email-logs/log-pagination';

export const metadata = { title: 'Send Failures' };

/**
 * "Whenever an email fails, display why" (0040).
 *
 * Before this page existed, only a genuine SMTP-level rejection ever touched
 * email_logs — sendLeadEmail()'s other eight refusal branches (archived, no
 * email, unverified, no draft, no subject, provider misconfigured, an
 * unresolved placeholder) just returned, leaving no trace anywhere. That is
 * exactly why a bracketed business name could silently block its own lead
 * for days with nothing in the database to find. Every one of those branches
 * now writes a `status='failed'` row with a `failure_reason` code, and this
 * page is where they surface — a "why" summary of the recent past above a
 * full, paginated history, same shape as the Email Logs page it sits under.
 */
export default async function SendFailuresPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; size?: string }>;
}) {
  await requireAdmin();

  const { page: pageParam, size: sizeParam } = await searchParams;
  const page = parsePageNumber(pageParam);
  const pageSize = parsePageSize(sizeParam);

  const { rows, total, summary, error } = await getEmailFailures(page, pageSize);

  return (
    <>
      <PageHeader
        title="Send Failures"
        description={
          total > 0
            ? `${formatNumber(total)} failed send${total === 1 ? '' : 's'} on record, newest first`
            : 'Every refused or rejected send is recorded here, with why'
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        {error ? (
          <p className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger">
            Could not load send failures: {error}
          </p>
        ) : null}

        {/*
          The "why" section. Scoped to the last FAILURE_SUMMARY_WINDOW_DAYS
          (see getEmailFailures) so a cause that was fixed months ago doesn't
          sit at the top forever — the full list below still has everything.
        */}
        <section aria-label="Why sends are failing">
          <h2 className="mb-2 text-xs font-medium text-muted-foreground">
            Why, in the last {FAILURE_SUMMARY_WINDOW_DAYS} days
          </h2>
          {summary.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-subtle px-3 py-2.5 text-sm text-success">
              <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
              Nothing has failed to send in the last {FAILURE_SUMMARY_WINDOW_DAYS} days.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {summary.map((item) => (
                <MetricCard
                  key={item.reason}
                  label={failureReasonLabel(item.reason === 'unknown' ? null : item.reason)}
                  value={formatNumber(item.count)}
                  tone={item.reason === 'archived' ? 'default' : 'danger'}
                />
              ))}
            </div>
          )}
        </section>

        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          {rows.length === 0 ? (
            <EmptyState
              icon={MailWarning}
              title="No failed sends on record"
              description="Every refusal sendLeadEmail() makes — archived, unverified, no draft, misconfigured provider, an unresolved placeholder, or a genuine rejection from the provider — is logged here with why."
            />
          ) : (
            <>
              {/* Two renderings of one list, same reasoning as the Email Logs page: */}
              <ul className="divide-y divide-border md:hidden">
                {rows.map((log) => (
                  <li key={log.id} className="space-y-1.5 px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 wrap-break-word text-sm font-medium">
                        {log.businessName ?? '—'}
                      </span>
                      <FailureReasonBadge reason={log.failure_reason} />
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
                        {formatDateTime(log.created_at)}
                      </span>
                    </div>

                    {log.error ? (
                      <p className="text-xs wrap-break-word text-danger">{log.error}</p>
                    ) : null}
                  </li>
                ))}
              </ul>

              <div className="hidden md:block">
                <TableWrap>
                  <Table style={{ minWidth: 1100 }}>
                    <THead>
                      <tr>
                        <TH style={{ width: 200 }}>Recipient</TH>
                        <TH style={{ width: 180 }}>Business</TH>
                        <TH style={{ width: 240 }}>Subject</TH>
                        <TH style={{ width: 110 }}>Step</TH>
                        <TH style={{ width: 190 }}>Why</TH>
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
                          <TD>
                            <Badge tone={log.email_type === 'initial' ? 'primary' : 'neutral'}>
                              {EMAIL_TYPE_LABELS[log.email_type]}
                            </Badge>
                          </TD>
                          <TD>
                            <FailureReasonBadge reason={log.failure_reason} />
                          </TD>
                          <TD className="tabular text-muted-foreground">{formatDateTime(log.created_at)}</TD>
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
