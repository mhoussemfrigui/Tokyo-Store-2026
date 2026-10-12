-- 0160 — life-event DATE for anniversary segmentation & pre-emptive mailing.
--
-- Phase 6 lets the owner target customers « X jours avant » an anniversary (e.g. a
-- wedding anniversary) for a mailing + promo. That needs the ACTUAL event date, which
-- loyalty_life_stage_claims never stored (only when it was declared/verified). The date
-- is CUSTOMER-PROVIDED on the /account declaration form; nullable, NO backfill (a past
-- event's date can't be invented), so anniversary targeting ramps up as customers add it.
ALTER TABLE "loyalty_life_stage_claims" ADD COLUMN "event_date" date;--> statement-breakpoint

-- Anniversary probes filter by (month, day) of a VERIFIED claim's event_date daily.
-- extract() on a date is IMMUTABLE (to_char is not), so this partial functional index
-- serves it — the twin of customer_profiles_birthday_md_idx (0047).
CREATE INDEX "loyalty_life_stage_event_md_idx"
  ON "loyalty_life_stage_claims" (extract(month from "event_date"), extract(day from "event_date"))
  WHERE "event_date" IS NOT NULL AND "status" = 'verified';--> statement-breakpoint

-- « Has a verified life-event of stage X » whole-audience scans.
CREATE INDEX "loyalty_life_stage_stage_verified_idx"
  ON "loyalty_life_stage_claims" ("stage") WHERE "status" = 'verified';
