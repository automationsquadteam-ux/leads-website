'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { X } from 'lucide-react';

import { Input } from '@/components/ui/input';

/**
 * Filter the log to one date or a period. Empty means all time.
 *
 * Same URL-is-the-state pattern as `LogPagination` right next to it: a
 * particular date range is shareable and survives the back button, and the
 * server component re-runs the real query — no client cache to keep in sync
 * with the stats row above the list.
 *
 * Selecting only one field filters to that single day, both fields make a
 * period. The values round-trip through `?from=`/`?to=` as plain
 * `YYYY-MM-DD` — the meaning of that string (midnight-to-midnight in
 * DISPLAY_TIME_ZONE, not the server's own clock) is resolved once, in
 * `dayBoundsUtc`, on the data side.
 */
export function DateRangeFilter({ from, to }: { from: string; to: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (!value) next.delete(key);
      else next.set(key, value);
    }
    // A new date range makes the old page number meaningless.
    next.delete('page');
    startTransition(() => router.push(`${pathname}?${next.toString()}`, { scroll: false }));
  };

  const hasFilter = Boolean(from || to);

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="space-y-1">
        <span className="block text-xs font-medium text-muted-foreground">From</span>
        <Input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => update({ from: e.target.value || null })}
          className="h-9 w-[150px]"
          aria-label="From date"
        />
      </label>
      <label className="space-y-1">
        <span className="block text-xs font-medium text-muted-foreground">To</span>
        <Input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => update({ to: e.target.value || null })}
          className="h-9 w-[150px]"
          aria-label="To date"
        />
      </label>
      {hasFilter ? (
        <button
          type="button"
          onClick={() => update({ from: null, to: null })}
          className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <X className="size-3" aria-hidden="true" />
          Clear
        </button>
      ) : null}
    </div>
  );
}
