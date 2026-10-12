-- 0155 — three-tier company roles: add business_members.can_manage_roles.
--
-- Roles are now Employé (is_partner=false), Gestionnaire (is_partner=true,
-- can_manage_roles=false — manages team/levels/invitations but can't change roles),
-- and Gérant (is_partner=true, can_manage_roles=true — full, incl. naming managers).
-- Existing managers keep their full power: every current partner becomes a Gérant.
-- Idempotent.
ALTER TABLE "business_members" ADD COLUMN IF NOT EXISTS "can_manage_roles" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "business_members" SET "can_manage_roles" = true WHERE "is_partner" = true AND "can_manage_roles" = false;
