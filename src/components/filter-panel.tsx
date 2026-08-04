'use client';

import * as React from 'react';
import { Check, Filter, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn, formatNumber } from '@/lib/utils';
import { LEAD_STATUS_LABELS } from '@/components/status-badge';
import { LEAD_STATUSES, type LeadStatus } from '@/lib/supabase/database.types';

/**
 * Status filter. Multi-select, with each option showing how many leads it
 * holds so an empty result is predictable before you click.
 */
export function FilterPanel({
  selected,
  onChange,
  facets = {},
}: {
  selected: LeadStatus[];
  onChange: (next: LeadStatus[]) => void;
  facets?: Record<string, number>;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  function toggle(status: LeadStatus) {
    onChange(
      selected.includes(status) ? selected.filter((s) => s !== status) : [...selected, status],
    );
  }

  return (
    <div ref={ref} className="relative">
      <Button
        variant={selected.length > 0 ? 'primary' : 'secondary'}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <Filter className="size-4" aria-hidden="true" />
        Status
        {selected.length > 0 ? (
          <span className="tabular ml-0.5 rounded bg-white/20 px-1 text-xs">{selected.length}</span>
        ) : null}
      </Button>

      {open ? (
        <div
          role="group"
          aria-label="Filter by status"
          className="absolute right-0 top-full z-50 mt-1 w-60 overflow-hidden rounded-lg border border-border bg-surface-raised shadow-lg"
        >
          <div className="max-h-80 overflow-y-auto p-1">
            {LEAD_STATUSES.map((status) => {
              const active = selected.includes(status);
              const count = facets[status];
              return (
                <button
                  key={status}
                  type="button"
                  role="checkbox"
                  aria-checked={active}
                  onClick={() => toggle(status)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
                    active ? 'bg-primary-subtle text-primary' : 'hover:bg-surface-hover',
                  )}
                >
                  <span
                    className={cn(
                      'grid size-4 shrink-0 place-items-center rounded border',
                      active ? 'border-primary bg-primary text-white' : 'border-border-strong',
                    )}
                    aria-hidden="true"
                  >
                    {active ? <Check className="size-3" /> : null}
                  </span>
                  <span className="flex-1">{LEAD_STATUS_LABELS[status]}</span>
                  {count !== undefined ? (
                    <span className="tabular text-xs text-muted-foreground">{formatNumber(count)}</span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {selected.length > 0 ? (
            <div className="border-t border-border p-1">
              <button
                type="button"
                onClick={() => onChange([])}
                className="flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-surface-hover hover:text-foreground"
              >
                <X className="size-3.5" aria-hidden="true" />
                Clear filters
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Removable chips showing the active filters below the toolbar. */
export function ActiveFilters({
  statuses,
  onRemove,
  onClear,
}: {
  statuses: LeadStatus[];
  onRemove: (status: LeadStatus) => void;
  onClear: () => void;
}) {
  if (statuses.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {statuses.map((status) => (
        <button
          key={status}
          type="button"
          onClick={() => onRemove(status)}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {LEAD_STATUS_LABELS[status]}
          <X className="size-3" aria-hidden="true" />
          <span className="sr-only">Remove filter</span>
        </button>
      ))}
      <button
        type="button"
        onClick={onClear}
        className="cursor-pointer px-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Clear all
      </button>
    </div>
  );
}
