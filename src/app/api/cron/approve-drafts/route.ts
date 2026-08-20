import { after, type NextRequest } from 'next/server';

import { guardCronRequest } from '@/lib/cron/authorize';
import { accepted } from '@/lib/cron/accepted';
import { runDraftSweep } from '@/lib/services/drafts/sweep';

/**
 * Scheduled draft clean-and-approve.
 *
 * Exactly what the "Clean and approve drafts" button in Settings does ,same
 * `runDraftSweep()`, same repair rules, same approval bar, same row in
 * `integration_runs`. Pressing the button and letting the schedule fire are
 * indistinguishable afterwards, which is the point: a cron job with its own idea
 * of "good enough to send" would be a second definition of approval.
 *
 *   cron-job.org   POST https://<host>/api/cron/approve-drafts
 *                  Authorization: Bearer <CRON_SECRET>
 *                  0 0,7,14,21 * * *
 *
 * Cron cannot express "every 7 hours" ,`0 * / 7 * * *` restarts the count at
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
 * The ceiling for the whole invocation, including the `after()` work. The sweep
 * stops itself at its own smaller budget (below), so the platform never kills it
 * mid-write. 300 is clamped to whatever the plan allows.
 */
export const maxDuration = 300;

async function handle(request: NextRequest) {
  const refusal = guardCronRequest(request, 'draft approval sweep');
  if (refusal) return refusal;

  after(async () => {
    await runDraftSweep({
      userId: null,
      /*
       * 50s, the same budget the scheduled sender uses and for the same reason:
       * a Vercel Hobby function is killed at 60s, and a sweep that stops itself
       * cleanly is worth far more than one cut off part-way through writing a
       * version. Whatever it does not reach stays in the queue for the next run
       * ,there are four a day, and the button is always there for a backlog.
       */
      maxRuntimeMs: 50_000,
    });
  });

  return accepted('Draft sweep');
}

export async function POST(request: NextRequest) {
  return handle(request);
}

/** GET is accepted because several schedulers only issue GET. Same Bearer check. */
export async function GET(request: NextRequest) {
  return handle(request);
}
