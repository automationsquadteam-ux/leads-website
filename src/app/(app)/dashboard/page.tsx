import Link from 'next/link';
import {
  AlertTriangle, CalendarClock, CheckSquare, Lock, Mail, MailQuestion,
  MailX, PenLine, RefreshCw, Reply, Search, Send, ShieldQuestion, Sparkles,
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
        {/*
          Every figure here links to the exact rows it counted. The named views
          in lib/data/leads.ts are what keep the count and the list in
          agreement a card reading 114 that opens a page of 97 is worse than
          no card at all.
        */}
        <section aria-label="Today" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <MetricCard
            label="Today's Emails"
            value={formatNumber(widgets.emailsToday)}
            icon={Mail}
            href="/email-logs"
          />
          <MetricCard
            label="Today's Replies"
            value={formatNumber(widgets.repliesToday)}
            icon={Reply}
            tone={widgets.repliesToday > 0 ? 'success' : 'default'}
            href="/replies"
          />
          {/*
            "Emails Waiting Review" used to sit here counting active draft
            versions. It was the same leads as the Approval Queue plus the
            follow-up drafts, so the two cards described one queue and neither
            said which. Follow-ups are reviewed on the lead page, in the thread
            they belong to.
          */}
          <MetricCard
            label="Initial Approval Queue"
            value={formatNumber(widgets.approvalQueue)}
            hint="Initial draft written, nobody has signed it off"
            icon={CheckSquare}
            tone={widgets.approvalQueue > 0 ? 'warning' : 'default'}
            href="/leads?view=approval_queue"
          />
        </section>

        <section aria-label="Due and blocked" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <MetricCard
            label="Follow-up 1 Due Today"
            value={formatNumber(widgets.followup1DueToday)}
            icon={CalendarClock}
            href="/leads?view=followup1_due"
          />
          <MetricCard
            label="Follow-up 2 Due Today"
            value={formatNumber(widgets.followup2DueToday)}
            icon={CalendarClock}
            href="/leads?view=followup2_due"
          />
          <MetricCard
            label="Overdue Follow-ups"
            value={formatNumber(widgets.overdueFollowups)}
            hint="Due before today, still unsent"
            icon={AlertTriangle}
            tone={widgets.overdueFollowups > 0 ? 'danger' : 'default'}
            href="/leads?view=overdue_followups"
          />
        </section>

        {/*
          The address gates, in the order a lead has to clear them. Every one of
          these is a stage count, so the number and the page it opens are the
          same query.
        */}
        <section aria-label="Addresses" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard
            label="Leads Missing Email"
            value={formatNumber(widgets.missingEmail)}
            hint="No address to send to"
            icon={MailQuestion}
            href="/leads?view=missing_email"
          />
          <MetricCard
            label="Dead Addresses"
            value={formatNumber(widgets.invalidEmail)}
            hint="Verified undeliverable need a new source"
            icon={MailX}
            tone={widgets.invalidEmail > 0 ? 'danger' : 'default'}
            href="/leads?view=invalid_email"
          />
          <MetricCard
            label="Awaiting Verification"
            value={formatNumber(widgets.awaitingVerification)}
            hint="Address on file, never checked"
            icon={ShieldQuestion}
            href="/leads?view=awaiting_verification"
          />
          <MetricCard
            label="Checked, Inconclusive"
            value={formatNumber(widgets.inconclusive)}
            hint="Catch-all or unknown a re-run proves nothing"
            icon={ShieldQuestion}
            tone={widgets.inconclusive > 0 ? 'warning' : 'default'}
            href="/leads?view=inconclusive"
          />
        </section>

        <section aria-label="Pipeline work" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <MetricCard
            label="Needs Research"
            value={formatNumber(widgets.needsResearch)}
            hint="Verified, nothing written yet"
            icon={Search}
            href="/leads?view=needs_research"
          />
          <MetricCard
            label="Needs Draft"
            value={formatNumber(widgets.needsDraft)}
            hint="Research done, no draft"
            icon={PenLine}
            href="/leads?view=needs_draft"
          />
          <MetricCard
            label="Ready to Send"
            value={formatNumber(widgets.readyToSend)}
            hint="Emails Verified and initial approved, not yet sent"
            icon={Send}
            tone={widgets.readyToSend > 0 ? 'success' : 'default'}
            href="/leads?view=ready_to_send"
          />
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Initial approval queue</CardTitle>
                <CardDescription>Oldest initial drafts waiting on a human</CardDescription>
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
                <CardTitle>Send queue</CardTitle>
                {/*
                  Not "what the sender would act on next" any more ,that read
                  as a preview, but it was sorted by when each lead's INITIAL
                  draft was approved (a timestamp that never updates again),
                  so a follow-up waiting weeks could show below a brand-new
                  initial candidate. This is now the real order: follow-up 2s
                  due, then follow-up 1s due, then initial sends by verifier
                  tier ,the exact three-part order the scheduler itself uses.
                  Empty here with a healthy Approval Queue above means the
                  hold-up IS the Approval Queue, not a bug in the sender.
                */}
                <CardDescription>In the order it will actually be sent</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {feeds.sendQueue.length === 0 ? (
                <EmptyState
                  icon={CalendarClock}
                  title="Nothing due"
                  description="Nothing is verifiably ready to send right now. If leads are waiting, look at Approval Queue above ,that is the usual reason this is empty."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {feeds.sendQueue.map((row, index) => (
                    <li key={row.lead_id}>
                      <Link
                        href={`/leads/${row.lead_id}`}
                        className="flex flex-wrap items-center gap-2 px-4 py-2.5 hover:bg-surface-hover"
                      >
                        <span className="tabular w-5 shrink-0 text-xs text-muted-foreground">
                          {index + 1}
                        </span>
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
