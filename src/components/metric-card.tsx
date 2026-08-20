import Link from 'next/link';
import { ArrowUpRight, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * A single figure, optionally a link to the rows behind it.
 *
 * When `href` is set the whole card becomes the hit target rather than a small
 * "view" link in a corner a number you can see is a number you expect to be
 * able to click, and a 40px target beats a 12px one on every device.
 */
export function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
  className,
  href,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: LucideIcon;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  className?: string;
  /** Where the rows behind this figure live. Omit for a static card. */
  href?: string;
}) {
  const toneClass = {
    default: 'text-foreground',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  }[tone];

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        {/*
          Wraps on a phone, truncates from `sm` up.
          Two-column grid on a 360px screen leaves ~150px per card, which cuts
          "Initial Approval Queue" to "Initial Appr…" ,a label that no longer
          says what the number is. On a wide screen the row rhythm matters more
          and every label fits anyway, so truncation returns there.
        */}
        <p className="text-xs font-medium text-muted-foreground sm:truncate">{label}</p>
        {href ? (
          <ArrowUpRight
            className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-hidden="true"
          />
        ) : Icon ? (
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : null}
      </div>
      <p className={cn('tabular mt-1.5 text-xl font-semibold tracking-tight sm:text-2xl', toneClass)}>
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground sm:truncate">{hint}</p>
      ) : null}
    </>
  );

  const base = 'rounded-lg border border-border bg-surface p-3 transition-colors';

  if (!href) {
    return <div className={cn(base, 'hover:border-border-strong', className)}>{body}</div>;
  }

  return (
    <Link
      href={href}
      className={cn(base, 'group block hover:border-primary hover:bg-surface-hover', className)}
    >
      {body}
      <span className="sr-only">open the leads behind this figure</span>
    </Link>
  );
}
