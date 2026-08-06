import { NextResponse, type NextRequest } from 'next/server';

import { guardCronRequest } from '@/lib/cron/authorize';
import { syncFromGoogleSheet } from '@/lib/services/sheet-sync';
import { finishRun, startRun } from '@/lib/services/integration-runs';

/**
 * Scheduled Google Sheet sync.
 *
 * Intended for one run a day at 23:59 Asia/Karachi, after n8n has finished
 * appending. **The schedule lives outside this app**, for the reason in the
 * outreach route: a Next.js server can be scaled to zero, restarted or
 * duplicated at any moment, so a timer inside one instance is not a schedule.
 *
 *   cron-job.org   POST https://<host>/api/cron/sheet-sync
 *                  Authorization: Bearer <CRON_SECRET>
 *                  59 23 * * *  with the timezone set to Asia/Karachi
 *                  (or 59 18 * * * if the scheduler only speaks UTC)
 *
 * It runs the SAME `syncFromGoogleSheet()` as the Sync button on the leads page,
 * so a scheduled sync and a hand-pressed one produce identical state, and both
 * land in `integration_runs` where the Settings page lists them.
 */

export const dynamic = 'force-dynamic';

/**
 * A full sheet read plus per-row upserts over ~700 rows. Vercel clamps this to
 * whatever the plan allows rather than erroring, so asking for the ceiling is
 * safe on any plan.
 */
export const maxDuration = 300;

async function handle(request: NextRequest) {
  const refusal = guardCronRequest(request, 'sheet sync');
  if (refusal) return refusal;

  const runId = await startRun('google_sheets', 'sync_data');

  try {
    // No triggeredBy: there is no user behind a cron call, and inventing one
    // would put a name against work nobody did.
    const summary = await syncFromGoogleSheet();

    await finishRun(runId, summary.ok ? 'success' : 'failed', summary.message, {
      totalRows: summary.totalRows,
      imported: summary.imported,
      updated: summary.updated,
      skipped: summary.skipped,
      invalid: summary.invalid,
      duplicatesInSheet: summary.duplicatesInSheet,
    });

    // 200 even when rows were invalid: the run itself completed, and a non-2xx
    // makes most cron services retry the whole thing.
    return NextResponse.json(
      {
        ok: summary.ok,
        message: summary.message,
        totalRows: summary.totalRows,
        imported: summary.imported,
        updated: summary.updated,
        skipped: summary.skipped,
        invalid: summary.invalid,
        durationMs: summary.durationMs,
      },
      { status: 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed unexpectedly.';
    await finishRun(runId, 'failed', message);
    // 500 here, unlike the invalid-rows case above: the sync did not run at all,
    // so a retry is the right response rather than a wasted one.
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return handle(request);
}

/** GET is accepted because several schedulers only issue GET. Same Bearer check. */
export async function GET(request: NextRequest) {
  return handle(request);
}
