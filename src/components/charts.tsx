'use client';

import * as React from 'react';

import { cn, formatNumber, formatPercent } from '@/lib/utils';

/**
 * Hand-rolled SVG charts.
 *
 * Deliberately dependency-free: a charting library is a large bundle and a
 * React-19 compatibility risk for what these views need (a trend line and a
 * ranked bar list). Every chart ships a visually-hidden <table> so screen
 * readers get the data a chart alone is not accessible.
 *
 * `'use client'` because hovering a point now needs state ,everything else
 * here is still a pure function of its props, same as before. Any server
 * component can still render these directly (Next composes server → client
 * freely); it is only the reverse that is restricted.
 */

export interface SeriesPoint {
  label: string;
  value: number;
}

function DataTableFallback({ caption, points }: { caption: string; points: SeriesPoint[] }) {
  /*
   * The `sr-only` class goes on a WRAPPER, never on the <table> itself.
   *
   * `sr-only` hides by setting `width: 1px; height: 1px; overflow: hidden`, and
   * a table refuses to shrink below its min-content width ,`width: 1px` on a
   * table is a suggestion it ignores. So this "invisible" fallback was really
   * ~400px wide and absolutely positioned, which pushed the document's
   * scrollWidth past the viewport and gave /analytics and the public page a
   * horizontal scrollbar with nothing visible in it. A plain <div> honours the
   * 1px and clips the table inside it.
   */
  return (
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.label}>
              <th scope="row">{p.label}</th>
              <td>{p.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="flex h-48 items-center justify-center rounded-md border border-dashed border-border">
      <p className="text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

/**
 * The floating card a hover/tap raises. Plain HTML positioned OUTSIDE the
 * `<svg>`, absolutely, as a percentage of the wrapping box.
 *
 * Not a `<foreignObject>` inside the SVG: every chart here uses
 * `preserveAspectRatio="none"`, which stretches the viewBox's x and y axes by
 * DIFFERENT factors to fill a container wider than its own aspect ratio ,the
 * usual case once a card is any width but 640px. Text inside a `foreignObject`
 * would be stretched by exactly the same non-uniform factor, which reads as
 * subtly warped type. Living outside the SVG, in normal document flow, keeps
 * the tooltip's own text crisp regardless of how the chart itself is scaled.
 */
function ChartTooltip({
  xPct,
  yPct,
  above = true,
  children,
}: {
  /** Position as a percentage of the wrapping box ,tracks the chart's own responsive size for free. */
  xPct: number;
  yPct: number;
  /** `true` anchors above the point (line charts); `false` sits just below the top edge (multi-series, where no single point owns "the" y). */
  above?: boolean;
  children: React.ReactNode;
}) {
  const alignRight = xPct > 75;
  const alignLeft = xPct < 15;
  return (
    <div
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs shadow-lg"
      style={{
        left: `${xPct}%`,
        top: `${yPct}%`,
        transform: `translate(${alignRight ? '-100%' : alignLeft ? '0%' : '-50%'}, ${
          above ? 'calc(-100% - 10px)' : '10px'
        })`,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Which data point the pointer is nearest, by X position alone ,points are
 * evenly spaced along the axis, so this is a straight proportion, no need to
 * walk the coordinate list. Shared by both line charts; a bar list needs no
 * such thing, its rows are already individually hoverable HTML.
 *
 * Reads `clientX` off either a mouse or a touch event so one handler covers
 * both ,`onTouchStart`/`onTouchMove` wire to the same function as
 * `onMouseMove`. Returns null for a touch event with no active touch (the
 * `touchend` case), which callers treat as "stop hovering".
 */
function nearestIndex(
  e: React.MouseEvent<SVGSVGElement> | React.TouchEvent<SVGSVGElement>,
  rect: DOMRect,
  count: number,
): number | null {
  const clientX = 'touches' in e ? e.touches[0]?.clientX : e.clientX;
  if (clientX === undefined || count <= 1) return count === 1 ? 0 : null;
  const fraction = (clientX - rect.left) / rect.width;
  return Math.max(0, Math.min(count - 1, Math.round(fraction * (count - 1))));
}

/**
 * Area + line trend. Values are plotted on a 0..max scale with a small headroom
 * so the peak never touches the top edge.
 */
export function LineChart({
  points,
  caption,
  color = 'var(--primary)',
  height = 180,
  emptyMessage = 'No data for this period yet.',
}: {
  points: SeriesPoint[];
  caption: string;
  color?: string;
  height?: number;
  emptyMessage?: string;
}) {
  const [hoverIndex, setHoverIndex] = React.useState<number | null>(null);

  if (points.length === 0) return <ChartEmpty message={emptyMessage} />;

  const width = 640;
  const padY = 8;
  const max = Math.max(...points.map((p) => p.value), 1);
  const step = points.length > 1 ? width / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const x = points.length === 1 ? width / 2 : i * step;
    const y = height - padY - (p.value / max) * (height - padY * 2);
    return { x, y, ...p };
  });

  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const area = `${line} L${coords[coords.length - 1]!.x.toFixed(1)},${height} L${coords[0]!.x.toFixed(1)},${height} Z`;
  const gradientId = `grad-${caption.replace(/\W/g, '')}`;

  function handlePointer(e: React.MouseEvent<SVGSVGElement> | React.TouchEvent<SVGSVGElement>) {
    setHoverIndex(nearestIndex(e, e.currentTarget.getBoundingClientRect(), points.length));
  }

  const hovered = hoverIndex !== null ? coords[hoverIndex] : undefined;

  return (
    <figure className="w-full">
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-44 w-full cursor-crosshair overflow-visible touch-none"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${caption}. Peak ${formatNumber(max)}.`}
          onMouseMove={handlePointer}
          onMouseLeave={() => setHoverIndex(null)}
          onTouchStart={handlePointer}
          onTouchMove={handlePointer}
          onTouchEnd={() => setHoverIndex(null)}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Low-contrast gridlines so they never compete with the data. */}
          {[0, 0.5, 1].map((t) => (
            <line
              key={t}
              x1="0"
              x2={width}
              y1={padY + t * (height - padY * 2)}
              y2={padY + t * (height - padY * 2)}
              stroke="var(--border)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          <path d={area} fill={`url(#${gradientId})`} />
          <path
            d={line}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* The hover guide line and highlighted point sit above the series line, drawn after it. */}
          {hovered ? (
            <>
              <line
                x1={hovered.x}
                x2={hovered.x}
                y1="0"
                y2={height}
                stroke="var(--border-strong)"
                strokeWidth="1"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={hovered.x}
                cy={hovered.y}
                r="5"
                fill={color}
                stroke="var(--surface)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            </>
          ) : null}

          {coords.map((c) => (
            <circle key={c.label} cx={c.x} cy={c.y} r="2.5" fill={color} vectorEffect="non-scaling-stroke">
              <title>{`${c.label}: ${formatNumber(c.value)}`}</title>
            </circle>
          ))}
        </svg>

        {hovered ? (
          <ChartTooltip xPct={(hovered.x / width) * 100} yPct={(hovered.y / height) * 100}>
            <p className="font-medium text-foreground">{hovered.label}</p>
            <p className="tabular text-muted-foreground">{formatNumber(hovered.value)}</p>
          </ChartTooltip>
        ) : null}
      </div>

      <figcaption className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </figcaption>

      <DataTableFallback caption={caption} points={points} />
    </figure>
  );
}

export interface Series {
  label: string;
  color: string;
  points: SeriesPoint[];
}

/**
 * Several trend lines on one shared scale.
 *
 * A shared scale is the point: plotting "emails sent" and "replies" on
 * independent axes makes 3 replies look like 300 sends, which is the single
 * most common way a chart lies. Every series here is measured against the same
 * maximum.
 *
 * Series are expected to share an x-axis (the same days, in the same order);
 * the longest one defines the axis.
 */
export function MultiLineChart({
  series,
  caption,
  height = 180,
  emptyMessage = 'No data for this period yet.',
}: {
  series: Series[];
  caption: string;
  height?: number;
  emptyMessage?: string;
}) {
  const [hoverIndex, setHoverIndex] = React.useState<number | null>(null);

  const populated = series.filter((s) => s.points.length > 0);
  if (populated.length === 0) return <ChartEmpty message={emptyMessage} />;

  const width = 640;
  const padY = 8;
  const length = Math.max(...populated.map((s) => s.points.length));
  const max = Math.max(...populated.flatMap((s) => s.points.map((p) => p.value)), 1);
  const step = length > 1 ? width / (length - 1) : 0;

  const axis = populated.reduce((longest, s) => (s.points.length > longest.points.length ? s : longest));

  const seriesCoords = populated.map((s) => ({
    ...s,
    coords: s.points.map((p, i) => {
      const x = s.points.length === 1 ? width / 2 : i * step;
      const y = height - padY - (p.value / max) * (height - padY * 2);
      return { x, y, ...p };
    }),
  }));

  function handlePointer(e: React.MouseEvent<SVGSVGElement> | React.TouchEvent<SVGSVGElement>) {
    setHoverIndex(nearestIndex(e, e.currentTarget.getBoundingClientRect(), length));
  }

  const hoverX = hoverIndex !== null ? (length === 1 ? width / 2 : hoverIndex * step) : null;

  return (
    <figure className="w-full">
      <ChartLegend items={populated.map((s) => ({ label: s.label, color: s.color }))} />

      <div className="relative mt-2">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-44 w-full cursor-crosshair overflow-visible touch-none"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${caption}. Peak ${formatNumber(max)}.`}
          onMouseMove={handlePointer}
          onMouseLeave={() => setHoverIndex(null)}
          onTouchStart={handlePointer}
          onTouchMove={handlePointer}
          onTouchEnd={() => setHoverIndex(null)}
        >
          {[0, 0.5, 1].map((t) => (
            <line
              key={t}
              x1="0"
              x2={width}
              y1={padY + t * (height - padY * 2)}
              y2={padY + t * (height - padY * 2)}
              stroke="var(--border)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {seriesCoords.map((s) => {
            const path = s.coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
            return (
              <path
                key={s.label}
                d={path}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {hoverX !== null ? (
            <line
              x1={hoverX}
              x2={hoverX}
              y1="0"
              y2={height}
              stroke="var(--border-strong)"
              strokeWidth="1"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {hoverIndex !== null
            ? seriesCoords.map((s) => {
                const point = s.coords[hoverIndex];
                if (!point) return null;
                return (
                  <circle
                    key={s.label}
                    cx={point.x}
                    cy={point.y}
                    r="4"
                    fill={s.color}
                    stroke="var(--surface)"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })
            : null}
        </svg>

        {hoverIndex !== null && hoverX !== null ? (
          <ChartTooltip xPct={(hoverX / width) * 100} yPct={0} above={false}>
            <p className="font-medium text-foreground">{axis.points[hoverIndex]?.label}</p>
            <ul className="mt-1 space-y-0.5">
              {seriesCoords.map((s) => {
                const point = s.coords[hoverIndex];
                if (!point) return null;
                return (
                  <li key={s.label} className="tabular flex items-center gap-1.5 text-muted-foreground">
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: s.color }}
                      aria-hidden="true"
                    />
                    {s.label}: <span className="font-medium text-foreground">{formatNumber(point.value)}</span>
                  </li>
                );
              })}
            </ul>
          </ChartTooltip>
        ) : null}
      </div>

      <figcaption className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>{axis.points[0]?.label}</span>
        <span>{axis.points[axis.points.length - 1]?.label}</span>
      </figcaption>

      {/* One hidden table per series a chart alone is not accessible. */}
      {populated.map((s) => (
        <DataTableFallback key={s.label} caption={`${caption} ${s.label}`} points={s.points} />
      ))}
    </figure>
  );
}

/**
 * Horizontal ranked bars. Chosen over a pie for status distribution because the
 * category count exceeds five, where pies stop being readable.
 */
export function BarList({
  points,
  caption,
  color = 'var(--primary)',
  emptyMessage = 'Nothing to show yet.',
  max: maxOverride,
}: {
  points: SeriesPoint[];
  caption: string;
  /**
   * One colour for every bar. Was `colorFor?: (label: string) => string` —
   * every real caller passed a closure that ignored `label` and returned one
   * fixed colour anyway, and now that this module is a Client Component
   * (needed for the hover state below), a function prop from a server-
   * component caller cannot cross that boundary at all: React serializes
   * props between the two, and a plain closure is not serializable. A string
   * is, and a string is honestly all any caller ever needed.
   */
  color?: string;
  emptyMessage?: string;
  max?: number;
}) {
  if (points.length === 0) return <ChartEmpty message={emptyMessage} />;

  const max = maxOverride ?? Math.max(...points.map((p) => p.value), 1);
  // Share of the total is the one stat that is not already sitting next to
  // every bar as plain text ,the actual value already is, always, so this
  // list needs no hover state at all to answer "how many"; the tooltip below
  // exists purely to add the number that was not on screen before.
  const total = points.reduce((sum, p) => sum + p.value, 0);

  return (
    <figure className="w-full">
      <ul className="space-y-2" aria-label={caption}>
        {points.map((p) => {
          const pct = (p.value / max) * 100;
          const share = total > 0 ? (p.value / total) * 100 : 0;
          return (
            <li key={p.label} className="group relative">
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="truncate text-xs text-foreground">{p.label}</span>
                <span className="tabular shrink-0 text-xs font-medium text-muted-foreground">
                  {formatNumber(p.value)}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full transition-[width,filter] duration-300 group-hover:brightness-110"
                  style={{
                    width: `${Math.max(pct, p.value > 0 ? 2 : 0)}%`,
                    backgroundColor: color,
                  }}
                />
              </div>

              <div
                className={cn(
                  'pointer-events-none absolute -top-1.5 left-0 z-10 whitespace-nowrap rounded-md border border-border',
                  'bg-surface-raised px-2.5 py-1.5 text-xs opacity-0 shadow-lg transition-opacity',
                  'group-hover:opacity-100',
                )}
                style={{ transform: 'translateY(-100%)' }}
              >
                <p className="font-medium text-foreground">{p.label}</p>
                <p className="tabular text-muted-foreground">
                  {formatNumber(p.value)} · {formatPercent(share)} of total
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      <DataTableFallback caption={caption} points={points} />
    </figure>
  );
}

/** Compact multi-series legend used above the activity charts. */
export function ChartLegend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <ul className="flex flex-wrap items-center gap-3">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: item.color }}
            aria-hidden="true"
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
