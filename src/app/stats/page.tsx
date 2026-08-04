import Link from 'next/link';
import {
  Ban, CheckCircle2, FileText, Mail, MailQuestion, Search, Send, ShieldQuestion,
  ThumbsDown, ThumbsUp, Timer, TrendingDown, TrendingUp, Users,
} from 'lucide-react';

import { BrandMark } from '@/components/brand';
import { MetricCard } from '@/components/metric-card';
import { BarList, MultiLineChart, STATUS_CHART_COLORS, type SeriesPoint } from '@/components/charts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ThemeToggle } from '@/components/theme-toggle';
import { LEAD_STATUS_LABELS } from '@/components/status-badge';
import { getPublicStats } from '@/lib/data/public-stats';
import { STAGE_META } from '@/lib/pipeline/labels';
import { formatNumber, formatPercent } from '@/lib/utils';

/**
 * The public statistics page. No login, no session, no cookies.
 *
 * What makes this safe is not this file — it is the database. Every figure
 * comes from one of the five `public_stats_*` views (migration 0013), read with
 * the anon key. Those views are the only objects in the schema granted to
 * `anon`, and they contain aggregates exclusively. There is no query I could
 * write here that would return a business name, an email address, a note, a
 * research paragraph or a draft, because the anon role cannot reach the tables
 * that hold them.
 *
 * Campaign names appear, and are the single identifier on the page. They are
 * our own labels for our own campaigns, not prospect data.
 */

export const metadata = {
  title: 'Outreach Statistics',
  description: 'Aggregate performance of the outreach pipeline.',
  robots: { index: false, follow: false },
};

/**
 * Rendered fresh on each request rather than at build time: a statistics page
 * showing figures from the last deploy is worse than no statistics page.
 */
export const dynamic = 'force-dynamic';

