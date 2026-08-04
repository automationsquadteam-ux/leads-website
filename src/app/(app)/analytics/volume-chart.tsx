'use client';

import * as React from 'react';

import { LineChart, type SeriesPoint } from '@/components/charts';
import { cn } from '@/lib/utils';

type Resolution = 'daily' | 'weekly' | 'monthly';

const LABELS: Record<Resolution, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

/**
 * Sending volume at three resolutions behind one toggle.
 *
 * Three separate charts would take three times the vertical space to answer the
 * same question the reader wants one trend, at the granularity that suits
 * what they are looking for. Each series is aggregated in its own Postgres
 * view, so switching does not re-bucket anything client-side.
 */
export function VolumeChart({
  daily,
  weekly,
  monthly,
}: {
  daily: SeriesPoint[];
  weekly: SeriesPoint[];
  monthly: SeriesPoint[];
}) {
  const [resolution, setResolution] = React.useState<Resolution>('daily');
  const series = { daily, weekly, monthly }[resolution];

  return (
    <div className="space-y-3">
      <div role="group" aria-label="Chart resolution" className="flex gap-1">
        {(Object.keys(LABELS) as Resolution[]).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={resolution === option}
            onClick={() => setResolution(option)}
            className={cn(
              'cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
              resolution === option
                ? 'border-primary bg-primary-subtle text-primary'
                : 'border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground',
            )}
          >
            {LABELS[option]}
          </button>
        ))}
      </div>

      <LineChart
        points={series}
        caption={`Emails sent, ${LABELS[resolution].toLowerCase()}`}
        emptyMessage="No sends recorded in this period yet."
      />
    </div>
  );
}
