import { NextResponse, type NextRequest } from 'next/server';

import { guardCronRequest } from '@/lib/cron/authorize';
import { runDraftSweep } from '@/lib/services/drafts/sweep';

/**
 * Scheduled draft clean-and-approve.
 *
 * Exactly what the "Clean and approve drafts" button in Settings does — same
 * `runDraftSweep()`, same repair rules, same approval bar, same row in
 * `integration_runs`. Pressing the button and letting the schedule fire are
 * indistinguishable afterwards, which is the point: a cron job with its own idea
 * of "good enough to send" would be a second definition of approval.
 *
 *   cron-job.org   POST https://<host>/api/cron/approve-drafts
 *                  Authorization: Bearer <CRON_SECRET>
 *                  0 0,7,14,21 * * *
 *
 * Cron cannot express "every 7 hours" — `0 * / 7 * * *` restarts the count at
 * midnight, so it fires at 00, 07, 14, 21 and then waits three hours rather than
 * seven. The explicit hour list above is the same four times and says outright
 * what it does. Four passes a day over a queue that only grows when the sheet
 * syncs is ample; nothing is lost by the short overnight gap.
 *
 * Note what it does NOT do: nothing is sent. A draft this cannot fully clean
 * keeps its place in the queue, and even an approved one only goes out if it has
 * cleared all four pipeline gates and `outreach.auto_send_initial` is on.
 */

export const dynamic = 'force-dynamic';

/**
 * The sweep stops itself at its own budget (below) and reports honestly, so the
 * platform never kills it mid-write. 300 is clamped to whatever the plan allows.
 */
export const maxDuration = 300;

async function handle(request: NextRequest) {
  const refusal = guardCronRequest(request, 'draft approval sweep');
  if (refusal) return refusal;

  const summary = await runDraftSweep({
    userId: null,
    /*
     * Larger than the button's implicit 45s because a cron call is not a person
     * waiting on a page, and a run that reaches the end of the queue is worth
     * more than one that returns quickly. Still under maxDuration, so the sweep
     * stops itself rather than being cut off part-way through a version insert.
     */
    maxRuntimeMs: 240_000,
  });

  // 200 even when drafts were left for review: that is a normal outcome, not a
  // failure, and a non-2xx makes most cron services retry the whole batch.
  return NextResponse.json(
    {
      ok: summary.ok,
      message: summary.message,
      examined: summary.examined,
      repaired: summary.repaired,
      approved: summary.approved,
      blocked: summary.blocked,
      remaining: summary.remaining,
      reasons: summary.reasons,
    },
    { status: 200 },
  );
}

export async function POST(request: NextRequest) {
  return handle(request);
}

/** GET is accepted because several schedulers only issue GET. Same Bearer check. */
export async function GET(request: NextRequest) {
  return handle(request);
}
