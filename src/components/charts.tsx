import { formatNumber } from '@/lib/utils';

/**
 * Hand-rolled SVG charts.
 *
 * Deliberately dependency-free: a charting library is a large bundle and a
 * React-19 compatibility risk for what these views need (a trend line and a
 * ranked bar list). Every chart ships a visually-hidden <table> so screen
 * readers get the data a chart alone is not accessible.
 */

export interface SeriesPoint {
  label: string;
  value: number;
}

function DataTableFallback({ caption, points }: { caption: string; points: SeriesPoint[] }) {
  return (
    <table className="sr-only">
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

  return (
    <figure className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-44 w-full overflow-visible"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${caption}. Peak ${formatNumber(max)}.`}
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

        {coords.map((c) => (
          <circle key={c.label} cx={c.x} cy={c.y} r="2.5" fill={color} vectorEffect="non-scaling-stroke">
            <title>{`${c.label}: ${formatNumber(c.value)}`}</title>
          </circle>
        ))}
      </svg>

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
  const populated = series.filter((s) => s.points.length > 0);
  if (populated.length === 0) return <ChartEmpty message={emptyMessage} />;

  const width = 640;
  const padY = 8;
  const length = Math.max(...populated.map((s) => s.points.length));
  const max = Math.max(...populated.flatMap((s) => s.points.map((p) => p.value)), 1);
  const step = length > 1 ? width / (length - 1) : 0;

  const axis = populated.reduce((longest, s) => (s.points.length > longest.points.length ? s : longest));

  return (
    <figure className="w-full">
      <ChartLegend items={populated.map((s) => ({ label: s.label, color: s.color }))} />

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-2 h-44 w-full overflow-visible"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${caption}. Peak ${formatNumber(max)}.`}
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

        {populated.map((s) => {
          const path = s.points
            .map((p, i) => {
              const x = s.points.length === 1 ? width / 2 : i * step;
              const y = height - padY - (p.value / max) * (height - padY * 2);
              return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(' ');

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
      </svg>

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
  colorFor,
  emptyMessage = 'Nothing to show yet.',
  max: maxOverride,
}: {
  points: SeriesPoint[];
  caption: string;
  colorFor?: (label: string) => string;
  emptyMessage?: string;
  max?: number;
}) {
  if (points.length === 0) return <ChartEmpty message={emptyMessage} />;

  const max = maxOverride ?? Math.max(...points.map((p) => p.value), 1);

  return (
    <figure className="w-full">
      <ul className="space-y-2" aria-label={caption}>
        {points.map((p) => {
          const pct = (p.value / max) * 100;
          return (
            <li key={p.label} className="group">
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="truncate text-xs text-foreground">{p.label}</span>
                <span className="tabular shrink-0 text-xs font-medium text-muted-foreground">
                  {formatNumber(p.value)}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{
                    width: `${Math.max(pct, p.value > 0 ? 2 : 0)}%`,
                    backgroundColor: colorFor?.(p.label) ?? 'var(--primary)',
                  }}
                />
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

