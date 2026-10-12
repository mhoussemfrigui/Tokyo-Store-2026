-- 0131 — Separate /boutique chooser image from the category page hero.
--
-- The /boutique landing renders one image card per top-level category; it was
-- pulling `categories.hero_media_id` — the SAME image as the category page's
-- wide hero banner. Add a dedicated, admin-settable `boutique_image_media_id`
-- so the two can differ. Soft link to media (a text id, like the other
-- `*_media_id` columns), nullable — unset ⇒ the boutique card shows a gradient
-- (NO fallback to the hero, by design). Additive + idempotent.

ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "boutique_image_media_id" text;
