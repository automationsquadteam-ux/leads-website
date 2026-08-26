'use client';

import { useActionState } from 'react';

import { clearLeadSendFailures } from '@/lib/actions/misc';
import type { ActionResult } from '@/lib/actions/leads';

const INITIAL: ActionResult = { ok: false, message: '' };

/**
 * "Mark fixed" for one lead's send failures.
 *
 * Deliberately a form posting a Server Action rather than a fetch: the whole
 * point is that clearing is an admin-gated write, and `assertAdmin()` runs
 * inside the action ,middleware does not run for Server Actions, so the guard
 * has to live there (section 3, layer 2).
 *
 * `stopPropagation` on the wrapper matters: on the desktop table this button
 * sits inside a row whose stretched `<Link>` covers the entire row, so without
 * it every click here would navigate to the lead instead of submitting.
 */
export function ClearFailureButton({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(clearLeadSendFailures, INITIAL);

  return (
    <div
      className="relative z-10 flex flex-col items-end gap-1"
      onClick={(event) => event.stopPropagation()}
    >
      <form action={action}>
        <input type="hidden" name="leadId" value={leadId} />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium whitespace-nowrap hover:border-primary hover:bg-surface-hover disabled:opacity-50"
        >
          {pending ? 'Clearing…' : 'Mark fixed'}
        </button>
      </form>
      {state.message ? (
        <span className={`text-xs ${state.ok ? 'text-success' : 'text-danger'}`}>{state.message}</span>
      ) : null}
    </div>
  );
}
