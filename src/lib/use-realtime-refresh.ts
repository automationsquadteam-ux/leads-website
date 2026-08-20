'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { createClient } from '@/lib/supabase/client';

/**
 * Live updates, without a second copy of the rules.
 *
 * Every page in this app is a SERVER component: the row it shows comes from
 * `src/lib/data/*`, and those functions are where the rules live ,archived
 * leads are excluded (0034), Ready to Send needs `send_priority < 9`, an
 * initial send needs its ACTIVE version approved (0039), the send queue has a
 * three-part order that mirrors `findDueWork()`, business names are resolved
 * by a keyed second query.
 *
 * So this hook does NOT patch changed rows into client state. It treats a
 * Realtime event purely as a SIGNAL ,"something you are looking at changed" —
 * and calls `router.refresh()`, which re-runs those same server components and
 * therefore those same rules. One definition, still in one place.
 *
 * Rebuilding even part of that filtering in a browser to splice a row into a
 * table would be exactly the mistake this codebase keeps paying for: "two
 * implementations of the same rule is how the board and the scheduled sender
 * start disagreeing" (see the comment on `compute_pipeline_stage`). A refresh
 * costs one re-query; a divergent copy of the archived rule costs a wrong
 * number on a dashboard that nobody notices for a week.
 *
 * `router.refresh()` also preserves client state, which a `location.reload()`
 * would throw away ,the leads table keeps its selection and any half-typed
 * inline email edit, an open dialog stays open, scroll position holds.
 */

/**
 * Quiet period before refreshing. Long enough that a bulk action ,approving
 * forty leads, or a send run touching `leads`, `lead_pipeline` and
 * `email_logs` for every message ,collapses into ONE refresh instead of one
 * per row.
 */
const COALESCE_MS = 400;

/**
 * ...but never wait longer than this while changes keep arriving.
 *
 * A pure debounce starves under sustained load: an import writing rows
 * continuously would push the deadline back forever and the page would never
 * update at all, which is the opposite of the point. This is the ceiling that
 * guarantees progress, and it is deliberately several seconds rather than
 * sub-second because the expensive pages here (analytics runs aggregate
 * views) should not re-query on every tick of a long send run.
 */
const MAX_WAIT_MS = 5_000;

export function useRealtimeRefresh(tables: readonly string[]): void {
  const router = useRouter();

  /*
   * Each mount gets its own channel topic. Two subscribers sharing one topic
   * is a real footgun in supabase-js ,the second `subscribe()` on an
   * identical topic does not get its own subscription ,and React Strict Mode
   * mounts every effect twice in development, which would hit it immediately.
   */
  const instanceId = React.useId();

  /*
   * The dependency is the JOINED string, not the array. Callers pass an inline
   * literal (`tables={['leads', ...]}`), which is a new array identity on
   * every render ,depending on the array itself would tear down and rebuild
   * the websocket subscription on every parent re-render.
   */
  const key = tables.join(',');

  React.useEffect(() => {
    const list = key.split(',').filter(Boolean);
    if (list.length === 0) return;

    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let firstQueuedAt = 0;
    let missedWhileHidden = false;
    let cancelled = false;

    const fire = () => {
      timer = null;
      firstQueuedAt = 0;
      if (cancelled) return;

      /*
       * A background tab must not re-query on every change. It remembers that
       * it fell behind and catches up the moment it is looked at again, which
       * is the only moment the freshness actually matters.
       */
      if (document.hidden) {
        missedWhileHidden = true;
        return;
      }
      router.refresh();
    };

    const schedule = () => {
      const now = Date.now();
      if (firstQueuedAt === 0) firstQueuedAt = now;
      if (timer) clearTimeout(timer);
      const waited = now - firstQueuedAt;
      timer = setTimeout(fire, Math.max(0, Math.min(COALESCE_MS, MAX_WAIT_MS - waited)));
    };

    const channel = supabase.channel(`realtime-refresh:${instanceId}`);
    for (const table of list) {
      // INSERT, UPDATE and DELETE alike ,all three mean the page is stale.
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, schedule);
    }

    channel.subscribe((status) => {
      /*
       * Degrades to exactly the old behaviour. If Realtime is unreachable, or
       * migration 0041 has not been pasted so nothing is published, the page
       * still renders and still updates on navigation and after a server
       * action ,it simply stops updating by itself. Worth one dev-only line
       * so that "why is it not live" is answerable without guessing.
       */
      if (
        process.env.NODE_ENV === 'development' &&
        (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
      ) {
        console.warn(
          `[realtime] subscription ${status}. Live updates are off; ` +
            'check that migration 0041 (supabase_realtime publication) has been applied.',
        );
      }
    });

    const onVisibilityChange = () => {
      if (!document.hidden && missedWhileHidden) {
        missedWhileHidden = false;
        schedule();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      // Unsubscribes AND drops the socket's reference to it, so a long session
      // navigating between pages does not accumulate dead channels.
      void supabase.removeChannel(channel);
    };
  }, [key, router, instanceId]);
}
