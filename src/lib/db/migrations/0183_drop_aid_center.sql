-- 0183 — remove the Aid Center (help) subsystem.
--
-- Drops the three aid_center tables, the aid_difficulty enum, and the
-- aide-only CMS/SEO settings keys. The in-module FKs (migration 0059) are
-- dropped with their tables; DROP TABLE also removes the generated
-- search_vector column + GIN / partial indexes from the 0000 baseline.
-- The BLOG subsystem (blog_posts / blog_categories / blog_tags) is untouched.
-- Idempotent + safe to re-run.

-- ── 1. tables (child → parent FK order; CASCADE for any stray dependency) ───
DROP TABLE IF EXISTS "aid_article_steps" CASCADE;
DROP TABLE IF EXISTS "aid_articles" CASCADE;
DROP TABLE IF EXISTS "aid_categories" CASCADE;

-- ── 2. enum (no dependents once aid_articles is gone) ───────────────────────
DROP TYPE IF EXISTS "aid_difficulty";

-- ── 3. aide-only settings keys ──────────────────────────────────────────────
DELETE FROM "site_settings" WHERE "key" = 'seo.sitemap_include_aide';
DELETE FROM "site_settings" WHERE "key" LIKE 'pages.aide.%';
