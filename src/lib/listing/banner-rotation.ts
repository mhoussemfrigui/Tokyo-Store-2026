/**
 * In-grid (`category_grid`) banner cadence + rotation — the ONE rule the
 * storefront listing grid (`[slug]/category-client.tsx`) renders with, shared
 * with its unit tests (listing-engine / banner-targeting). Pure: no React, no
 * server-only.
 *
 * Each banner's `gridPosition` (migration 0177) decides WHERE it shows:
 *   - `top`             — pinned ABOVE the listing (not part of the schedule here;
 *                         the client renders every `top` banner above the grid).
 *   - `after_load_more` — once, at the FIRST block boundary only.
 *   - `after_rows`      — interspersed at every Nth PAGE_SIZE « block » boundary
 *                         (N = `afterLoadMoreCount`; the legacy cadence).
 * A « block » is the 1-indexed count of full product blocks above the boundary,
 * counted over the WHOLE sorted list — so the pagination display mode (one block
 * per page) lands on the same blocks as « Charger plus ». N ≤ 0 / non-finite → 1.
 *
 * Exactly ONE banner renders per boundary. When several are due it is picked by
 * FAIR rotation: the due banner shown the FEWEST times so far wins, ties going
 * to the one shown least recently, then to display order. The old rule indexed
 * the due list by the block number (`due[(blk - 1) % due.length]`): two banners
 * at the default N = 2 are only due at even blocks, where `(blk - 1) % 2` is
 * always 1, so the first was NEVER shown. A plain running slot counter
 * (`due[slot % due.length]`) fixes equal cadences but still starves a banner
 * under mixed ones (two at N = 2 + two at N = 1 never reach the first), hence
 * the least-shown rule — every banner that keeps coming due is eventually shown.
 */
import type { GridPosition } from "@/lib/cms/banner-model";

/** Minimal banner shape the rotation needs (RenderableBanner satisfies it). */
export type CadencedBanner = { afterLoadMoreCount: number; gridPosition: GridPosition };

/** Normalised cadence: a positive integer (≤ 0 / NaN / fractional-below-1 → 1). */
function cadenceOf(afterLoadMoreCount: number): number {
  const n = Math.trunc(Number(afterLoadMoreCount));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Whether `banner` is due at `block` (1-indexed), honouring its grid position:
 * `top` never schedules (pinned above the grid), `after_load_more` is due only at
 * block 1, `after_rows` is due at every multiple of its cadence.
 */
export function isBannerDueAtBlock(banner: CadencedBanner, block: number): boolean {
  if (block < 1) return false;
  switch (banner.gridPosition) {
    case "top":
      return false;
    case "after_load_more":
      return block === 1;
    default:
      return block % cadenceOf(banner.afterLoadMoreCount) === 0;
  }
}

/**
 * The banner shown at each block boundary 1..`blocks` (index `block - 1`), or
 * null where none is due. `top`-positioned banners never appear (the client pins
 * them above the grid). Deterministic for a given banner list, so every render /
 * page computes the same schedule. O(blocks × banners).
 */
export function gridBannerSchedule<T extends CadencedBanner>(
  banners: readonly T[],
  blocks: number,
): (T | null)[] {
  const total = Math.max(0, Math.trunc(blocks) || 0);
  const shown = banners.map(() => 0);
  const lastShown = banners.map(() => 0);
  const out: (T | null)[] = [];
  for (let block = 1; block <= total; block++) {
    let pick = -1;
    for (let i = 0; i < banners.length; i++) {
      if (!isBannerDueAtBlock(banners[i], block)) continue;
      if (
        pick === -1 ||
        shown[i] < shown[pick] ||
        (shown[i] === shown[pick] && lastShown[i] < lastShown[pick])
      ) {
        pick = i;
      }
    }
    if (pick === -1) {
      out.push(null);
      continue;
    }
    shown[pick]++;
    lastShown[pick] = block;
    out.push(banners[pick]);
  }
  return out;
}

/**
 * The block boundary that follows the product at absolute `index` (0-based,
 * over the whole sorted list), or null when that product doesn't close a full
 * `pageSize` block or is the LAST one rendered (`lastIndex`) — a banner never
 * trails the final card. Load-more passes the last VISIBLE index; pagination
 * passes the last index of the whole list, so every non-final page ends on a
 * banner slot.
 */
export function bannerBlockAfter(index: number, pageSize: number, lastIndex: number): number | null {
  const size = Math.max(1, Math.trunc(pageSize) || 1);
  if ((index + 1) % size !== 0 || index >= lastIndex) return null;
  return (index + 1) / size;
}
