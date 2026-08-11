import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * A settings section that starts collapsed.
 *
 * Built on native `<details>` / `<summary>` rather than React state, for three
 * reasons that matter here:
 *
 *   * The content stays in the DOM when closed. The Sending & content card is
 *     ONE form spanning several sections with a single save button, so
 *     unmounting a collapsed section would silently drop its fields on submit.
 *   * Keyboard support, focus behaviour and the open/closed announcement come
 *     free and correct.
 *   * It works without hydration, so a section can be opened before the page
 *     has finished loading.
 *
 * `defaultOpen` is for the section someone came to use; everything else stays
 * shut so the page is a menu rather than a wall.
 */
export function CollapsibleSection({
  title,
  description,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string;
  description?: string;
  /** Short status shown on the closed header, e.g. a count or "Not configured". */
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-lg border border-border bg-surface [&[open]]:bg-transparent"
    >
      {/*
        The badge STACKS BELOW the title on a phone, and only sits beside it
        from `sm` up.
        
        It was `shrink-0` next to a `min-w-0 flex-1` title, and every Badge is
        `whitespace-nowrap`. On a 386px screen a badge reading
        "From: send@team-automationsolutions.me" therefore kept its full ~250px
        and the title absorbed everything left — about 30px, which rendered
        "Integrations" as "Int / eg / rat / io / ns" straight down the card.
        
        `flex-wrap` alone does NOT fix this: the title has `min-w-0`, so the
        browser can always satisfy the row by shrinking the title to nothing
        rather than wrapping the badge. The two have to be told to stack.
      */}
      <summary
        className={cn(
          'flex cursor-pointer list-none items-start gap-3 rounded-lg px-4 py-3',
          'hover:bg-surface-hover sm:items-center',
          // Safari renders a disclosure triangle unless this is suppressed.
          '[&::-webkit-details-marker]:hidden',
        )}
      >
        <ChevronRight
          className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 sm:mt-0"
          aria-hidden="true"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <span className="min-w-0">
            <span className="block text-sm font-semibold">{title}</span>
            {description ? (
              <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
            ) : null}
          </span>
          {/*
            `max-w-full` with `truncate` on the badge itself: alone on its own
            line it has the whole card to work with, but a from-address long
            enough to exceed even that must clip rather than widen the page.
          */}
          {badge ? <span className="min-w-0 max-w-full shrink-0 truncate">{badge}</span> : null}
        </span>
      </summary>

      <div className="space-y-4 px-1 pt-1 pb-4 sm:px-2">{children}</div>
    </details>
  );
}
