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
 * here is what the schedule will do — not a separate "test mode" that can drift
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

          <div className="rounded-md border border-border bg-muted px-3 py-2.5 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Running this on a schedule</p>
            <p className="mt-1">
              The website never schedules anything itself — a Next.js server can be restarted or
              scaled to zero at any moment, so an in-process timer is not a schedule. Point any cron
              service at the endpoint instead:
            </p>
            <pre className="mt-1.5 overflow-x-auto rounded border border-border bg-surface px-2 py-1.5 font-mono text-[11px]">
              curl -X POST -H &quot;Authorization: Bearer $CRON_SECRET&quot; https://your-host/api/cron/outreach
            </pre>
            <p className="mt-1.5">
              {cronConfigured ? (
                <>
                  <span className="text-success">CRON_SECRET is set.</span> The endpoint is live.
                </>
              ) : (
                <>
                  <span className="text-warning">CRON_SECRET is not set</span>, so the endpoint
                  answers 503 and scheduled sending is disabled. Add it to the environment and
                  redeploy.
                </>
              )}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
