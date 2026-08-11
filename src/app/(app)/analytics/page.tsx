import { Clock, Hourglass, PenLine, Timer } from 'lucide-react';

import { PageHeader } from '@/components/shell/app-shell';
import { MetricCard } from '@/components/metric-card';
import { BarList, MultiLineChart, type SeriesPoint } from '@/components/charts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { requireAdmin } from '@/lib/auth/session';
import { getAnalytics } from '@/lib/data/analytics';
import { EMAIL_TYPE_LABELS, STAGE_META } from '@/lib/pipeline/labels';
import { formatNumber, formatPercent } from '@/lib/utils';
import { VolumeChart } from './volume-chart';

export const metadata = { title: 'Analytics' };

/** Hours are the storage unit; days read better once you are past two of them. */
function formatDuration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/**
 * Analytics.
 *
 * Every figure on this page comes from an `analytics_*` or `dashboard_*` view.
 * Nothing is aggregated in TypeScript that is what keeps a rate on this page
 * identical to the same rate on the dashboard.
 */
export default async function AnalyticsPage() {
  await requireAdmin();

  const data = await getAnalytics();

  const dailyVolume: SeriesPoint[] = data.emailDaily.map((row) => ({
    label: row.day,
    value: row.sent ?? 0,
  }));
  const weeklyVolume: SeriesPoint[] = data.emailWeekly.map((row) => ({
    label: row.week_start,
    value: row.sent ?? 0,
  }));
  const monthlyVolume: SeriesPoint[] = data.emailMonthly.map((row) => ({
    label: row.month_start,
    value: row.sent ?? 0,
  }));

  const sentSeries: SeriesPoint[] = data.replyRate.map((row) => ({
    label: row.day,
    value: row.sent ?? 0,
  }));
  const replySeries: SeriesPoint[] = data.replyRate.map((row) => ({
    label: row.day,
    value: row.replies ?? 0,
  }));

  const stagePoints: SeriesPoint[] = data.stages.map((row) => ({
    label: STAGE_META[row.stage]?.label ?? row.stage,
    value: row.lead_count,
  }));

  /*
   * analytics_generation_daily returns one row per (day, generator), so the
   * days have to be unioned before they can be plotted — a generator that was
   * idle on a day has no row at all rather than a zero.
   */
  const generators = [...new Set(data.generation.map((row) => row.generated_by))].slice(0, 4);
  const generationSeries = generators.map((generator, index) => ({
    label: generator,
    color: ['var(--primary)', 'var(--violet)', 'var(--success)', 'var(--info)'][index] ?? 'var(--primary)',
    points: data.generation
      .filter((row) => row.generated_by === generator)
      .map((row) => ({ label: row.day, value: row.versions_created })),
  }));

  const generatorTotals = new Map<string, number>();
  for (const row of data.generation) {
    generatorTotals.set(
      row.generated_by,
      (generatorTotals.get(row.generated_by) ?? 0) + row.versions_created,
    );
  }
  const generatorPoints: SeriesPoint[] = [...generatorTotals.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  const industryPoints: SeriesPoint[] = data.industries
    .slice(0, 10)
    .map((row) => ({ label: row.industry, value: row.leads }));

  return (
    <>
      <PageHeader title="Analytics" description="How the pipeline is actually performing." />

      <div className="space-y-6 p-4 sm:p-6">
        {data.error ? (
          <p className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger">
            Could not load analytics: {data.error}
          </p>
        ) : null}

        <section aria-label="Funnel timing" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard
            label="Avg Initial Approval Time"
            value={formatDuration(data.timing?.avg_approval_hours)}
            hint={
              data.timing?.approved_sample
                ? `${formatNumber(data.timing.approved_sample)} approved`
                : 'No approvals yet'
            }
            icon={Clock}
          />
          <MetricCard
            label="Avg Send Delay"
            value={formatDuration(data.timing?.avg_send_delay_hours)}
            hint={
              data.timing?.sent_sample
                ? `${formatNumber(data.timing.sent_sample)} sent after approval`
                : 'No sends yet'
            }
            icon={Timer}
          />
          <MetricCard
            label="Avg Time to Reply"
            value={formatDuration(data.timing?.avg_reply_hours)}
            hint="From the first email to the response"
            icon={Hourglass}
          />
          <MetricCard
            label="Avg Drafting Time"
            value={formatDuration(data.timing?.avg_drafting_hours)}
            hint="Research complete to draft ready"
            icon={PenLine}
          />
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Emails sent</CardTitle>
                <CardDescription>Volume over time</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <VolumeChart daily={dailyVolume} weekly={weeklyVolume} monthly={monthlyVolume} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Reply rate over time</CardTitle>
                <CardDescription>Sends and replies on one scale, last 90 days</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <MultiLineChart
                caption="Emails sent and replies received per day"
                series={[
                  { label: 'Sent', color: 'var(--primary)', points: sentSeries },
                  { label: 'Replies', color: 'var(--success)', points: replySeries },
                ]}
                emptyMessage="No sending activity in the last 90 days."
              />
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Follow-up conversion</CardTitle>
                <CardDescription>Reply rate per step of the sequence</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full min-w-[380px] text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">Step</th>
                    <th className="px-4 py-2 text-right font-medium">Sent</th>
                    <th className="px-4 py-2 text-right font-medium">Replies</th>
                    <th className="px-4 py-2 text-right font-medium">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.followups.map((row) => (
                    <tr key={row.step} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 font-medium">{EMAIL_TYPE_LABELS[row.step]}</td>
                      <td className="tabular px-4 py-2.5 text-right">{formatNumber(row.sent)}</td>
                      <td className="tabular px-4 py-2.5 text-right">{formatNumber(row.replies)}</td>
                      <td className="tabular px-4 py-2.5 text-right">
                        {formatPercent(row.reply_rate_pct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Stage distribution</CardTitle>
                <CardDescription>Where every lead sits right now</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <BarList
                points={stagePoints}
                caption="Leads by pipeline stage"
                colorFor={() => 'var(--violet)'}
                emptyMessage="No pipeline rows yet."
              />
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Top performing industries</CardTitle>
                <CardDescription>Reply rate by vertical</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="scrollbar-thin overflow-x-auto">
                <table className="w-full min-w-[380px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="px-4 py-2 text-left font-medium">Industry</th>
                      <th className="px-4 py-2 text-right font-medium">Leads</th>
                      <th className="px-4 py-2 text-right font-medium">Sent</th>
                      <th className="px-4 py-2 text-right font-medium">Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.industries.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-4 py-6 text-center text-xs text-muted-foreground">
                          No leads yet.
                        </td>
                      </tr>
                    ) : (
                      data.industries.map((row) => (
                        <tr key={row.industry} className="border-b border-border last:border-0">
                          <td className="px-4 py-2.5 font-medium">{row.industry}</td>
                          <td className="tabular px-4 py-2.5 text-right">{formatNumber(row.leads)}</td>
                          <td className="tabular px-4 py-2.5 text-right">
                            {formatNumber(row.emails_sent)}
                          </td>
                          <td className="tabular px-4 py-2.5 text-right">
                            {formatPercent(row.reply_rate_pct)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Largest verticals</CardTitle>
                <CardDescription>By lead count</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <BarList
                points={industryPoints}
                caption="Leads by industry"
                colorFor={() => 'var(--info)'}
                emptyMessage="No leads yet."
              />
            </CardContent>
          </Card>
        </section>

        {/*
          Draft output, from analytics_generation_daily. The view has always been
          queried and never rendered — this row exists partly because removing
          the campaign and template cards left the grid lopsided, and the honest
          way to fill a gap is with a figure that was already being fetched
          rather than a chart invented to occupy space.
        */}
        <section className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Drafts written</CardTitle>
                <CardDescription>Versions created per day, by generator</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <MultiLineChart series={generationSeries} caption="Draft versions created per day" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Who wrote the drafts</CardTitle>
                <CardDescription>Versions per generator, all time in view</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <BarList
                points={generatorPoints}
                caption="Draft versions by generator"
                colorFor={() => 'var(--primary)'}
                emptyMessage="No drafts generated yet."
              />
            </CardContent>
          </Card>
        </section>
      </div>
    </>
  );
}
