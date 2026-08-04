import { cn } from '@/lib/utils';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} aria-hidden="true" />;
}

/**
 * Table placeholder sized to the real row height, so swapping in data causes no
 * layout shift (CLS).
 */
export function TableSkeleton({ rows = 8, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <div className="w-full" role="status" aria-label="Loading data">
      <div className="flex h-9 items-center gap-4 border-b border-border px-3">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex h-9 items-center gap-4 border-b border-border px-3">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className="h-3 flex-1" />
          ))}
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-lg border border-border bg-surface p-4', className)}>
      <Skeleton className="mb-3 h-3 w-24" />
      <Skeleton className="h-7 w-16" />
    </div>
  );
}

export function MetricGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}

export function ChartSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-lg border border-border bg-surface p-4', className)}>
      <Skeleton className="mb-4 h-3 w-32" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
