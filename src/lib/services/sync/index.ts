import 'server-only';

import { createServiceClient } from '@/lib/supabase/service-client';
import type { EmailType } from '@/lib/supabase/database.types';
import { GoogleSheetTarget } from './google-sheet-target';
import type { SyncField, SyncReport, SyncSnapshot, SyncTarget } from './types';

export type { SyncField, SyncReport, SyncSnapshot, SyncTarget, SyncOutcome } from './types';
export { ALL_SYNC_FIELDS } from './types';

/**
 * Outbound synchronisation — one call, N targets.
 *
 * Every admin change that must leave the CRM (research, personalization, a
 * draft, status, stage, notes) goes through `syncLeadChange()`. Actions never
 * talk to a target directly, so:
 *
 *   * adding a destination is a new SyncTarget plus one line in TARGETS below;
 *   * "did this change need pushing?" is decided once, not per call site;
 *   * a target that is off, or unreachable, cannot make the database write
 *     that preceded it look like it failed.
 *
 * The CRM is the system of record. Sync is best-effort by design — but never
 * silent: the outcome comes back in the report and ends up in the toast.
 *
 * ── Adding an API target later ────────────────────────────────────────────
 * Implement SyncTarget: `isEnabled()` reads its own setting, `push()` receives
 * the resolved snapshot and returns an outcome. Register it in TARGETS. No
 * caller changes. The snapshot already carries the lead, the pipeline row, the
 * derived next step and the active draft for each step, which is everything an
 * outbound webhook would want to send.
 */

const TARGETS: SyncTarget[] = [new GoogleSheetTarget()];

/**
 * Resolve everything the targets need in one pass.
 *
 * Reads through the service-role client: callers have already passed
 * assertAdmin(), and the scheduled sender has no user session at all.
 */
export async function buildSyncSnapshot(leadId: string): Promise<SyncSnapshot | null> {
  const admin = createServiceClient();

  const { data: lead } = await admin.from('leads').select('*').eq('id', leadId).maybeSingle();
  if (!lead) return null;

  const [pipelineResult, boardResult, versionsResult] = await Promise.all([
    admin.from('lead_pipeline').select('*').eq('lead_id', leadId).maybeSingle(),
    admin.from('pipeline_board').select('next_step').eq('lead_id', leadId).maybeSingle(),
    admin
      .from('email_versions')
      .select('type, subject, content')
      .eq('lead_id', leadId)
      .eq('active', true),
  ]);

  const activeDrafts: SyncSnapshot['activeDrafts'] = {};
  for (const version of versionsResult.data ?? []) {
    activeDrafts[version.type as EmailType] = {
      subject: version.subject,
      content: version.content,
    };
  }

  return {
    lead,
    pipeline: pipelineResult.data ?? null,
    // pipeline_board is gated on is_admin(), and the service-role client is not
    // an admin JWT — so this is null in practice for server-side callers. The
    // stage on the pipeline row is the useful part; next_step is a bonus when
    // the caller happens to have an admin session.
    nextStep: boardResult.data?.next_step ?? null,
    activeDrafts,
  };
}

/**
 * Push a lead's current state to every enabled target.
 *
 * `fields` describes what changed. Targets may use it to decide what to write;
 * the Sheet target rewrites the whole mapped row regardless, because one
 * batchUpdate costs the same as one cell.
 */
export async function syncLeadChange(
  leadId: string,
  fields: SyncField[],
): Promise<SyncReport> {
  const snapshot = await buildSyncSnapshot(leadId);
  if (!snapshot) {
    return {
      outcomes: [],
      hasFailure: false,
      summary: null,
    };
  }

  return syncSnapshot(snapshot, fields);
}

/** Same as syncLeadChange but for a caller that already resolved the snapshot. */
export async function syncSnapshot(
  snapshot: SyncSnapshot,
  fields: SyncField[],
): Promise<SyncReport> {
  const outcomes = await Promise.all(
    TARGETS.map(async (target) => {
      try {
        if (!(await target.isEnabled())) {
          return {
            target: target.id,
            attempted: false,
            ok: true,
            message: `${target.label} sync is disabled.`,
          };
        }
        return await target.push(snapshot, fields);
      } catch (error) {
        // A throwing target must not take the others down with it.
        return {
          target: target.id,
          attempted: true,
          ok: false,
          message: error instanceof Error ? error.message : `${target.label} sync failed.`,
        };
      }
    }),
  );

  const attempted = outcomes.filter((outcome) => outcome.attempted);
  const failures = attempted.filter((outcome) => !outcome.ok);

  return {
    outcomes,
    hasFailure: failures.length > 0,
    summary:
      attempted.length === 0
        ? null
        : failures.length > 0
          ? failures.map((f) => f.message).join(' ')
          : attempted.map((a) => a.message).join(' '),
  };
}

/**
 * Fold a sync report into an action's message.
 *
 * The database write already succeeded by the time this runs, so the result
 * stays `ok` — but a failed push is appended verbatim. A sync that fails
 * silently is worse than one that fails loudly.
 */
export function appendSyncMessage(base: string, report: SyncReport): string {
  if (!report.summary) return base;
  return report.hasFailure ? `${base} Sheet not updated: ${report.summary}` : `${base} ${report.summary}`;
}
