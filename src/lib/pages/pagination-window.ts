/**
 * Pure pagination helpers for the storefront listing surface — no React, no DOM,
 * no server-only deps, so the off-by-one-prone math is unit-testable in isolation
 * (see src/lib/db/tests/pagination-window.test.ts) and shared by the client grid.
 */

/** A windowed page list with ellipses: 1 … (p-1) p (p+1) … last. */
export function pageWindow(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | "…")[] = [1];
  const lo = Math.max(2, current - 1);
  const hi = Math.min(total - 1, current + 1);
  if (lo > 2) out.push("…");
  for (let p = lo; p <= hi; p += 1) out.push(p);
  if (hi < total - 1) out.push("…");
  out.push(total);
  return out;
}

/**
 * Clamp + slice math for the classic numbered "pagination" display mode.
 * Always yields at least one page; clamps `page` into `[1, totalPages]` so a
 * filter that shrinks the result set can't leave the view on a now-empty page.
 * `end` is bounded by `totalItems` so the final page never over-slices.
 */
export function paginate(
  totalItems: number,
  pageSize: number,
  page: number,
): { totalPages: number; currentPage: number; start: number; end: number } {
  const size = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(Math.max(0, totalItems) / size));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * size;
  const end = Math.min(start + size, Math.max(0, totalItems));
  return { totalPages, currentPage, start, end };
}
