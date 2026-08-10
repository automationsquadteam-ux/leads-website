'use client';

import { PlayCircle, Sparkles, TestTube2 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TriggerButton, type LastRun } from '@/components/integrations/trigger-button';
import { runOutreachNow, testDraftGenerator } from '@/lib/actions/integrations';
import type { IntegrationConfig } from '@/lib/services/config';

/**
 * Manual triggers for the two automated pieces.
 *
 * Both call exactly the same functions the cron endpoint does, so what you see
 * here is what the schedule will do not a separate "test mode" that can drift
 * from the real thing.
 */
export function AutomationPanel({
  config,
  lastRuns,
  cronConfigured,
}: {
  config: IntegrationConfig;
  lastRuns: Record<string, LastRun | null>;
  cronConfigured: boolean;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Draft generation</CardTitle>
            <CardDescription>
              Currently using the{' '}
              <strong>{config.ai.provider === 'ollama' ? config.ai.ollamaModel : 'template'}</strong>{' '}
              generator. Change it under Sending &amp; content below.
            </CardDescription>
          </div>
          <Badge tone={config.ai.provider === 'ollama' ? 'violet' : 'neutral'}>
            {config.ai.provider === 'ollama' ? 'Ollama' : 'Template'}
          </Badge>
        </CardHeader>
        <CardContent>
          <TriggerButton
            label="Test generator"
            icon={TestTube2}
            variant="secondary"
            lastRun={lastRuns['ai:test_connection'] ?? null}
            description={
              config.ai.provider === 'ollama'
                ? `Checks that ${config.ai.ollamaUrl} is reachable and ${config.ai.ollamaModel} is pulled.`
                : 'The template generator needs no external service, so this always succeeds.'
            }
            action={testDraftGenerator}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Scheduled sender</CardTitle>
            <CardDescription>
              Sends follow-ups that are due, generating a draft first when none exists.
            </CardDescription>
          </div>
          <Badge tone={config.sending.paused ? 'danger' : config.outreach.autoFollowups ? 'success' : 'neutral'}>
            {config.sending.paused
              ? 'Paused'
              : config.outreach.autoFollowups
                ? 'Follow-ups automatic'
                : 'Manual only'}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TriggerButton
              label="Preview what is due"
              icon={Sparkles}
              variant="secondary"
              lastRun={lastRuns['outreach:dry_run'] ?? null}
              description="Counts the emails a run would send. Sends nothing."
              action={() => runOutreachNow(true)}
            />
            <TriggerButton
              label="Run now"
              icon={PlayCircle}
              lastRun={lastRuns['outreach:send_due'] ?? null}
              description="Sends everything due, ignoring the working-hours window."
              confirmLabel="This sends real email to real people. Continue?"
              action={() => runOutreachNow(false)}
            />
          </div>

          <ScheduleNotice cronConfigured={cronConfigured} />
        </CardContent>
      </Card>
    </div>
  );
}

/** The two scheduled jobs, what they do, and the exact cron entries. */
const SCHEDULED_JOBS: Array<{
  path: string;
  title: string;
  when: string;
  cron: string;
  what: string;
}> = [
  {
    path: '/api/cron/approve-drafts',
    title: 'Clean and approve drafts',
    when: 'Every 4 hours (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)',
    cron: '0 */4 * * *',
    what: 'Identical to the Clean and approve drafts button below. Sends nothing — a draft it cannot fully clean keeps its place in the queue.',
  },
  {
    path: '/api/cron/outreach',
    title: 'Scheduled sender',
    when: 'Every few minutes',
    cron: '*/3 * * * *',
    what: 'Sends follow-ups that are due. Initial emails only while outreach.auto_send_initial is on.',
  },
];

function ScheduleNotice({ cronConfigured }: { cronConfigured: boolean }) {
  return (
    <div className="space-y-2.5 rounded-md border border-border bg-muted px-3 py-2.5 text-xs text-muted-foreground">
      <div>
        <p className="font-medium text-foreground">Running these on a schedule</p>
        <p className="mt-1">
          The website never schedules anything itself a Next.js server can be restarted or scaled
          to zero at any moment, so an in-process timer is not a schedule. Point a cron service
          (cron-job.org, Vercel Cron, schtasks) at each endpoint, sending the secret as a bearer
          token. Set the schedule&apos;s timezone to <strong>Asia/Karachi</strong>, or subtract five
          hours for UTC.
        </p>
        <p className="mt-1">
          Each endpoint answers <strong>202 Accepted</strong> immediately and then does the work,
          because a draft sweep over a full queue outlasts the ~30 second timeout most cron
          services allow. That means <strong>a green tick from your scheduler only says the job
          started</strong> the outcome of every run, success or failure, is the list below.
        </p>
      </div>

      <div className="space-y-2">
        {SCHEDULED_JOBS.map((job) => (
          <div key={job.path} className="min-w-0 rounded border border-border bg-surface px-2.5 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="font-medium text-foreground">{job.title}</span>
              <span className="tabular font-mono text-[11px]">{job.cron}</span>
            </div>
            <p className="mt-0.5">
              {job.when} · {job.what}
            </p>
            <pre className="scrollbar-thin mt-1.5 max-w-full overflow-x-auto whitespace-pre font-mono text-[11px]">
              curl -X POST -H &quot;Authorization: Bearer $CRON_SECRET&quot; https://your-host
              {job.path}
            </pre>
          </div>
        ))}
      </div>

      <p>
        {cronConfigured ? (
          <>
            <span className="text-success">CRON_SECRET is set.</span> All three endpoints are live.
            Every run is recorded below, whether a schedule or a button started it.
          </>
        ) : (
          <>
            <span className="text-warning">CRON_SECRET is not set</span>, so all three endpoints
            answer 503 and every scheduled job is disabled. Add it to the environment and redeploy.
          </>
        )}
      </p>
    </div>
  );
}
