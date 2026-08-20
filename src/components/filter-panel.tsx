'use client';

import * as React from 'react';
import { Check, Filter, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn, formatNumber } from '@/lib/utils';
import { STAGE_META } from '@/lib/pipeline/labels';
import { PIPELINE_STAGES, type PipelineStage } from '@/lib/supabase/database.types';

/**
 * Stage filter. Multi-select, with each option showing how many leads it holds
 * so an empty result is predictable before you click.
 *
 * This used to filter `leads.status`, a label somebody sets. It disagreed with
 * the pipeline constantly — 472 leads read `status = 'researching'` while 695
 * had research complete — so filtering by it found the wrong leads. The stage is
 * derived from what is actually true, and it is what every dashboard tile counts,
 * so the filter and the tiles now describe the same thing.
 */
export function FilterPanel({
  selected,
  onChange,
  facets = {},
}: {
  selected: PipelineStage[];
  onChange: (next: PipelineStage[]) => void;
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

  function toggle(stage: PipelineStage) {
    onChange(selected.includes(stage) ? selected.filter((s) => s !== stage) : [...selected, stage]);
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
        Stage
        {selected.length > 0 ? (
          <span className="tabular ml-0.5 rounded bg-white/20 px-1 text-xs">{selected.length}</span>
        ) : null}
      </Button>

      {open ? (
        <div
          role="group"
          aria-label="Filter by stage"
          className="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-surface-raised shadow-lg"
        >
          <div className="max-h-80 overflow-y-auto p-1">
            {PIPELINE_STAGES.map((stage) => {
              const active = selected.includes(stage);
              /*
               * `lead_stage_counts` is a GROUP BY view, so a stage with
               * genuinely zero leads (active or archived) produces no row at
               * all — not a row reading 0. Falling back to 0 here means an
               * honestly-empty stage still reads "0" instead of
               * vanishing, which is what made Researching / Needs Draft /
               * Draft Ready show a blank cell next to Dead Address's real 0:
               * Dead Address had at least one ARCHIVED lead to group on
               * (giving it a row with lead_count 0), those three had none at
               * all, archived included.
               */
              const count = facets[stage] ?? 0;
              return (
                <button
                  key={stage}
                  type="button"
                  role="checkbox"
                  aria-checked={active}
                  onClick={() => toggle(stage)}
                  title={STAGE_META[stage].description}
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
                  <span className="flex-1">{STAGE_META[stage].label}</span>
                  <span className="tabular text-xs text-muted-foreground">{formatNumber(count)}</span>
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
  stages,
  onRemove,
  onClear,
}: {
  stages: PipelineStage[];
  onRemove: (stage: PipelineStage) => void;
  onClear: () => void;
}) {
  if (stages.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {stages.map((stage) => (
        <button
          key={stage}
          type="button"
          onClick={() => onRemove(stage)}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {STAGE_META[stage].label}
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
