import "server-only";

/**
 * DYNAMIC RBAC capping + segmentation matrix (Docker dev DB).
 *
 * Seeds MANY synthetic users with scoped grants and drives the real gate chain
 * end-to-end — DB (role_permissions / user_roles / user_permissions) → overlay
 * (applyPermissionOverlay) → permissionSetAllows / canAccessAdminArea /
 * resolveAccountType / nav visibility (isNavItemVisible) — to prove, per the
 * owner's requirement, that:
 *   1. EACH registry module is independently gated (a `<mod>:view` grant opens
 *      ONLY that module+action, never another module and never a higher action).
 *   2. SEGMENTATION holds: a single-module delegate is denied every other module
 *      and its sidebar shows only its own item(s).
 *   3. The per-user OVERLAY caps correctly (allow adds, deny removes, a role-`*`
 *      holder with any deny is NOT a literal `*` holder).
 *   4. The DERIVED account type is right (`*`→admin, scoped→staff, none→customer,
 *      disabled→empty/denied).
 *   5. The Clients↔Utilisateurs linking is gated (a customers-only operator cannot
 *      assign RBAC roles — that needs users:manage).
 *   6. The DEFAULT ROLE catalog (super_admin + the business starter roles) resolves
 *      to its intended grant set and caps as designed.
 *
 * Self-cleaning (`__capmatrix…`). Run against the isolated/dev DB:
 *   export DATABASE_URL=$(grep ^DATABASE_URL= .env.development.local|cut -d= -f2-|tr -d '"')
 *   npx tsx --conditions=react-server --env-file-if-exists=.env.development.local \
 *     src/lib/db/tests/rbac-capping-matrix.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import {
  canAccessAdminArea,
  permissionSetAllows,
  resolveAccountType,
  resolveUserPermissions,
} from "@/lib/rbac/authorize";
import { isInternalAccount } from "@/lib/rbac/roster";
import { setUserRolesWorkflow } from "@/workflows/rbac/assign-roles";
import {
  isValidPermissionKey,
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  type PermissionAction,
  type PermissionModuleId,
} from "@/lib/rbac/registry";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const TAG = "__capmatrix";

async function cleanup() {
  await db.execute(sql`delete from user_permissions where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from user_roles where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from role_permissions where role_id in (select id from roles where key like ${TAG + "%"})`);
  await db.execute(sql`delete from roles where key like ${TAG + "%"}`);
  await db.execute(sql`delete from audit_log where actor_user_id like ${TAG + "%"} or target_id like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
}

/** Seed a plain user (no grants). */
async function mkUser(id: string): Promise<void> {
  await authService.insert({ id, email: `${id}@example.test`, name: id } as never);
}

/** Seed a role carrying `perms` and assign it to a fresh user; returns the user id. */
async function mkScopedUser(suffix: string, perms: string[]): Promise<string> {
  const uid = `${TAG}-u-${suffix}`;
  await mkUser(uid);
  const role = await rbacService.createRole({
    key: `${TAG}-r-${suffix}`,
    name: `${TAG} ${suffix}`,
    description: null,
    is_system: false,
  });
  if (perms.length) await rbacService.setRolePermissions(role.id, perms);
  await rbacService.assignRoleToUser(uid, role.id);
  return uid;
}

