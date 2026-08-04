import Image from 'next/image';

import { cn } from '@/lib/utils';

/**
 * The Automation Squad mark.
 *
 * Rendered on a white tile because the source PNG has no alpha channel — its
 * background is solid white. Dropping it straight onto a dark surface would
 * show a white square with ragged edges; the tile makes that deliberate instead
 * of accidental, and keeps the mark legible in both themes.
 *
 * `priority` is off by default: the mark is small and appears in the shell, so
 * it should never compete with page content for bandwidth. The login and public
 * pages pass it, since there the logo IS the largest contentful paint.
 */
export function BrandMark({
  size = 28,
  className,
  priority = false,
}: {
  size?: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden rounded-md bg-white',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Image
        src="/logo-mark.png"
        alt=""
        width={size}
        height={size}
        priority={priority}
        // Decorative: every use sits next to the wordmark in text, so
        // announcing it again would just repeat the brand name.
        aria-hidden="true"
        className="size-full object-contain"
      />
    </span>
  );
}

/** Mark + wordmark, for headers and the sign-in screen. */
export function BrandLockup({
  className,
  markSize = 28,
  subtitle,
}: {
  className?: string;
  markSize?: number;
  subtitle?: string;
}) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <BrandMark size={markSize} />
      <span className="min-w-0">
        <span className="block text-sm font-semibold tracking-tight">Automation Squad</span>
        {subtitle ? (
          <span className="block text-[11px] text-muted-foreground">{subtitle}</span>
        ) : null}
      </span>
    </span>
  );
}
