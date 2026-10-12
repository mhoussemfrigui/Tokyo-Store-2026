/**
 * Tiny inline trend sparkline — pure SVG, server-renderable (no hooks, no client
 * JS). Drives the dashboard KPI cards. Colour comes from `currentColor` (set the
 * parent's text colour via `strokeClass`) so the area + line share one tint and
 * there are NO gradient ids to collide when several sparklines sit on one page.
 *
 * Renders nothing for fewer than 2 points, or an all-equal series, so a flat or
 * empty window doesn't draw a misleading line.
 */
export function Sparkline({
  data,
  className = "",
  strokeClass = "text-primary",
  width = 120,
  height = 34,
}: {
  data: number[];
  className?: string;
  /** Tailwind text-* class — sets `currentColor` for both stroke and area. */
  strokeClass?: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min;
  if (span === 0) return null; // perfectly flat → no signal worth drawing

  const pad = 2;
  const stepX = (width - pad * 2) / (data.length - 1);
  const pts = data.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (height - pad * 2) * (1 - (v - min) / span);
    return [x, y] as const;
  });
  const line = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
  const last = pts[pts.length - 1];
  const first = pts[0];
  const area = `${line} L${last[0].toFixed(1)} ${height} L${first[0].toFixed(1)} ${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={`${strokeClass} ${className}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <path d={area} fill="currentColor" fillOpacity={0.1} stroke="none" />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={last[0]} cy={last[1]} r={2.4} fill="currentColor" />
    </svg>
  );
}
