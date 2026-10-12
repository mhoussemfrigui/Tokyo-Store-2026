/**
 * Pure listing-pagination helpers — the windowed page list + the clamp/slice
 * math shared by the storefront listing grid (CategoryPageClient). No DB, no
 * React; runs without Docker.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/pagination-window.test.ts
 */
import { pageWindow, paginate } from "@/lib/pages/pagination-window";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function main() {
  console.log("pageWindow:");
  check("≤7 pages → all shown, no ellipsis", eq(pageWindow(1, 7), [1, 2, 3, 4, 5, 6, 7]));
  check("1 page → [1]", eq(pageWindow(1, 1), [1]));
  check("0 pages → []", eq(pageWindow(1, 0), []));
  check("near start → trailing ellipsis only", eq(pageWindow(1, 10), [1, 2, "…", 10]));
  check("near end → leading ellipsis only", eq(pageWindow(10, 10), [1, "…", 9, 10]));
  check("middle → both ellipses", eq(pageWindow(5, 10), [1, "…", 4, 5, 6, "…", 10]));
  check("first + last always present", (() => {
    const w = pageWindow(5, 21);
    return w[0] === 1 && w[w.length - 1] === 21;
  })());
  check("current page always inside the window", (() => {
    for (let p = 1; p <= 21; p++) if (!pageWindow(p, 21).includes(p)) return false;
    return true;
  })());

  console.log("paginate:");
  check("empty set → 1 page, empty slice", eq(paginate(0, 12, 1), { totalPages: 1, currentPage: 1, start: 0, end: 0 }));
  check("exact multiple → no trailing page", paginate(24, 12, 1).totalPages === 2);
  check("remainder → extra page", paginate(25, 12, 1).totalPages === 3);
  check("page 1 slice is [0,12)", (() => {
    const r = paginate(25, 12, 1);
    return r.start === 0 && r.end === 12;
  })());
  check("last page slice is bounded by total (no over-slice)", (() => {
    const r = paginate(25, 12, 3);
    return r.start === 24 && r.end === 25; // only 1 item on the last page
  })());
  check("page below 1 clamps up to 1", paginate(25, 12, 0).currentPage === 1);
  check("page above totalPages clamps down (filter shrink)", paginate(25, 12, 99).currentPage === 3);
  check("clamped page yields a valid in-range slice", (() => {
    const r = paginate(25, 12, 99);
    return r.start === 24 && r.end === 25;
  })());
  check("pageSize floored to ≥1 (never divide by zero)", paginate(5, 0, 1).totalPages === 5);
  check("negative total treated as empty", eq(paginate(-3, 12, 1), { totalPages: 1, currentPage: 1, start: 0, end: 0 }));

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
