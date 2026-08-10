import { PageHeader } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { CollapsibleSection } from '@/components/collapsible-section';
import { formatNumber } from '@/lib/utils';
import { requireAdmin } from '@/lib/auth/session';
import { getCronSecret } from '@/lib/env';
import { getSettings, settingsMap } from '@/lib/data/misc';
import { getIntegrationConfig } from '@/lib/services/config';
import { encryptionAvailable, listSecretStatus } from '@/lib/services/secrets';
import { getLatestRuns, reapStaleRuns } from '@/lib/services/integration-runs';
import type { LastRun } from '@/components/integrations/trigger-button';
import { getVerificationCounts } from '@/lib/data/admin-dashboard';
import { AutomationPanel } from './automation-panel';
import { IntegrationsPanel } from './integrations-panel';
import { SettingsForm } from './settings-form';
import { VerificationPanel } from './verification-panel';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  await requireAdmin();

  // Close out any run left hanging by a crash or timeout, so the UI never shows
  // "Running" forever.
  await reapStaleRuns();

  const [{ rows, error }, config, secrets, latestRuns, verification] = await Promise.all([
    getSettings(),
    getIntegrationConfig(),
    listSecretStatus(),
    getLatestRuns(),
    getVerificationCounts(),
  ]);

  const lastRuns: Record<string, LastRun | null> = {};
  for (const [key, run] of Object.entries(latestRuns)) {
    lastRuns[key] = {
      status: run.status,
      message: run.message,
      startedAt: run.started_at,
      durationMs: run.duration_ms,
    };
  }

  // Sensitive rows never reach the client, even for admins.
  const values = Object.fromEntries(settingsMap(rows.filter((row) => !row.is_sensitive)));

  const cronConfigured = getCronSecret() !== null;

  return (
    <>
      <PageHeader
        title="Settings"
        description="Integrations, sending configuration and credentials."
      />

      {/*
        Every section starts collapsed. This page had grown to five panels of
        dense configuration, and scrolling past four of them to reach the fifth
        is not reading, it is hunting. Each header carries a one-line status so
        the closed page still answers "is anything wrong".
      */}
      <div className="space-y-3 p-4 sm:p-6">
        {error ? (
          <p className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger">
            Could not load settings: {error}
          </p>
        ) : null}

        <CollapsibleSection
          title="Integrations"
          description="The email provider, the draft generator, and stored credentials."
          badge={
            <Badge tone={config.email.fromAddress ? 'success' : 'neutral'}>
              {config.email.fromAddress ? `From: ${config.email.fromAddress}` : 'Not configured'}
            </Badge>
          }
        >
          <IntegrationsPanel
            config={config}
            secrets={secrets}
            lastRuns={lastRuns}
            encryptionReady={encryptionAvailable()}
          />
        </CollapsibleSection>

        <CollapsibleSection
          title="Email verification, drafts &amp; follow-ups"
          description="Check addresses, clean drafts, and write follow-ups ahead of time."
          badge={
            <Badge tone={verification.exportable > 0 ? 'warning' : 'success'}>
              {formatNumber(verification.exportable)} to check
            </Badge>
          }
        >
          <VerificationPanel
            counts={verification.counts}
            noAddress={verification.noAddress}
            exportable={verification.exportable}
            inconclusive={verification.inconclusive}
            sentWithoutFollowups={verification.sentWithoutFollowups}
            leadsMissingFollowups={verification.leadsMissingFollowups}
          />
        </CollapsibleSection>

        <CollapsibleSection
          title="Automation"
          description="The scheduled sender and the draft generator."
          badge={
            <Badge
              tone={
                config.sending.paused ? 'danger' : cronConfigured ? 'success' : 'warning'
              }
            >
              {config.sending.paused
                ? 'Paused'
                : cronConfigured
                  ? 'Scheduler live'
                  : 'CRON_SECRET missing'}
            </Badge>
          }
        >
          {/*
            Only whether the secret EXISTS crosses to the client, never its
            value the panel needs to say "configured" or "not configured" and
            nothing more.
          */}
          <AutomationPanel
            config={config}
            lastRuns={lastRuns}
            cronConfigured={cronConfigured}
          />
        </CollapsibleSection>

        {/*
          One <form> with one save button spanning several cards, which is why
          CollapsibleSection uses <details> rather than conditional rendering:
          the inputs stay in the DOM when collapsed, so a section you never
          opened still submits its existing values instead of blanking them.
        */}
        <CollapsibleSection
          title="Sending &amp; content"
          description="Pace, working hours, email identity, the generator, and what the public page shows."
          badge={
            <Badge tone={config.email.fromAddress ? 'neutral' : 'warning'}>
              {config.email.fromAddress || 'No from address'}
            </Badge>
          }
        >
          <SettingsForm values={values} />
        </CollapsibleSection>
      </div>
    </>
  );
}
