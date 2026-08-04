import { Mail } from 'lucide-react';

import { PageHeader } from '@/components/shell/app-shell';
import { EmptyState } from '@/components/empty-state';
import { EmailStatusBadge } from '@/components/status-badge';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/table';
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
              description="Email delivery is not connected. Once the sending worker runs, every attempt delivered, bounced or failed is logged here with its provider message id."
            />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <tr>
                    <TH>Recipient</TH>
                    <TH>Business</TH>
                    <TH>Subject</TH>
                    <TH>Status</TH>
                    <TH>Provider</TH>
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
                      <TD>
                        <EmailStatusBadge status={log.status} />
                      </TD>
                      <TD className="text-muted-foreground">{log.provider ?? '—'}</TD>
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
