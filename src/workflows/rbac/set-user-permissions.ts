import "server-only";

import { z } from "zod";

import { authService } from "@/modules/auth/service";
import { apiKeyService } from "@/modules/api-key/service";
import { rbacService } from "@/modules/rbac/service";
import { assertActorMayGrantPermissionKeys, assertActorOutranksTarget } from "@/lib/rbac/guards";
import { isValidPermissionKey, WILDCARD } from "@/lib/rbac/registry";
import { applyPermissionOverlay, materializePermissionSet } from "@/lib/rbac/overlay";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Replace a user's per-user permission OVERLAY (0191) — the allow/deny deltas
 * layered on top of their roles, edited from the matrix on the Utilisateurs fiche.
 * The desired full set is sent; we validate, apply, and emit
 * `user.permissions_changed`.
 *
 * GUARDS (mirror the role-assignment path):
 *   - the GLOBAL wildcard `*` is REFUSED as an override target — super-admin is a
 *     role-only decision, so the last-admin floor (role-granted `*`) can't be
 *     fooled and no per-user override can mint/strip a super-admin. `<module>:*` ok.
 *   - every key must be a real registry key (typos/stale keys rejected up-front).
 *   - a non-wildcard actor may not touch a higher-privileged target
 *     (assertActorOutranksTarget), and may only ALLOW keys it holds itself
 *     (assertActorMayGrantPermissionKeys) — DENY is de-escalation, unrestricted.
 *   - on a real de-escalation (the effective set shrank) the target's live sessions
 *     + API keys are revoked so the reduced grant set takes effect actively.
 */
const overrideInput = z.object({
  permission: z.string().trim().min(1).max(100),
  effect: z.enum(["allow", "deny"]),
});
export const setUserPermissionsSchema = z.object({
  userId: z.string().min(1),
  overrides: z.array(overrideInput).max(500),
});
export type SetUserPermissionsInput = z.input<typeof setUserPermissionsSchema>;

export const setUserPermissionsWorkflow = workflow<
  [SetUserPermissionsInput, { actorUserId: string }],
  { userId: string; allowCount: number; denyCount: number }
>("rbac.set_user_permissions", async (input, { actorUserId }) => {
  const parsed = setUserPermissionsSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Données invalides.");
  const { userId, overrides } = parsed.data;

  const user = await authService.findById(userId);
  if (!user) return fail("not_found", "Utilisateur introuvable.");

  // NO self-service overlay edit. assertActorOutranksTarget passes self, and only
  // ALLOW keys are rank-checked — so without this a restricted operator could
  // REMOVE its OWN deny override (neither an allow nor rank-checked) and regain a
  // permission a higher actor deliberately denied it. Managing your own access is
  // never a self-op (mirrors the self-action guards on disable / set-email).
  if (userId === actorUserId) {
    return fail("self_action", "Vous ne pouvez pas modifier vos propres permissions.");
  }

  // A role-super-admin (a role granting the global `*`) is NEVER overlay-editable:
  // a per-user DENY on them would force subtractDenies to MATERIALIZE their `*` to
  // concrete keys and drop the `*` sentinel that requireSuperAdmin / resolveAccountType
  // and the last-admin floor (countEffectiveWildcardAdmins, which counts role-granted
  // `*`) all key on — silently dropping them below admin while the SQL floor still
  // counts them, which can drive the effective super-admin count to zero (a hard
  // lockout). super-admin is a ROLE-only decision; manage it via roles. (An
  // « administrateur » role carrying all concrete keys — NOT `*` — stays overlay-
  // editable, so "all except X" is still doable.)
  const roleGrants = await rbacService.listPermissionsForUser(userId);
  if (roleGrants.includes(WILDCARD)) {
    return fail(
      "forbidden",
      "Ce compte est super-administrateur (accès total via un rôle) : gérez son accès via les rôles, pas par utilisateur.",
    );
  }

  // Validate + dedupe by key (last effect wins).
  const byKey = new Map<string, "allow" | "deny">();
  for (const o of overrides) {
    if (o.permission === WILDCARD) {
      return fail(
        "validation",
        "L'accès total (« * ») s'accorde via le rôle super-administrateur, pas par utilisateur.",
      );
    }
    if (!isValidPermissionKey(o.permission)) {
      return fail("validation", `Permission inconnue : ${o.permission}.`);
    }
    byKey.set(o.permission, o.effect);
  }
  const deduped = [...byKey.entries()].map(([permission, effect]) => ({ permission, effect }));

  // A non-wildcard actor may not modify a higher-privileged target.
  const outranked = await assertActorOutranksTarget(actorUserId, userId);
  if (outranked) return outranked;

  // ALLOW keys must be ones the actor could itself wield (no granting above your
  // own); DENY is de-escalation, unrestricted.
  const allowKeys = deduped.filter((o) => o.effect === "allow").map((o) => o.permission);
  const denyKeys = deduped.filter((o) => o.effect === "deny").map((o) => o.permission);
  const denied = await assertActorMayGrantPermissionKeys(actorUserId, allowKeys);
  if (denied) return denied;

  // Snapshot effective perms BEFORE the write (materialized so before/after compare
  // like-for-like). Reuse `roleGrants` (roles are unchanged by this op).
  const currentOverrides = await rbacService.listUserPermissionOverrides(userId);
  const before = materializePermissionSet(applyPermissionOverlay(roleGrants, currentOverrides));

  await rbacService.setUserPermissionOverrides(userId, deduped);

  const after = materializePermissionSet(applyPermissionOverlay(roleGrants, deduped));
  const lost = [...before].filter((p) => !after.has(p));
  if (lost.length > 0) {
    // De-escalation → force re-auth under the reduced grant set (mirrors the role
    // path). API keys write with the creator's identity and outlive cookies, so
    // they go too.
    await authService.deleteSessionsForUser(userId);
    await apiKeyService.revokeAllForUser(userId).catch(() => [] as string[]);
  }

  await bus.emit(
    "user.permissions_changed",
    { userId, allowCount: allowKeys.length, denyCount: denyKeys.length },
    { actorUserId },
  );
  return ok({ userId, allowCount: allowKeys.length, denyCount: denyKeys.length });
});
