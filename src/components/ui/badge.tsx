import * as React from 'react';

import { cn } from '@/lib/utils';

export type BadgeTone =
  | 'neutral'
  | 'primary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'violet';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-muted-foreground border-border',
  primary: 'bg-primary-subtle text-primary border-primary/25',
  success: 'bg-success-subtle text-success border-success/25',
  warning: 'bg-warning-subtle text-warning border-warning/25',
  danger: 'bg-danger-subtle text-danger border-danger/25',
  info: 'bg-info-subtle text-info border-info/25',
  violet: 'bg-violet-subtle text-violet border-violet/25',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5',
        'text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