function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export default async function PublicStatsPage() {
  const data = await getPublicStats();
  const { overview } = data;

  const emailsSeries: SeriesPoint[] = data.activity.map((row) => ({
    label: row.day,
    value: row.emails_sent,
  }));
  const repliesSeries: SeriesPoint[] = data.activity.map((row) => ({
    label: row.day,
    value: row.replies,
  }));

  const stagePoints: SeriesPoint[] = data.stages.map((row) => ({
    label: STAGE_META[row.stage]?.label ?? row.stage,
    value: row.lead_count,
  }));

  const statusPoints: SeriesPoint[] = data.statuses.map((row) => ({
    label: LEAD_STATUS_LABELS[row.status] ?? row.status,
    value: row.lead_count,
  }));

  const sequencePoints: SeriesPoint[] = overview
    ? [
        { label: 'Initial', value: overview.initial_sent },
        { label: 'Follow-up 1', value: overview.followup1_sent },
        { label: 'Follow-up 2', value: overview.followup2_sent },
      ]
    : [];

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-4 sm:px-6">
          <BrandMark size={40} className="rounded-lg" priority />
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold tracking-tight">
              Automation Squad — Outreach Statistics
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Aggregate performance of the cold-outreach pipeline. No lead or contact details are
              published here.
            </p>
          </div>
          <ThemeToggle />
          <Link
            href="/dashboard"
            className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-hover"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
        {data.error ? (
          <p className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger">
            Statistics are unavailable right now: {data.error}
          </p>
        ) : null}

        <section aria-label="Pipeline" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label="Total Leads" value={formatNumber(overview?.total_leads ?? 0)} icon={Users} />
          <MetricCard
            label="Need Email"
            value={formatNumber(overview?.need_email ?? 0)}
            icon={MailQuestion}
          />
          <MetricCard
            label="Need Verification"
            value={formatNumber(overview?.need_verification ?? 0)}
            icon={ShieldQuestion}
          />
          <MetricCard
            label="Researching"
            value={formatNumber(overview?.researching ?? 0)}
            icon={Search}
          />
          <MetricCard
            label="Draft Ready"
            value={formatNumber(overview?.draft_ready ?? 0)}
            hint="Awaiting review"
            icon={FileText}
          />
          <MetricCard
            label="Approved"
            value={formatNumber(overview?.approved ?? 0)}
            icon={CheckCircle2}
            tone="success"
          />
          <MetricCard label="Emails Sent" value={formatNumber(overview?.emails_sent ?? 0)} icon={Send} />
          <MetricCard
            label="Replies"
            value={formatNumber(overview?.replies ?? 0)}
            icon={Mail}
            tone={(overview?.replies ?? 0) > 0 ? 'success' : 'default'}
          />
        </section>

        <section aria-label="Rates" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <MetricCard
            label="Positive Replies"
            value={formatNumber(overview?.positive_replies ?? 0)}
            icon={ThumbsUp}
            tone={(overview?.positive_replies ?? 0) > 0 ? 'success' : 'default'}
          />
          <MetricCard
            label="Negative Replies"
            value={formatNumber(overview?.negative_replies ?? 0)}
            icon={ThumbsDown}
          />
          <MetricCard
            label="Reply Rate"
            value={formatPercent(overview?.reply_rate_pct)}
            hint={
              overview && overview.emails_sent > 0
                ? `${formatNumber(overview.replies)} of ${formatNumber(overview.emails_sent)}`
                : 'No sends yet'
            }
            icon={TrendingUp}
            tone={(overview?.reply_rate_pct ?? 0) >= 5 ? 'success' : 'default'}
          />
          <MetricCard
            label="Bounce Rate"
            value={formatPercent(overview?.bounce_rate_pct)}
            hint={
              overview && overview.emails_attempted > 0
                ? `${formatNumber(overview.emails_bounced)} of ${formatNumber(overview.emails_attempted)}`
                : 'No sends yet'
            }
            icon={TrendingDown}
            tone={(overview?.bounce_rate_pct ?? 0) > 5 ? 'danger' : 'default'}
          />
          <MetricCard
            label="Avg Response Time"
            value={formatHours(overview?.avg_response_hours)}
            hint="Send to reply"
            icon={Timer}
          />
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <div>
                <CardTitle>Activity</CardTitle>
                <CardDescription>Emails sent and replies received, last 90 days</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <MultiLineChart
                caption="Emails sent and replies received per day"
                series={[
                  { label: 'Emails sent', color: 'var(--primary)', points: emailsSeries },
                  { label: 'Replies', color: 'var(--success)', points: repliesSeries },
                ]}
                emptyMessage="No sending activity in the last 90 days."
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Sequence volume</CardTitle>
                <CardDescription>How far the sequence reaches</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <BarList
                points={sequencePoints}
                caption="Emails sent per sequence step"
                colorFor={() => 'var(--primary)'}
                emptyMessage="No emails sent yet."
              />
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Stage distribution</CardTitle>
                <CardDescription>Where the pipeline sits</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <BarList
                points={stagePoints}
                caption="Leads by pipeline stage"
                colorFor={() => 'var(--violet)'}
                emptyMessage="No leads yet."
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Status distribution</CardTitle>
                <CardDescription>Lead status across the whole list</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <BarList
                points={statusPoints}
                caption="Leads by status"
                colorFor={(label) => STATUS_CHART_COLORS[label] ?? 'var(--primary)'}
                emptyMessage="No leads yet."
              />
            </CardContent>
          </Card>
        </section>

        <section>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Campaign performance</CardTitle>
                <CardDescription>Counts and rates per campaign</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {data.campaigns.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No campaigns have run yet.
                </p>
              ) : (
                <div className="scrollbar-thin overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        <th className="px-4 py-2 text-left font-medium">Campaign</th>
                        <th className="px-4 py-2 text-left font-medium">Status</th>
                        <th className="px-4 py-2 text-right font-medium">Leads</th>
                        <th className="px-4 py-2 text-right font-medium">Sent</th>
                        <th className="px-4 py-2 text-right font-medium">Replies</th>
                        <th className="px-4 py-2 text-right font-medium">Reply rate</th>
                        <th className="px-4 py-2 text-right font-medium">Bounce rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.campaigns.map((row) => (
                        <tr key={row.campaign_name} className="border-b border-border last:border-0">
                          <td className="px-4 py-2.5 font-medium">{row.campaign_name}</td>
                          <td className="px-4 py-2.5 text-muted-foreground">
                            {row.active ? 'Running' : 'Paused'}
                          </td>
                          <td className="tabular px-4 py-2.5 text-right">
                            {formatNumber(row.leads_assigned)}
                          </td>
                          <td className="tabular px-4 py-2.5 text-right">
                            {formatNumber(row.emails_sent)}
                          </td>
                          <td className="tabular px-4 py-2.5 text-right">
                            {formatNumber(row.replies_received)}
                          </td>
                          <td className="tabular px-4 py-2.5 text-right">
                            {formatPercent(row.reply_rate_pct)}
                          </td>
                          <td className="tabular px-4 py-2.5 text-right">
                            {formatPercent(row.bounce_rate_pct)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <footer className="flex items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
          <Ban className="size-3.5 shrink-0" aria-hidden="true" />
          <p>
            This page publishes aggregate counts only. Contact details, business names, research,
            drafts and notes are never exposed here and are not readable without an administrator
            account.
          </p>
        </footer>
      </main>
    </div>
  );
}
