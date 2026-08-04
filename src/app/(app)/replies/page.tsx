import { AlertTriangle, Inbox, MailX, MessageSquare } from 'lucide-react';

import { PageHeader } from '@/components/shell/app-shell';
import { MetricCard } from '@/components/metric-card';
import { requireAdmin } from '@/lib/auth/session';
import { getInbox } from '@/lib/data/inbox';
import { formatNumber } from '@/lib/utils';
import { InboxClient } from './inbox-client';

export const metadata = { title: 'Replies' };

export default async function RepliesPage() {
  await requireAdmin();

  const data = await getInbox();

  return (
    <>
      <PageHeader
        title="Replies"
        description="Everything that arrived at the outreach address, and what it was."
      />

      <div className="space-y-4 p-4 sm:p-6">
        {data.error ? (
          <p className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger">
            Could not load the inbox: {data.error}
          </p>
        ) : null}

        <section aria-label="Inbox summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard
            label="Needs Assigning"
            value={formatNumber(data.counts.unmatched)}
            hint="Arrived, no lead attached"
            icon={Inbox}
            tone={data.counts.unmatched > 0 ? 'warning' : 'default'}
          />
          <MetricCard
            label="Replies Awaiting Review"
            value={formatNumber(data.counts.needsReview)}
            icon={MessageSquare}
          />
          <MetricCard
            label="Bounces"
            value={formatNumber(data.counts.bounces)}
            hint="Hard ones mark the address invalid"
            icon={MailX}
            tone={data.counts.bounces > 0 ? 'danger' : 'default'}
          />
          <MetricCard
            label="Auto-replies"
            value={formatNumber(data.counts.autoReplies)}
            hint="Not counted as replies"
            icon={AlertTriangle}
          />
        </section>

        {data.counts.total === 0 ? (
          <div className="rounded-lg border border-border bg-surface px-4 py-8 text-center">
            <p className="text-sm font-medium">Nothing has arrived yet</p>
            <p className="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">
              Inbound mail reaches this page through the Cloudflare Email Worker in{' '}
              <code className="font-mono">cloudflare/email-worker.js</code>, which posts to{' '}
              <code className="font-mono">/api/inbound/reply</code>. Deploy it and set{' '}
              <code className="font-mono">INBOUND_SECRET</code>, then reply to one of your own sent
              emails to test the round trip.
            </p>
          </div>
        ) : (
          <InboxClient
            unmatched={data.unmatched}
            matched={data.matched}
            bounces={data.bounces}
            autoReplies={data.autoReplies}
          />
        )}
      </div>
    </>
  );
}
