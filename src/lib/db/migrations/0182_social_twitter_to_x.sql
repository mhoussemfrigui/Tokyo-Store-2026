-- 0182 — rename the social.twitter setting key → social.x (X, ex-Twitter) + relabel.
-- Preserves the stored URL on existing installs; the admin forms, footer, SEO
-- sameAs and email brand now read social.x. Guarded so it no-ops when a social.x
-- row already exists (avoids the settings_key_unique conflict).
UPDATE site_settings
   SET key = 'social.x', label = 'X (URL)', updated_at = now()
 WHERE key = 'social.twitter'
   AND NOT EXISTS (SELECT 1 FROM site_settings WHERE key = 'social.x');
