import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Clock, Mail, MessageSquare } from 'lucide-react';

import { PageHeader } from '@/components/shell/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/empty-state';
import { EmailStatusBadge, SentimentBadge } from '@/components/status-badge';
import { PipelineTracker } from '@/components/pipeline-badge';
import { requireAdmin } from '@/lib/auth/session';
import { getLeadDetail } from '@/lib/data/leads';
import { EMAIL_TYPE_LABELS } from '@/lib/pipeline/labels';
import { formatDateTime, formatRelative, truncate } from '@/lib/utils';
import type { EmailType } from '@/lib/supabase/database.types';
import { EnrichmentDetail, LeadDetail } from './lead-detail';
import { DraftWorkspace } from './draft-workspace';
import { NotesPanel, PersonalizationPanel, ResearchPanel } from './research-panels';
import { PipelinePanel } from './pipeline-panel';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { lead } = await getLeadDetail(id);
  return { title: lead?.business_name ?? 'Lead' };
}

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  // Viewers must never reach this page: it exposes email, research and drafts.
  await requireAdmin();

  const { id } = await params;
  const { lead, pipeline, versions, activity, emailLogs, replies } = await getLeadDetail(id);

  if (!lead) notFound();

  // Which steps have already gone out, so the workspace does not offer to send
  // the same email twice. Derived from the logs rather than from the pipeline
  // so a send recorded by any path counts.
  const sentTypes = [
    ...new Set(
      emailLogs
        .filter((log) => ['sent', 'delivered', 'opened', 'clicked'].includes(log.status))
        .map((log) => log.email_type),
    ),
  ] as EmailType[];

  const timeline = [
    { at: lead.created_at, label: 'Lead created', detail: lead.source ?? 'Manual entry' },
    ...(lead.imported_at ? [{ at: lead.imported_at, label: 'Imported', detail: lead.source ?? '' }] : []),
    ...activity.map((event) => ({
      at: event.created_at,
      label: event.summary,
      detail: event.detail ? truncate(event.detail, 90) : '',
    })),
    ...emailLogs.map((log) => ({
      at: log.sent_at ?? log.created_at,
      label: `${EMAIL_TYPE_LABELS[log.email_type]} ${log.status}`,
      detail: log.subject ?? log.error ?? '',
    })),
    ...replies.map((reply) => ({
      at: reply.received_at,
      label: 'Reply received',
      detail: truncate(reply.reply_text, 80),
    })),
  ]
    .filter((event) => Boolean(event.at))
    .sort((a, b) => new Date(b.at!).getTime() - new Date(a.at!).getTime())
    .slice(0, 25);

  return (
    <>
      <PageHeader
        title={lead.business_name}
        description={[lead.city, lead.country, lead.niche].filter(Boolean).join(' · ') || undefined}
        actions={
          <Link
            href="/leads"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-hover"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to leads
          </Link>
        }
      />

      {/*
        Stage and next step sit above everything else, on every lead. They are
        the two facts that decide what an operator does on this page, so they
        are not something to go looking for in a sidebar.
      */}
      <div className="px-4 pt-4 sm:px-6">
        {pipeline ? (
          <PipelineTracker
            stage={pipeline.current_stage}
            nextStep={pipeline.next_step}
            due={pipeline.followup1_sent ? pipeline.followup2_due : pipeline.followup1_due}
          />
        ) : (
          <p className="rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2.5 text-sm text-warning">
            No pipeline row for this lead yet. It is created automatically on the next edit.
          </p>
        )}
      </div>

      {/*
        `min-w-0` on BOTH columns is what makes this page usable on a phone.

        A grid child defaults to `min-width: auto`, meaning it refuses to shrink
        below its widest unbreakable content. One long draft body, email address
        or generated_by string therefore widened the column, which widened the
        grid past the viewport — and because `main` clips with
        `overflow-x-hidden` rather than scrolling, the right-hand edge of every
        card was cut off and unreachable. The Save / Cancel row sits at
        `justify-end`, so the button you most need was the first thing to
        disappear.

        This is the same trap already documented on the shell's own container in
        components/shell/app-shell.tsx; it just had to be repeated here, because
        every nested grid re-introduces it.
      */}
      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <LeadDetail lead={lead} stage={pipeline?.current_stage ?? null} />
          <ResearchPanel lead={lead} />
          <PersonalizationPanel lead={lead} />
          <DraftWorkspace
            leadId={lead.id}
            versions={versions}
            hasEmail={Boolean(lead.email)}
            sentTypes={sentTypes}
            context={{
              businessName: lead.business_name,
              niche: lead.niche,
              city: lead.city,
              country: lead.country,
            }}
          />
          <NotesPanel lead={lead} />
        </div>

        <div className="min-w-0 space-y-4">
          {pipeline ? <PipelinePanel pipeline={pipeline} /> : null}
          <EnrichmentDetail lead={lead} />

          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3">
                {timeline.map((event, index) => (
                  <li key={`${event.label}-${index}`} className="flex gap-2.5">
                    <div className="flex flex-col items-center">
                      <span
                        className="mt-1 size-1.5 shrink-0 rounded-full bg-border-strong"
                        aria-hidden="true"
                      />
                      {index < timeline.length - 1 ? (
                        <span className="mt-1 w-px flex-1 bg-border" aria-hidden="true" />
                      ) : null}
                    </div>
                    <div className="min-w-0 pb-1">
                      <p className="text-xs font-medium">{event.label}</p>
                      <p className="tabular text-[11px] text-muted-foreground">
                        {formatRelative(event.at)}
                      </p>
                      {event.detail ? (
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {event.detail}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <Card className="min-w-0 lg:col-span-2">
          <CardHeader>
            <CardTitle>Email history</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {emailLogs.length === 0 ? (
              <EmptyState
                icon={Mail}
                title="No emails sent"
                description="Every send attempt is recorded here, including failures."
              />
            ) : (
              <ul className="divide-y divide-border">
                {emailLogs.map((log) => (
                  <li key={log.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                    <EmailStatusBadge status={log.status} />
                    <Badge tone="neutral">{EMAIL_TYPE_LABELS[log.email_type]}</Badge>
                    <span className="min-w-0 flex-1 truncate text-sm">{log.subject ?? '—'}</span>
                    <span className="tabular text-xs text-muted-foreground">
                      {formatDateTime(log.sent_at ?? log.created_at)}
                    </span>
                    {log.error ? <p className="w-full text-xs text-danger">{log.error}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Replies</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {replies.length === 0 ? (
              <EmptyState
                icon={MessageSquare}
                title="No replies yet"
                description="Inbound responses will be captured here once reply ingestion is connected."
              />
            ) : (
              <ul className="divide-y divide-border">
                {replies.map((reply) => (
                  <li key={reply.id} className="px-4 py-3">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <SentimentBadge sentiment={reply.sentiment} />
                      <span className="tabular flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="size-3" aria-hidden="true" />
                        {formatDateTime(reply.received_at)}
                      </span>
                    </div>
                    <p className="text-sm whitespace-pre-line">{reply.reply_text ?? '—'}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