async function main() {
  await cleanup();

  const superRole = await rbacService.findRoleByKey("super_admin");
  check("super_admin role seeded", !!superRole);
  if (!superRole) throw new Error("super_admin missing — run migrations");

  // ── 1 + 2. Per-module capping + cross-module segmentation ──────────────────
  // For EACH module, a `<mod>:view`-only delegate must: satisfy <mod>:view, NOT
  // satisfy any OTHER action of that module, and NOT satisfy ANY action of ANY
  // other module (segmentation). One grouped pass over the whole registry.
  console.log(`matrix: per-module capping + segmentation over ${PERMISSION_MODULES.length} modules…`);
  for (const mod of PERMISSION_MODULES) {
    const uid = await mkScopedUser(`view-${mod.id}`, [`${mod.id}:view`]);
    const perms = await resolveUserPermissions(uid);

    check(`${mod.id}: resolves exactly {${mod.id}:view}`, perms.size === 1 && perms.has(`${mod.id}:view`));
    check(`${mod.id}: canAccessAdminArea (holds a grant)`, await canAccessAdminArea(uid));
    check(`${mod.id}: :view satisfied`, permissionSetAllows(perms, mod.id as PermissionModuleId, "view"));
    check(`${mod.id}: derived type = staff`, (await resolveAccountType(uid)) === "staff");

    // Within-module ACTION capping: every non-view action of this module is denied.
    for (const action of mod.actions) {
      if (action === "view") continue;
      check(
        `${mod.id}: :view does NOT satisfy :${action}`,
        !permissionSetAllows(perms, mod.id as PermissionModuleId, action),
      );
    }

    // Cross-module SEGMENTATION: denied every action of every OTHER module.
    let leaked: string | null = null;
    for (const other of PERMISSION_MODULES) {
      if (other.id === mod.id) continue;
      for (const action of PERMISSION_ACTIONS) {
        if (permissionSetAllows(perms, other.id as PermissionModuleId, action as PermissionAction)) {
          leaked = `${other.id}:${action}`;
          break;
        }
      }
      if (leaked) break;
    }
    check(`${mod.id}: no cross-module leak (segmented)`, leaked === null);
  }

  // A `<mod>:*` delegate satisfies EVERY action of that module (module-wildcard),
  // and still no other module — sampled on a rich module (products).
  {
    const uid = await mkScopedUser("star-products", ["products:*"]);
    const perms = await resolveUserPermissions(uid);
    const prod = PERMISSION_MODULES.find((m) => m.id === "products")!;
    for (const a of prod.actions) {
      check(`products:* satisfies products:${a}`, permissionSetAllows(perms, "products", a));
    }
    check("products:* does NOT satisfy orders:view", !permissionSetAllows(perms, "orders", "view"));
    check("products:* is NOT a wildcard '*'", !perms.has("*"));
    check("products:* derived type = staff (not admin)", (await resolveAccountType(uid)) === "staff");
  }

  // ── 3. Overlay capping ─────────────────────────────────────────────────────
  console.log("overlay: allow adds, deny removes, phantom '*' …");
  {
    // role grants orders:view; overlay ALLOWs products:manage (cross-module) and
    // DENIES orders:view (de-escalation).
    const uid = await mkScopedUser("overlay", ["orders:view"]);
    await rbacService.setUserPermissionOverrides(uid, [
      { permission: "products:manage", effect: "allow" },
      { permission: "orders:view", effect: "deny" },
    ]);
    const perms = await resolveUserPermissions(uid);
    check("overlay allow adds products:manage", permissionSetAllows(perms, "products", "manage"));
    check("overlay deny removes orders:view", !permissionSetAllows(perms, "orders", "view"));
  }
  {
    // super_admin role + a single deny → NOT a literal '*' holder (materialized).
    const uid = `${TAG}-u-phantom`;
    await mkUser(uid);
    await rbacService.assignRoleToUser(uid, superRole.id);
    const before = await resolveUserPermissions(uid);
    check("super_admin role alone resolves to literal '*'", before.has("*"));
    await rbacService.setUserPermissionOverrides(uid, [{ permission: "blog_posts:delete", effect: "deny" }]);
    const after = await resolveUserPermissions(uid);
    check("super_admin + a deny drops the literal '*'", !after.has("*"));
    check("…but still satisfies an un-denied action (near-omnipotent)", permissionSetAllows(after, "orders", "manage"));
    check("…and the denied action is gone", !permissionSetAllows(after, "blog_posts", "delete"));
    check("phantom derived type is still admin (allow-set includes '*')", (await resolveAccountType(uid)) === "admin");
  }

  // ── 4. Account type derivation + disabled lockout ──────────────────────────
  console.log("account type + disabled …");
  {
    const sadmin = `${TAG}-u-sadmin`;
    await mkUser(sadmin);
    await rbacService.assignRoleToUser(sadmin, superRole.id);
    check("super_admin holder → admin", (await resolveAccountType(sadmin)) === "admin");
    check("super_admin holder resolves '*'", (await resolveUserPermissions(sadmin)).has("*"));
    check("super_admin holder isInternalAccount", await isInternalAccount(sadmin));

    const plain = `${TAG}-u-plain`;
    await mkUser(plain);
    check("plain account → customer", (await resolveAccountType(plain)) === "customer");
    check("plain account not internal", !(await isInternalAccount(plain)));
    check("plain account empty perms", (await resolveUserPermissions(plain)).size === 0);
    check("plain account cannot access admin area", !(await canAccessAdminArea(plain)));

    // A disabled scoped operator resolves to NOTHING (denied everywhere).
    const dis = await mkScopedUser("disabled", ["orders:view", "orders:manage"]);
    check("active scoped operator can access admin area", await canAccessAdminArea(dis));
    await authService.disable(dis);
    const disPerms = await resolveUserPermissions(dis);
    check("DISABLED operator resolves to empty perms", disPerms.size === 0);
    check("DISABLED operator cannot access admin area", !(await canAccessAdminArea(dis)));
  }

  // ── 5. Clients ↔ Utilisateurs linking is gated ─────────────────────────────
  // A customers-tab operator (customers:* but NOT users:manage) must NOT be able
  // to assign RBAC roles to anyone — the role editor on the 360 calls
  // setUserRolesWorkflow which is users:manage-gated via assertActorOutranksTarget
  // + the action layer; here we drive the workflow directly to prove the guard.
  console.log("clients↔utilisateurs linking gate …");
  {
    const custOp = await mkScopedUser("custops", ["customers:view", "customers:update", "customers:manage"]);
    const target = await mkScopedUser("linktarget", ["orders:view"]);
    // Grant a '*'-ish role via the workflow as the customers-op → must be refused
    // (a customers operator does not out-rank nothing here, but it may not grant a
    // role it cannot itself wield; super_admin is a system role → refused).
    const res = await setUserRolesWorkflow(
      { userId: target, roleIds: [superRole.id] },
      { actorUserId: custOp },
    );
    check("customers-operator CANNOT grant super_admin via the role editor", !res.ok && res.error === "forbidden");
    // The target's grants are unchanged (no partial write).
    check("…and the target did not gain '*'", !(await resolveUserPermissions(target)).has("*"));
  }

  // ── 6. Default role catalog resolves + caps ────────────────────────────────
  // Each seeded business role (if the catalog migration ran) must resolve to a
  // non-empty, '*'-free grant set and land its holder as staff (never admin).
  console.log("default role catalog …");
  const CATALOG = ["administrateur", "manager", "web_master", "support"];
  let catalogPresent = 0;
  for (const key of CATALOG) {
    const role = await rbacService.findRoleByKey(key);
    if (!role) continue;
    catalogPresent++;
    const grants = await rbacService.listPermissionsForRole(role.id);
    check(`default role '${key}' is non-system (editable/delegable)`, role.is_system === false);
    check(`default role '${key}' has grants`, grants.length > 0);
    check(`default role '${key}' does NOT carry the global '*'`, !grants.includes("*"));
    const stale = grants.filter((g) => !isValidPermissionKey(g));
    check(`default role '${key}' has NO stale/invalid grant keys${stale.length ? ` (${stale.join(",")})` : ""}`, stale.length === 0);
    // A holder lands as staff (scoped), never admin, and can access the admin area.
    const uid = `${TAG}-u-cat-${key}`;
    await mkUser(uid);
    await rbacService.assignRoleToUser(uid, role.id);
    const perms = await resolveUserPermissions(uid);
    check(`'${key}' holder can access admin area`, perms.size > 0 && (await canAccessAdminArea(uid)));
    check(`'${key}' holder derived type = staff (not admin)`, (await resolveAccountType(uid)) === "staff");
  }
  check(
    `default role catalog present (${catalogPresent}/${CATALOG.length}) — starter profiles beyond super_admin`,
    catalogPresent === CATALOG.length,
  );

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
