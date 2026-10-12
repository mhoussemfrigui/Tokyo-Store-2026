-- Remove the promo-links ("Boutons rapides") feature entirely. The admin
-- persisted chips (label/icon/colors/flashMode/schedule) but NO storefront
-- surface ever rendered them — dead since the luxury reskin. Drops the table
-- and purges every leftover RBAC permission row for the removed module.
DROP TABLE IF EXISTS "promo_links" CASCADE;--> statement-breakpoint
DELETE FROM "role_permissions" WHERE "permission" LIKE 'promo_links:%';
