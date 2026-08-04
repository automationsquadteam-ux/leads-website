import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Table primitives. Row height is pinned to --row-height (36px) from the
 * density scale so every table in the app shares one rhythm.
 */
export function TableWrap({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('scrollbar-thin w-full overflow-x-auto', className)} {...props} />;
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full border-collapse text-sm', className)} {...props} />;
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn('sticky top-0 z-10 bg-surface [&_th]:border-b [&_th]:border-border', className)}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b border-border transition-colors last:border-0 hover:bg-surface-hover',
        'data-[selected=true]:bg-primary-subtle',
        className,
      )}
      {...props}
    />
  );
}

export function TH({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'h-9 px-3 text-left text-xs font-medium tracking-wide text-muted-foreground whitespace-nowrap',
        className,
      )}
      {...props}
    />
  );
}

export function TD({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('h-9 px-3 align-middle whitespace-nowrap', className)} {...props} />;
}
