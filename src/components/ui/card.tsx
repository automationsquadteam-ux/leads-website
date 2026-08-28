import * as React from 'react';

import { cn } from '@/lib/utils';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  /*
   * `min-w-0` is load-bearing, not cosmetic.
   *
   * As a grid or flex child a Card defaults to `min-width: auto`, so it refuses
   * to shrink below its own min-content width ,and `truncate` sets
   * `white-space: nowrap`, whose min-content width is the ENTIRE string. A
   * dashboard list of activity summaries therefore pushed its card to 948px on
   * a 386px screen: the text never truncated, it just made the card wider, and
   * the shell clips horizontally rather than scrolling, so the right-hand side
   * was silently cut off.
   *
   * Setting it here rather than on each grid means the fix cannot be forgotten
   * the next time a card is dropped into a layout.
   */
  /*
   * Deliberately NOT `.glass`. A card is a container for tables and charts,
   * and `backdrop-filter` on a few dozen of them at once is the single most
   * expensive thing this app could ask a GPU to do ,the dashboard alone
   * renders more than twenty. The glass treatment is reserved for the handful
   * of floating surfaces over the hero, where there is actually something
   * behind them worth blurring. Here the same look is approximated with a
   * raised surface and a top highlight, which costs nothing.
   */
  return (
    <div
      className={cn(
        'min-w-0 rounded-xl border border-border bg-surface',
        'shadow-[inset_0_1px_0_var(--glass-highlight),0_1px_2px_rgb(0_0_0/0.04)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      /*
       * `flex-wrap` by default: a header is a title on the left and controls on
       * the right, and on a narrow screen that pair has to become two rows
       * rather than one row wider than the card. Without it the controls
       * overflow the card, and because the app shell clips horizontally they
       * become unreachable rather than merely ugly.
       */
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3',
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-sm font-semibold', className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-xs text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />;
}
