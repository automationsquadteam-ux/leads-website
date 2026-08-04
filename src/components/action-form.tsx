'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { useToast } from '@/components/ui/toast';
import type { ActionResult } from '@/lib/actions/leads';

/**
 * Shared plumbing for the review workspace's many small forms.
 *
 * The workspace is deliberately made of independent panels — research,
 * personalization, each draft, notes — that each save on their own. One big
 * "Save everything" form would mean an admin who fixes a typo in the notes also
 * re-submits a draft they were still thinking about.
 */

export const EMPTY_ACTION_RESULT: ActionResult = { ok: false, message: '' };

/**
 * Toast whenever an action reports back, and refresh the route on success so
 * the server-rendered panels pick up the new row.
 *
 * Toasting is an external-system update, which is what an effect is for.
 * Anything that adjusts local React state on success is done during render by
 * the caller instead — a setState inside an effect triggers an extra cascading
 * render and trips the React Compiler lint.
 */
export function useActionFeedback(state: ActionResult, options: { refreshOnSuccess?: boolean } = {}) {
  const { toast } = useToast();
  const router = useRouter();
  const refresh = options.refreshOnSuccess ?? true;

  React.useEffect(() => {
    if (!state.message) return;
    toast(state.message, state.ok ? 'success' : 'error');
    if (state.ok && refresh) router.refresh();
  }, [state, toast, router, refresh]);
}

/**
 * Run a non-form action (a button click) with a busy key, a toast and a refresh.
 *
 * Returns the key currently running so several buttons can share one state and
 * only the clicked one shows a spinner.
 */
export function useAsyncAction() {
  const { toast } = useToast();
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  const run = React.useCallback(
    async (key: string, fn: () => Promise<ActionResult>) => {
      setBusy(key);
      try {
        const result = await fn();
        toast(result.message, result.ok ? 'success' : 'error');
        if (result.ok) router.refresh();
        return result;
      } finally {
        setBusy(null);
      }
    },
    [toast, router],
  );

  return { busy, run };
}

/** Error text rendered next to the panel it belongs to, never only at the top. */
export function PanelError({ state }: { state: ActionResult }) {
  if (state.ok || !state.message) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger"
    >
      {state.message}
    </p>
  );
}
