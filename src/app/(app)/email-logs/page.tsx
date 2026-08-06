import { Mail } from 'lucide-react';

import { PageHeader } from '@/components/shell/app-shell';
import { EmptyState } from '@/components/empty-state';
import { EmailStatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/table';
import { EMAIL_TYPE_LABELS } from '@/lib/pipeline/labels';
import { requireAdmin } from '@/lib/auth/session';
import { getEmailLogs } from '@/lib/data/misc';
import { formatDateTime, formatNumber } from '@/lib/utils';

export const metadata = { title: 'Email Logs' };

export default async function EmailLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await requireAdmin();

  const { page: pageParam } = await searchParams;
  const parsed = Number.parseInt(pageParam ?? '1', 10);
  const page = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;

  const { rows, total, error } = await getEmailLogs(page);

  return (
    <>
      <PageHeader
        title="Email Logs"
        description={
          total > 0
            ? `${formatNumber(total)} send attempt${total === 1 ? '' : 's'} recorded`
            : 'Every send attempt is recorded here'
        }
      />

      <div className="p-4 sm:p-6">
        {error ? (
          <p className="mb-3 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger">
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
            <TableWrap>
              <Table>
                <THead>
                  <tr>
                    <TH>Recipient</TH>
                    <TH>Business</TH>
                    <TH>Subject</TH>
                    <TH>Step</TH>
                    <TH>Status</TH>
                    <TH>Date</TH>
                    <TH>Error</TH>
                  </tr>
                </THead>
                <TBody>
                  {rows.map((log) => (
                    <TR key={log.id}>
                      <TD className="font-mono text-xs">{log.recipient ?? '—'}</TD>
                      <TD>{log.businessName ?? '—'}</TD>
                      <TD className="max-w-[280px] truncate">{log.subject ?? '—'}</TD>
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
                      <TD className="max-w-[240px] truncate text-danger">{log.error ?? ''}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </div>
      </div>
    </>
  );
}
