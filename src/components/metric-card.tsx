import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

export function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
  className,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: LucideIcon;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  className?: string;
}) {
  const toneClass = {
    default: 'text-foreground',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  }[tone];

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-surface p-3 transition-colors hover:border-border-strong',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
      </div>
      <p className={cn('tabular mt-1.5 text-2xl font-semibold tracking-tight', toneClass)}>{value}</p>
      {hint ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
