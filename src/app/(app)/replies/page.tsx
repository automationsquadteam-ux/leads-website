import Link from 'next/link';
import { MessageSquare } from 'lucide-react';

import { PageHeader } from '@/components/shell/app-shell';
import { EmptyState } from '@/components/empty-state';
import { SentimentBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { requireAdmin } from '@/lib/auth/session';
import { getReplies } from '@/lib/data/misc';
import { formatDateTime, formatNumber, truncate } from '@/lib/utils';

export const metadata = { title: 'Replies' };

export default async function RepliesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await requireAdmin();

  const { page: pageParam } = await searchParams;
  const parsed = Number.parseInt(pageParam ?? '1', 10);
  const page = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;

  const { rows, total, error } = await getReplies(page);

  return (
    <>
      <PageHeader
        title="Replies"
        description={
          total > 0
            ? `${formatNumber(total)} repl${total === 1 ? 'y' : 'ies'} received`
            : 'Inbound responses from prospects'
        }
      />

      <div className="p-4 sm:p-6">
        {error ? (
          <p className="mb-3 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger">
            Could not load replies: {error}
          </p>
        ) : null}

        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          {rows.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="No replies yet"
              description="Reply ingestion is not connected. Once inbound mail is wired up, responses appear here with a sentiment classification."
            />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((reply) => (
                <li key={reply.id} className="px-4 py-3.5 transition-colors hover:bg-surface-hover">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <Link
                      href={`/leads/${reply.lead_id}`}
                      className="text-sm font-medium hover:text-primary hover:underline"
                    >
                      {reply.businessName ?? 'Unknown business'}
                    </Link>
                    <SentimentBadge sentiment={reply.sentiment} />
                    {!reply.is_handled ? <Badge tone="warning">Needs review</Badge> : null}
                    <div className="flex-1" />
                    <span className="tabular text-xs text-muted-foreground">
                      {formatDateTime(reply.received_at)}
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {truncate(reply.reply_text, 260) || '—'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
