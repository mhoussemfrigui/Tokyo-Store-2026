-- 0176 — Nav item sub-title + two mis-mapped footer links.
--
-- `nav_items.description` is an optional one-line sub-title under a link's label. It powers
-- the « Explorer la maison » index at the foot of the Maison & legal content pages (menu
-- key `maison-explore`, edited in CMS → Footer), where each entry shows a short hint
-- (« La maison Tokyo », « Vos données »…). Nullable + additive: every existing menu keeps
-- rendering exactly as before (the header + footer columns ignore it).
ALTER TABLE "nav_items" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint

-- One-time fixes for the demo-seeded footer « Support » column, which pointed two links at
-- the wrong page. Guarded on the EXACT seeded state (label + old href + no internal target)
-- so a link an admin already re-pointed or renamed is never touched.
UPDATE "nav_items" SET "href" = '/suivi-de-commande', "updated_at" = now()
WHERE "label" = 'Suivi de commande' AND "href" = '/account' AND "internal_kind" IS NULL
  AND "menu_id" IN (SELECT "id" FROM "nav_menus" WHERE "key" = 'footer-support');--> statement-breakpoint
UPDATE "nav_items" SET "href" = '/garantie-retours', "updated_at" = now()
WHERE "label" = 'Garantie & retours' AND "href" = '/help' AND "internal_kind" IS NULL
  AND "menu_id" IN (SELECT "id" FROM "nav_menus" WHERE "key" = 'footer-support');
