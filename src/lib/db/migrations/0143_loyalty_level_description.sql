-- 0143 — Editable niveau description (public "reach" / accroche text)
--
-- Adds an optional free-text `description` to loyalty_levels so an operator can
-- OVERRIDE the auto-generated reach sentence shown on the public /fidelite cards
-- and the /account « Tous les niveaux » tiles (e.g. « À partir de 1 500 TND, en 3
-- achats minimum »). NULL / empty ⇒ fall back to the generated default
-- (src/lib/loyalty/level-benefits.ts reachSentence).
--
-- SAFE: nullable, no default, no backfill — existing rows keep the generated text.

ALTER TABLE "loyalty_levels" ADD COLUMN "description" text;--> statement-breakpoint
