-- 0061 — Seed the "system pages" (help + legal) as protected CMS pages.
--
-- /help and the 5 legal routes (/cgu /cgv /privacy /cookies /mentions-legales)
-- render a CMS page BY SLUG, but the slugs were never created, so admins saw
-- fallback placeholders and had nowhere to edit them. This seeds the rows (once)
-- with is_system=true so they appear in the admin Pages list, can't be deleted,
-- and give the operator a place to add content. Left UNPUBLISHED so the
-- storefront keeps its current fallback until the operator adds sections +
-- publishes. Idempotent (insert by slug only when absent). is_system column
-- added in 0060.

INSERT INTO "pages" ("slug", "title", "is_published", "is_system", "published_at")
SELECT v.slug, v.title, false, true, NULL
FROM (VALUES
  ('help', 'Aide & contact'),
  ('cgu', 'Conditions générales d''utilisation'),
  ('cgv', 'Conditions générales de vente'),
  ('privacy', 'Politique de confidentialité'),
  ('cookies', 'Politique de cookies'),
  ('mentions-legales', 'Mentions légales')
) AS v(slug, title)
WHERE NOT EXISTS (SELECT 1 FROM "pages" p WHERE p.slug = v.slug);

-- A page an operator already created by hand for one of these slugs becomes a
-- protected system page too (no duplicate — the INSERT above skipped it).
UPDATE "pages" SET "is_system" = true
WHERE "slug" IN ('help', 'cgu', 'cgv', 'privacy', 'cookies', 'mentions-legales')
  AND "is_system" = false
  AND "deleted_at" IS NULL;
