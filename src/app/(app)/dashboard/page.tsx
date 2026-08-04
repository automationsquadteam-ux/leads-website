import Link from 'next/link';
import {
  AlertTriangle, CalendarClock, CheckSquare, FileClock, Lock, Mail, MailQuestion,
  RefreshCw, Reply, ShieldQuestion, Sparkles,
} from 'lucide-react';

import { PageHeader } from '@/components/shell/app-shell';
import { EmptyState } from '@/components/empty-state';
import { MetricCard } from '@/components/metric-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { NextStepBadge, StageBadge } from '@/components/pipeline-badge';
import { SentimentBadge } from '@/components/status-badge';
import { getDashboardFeeds, getDashboardWidgets } from '@/lib/data/admin-dashboard';
import { requireUser } from '@/lib/auth/session';
import { formatNumber, formatRelative, truncate } from '@/lib/utils';

export const metadata = { title: 'Dashboard' };

/**
 * What a non-admin sees.
 *
 * Deliberately empty rather than a reduced dashboard: the set of figures a
 * viewer should be allowed to see has not been decided, and defaulting to "show
 * something" is how data leaks. The login-free /stats page is the one place
 * aggregate figures are published on purpose.
 */
function ViewerRestricted() {
  return (
    <>
      <PageHeader title="Dashboard" description="Your account has limited access." />
      <div className="p-4 sm:p-6">
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState
            icon={Lock}
            title="Nothing to show yet"
            description="Reporting for your role has not been configured. Aggregate statistics are published on the public statistics page, which needs no login."
            action={
              <Link
                href="/stats"
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-hover"
              >
                Open public statistics
              </Link>
            }
          />
        </div>
      </div>
    </>
  );
}

/**
 * The admin dashboard is an operations screen, not a report.
 *
 * Every widget answers "what needs a human right now". Trend charts and rate
 * analysis live on /analytics, because mixing the two produces a page that is
 * good at neither.
 */
