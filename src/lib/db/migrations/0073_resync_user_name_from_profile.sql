-- One-time backfill: resync the denormalised `users.name` from each user's
-- linked customer profile where the two have DRIFTED.
--
-- `users.name` is a denormalised `${first_name} ${last_name}` copy of the linked
-- customer_profiles row. The sync subscriber (sync-user-name-from-profile) only
-- fires on a profile EDIT, so an account whose profile name was set once at
-- creation/seed and never re-edited (or that predates the subscriber) keeps a
-- stale `users.name` — e.g. an owner row showing the signup name instead of the
-- current fiche-client name. The Utilisateurs list now reads the live profile
-- name, but other readers (audit actor names, order link-candidate names, the
-- customer-360 header) still read `users.name`, so fix the stored copy once here.
--
-- Composes exactly like signup / the sync helper: trim of "first last" (handles a
-- blank half). Never blanks the NOT NULL column (skips empty composed names).
-- Idempotent: `IS DISTINCT FROM` only touches genuinely-drifted rows.
UPDATE "users" u
SET "name" = btrim(p."first_name" || ' ' || p."last_name")
FROM "customer_user_links" l
JOIN "customer_profiles" p ON p."id" = l."customer_profile_id"
WHERE l."user_id" = u."id"
  AND p."deleted_at" IS NULL
  AND btrim(p."first_name" || ' ' || p."last_name") <> ''
  AND u."name" IS DISTINCT FROM btrim(p."first_name" || ' ' || p."last_name");
