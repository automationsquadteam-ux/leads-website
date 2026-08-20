import 'server-only';

import { NextResponse } from 'next/server';

/**
 * The 202 every cron route answers with, immediately, before doing the work.
 *
 * **Why these routes do not wait for their own result.** cron-job.org gives up
 * on a request after about 30 seconds and reports it as a failed run. A sheet
 * sync over 700 rows and a draft sweep over a queue of 90 both take longer than
 * that legitimately, so both were reported as failures while actually running to
 * completion in the background ,the worst of both worlds, since the alarm was
 * false AND a real failure would have looked identical.
 *
 * `/api/cron/outreach` appeared to work only because it usually has nothing to
 * do and returns in milliseconds. It would have started failing the same way the
 * first time it had a real queue to work through, since it sleeps 90 seconds
 * between sends by design.
 *
 * So: answer 202 Accepted straight away, and let Next's `after()` keep the
 * function alive to finish the job. The scheduler only needs to know its poke
 * landed; it is not the thing that reads the result.
 *
 * **The trade-off, stated plainly.** The cron service can no longer tell you
 * whether the work SUCCEEDED, only that it started ,so it will show green even
 * when a run fails. That is acceptable only because every one of these jobs
 * writes an `integration_runs` row with its real outcome, which the Settings
 * page lists. If you add a cron route that does not record a run, do not use
 * this helper: you would be building a job whose failures are invisible.
 */
export function accepted(job: string): NextResponse {
  return NextResponse.json(
    {
      ok: true,
      accepted: true,
      message: `${job} started. It runs in the background; the outcome is recorded under Settings.`,
    },
    { status: 202 },
  );
}