export default async function DashboardPage() {
  const { isAdmin } = await requireUser();
  if (!isAdmin) return <ViewerRestricted />;

  const [widgets, feeds] = await Promise.all([getDashboardWidgets(), getDashboardFeeds()]);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="What needs attention today."
        actions={
          <Link
            href="/analytics"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-hover"
          >
            Analytics
          </Link>
        }
      />

      <div className="space-y-6 p-4 sm:p-6">
        <section aria-label="Today" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label="Today's Emails" value={formatNumber(widgets.emailsToday)} icon={Mail} />
          <MetricCard
            label="Today's Replies"
            value={formatNumber(widgets.repliesToday)}
            icon={Reply}
            tone={widgets.repliesToday > 0 ? 'success' : 'default'}
          />
          <MetricCard
            label="Approval Queue"
            value={formatNumber(widgets.approvalQueue)}
            hint="Drafted, nobody has signed off"
            icon={CheckSquare}
            tone={widgets.approvalQueue > 0 ? 'warning' : 'default'}
          />
          <MetricCard
            label="Emails Waiting Review"
            value={formatNumber(widgets.awaitingReview)}
            hint="Active versions still marked draft"
            icon={FileClock}
          />
        </section>

        <section aria-label="Due and blocked" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <MetricCard
            label="Follow-up 1 Due Today"
            value={formatNumber(widgets.followup1DueToday)}
            icon={CalendarClock}
          />
          <MetricCard
            label="Follow-up 2 Due Today"
            value={formatNumber(widgets.followup2DueToday)}
            icon={CalendarClock}
          />
          <MetricCard
            label="Overdue Follow-ups"
            value={formatNumber(widgets.overdueFollowups)}
            hint="Due before today, still unsent"
            icon={AlertTriangle}
            tone={widgets.overdueFollowups > 0 ? 'danger' : 'default'}
          />
          <MetricCard
            label="Leads Missing Email"
            value={formatNumber(widgets.missingEmail)}
            icon={MailQuestion}
          />
          <MetricCard
            label="Awaiting Verification"
            value={formatNumber(widgets.awaitingVerification)}
            hint="Address on file, not confirmed"
            icon={ShieldQuestion}
          />
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Approval queue</CardTitle>
                <CardDescription>Oldest drafts waiting on a human</CardDescription>
              </div>
              <Badge tone={widgets.approvalQueue > 0 ? 'warning' : 'neutral'}>
                {formatNumber(widgets.approvalQueue)}
              </Badge>
            </CardHeader>
            <CardContent className="p-0">
              {feeds.approvalQueue.length === 0 ? (
                <EmptyState
                  icon={CheckSquare}
                  title="Nothing waiting"
                  description="Every draft has been reviewed."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {feeds.approvalQueue.map((row) => (
                    <li key={row.lead_id}>
                      <Link
                        href={`/leads/${row.lead_id}`}
                        className="flex flex-wrap items-center gap-2 px-4 py-2.5 hover:bg-surface-hover"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {row.business_name}
                        </span>
                        <StageBadge stage={row.current_stage} />
                        <span className="tabular text-xs text-muted-foreground">
                          {formatRelative(row.draft_ready_at)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Ready to send</CardTitle>
                <CardDescription>Approved or due, waiting on delivery</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {feeds.dueToday.length === 0 ? (
                <EmptyState
                  icon={CalendarClock}
                  title="Nothing due"
                  description="No approved email or follow-up is waiting to go out."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {feeds.dueToday.map((row) => (
                    <li key={row.lead_id}>
                      <Link
                        href={`/leads/${row.lead_id}`}
                        className="flex flex-wrap items-center gap-2 px-4 py-2.5 hover:bg-surface-hover"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {row.business_name}
                        </span>
                        <NextStepBadge step={row.next_step} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Recent activity</CardTitle>
                <CardDescription>What admins changed</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {feeds.recentActivity.length === 0 ? (
                <EmptyState
                  title="No activity yet"
                  description="Edits, approvals and regenerations appear here."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {feeds.recentActivity.map((event) => (
                    <li key={event.id} className="px-4 py-2.5">
                      <Link href={`/leads/${event.lead_id}`} className="block hover:underline">
                        <p className="truncate text-sm">{event.summary}</p>
                      </Link>
                      <p className="tabular mt-0.5 text-xs text-muted-foreground">
                        {event.businessName ?? 'Unknown lead'} · {formatRelative(event.created_at)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Recent replies</CardTitle>
                <CardDescription>Newest inbound responses</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {feeds.recentReplies.length === 0 ? (
                <EmptyState icon={Reply} title="No replies yet" />
              ) : (
                <ul className="divide-y divide-border">
                  {feeds.recentReplies.map((reply) => (
                    <li key={reply.id} className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <SentimentBadge sentiment={reply.sentiment} />
                        <Link
                          href={`/leads/${reply.lead_id}`}
                          className="min-w-0 flex-1 truncate text-sm hover:underline"
                        >
                          {reply.businessName ?? 'Unknown lead'}
                        </Link>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {truncate(reply.reply_text, 140) || '—'}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Recent regenerations</CardTitle>
                <CardDescription>Drafts the generator produced</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {feeds.recentRegenerations.length === 0 ? (
                <EmptyState
                  icon={Sparkles}
                  title="Nothing generated yet"
                  description="Regenerate a draft from any lead to see it here."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {feeds.recentRegenerations.map((version) => (
                    <li key={version.id} className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <RefreshCw className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <Link
                          href={`/leads/${version.lead_id}`}
                          className="min-w-0 flex-1 truncate text-sm hover:underline"
                        >
                          {version.businessName ?? 'Unknown lead'}
                        </Link>
                        <Badge tone="neutral">v{version.version_number}</Badge>
                      </div>
                      <p className="tabular mt-0.5 text-xs text-muted-foreground">
                        {version.generated_by} · {formatRelative(version.created_at)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </>
  );
}
