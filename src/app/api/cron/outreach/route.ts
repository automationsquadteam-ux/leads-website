import { after, type NextRequest } from 'next/server';

import { guardCronRequest } from '@/lib/cron/authorize';
import { accepted } from '@/lib/cron/accepted';
import { runOutreachCycle } from '@/lib/services/outreach/scheduler';
import { finishRun, startRun } from '@/lib/services/integration-runs';

/**
 * Scheduled outreach endpoint.
 *
 * The app does not schedule anything itself a Next.js server can be scaled to
 * zero or duplicated at any moment, so an in-process timer is not a schedule.
 * Something external calls this on an interval:
 *
 *   Vercel Cron      vercel.json (already committed) sends the CRON_SECRET
 *                    as a Bearer token automatically.
 *   Windows / Linux  schtasks or crontab running:
 *                    curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *                         https://<host>/api/cron/outreach
 *   cron-job.org     same request, if the CRM is publicly reachable.
 *
 * Authorization is a shared secret, not a session: there is no user here. The
 * route is outside the middleware's admin prefixes for that reason, which makes
 * guardCronRequest() the ONLY thing standing between the open internet and a
 * function that sends email. It fails closed when CRON_SECRET is unset, and it
 * lives in lib/cron/authorize.ts because three routes now share it.
 */

// Sending email is not a cacheable GET.
export const dynamic = 'force-dynamic';

/**
 * The run sleeps between sends to honour `sending.min_gap_seconds`, so it needs
 * longer than the default function timeout. Vercel clamps this to what the plan
 * allows (Hobby 60s, Pro 300s) rather than erroring, so asking for 300 is safe
 * either way.
 *
 * Keep `outreach.max_runtime_seconds` BELOW whatever the plan grants: the run
 * stops itself cleanly at that budget, whereas the platform killing it does so
 * mid-flight.
 */
export const maxDuration = 300;

async function handle(request: NextRequest) {
  const refusal = guardCronRequest(request, 'sending');
  if (refusal) return refusal;

  const dryRun = request.nextUrl.searchParams.get('dry') === '1';

  /*
   * This route seemed fine while the other two were timing out, because it
   * almost always finds nothing due and returns in milliseconds. It sleeps 90
   * seconds between sends by design, so the first run with a real queue would
   * have blown through cron-job.org's ~30s timeout exactly the same way.
   * Answering first removes a failure that had not happened yet.
   */
  after(async () => {
    const runId = await startRun('outreach', dryRun ? 'dry_run' : 'send_due');
    const summary = await runOutreachCycle({ dryRun });
    await finishRun(runId, summary.ok ? 'success' : 'failed', summary.message, {
      considered: summary.considered,
      sent: summary.sent,
      generated: summary.generated,
      skipped: summary.skipped,
      failed: summary.failed,
      closed: summary.closed,
      /*
       * The full list, not just the reason `summary.message` already carries
       * for the first one. This is the ONLY caller that runs unattended every
       * 3 minutes, so it is the one place a silent, permanently-repeating
       * failure would otherwise leave no trace at all — three leads did
       * exactly that for hours: a bracketed tag in their own business name
       * tripped the placeholder guard on every tick, `failed` incremented
       * next to a bare run id, and finding out why meant reading the database
       * by hand. See the comment in runOutreachCycle().
       */
      notes: summary.notes,
    });
  });

  return accepted(dryRun ? 'Outreach dry run' : 'Outreach run');
}

export async function POST(request: NextRequest) {
  return handle(request);
}

/**
 * GET is accepted because several schedulers (Vercel Cron included) only issue
 * GET. It carries the same Bearer check and is marked force-dynamic, so it is
 * never served from a cache.
 */
export async function GET(request: NextRequest) {
  return handle(request);
}
