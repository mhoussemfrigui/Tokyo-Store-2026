-- 0205 — Drop two now-inert promotion columns left behind by 0204's subsystem
-- removal. Both were only ever meaningful to the removed B2B / member-discount
-- features: `business_id` (legacy single-business eligibility filter, superseded
-- by promotion_targets and always written NULL since migration 0042) and
-- `stack_with_member_discount` (per-promo override of member-discount stacking —
-- there is no member discount anymore). Neither is read by live code; dropping
-- them removes the last residue. Forward DROP migration, idempotent (IF EXISTS).
ALTER TABLE "promotions" DROP COLUMN IF EXISTS "business_id";--> statement-breakpoint
ALTER TABLE "promotions" DROP COLUMN IF EXISTS "stack_with_member_discount";
