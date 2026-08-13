'use client';

import { useRealtimeRefresh } from '@/lib/use-realtime-refresh';

/**
 * The tables an open admin page can be made stale by.
 *
 * **Keep this list in step with migration 0041**, which publishes exactly
 * these to `supabase_realtime`. A table listed here but not published emits
 * nothing (silently); a table published but not listed here is streamed to
 * nobody. Neither breaks anything — you just do not get live updates — which
 * is precisely why it is worth saying so here rather than finding out later.
 *
 * `settings` is deliberately absent: it changes only when the person reading
 * the page saves the form themselves, and that path already revalidates.
 */
const LIVE_TABLES = [
  'leads',
  'lead_pipeline',
  'email_logs',
  'email_versions',
  'replies',
  'inbound_messages',
  'lead_activity',
  'integration_runs',
] as const;

/**
 * One subscription for the whole authenticated shell.
 *
 * Mounted in the (app) layout rather than per page, so a page added later is
 * live by default instead of being live only if somebody remembered — the
 * same argument this codebase makes for putting the send gates inside
 * `sendLeadEmail()` rather than in each caller.
 *
 * The cost of the coarse subscription is honest and small: a change to
 * `integration_runs` while you are on /leads triggers one refresh of the
 * leads queries. `router.refresh()` only re-renders the route you are
 * actually on, and the hook coalesces bursts, so the ceiling is one re-query
 * every few seconds during sustained churn — against the alternative of eight
 * per-page table lists to keep in sync.
 *
 * Renders nothing. It exists for its subscription.
 */
export function RealtimeRefresh() {
  useRealtimeRefresh(LIVE_TABLES);
  return null;
}
