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
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-3 rounded-lg px-4 py-3',
          'hover:bg-surface-hover',
          // Safari renders a disclosure triangle unless this is suppressed.
          '[&::-webkit-details-marker]:hidden',
        )}
      >
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{title}</span>
          {description ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
          ) : null}
        </span>
        {badge ? <span className="shrink-0">{badge}</span> : null}
      </summary>

      <div className="space-y-4 px-1 pt-1 pb-4 sm:px-2">{children}</div>
    </details>
  );
}
