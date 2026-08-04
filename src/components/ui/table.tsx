import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Table primitives. Row height is pinned to --row-height (36px) from the
 * density scale so every table in the app shares one rhythm.
 */
export function TableWrap({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('scrollbar-thin w-full overflow-x-auto', className)} {...props} />;
}

/**
 * `fixed` layout is load-bearing, not cosmetic.
 *
 * Under the default `auto` layout a browser sizes each column to its widest
 * unbreakable cell and treats an explicit `width` as a suggestion it may
 * ignore. That is why dragging a column narrower than its longest value did
 * nothing. With `fixed`, the declared widths are honoured exactly and cells
 * clip — which is what makes resizing work at all.
 *
 * The consequence is that cells MUST be able to clip: TD below sets
 * overflow-hidden and truncates. Anything that must stay fully visible needs
 * its own wider default width, not an escape from truncation.
 */
export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full table-fixed border-collapse text-sm', className)} {...props} />;
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
        'h-9 overflow-hidden px-3 text-left text-xs font-medium tracking-wide text-muted-foreground whitespace-nowrap',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Truncation lives here rather than on each cell's contents, so a column dragged
 * narrow clips cleanly instead of forcing the table wider than the viewport.
 * The full value stays available via the row's link or the detail page.
 */
export function TD({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn('h-9 overflow-hidden px-3 align-middle text-ellipsis whitespace-nowrap', className)}
      {...props}
    />
  );
}
