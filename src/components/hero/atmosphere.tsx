import { cn } from '@/lib/utils';

/**
 * The decorative layer behind hero content: a wide elliptical glow and the
 * quarter-point grid lines.
 *
 * Both are `aria-hidden` and pointer-transparent. They are atmosphere, not
 * content ,a screen reader announcing "image" here would be noise, and a
 * stray pointer target over a headline is worse.
 */

/**
 * A single wide ellipse, blurred, sitting behind the headline.
 *
 * Done as an SVG with a real `feGaussianBlur` rather than a CSS radial
 * gradient because a gradient's falloff is linear and reads as a visible ring
 * on a dark background at this size; a blurred solid has the soft shoulder the
 * spec is after. `filterUnits="userSpaceOnUse"` with an oversized region stops
 * the blur being clipped at the ellipse's own bounding box, which is what
 * produces a hard rectangular edge on the glow.
 */
export function CenterGlow({ className }: { className?: string }) {
  return (
    <svg
      className={cn('pointer-events-none absolute select-none', className)}
      viewBox="0 0 1200 400"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <filter
          id="hero-glow-blur"
          x="-20%"
          y="-60%"
          width="140%"
          height="220%"
          filterUnits="objectBoundingBox"
        >
          <feGaussianBlur stdDeviation="25" />
        </filter>
        <linearGradient id="hero-glow-fill" x1="0" y1="0" x2="1" y2="0">
          {/*
            Azure through indigo, matching the brand accent. Deliberately does NOT
            reach the success green: the glow sits directly behind the headline
            and the metric tiles, and a green cast there would read as state.
          */}
          <stop offset="0%" stopColor="#123a63" stopOpacity="0.55" />
          <stop offset="50%" stopColor="#5c9dff" stopOpacity="0.42" />
          <stop offset="100%" stopColor="#3f7fd4" stopOpacity="0.5" />
        </linearGradient>
      </defs>
      <ellipse
        cx="600"
        cy="200"
        rx="440"
        ry="90"
        fill="url(#hero-glow-fill)"
        filter="url(#hero-glow-blur)"
      />
    </svg>
  );
}

/**
 * Hairlines at 25%, 50% and 75% of the width.
 *
 * `hidden md:block`: on a phone these sit a few millimetres from the text and
 * read as rendering artefacts rather than structure.
 */
export function GridLines({ className }: { className?: string }) {
  return (
    <div
      className={cn('grid-lines pointer-events-none absolute inset-0 hidden md:block', className)}
      aria-hidden="true"
    />
  );
}
