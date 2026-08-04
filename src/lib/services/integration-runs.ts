import 'server-only';

import { createServiceClient } from '@/lib/supabase/service-client';
import type { IntegrationRun, Json } from '@/lib/supabase/database.types';

/**
 * Run bookkeeping for every integration invocation.
 *
 * Persisted rather than kept in memory so "Running / Success / Failed / Last
 * run" survives a reload or redeploy, and so a scheduled job running outside
 * any browser session records its outcome the same way.
 *
 * Written with the service-role client: the caller has already passed
 * assertAdmin(), and a run must still be closed out even if the user's session
 * expires mid-request.
 */

export type IntegrationName = 'google_sheets' | 'email' | 'outreach' | 'ai';

export async function startRun(
  integration: IntegrationName,
  action: string,
  userId?: string,
): Promise<string | null> {
  const admin = createServiceClient();
  const { data, error } = await admin
    .from('integration_runs')
    .insert({ integration, action, status: 'running', triggered_by: userId ?? null })
    .select('id')
    .single();

  // A failure to record the run must not block the work itself.
  if (error || !data) return null;
  return data.id;
}

export async function finishRun(
  runId: string | null,
  status: 'success' | 'failed',
  message: string,
  stats: Record<string, unknown> = {},
): Promise<void> {
  if (!runId) return;

  const admin = createServiceClient();
  const { data: existing } = await admin
    .from('integration_runs')
    .select('started_at')
    .eq('id', runId)
    .maybeSingle();

  const startedAt = existing?.started_at ? new Date(existing.started_at).getTime() : Date.now();
  const finishedAt = new Date();

  await admin
    .from('integration_runs')
    .update({
      status,
      // Postgres text has no practical limit, but there is no reason to store a
      // multi-megabyte stack trace from a misbehaving endpoint.
      message: message.slice(0, 2000),
      stats: stats as Json,
      finished_at: finishedAt.toISOString(),
      duration_ms: Math.max(0, finishedAt.getTime() - startedAt),
    })
    .eq('id', runId);
}

/** Most recent run per integration, for the status chips on the settings page. */
export async function getLatestRuns(): Promise<Record<string, IntegrationRun>> {
  const admin = createServiceClient();
  const { data } = await admin
    .from('integration_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(60);

  const latest: Record<string, IntegrationRun> = {};
  for (const run of data ?? []) {
    const key = `${run.integration}:${run.action}`;
    if (!latest[key]) latest[key] = run;
  }
  return latest;
}

export async function getRecentRuns(limit = 15): Promise<IntegrationRun[]> {
  const admin = createServiceClient();
  const { data } = await admin
    .from('integration_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}

/**
 * Close out runs that were left 'running' a crash, a redeploy mid-request, or
 * a serverless timeout. Without this the UI would show "Running" forever.
 */
export async function reapStaleRuns(olderThanMinutes = 15): Promise<void> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const admin = createServiceClient();
  await admin
    .from('integration_runs')
    .update({
      status: 'failed',
      message: 'Run did not report a result (timed out or the process was interrupted).',
      finished_at: new Date().toISOString(),
    })
    .eq('status', 'running')
    .lt('started_at', cutoff);
}
