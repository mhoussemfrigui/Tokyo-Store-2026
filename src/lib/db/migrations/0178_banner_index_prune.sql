-- 0178 — prune redundant banner indexes (stability / write-overhead; no read regression).
--
-- The partial index `banners_live_placement_order_idx` (placement, display_order)
-- WHERE is_active = true AND deleted_at IS NULL already serves every live read
-- (listLive / listGridBannersForListing), and `banners_placement_idx` serves the
-- active-agnostic singleton lookup (findAnyByPlacement). That leaves three indexes
-- that NO query can use as a leading-column choice, so they are pure write overhead:
--   * banners_active_idx     — is_active alone (a 2-value boolean; never selective,
--                              and the live partial already encodes is_active = true).
--   * banners_order_idx      — display_order alone (never filtered/ordered without a
--                              placement scope; the live partial covers that pairing).
--   * banners_scheduled_idx  — (start_at, end_at) WHERE is_active AND not deleted; no
--                              query filters the schedule window WITHOUT a placement,
--                              so the planner always prefers the placement index.
-- Kept: pkey, placement_idx, target_idx, live_placement_order_idx, and the
-- image/image_mobile media partials. Mirrors migration 0126's product-index prune.
DROP INDEX IF EXISTS "banners_active_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "banners_order_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "banners_scheduled_idx";
