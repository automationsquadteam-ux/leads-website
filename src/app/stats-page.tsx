import Link from 'next/link';
import {
  Building2, CheckCircle2, FileText, Globe2, LogIn, Mail, MailQuestion, MailX, Search,
  Send, ShieldQuestion, ThumbsDown, ThumbsUp, Timer, TrendingDown, TrendingUp, Users,
} from 'lucide-react';

import { BrandMark } from '@/components/brand';
import { MetricCard } from '@/components/metric-card';
import { BarList, MultiLineChart, type SeriesPoint } from '@/components/charts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/theme-toggle';
import { getPublicStats } from '@/lib/data/public-stats';
import { STAGE_META } from '@/lib/pipeline/labels';
import { formatNumber, formatPercent } from '@/lib/utils';

/**
 * The public front page. No login, no session, no cookies.
 *
 * Safety does not come from this file it comes from the database. Every
 * figure is read with the ANON key, and the only objects granted to `anon` are
 * the six `public_stats_*` views. There is no query here that could return a
 * contact address, a research note or a draft, because the anon role cannot
 * reach the tables holding them.
 *
 * The one place identity can appear is the lead list, and it is off by default:
 * an admin must both enable it and pick which stages may show. Even then the
 * view exposes name, city, country, industry and stage nothing else.
 */

function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export async function PublicStatsPage() {
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

  const sequencePoints: SeriesPoint[] = overview
    ? [
        { label: 'Initial', value: overview.initial_sent },
        { label: 'Follow-up 1', value: overview.followup1_sent },
        { label: 'Follow-up 2', value: overview.followup2_sent },
      ]
    : [];

  // Countries covered is a nice headline figure and costs nothing extra: the
  // public lead list may be empty, so it is derived from what we do have.
  const countries = new Set(data.leads.map((l) => l.country).filter(Boolean)).size;

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <BrandMark size={32} className="rounded-lg" priority />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold tracking-tight">
              Automation Squad
            </span>
            <span className="block text-[11px] text-muted-foreground">Outreach statistics</span>
          </span>
          <ThemeToggle />
          <Link
            href="/login"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-hover"
          >
            <LogIn className="size-4" aria-hidden="true" />
            Sign in
          </Link>
        </div>
      </header>

      <main>
        {/* ---------------------------------------------------------------- */}
        {/* Hero                                                             */}
        {/* ---------------------------------------------------------------- */}
        <section className="border-b border-border bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
            <div className="max-w-2xl">
              <Badge tone="primary" className="mb-4">
                <Globe2 className="size-3" aria-hidden="true" />
                Live pipeline data
              </Badge>
              <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                Cold outreach, measured honestly.
              </h1>
              <p className="mt-3 text-base leading-relaxed text-muted-foreground text-pretty">
                Every figure below is read straight from the live pipeline research completed,
                businesses contacted, replies received. Outreach is counted per business, not per
                message, so a follow-up never inflates the total. Nothing is rounded up and nothing
                is a mock-up. Lead identities and contact details are never published here.
              </p>

              <dl className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
                {[
                  ['Leads tracked', formatNumber(overview?.total_leads ?? 0)],
                  ['Businesses contacted', formatNumber(overview?.leads_contacted ?? 0)],
                  ['Replies', formatNumber(overview?.replies ?? 0)],
                  ['Reply rate', formatPercent(overview?.reply_rate_pct)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                    <dd className="tabular mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
          {data.error ? (
            <p className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger">
              Statistics are unavailable right now: {data.error}
            </p>
          ) : null}

          <section aria-label="Pipeline" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <MetricCard label="Total Leads" value={formatNumber(overview?.total_leads ?? 0)} icon={Users} />
            <MetricCard
              label="Need Email"
              value={formatNumber(overview?.need_email ?? 0)}
              icon={MailQuestion}
            />
            <MetricCard
              label="Dead Address"
              value={formatNumber(overview?.dead_email ?? 0)}
              icon={MailX}
              hint="Proved undeliverable"
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
              label="Initial Approved"
              value={formatNumber(overview?.approved ?? 0)}
              icon={CheckCircle2}
              tone="success"
            />
            {/*
              Businesses reached, not messages sent (0036). One lead in a full
              three-step sequence is three rows in email_logs; publishing that
              as "Emails Sent" described our activity rather than our reach —
              ten businesses read as 25. The raw message count is still in the
              view as `emails_sent` and still drives Bounce Rate, where
              per-message really is the right denominator.
            */}
            <MetricCard
              label="Businesses Contacted"
              value={formatNumber(overview?.leads_contacted ?? 0)}
              hint="Unique businesses emailed at least once"
              icon={Send}
            />
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
                overview && overview.leads_contacted > 0
                  ? `${formatNumber(overview.replies)} of ${formatNumber(overview.leads_contacted)} contacted`
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

          {/*
            Full width, not half of a two-column grid. It lost its neighbour when
            the Status distribution chart was retired, and a half-width card
            beside a hole is worse than a wide one - which this is better as
            anyway, since the stage list is eleven rows long.
          */}
          <section>
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Stage distribution</CardTitle>
                  <CardDescription>Where the pipeline sits right now</CardDescription>
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
          </section>

          {/*
            Opt-in lead list. The view returns nothing unless an admin turned it
            on and picked stages, so this section simply does not render by
            default no empty-state placeholder advertising data we are not
            publishing.
          */}
          {data.leads.length > 0 ? (
            <section>
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle className="flex items-center gap-1.5">
                      <Building2 className="size-3.5 text-muted-foreground" aria-hidden="true" />
                      Selected businesses
                    </CardTitle>
                    <CardDescription>
                      {formatNumber(data.leads.length)} business
                      {data.leads.length === 1 ? '' : 'es'}
                      {countries > 0 ? ` across ${formatNumber(countries)} countr${countries === 1 ? 'y' : 'ies'}` : ''}
                      . Name and location only no contact details.
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="scrollbar-thin overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-xs text-muted-foreground">
                          <th className="px-4 py-2 text-left font-medium">Business</th>
                          <th className="px-4 py-2 text-left font-medium">Location</th>
                          <th className="px-4 py-2 text-left font-medium">Industry</th>
                          <th className="px-4 py-2 text-left font-medium">Stage</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.leads.map((lead, index) => (
                          <tr
                            key={`${lead.business_name}-${index}`}
                            className="border-b border-border last:border-0"
                          >
                            <td className="px-4 py-2.5 font-medium">{lead.business_name}</td>
                            <td className="px-4 py-2.5 text-muted-foreground">
                              {[lead.city, lead.country].filter(Boolean).join(', ') || '—'}
                            </td>
                            <td className="px-4 py-2.5 text-muted-foreground">{lead.industry}</td>
                            <td className="px-4 py-2.5">
                              <Badge tone={STAGE_META[lead.stage]?.tone ?? 'neutral'}>
                                {STAGE_META[lead.stage]?.label ?? lead.stage}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </section>
          ) : null}

        </div>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-6 text-xs text-muted-foreground sm:px-6">
          <BrandMark size={20} className="rounded" />
          <p className="min-w-0 flex-1">
            Aggregate counts only. Contact details, research, drafts and internal notes are never
            exposed on this page and are not readable without an administrator account.
          </p>
          <Link href="/login" className="hover:text-foreground hover:underline">
            Administrator sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}
