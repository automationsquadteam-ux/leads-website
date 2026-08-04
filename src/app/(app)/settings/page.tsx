import { PageHeader } from '@/components/shell/app-shell';
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

  return (
    <>
      <PageHeader
        title="Settings"
        description="Integrations, sending configuration and credentials."
      />

      <div className="space-y-8 p-4 sm:p-6">
        {error ? (
          <p className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger">
            Could not load settings: {error}
          </p>
        ) : null}

        <section>
          <h2 className="mb-3 text-sm font-semibold">Integrations</h2>
          <IntegrationsPanel
            config={config}
            secrets={secrets}
            lastRuns={lastRuns}
            encryptionReady={encryptionAvailable()}
          />
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold">Email verification &amp; follow-ups</h2>
          <VerificationPanel
            counts={verification.counts}
            sentWithoutFollowups={verification.sentWithoutFollowups}
          />
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold">Automation</h2>
          {/*
            Only whether the secret EXISTS crosses to the client, never its
            value the panel needs to say "configured" or "not configured" and
            nothing more.
          */}
          <AutomationPanel
            config={config}
            lastRuns={lastRuns}
            cronConfigured={getCronSecret() !== null}
          />
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold">Sending &amp; content</h2>
          <SettingsForm values={values} />
        </section>
      </div>
    </>
  );
}
