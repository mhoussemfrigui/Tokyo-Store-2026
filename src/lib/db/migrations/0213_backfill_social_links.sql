-- 0213 — Backfill « Identité & contact » social links into the one array key.
--
-- Socials used to live in SIX single-value settings (`social.instagram`,
-- `social.facebook`, `social.x`, `social.youtube`, `social.tiktok`,
-- `social.linkedin`) — one URL per network. The editor now stores an ORDERED
-- ARRAY under `social.links` so an operator can list MANY accounts per platform
-- (two Facebook pages, a second Instagram…). `resolveSocialList` already reads
-- the legacy keys at request time, so nothing broke; this migration MATERIALISES
-- that same list into `social.links` once, so the canonical key exists in the
-- store (the admin editor + every consumer then read the array directly, and the
-- legacy keys become inert — kept only for the read-time fallback).
--
-- Guarded + idempotent:
--   • runs ONLY when `social.links` is absent (a site that already saved via the
--     new editor is left untouched), and
--   • only when at least one legacy key holds a non-empty URL (an empty site
--     gets no row — never an empty `[]`).
-- The array is built in the SAME canonical platform order as SOCIAL_PLATFORMS,
-- as `[{"p":<platform>,"u":<url>}]` (no label — the legacy keys had none), which
-- is exactly what `parseSocialList` expects.

INSERT INTO site_settings (key, value, type, group_key, label)
SELECT
  'social.links',
  (
    SELECT jsonb_agg(jsonb_build_object('p', p.platform, 'u', TRIM(s.value)) ORDER BY p.ord)::text
    FROM (VALUES
      ('social.instagram', 'instagram', 1),
      ('social.facebook',  'facebook',  2),
      ('social.x',         'x',         3),
      ('social.youtube',   'youtube',   4),
      ('social.tiktok',    'tiktok',    5),
      ('social.linkedin',  'linkedin',  6)
    ) AS p(legacy_key, platform, ord)
    JOIN site_settings s ON s.key = p.legacy_key AND COALESCE(TRIM(s.value), '') <> ''
  ),
  'text',
  'social',
  'Réseaux sociaux'
WHERE NOT EXISTS (SELECT 1 FROM site_settings WHERE key = 'social.links')
  AND EXISTS (
    SELECT 1 FROM site_settings s
    WHERE s.key IN (
      'social.instagram', 'social.facebook', 'social.x',
      'social.youtube', 'social.tiktok', 'social.linkedin'
    )
    AND COALESCE(TRIM(s.value), '') <> ''
  );
