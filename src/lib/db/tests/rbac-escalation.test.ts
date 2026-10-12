import "server-only";

/**
 * RBAC privilege-escalation regression test (SEC-1/2/3).
 *
 * Proves a NON-wildcard "users manager" delegate (the least-privilege account
 * RBAC exists to enable — holds users:view/create/manage but NOT '*') cannot:
 *   - assign itself the is_system super_admin role,
 *   - create or promote a full-access enum 'admin',
 *   - reset / disable an existing higher-privileged account,
 * while a wildcard admin still can, and the delegate is NOT falsely locked out
 * of managing a lower-or-equal target.
 *
 * Also proves the super-admin STEP-UP (src/lib/auth/super-admin.ts) that guards
 * the store-wide destructive surfaces (demo clear, data-job clean, purge): a
 * "power operator" holding every module grant behind them — plus the mail
 * transport / API-key grants — is still NOT `*`, is refused, and the probe is
 * recorded as `rbac.permission_denied` (module "*"). The static wiring of those
 * step-ups is pinned by route-invariants.test.ts.
 *
 * Self-cleaning: all rows are tagged `__esctest…` and removed at the end.
 *
 * Run: pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *        src/lib/db/tests/rbac-escalation.test.ts
 * (needs the Docker DB on localhost:5434; super_admin role is seeded by 0033.)
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { checkSuperAdmin, isSuperAdmin } from "@/lib/auth/super-admin";
import { resolveUserPermissions } from "@/lib/rbac/authorize";
import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import {
  assertActorMayGrantRole,
  assertActorOutranksTarget,
} from "@/lib/rbac/guards";
import { setUserRolesWorkflow } from "@/workflows/rbac/assign-roles";
import { setUserPermissionsWorkflow } from "@/workflows/rbac/set-user-permissions";
import { applyPermissionOverlay } from "@/lib/rbac/overlay";
import { createUserWorkflow } from "@/workflows/auth/create-user";
import { inviteUserWorkflow } from "@/workflows/auth/invite-user";
import { setPasswordWorkflow } from "@/workflows/auth/set-password";
import { setEmailWorkflow } from "@/workflows/auth/set-email";
import {
  disableUserWorkflow,
  enableUserWorkflow,
  forceLogoutWorkflow,
  setEmailVerifiedWorkflow,
} from "@/workflows/auth/disable-user";
import {
  createRoleWorkflow,
  deleteRoleWorkflow,
  updateRoleWorkflow,
} from "@/workflows/rbac/manage-roles";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

const SUPER = "__esctest-super"; // super_admin ROLE holder (wildcard actor)
const DELEG = "__esctest-deleg"; // customer + custom users-manager role (no '*')
const VICTIM_SUPER = "__esctest-victim-super"; // super_admin ROLE holder target
const VICTIM_CUST = "__esctest-victim-cust"; // customer target
const TARGET = "__esctest-target"; // customer target for positive grant
const POWER = "__esctest-power"; // customer + every destructive-surface module grant (no '*')

async function cleanup() {
  await db.execute(sql`delete from user_permissions where user_id like '__esctest%'`);
  await db.execute(sql`delete from user_roles where user_id like '__esctest%'`);
  await db.execute(sql`delete from roles where key like '__esctest%' or name like '__esctest%'`);
  await db.execute(sql`delete from users where id like '__esctest%' or email like '__esctest%'`);
  // Audit rows the synthetic actors produced (when the audit subscriber is live).
  await db.execute(sql`delete from audit_log where actor_user_id like '__esctest%'`);
}

async function main() {
  await cleanup();

  // ── seed users (access is role-only — no enum; admins get the super_admin role below) ──
  const mk = (id: string) =>
    authService.insert({ id, email: `${id}@example.test`, name: id });
  await mk(SUPER);
  await mk(DELEG);
  await mk(VICTIM_SUPER);
  await mk(VICTIM_CUST);
  await mk(TARGET);

  // ── seed roles ──
  const superRole = await rbacService.findRoleByKey("super_admin");
  check("super_admin role is seeded (migration 0033)", !!superRole);
  if (!superRole) throw new Error("super_admin role missing — run migrations");

  // Admins = holders of the super_admin ('*') role — the sole source of full
  // access now that the enum is gone.
  await rbacService.assignRoleToUser(SUPER, superRole.id);
  await rbacService.assignRoleToUser(VICTIM_SUPER, superRole.id);

  const mgr = await rbacService.createRole({
    key: "__esctest-mgr",
    name: "ESC users manager",
    description: null,
    is_system: false,
  });
  // A realistic "users manager": can view/create/manage accounts AND grant access
  // (users:roles — the grant-power verb), but NOT the global '*'.
  await rbacService.setRolePermissions(mgr.id, ["users:view", "users:manage", "users:create", "users:roles"]);

  const viewer = await rbacService.createRole({
    key: "__esctest-viewer",
    name: "ESC users viewer",
    description: null,
    is_system: false,
  });
  await rbacService.setRolePermissions(viewer.id, ["users:view"]);

  // delegate = customer carrying the users-manager role (NOT wildcard)
  await rbacService.assignRoleToUser(DELEG, mgr.id);

  // ── guard-level sanity ──
  check(
    "guard: delegate may NOT grant the system super_admin role",
    !!(await assertActorMayGrantRole(DELEG, superRole)),
  );
  check(
    "guard: delegate MAY grant a subset (users:view) role",
    (await assertActorMayGrantRole(DELEG, viewer)) === null,
  );
  check(
    "guard: wildcard admin MAY grant super_admin",
    (await assertActorMayGrantRole(SUPER, superRole)) === null,
  );
  check(
    "guard: delegate out-ranks a plain customer (no false lockout)",
    (await assertActorOutranksTarget(DELEG, VICTIM_CUST)) === null,
  );
  check(
    "guard: delegate does NOT out-rank a super_admin",
    !!(await assertActorOutranksTarget(DELEG, VICTIM_SUPER)),
  );

  // ── EXPLOIT attempts via the real workflows (must all be refused) ──
  const a = await setUserRolesWorkflow(
    { userId: DELEG, roleIds: [superRole.id] },
    { actorUserId: DELEG },
  );
  check("SEC-1: delegate self-assigning super_admin is REFUSED", !a.ok && a.error === "forbidden");

  const b = await createUserWorkflow(
    {
      email: "__esctest-newadmin@example.test",
      firstName: "New",
      lastName: "Admin",
      password: "correct horse battery staple",
      roleIds: [superRole.id],
    },
    { actorUserId: DELEG },
  );
  check("SEC-2: delegate CREATING a super_admin (via roleIds) is REFUSED", !b.ok && b.error === "forbidden");

  const bInvite = await inviteUserWorkflow(
    { email: "__esctest-invite@example.test", firstName: "New", lastName: "Admin", roleIds: [superRole.id] },
    { actorUserId: DELEG },
  );
  check("SEC-2: delegate INVITING a super_admin (via roleIds) is REFUSED", !bInvite.ok && bInvite.error === "forbidden");

  const overpowered = await createRoleWorkflow(
    { name: "__esctest overpowered", permissions: ["*"] },
    { actorUserId: DELEG },
  );
  check("delegate authoring a role carrying '*' is REFUSED", !overpowered.ok && overpowered.error === "forbidden");

  const d = await setPasswordWorkflow(
    { userId: VICTIM_SUPER, newPassword: "correct horse battery staple" },
    { actorUserId: DELEG },
  );
  check("SEC-3: delegate setting a super_admin's password is REFUSED", !d.ok && d.error === "forbidden");

  const e = await disableUserWorkflow(
    { userId: VICTIM_SUPER },
    { actorUserId: DELEG },
  );
  check("SEC-3: delegate disabling a super_admin is REFUSED", !e.ok && e.error === "forbidden");

  // SEC-3 (extended): the delegate can't touch a higher target through ANY of the
  // sibling account mutations either — all gated by assertActorOutranksTarget.
  const eEnable = await enableUserWorkflow({ userId: VICTIM_SUPER }, { actorUserId: DELEG });
  check("SEC-3: delegate RE-ENABLING a super_admin is REFUSED", !eEnable.ok && eEnable.error === "forbidden");

  const eForce = await forceLogoutWorkflow({ userId: VICTIM_SUPER }, { actorUserId: DELEG });
  check("SEC-3: delegate FORCE-LOGGING-OUT a super_admin is REFUSED", !eForce.ok && eForce.error === "forbidden");

  const eVerify = await setEmailVerifiedWorkflow(
    { userId: VICTIM_SUPER, verified: true },
    { actorUserId: DELEG },
  );
  check("SEC-3: delegate flipping a super_admin's email_verified is REFUSED", !eVerify.ok && eVerify.error === "forbidden");

  // The email IS the login identity, so setEmail is the most sensitive of the three
  // account mutations (rewrite email → password-reset → takeover). It must refuse a
  // higher target AND leave the address untouched (guard runs BEFORE any write).
  const eSetEmail = await setEmailWorkflow(
    { userId: VICTIM_SUPER, newEmail: "__esc-hijack@x.test" },
    { actorUserId: DELEG },
  );
  check("SEC-3: delegate setting a super_admin's login EMAIL is REFUSED", !eSetEmail.ok && eSetEmail.error === "forbidden");
  check(
    "SEC-3: the refused email-set left the super_admin's address untouched",
    (await authService.findById(VICTIM_SUPER))?.email !== "__esc-hijack@x.test",
  );

  // Role AUTHORING via UPDATE: a delegate can't rewrite a role to carry '*'
  // (mirrors the createRole('*') guard), and NOBODY may edit an immutable system
  // role — even a wildcard admin.
  const upOver = await updateRoleWorkflow({ roleId: viewer.id, permissions: ["*"] }, { actorUserId: DELEG });
  check("delegate updating a role to carry '*' is REFUSED", !upOver.ok && upOver.error === "forbidden");

  const upSys = await updateRoleWorkflow({ roleId: superRole.id, name: "hijacked" }, { actorUserId: SUPER });
  check("editing the immutable super_admin system role is REFUSED (even for '*')", !upSys.ok && upSys.error === "forbidden");

  // ── positive controls (allow paths still work) ──
  const f = await setUserRolesWorkflow(
    { userId: TARGET, roleIds: [superRole.id] },
    { actorUserId: SUPER },
  );
  check("control: wildcard admin CAN assign super_admin", f.ok);

  const g = await setUserRolesWorkflow(
    { userId: TARGET, roleIds: [superRole.id, viewer.id] },
    { actorUserId: SUPER },
  );
  check("control: wildcard admin CAN assign a mixed set", g.ok);

  const h = await setUserRolesWorkflow(
    { userId: VICTIM_CUST, roleIds: [viewer.id] },
    { actorUserId: DELEG },
  );
  check("control: delegate CAN grant a subset role to a lower target", h.ok);

  const upOk = await updateRoleWorkflow(
    { roleId: viewer.id, permissions: ["users:view"] },
    { actorUserId: DELEG },
  );
  check("control: delegate CAN update a role within its own grants", upOk.ok);

  // ── STALE permission keys (removed from the registry, still stored) ──
  // The editor sends a role's stored grants back on every save; a stale key it
  // can't render must not brick the role (nor count against a delegate).
  const stale = await rbacService.createRole({
    key: "__esctest-stale",
    name: "ESC stale",
    description: null,
    is_system: false,
  });
  await rbacService.setRolePermissions(stale.id, ["users:view", "users:update"]); // users:update = removed key
  const upStale = await updateRoleWorkflow(
    { roleId: stale.id, name: "ESC stale renamed", permissions: ["users:view", "users:update"] },
    { actorUserId: DELEG },
  );
  check("stale key already on the role: save SUCCEEDS (delegate)", upStale.ok);
  const staleAfter = await rbacService.listPermissionsForRole(stale.id);
  check(
    "…and the stale key is purged on save",
    staleAfter.length === 1 && staleAfter[0] === "users:view",
  );
  const upBogus = await updateRoleWorkflow(
    { roleId: stale.id, permissions: ["users:view", "users:bogus"] },
    { actorUserId: DELEG },
  );
  check("a NEW unknown key is still REFUSED", !upBogus.ok && upBogus.error === "validation");
  await rbacService.setRolePermissions(stale.id, ["users:view", "users:update"]);
  const delStale = await deleteRoleWorkflow({ roleId: stale.id }, { actorUserId: DELEG });
  check("delegate CAN delete a role carrying a stale key (confers nothing)", delStale.ok);

  // ── Super-admin step-up: module grants never add up to '*' (admin-authz-01) ──
  const powerRole = await rbacService.createRole({
    key: "__esctest-power",
    name: "ESC power operator",
    description: null,
    is_system: false,
  });
  await rbacService.setRolePermissions(powerRole.id, [
    "system_demo:view",
    "system_demo:manage", // « Importer la démo » — demo clear / purge surface
    "system_jobs:view",
    "system_jobs:manage", // « Tâches planifiées » — data-job clean surface
    "system_mail:view",
    "system_mail:update", // mail hub (transport + security templates are owner-only)
    "system_api:view",
    "system_api:create", // API keys (scopes bounded by the creator)
  ]);
  await mk(POWER);
  await rbacService.assignRoleToUser(POWER, powerRole.id);
  const denials: { actorUserId: string; module: string; action: string }[] = [];
  bus.on("rbac.permission_denied", (env) => {
    if (env.payload.actorUserId.startsWith("__esctest")) denials.push(env.payload);
  });

  const powerPerms = await resolveUserPermissions(POWER);
  check(
    "power operator resolves its 8 module grants and NOT '*'",
    powerPerms.has("system_demo:manage") && powerPerms.has("system_jobs:manage") && !powerPerms.has("*"),
  );
  check("power operator is NOT super-admin", !(await isSuperAdmin(POWER)));
  check("step-up (checkSuperAdmin) REFUSES the power operator", !(await checkSuperAdmin(POWER)));
  check(
    "…and records the probe as rbac.permission_denied on module '*'",
    denials.some((d) => d.actorUserId === POWER && d.module === "*"),
  );
  const denialsBefore = denials.length;
  check("control: the wildcard admin passes the step-up", await checkSuperAdmin(SUPER));
  check("…without recording a denial", denials.length === denialsBefore);
  check(
    "a users-manager delegate may NOT grant the power role (grants it lacks)",
    !!(await assertActorMayGrantRole(DELEG, powerRole)),
  );

  // ── per-user permission OVERLAY (0191) escalation ──────────────────────────
  // '*' is never a valid override target (super-admin stays role-only).
  const ovWild = await setUserPermissionsWorkflow(
    { userId: VICTIM_CUST, overrides: [{ permission: "*", effect: "allow" }] },
    { actorUserId: SUPER },
  );
  check("overlay: '*' as an override target is REFUSED (even for a wildcard admin)", !ovWild.ok && ovWild.error === "validation");

  // TARGET holds the super_admin role ('*' via role) → its overlay is NEVER editable.
  const ovSuper = await setUserPermissionsWorkflow(
    { userId: TARGET, overrides: [{ permission: "products:view", effect: "allow" }] },
    { actorUserId: SUPER },
  );
  check("overlay: editing a role-super-admin's overlay is REFUSED", !ovSuper.ok && ovSuper.error === "forbidden");

  // A delegate may not ALLOW a key it doesn't hold itself (no granting above your own).
  const ovOver = await setUserPermissionsWorkflow(
    { userId: VICTIM_CUST, overrides: [{ permission: "products:delete", effect: "allow" }] },
    { actorUserId: DELEG },
  );
  check("overlay: delegate ALLOWing a key it lacks is REFUSED", !ovOver.ok && ovOver.error === "forbidden");

  // A delegate CAN allow a key it holds + deny anything (deny is unrestricted de-escalation).
  const ovOk = await setUserPermissionsWorkflow(
    { userId: VICTIM_CUST, overrides: [{ permission: "users:manage", effect: "allow" }, { permission: "users:view", effect: "deny" }] },
    { actorUserId: DELEG },
  );
  check("overlay: delegate allow(held) + deny is ACCEPTED", ovOk.ok);
  {
    const eff = applyPermissionOverlay(
      await rbacService.listPermissionsForUser(VICTIM_CUST),
      await rbacService.listUserPermissionOverrides(VICTIM_CUST),
    );
    check("overlay effect: allowed key present, denied role-key removed", eff.has("users:manage") && !eff.has("users:view"));
  }

  // A wildcard admin CAN set a module-wildcard override on a non-super target.
  const ovAdmin = await setUserPermissionsWorkflow(
    { userId: VICTIM_CUST, overrides: [{ permission: "products:*", effect: "allow" }] },
    { actorUserId: SUPER },
  );
  check("overlay: wildcard admin CAN grant a <module>:* override", ovAdmin.ok);

  // ── REGRESSION: the outrank guard must count the target's ALLOW overlay ──────
  // VICTIM_CUST holds only the `viewer` role (users:view ⊆ DELEG's set) but now a
  // SUPER-granted products:* ALLOW override that DELEG LACKS. latentTargetPerms
  // must union that override, so DELEG does NOT out-rank VICTIM_CUST — else DELEG
  // could reset its password / repoint its email and seize products:* (the HIGH
  // audit finding: role-only rank let a lesser actor take over an overlay-elevated
  // account).
  check(
    "SEC: outrank guard counts the target's ALLOW overlay (no seizing an overlay-elevated account)",
    !!(await assertActorOutranksTarget(DELEG, VICTIM_CUST)),
  );
  check(
    "SEC: a wildcard admin still out-ranks the overlay-elevated account",
    (await assertActorOutranksTarget(SUPER, VICTIM_CUST)) === null,
  );

  // ── REGRESSION: no self-service overlay edit (can't lift your own deny) ──────
  const ovSelf = await setUserPermissionsWorkflow(
    { userId: DELEG, overrides: [{ permission: "users:view", effect: "deny" }] },
    { actorUserId: DELEG },
  );
  check("SEC: editing your OWN permission overlay is REFUSED (self)", !ovSelf.ok && ovSelf.error === "self_action");

  // ── REGRESSION: granting a '*'-role to a target with a DENY override refused ──
  // (phantom-super-admin prevention: a deny would materialize the '*' away).
  await setUserPermissionsWorkflow(
    { userId: VICTIM_CUST, overrides: [{ permission: "products:delete", effect: "deny" }] },
    { actorUserId: SUPER },
  );
  const phantomGrant = await setUserRolesWorkflow(
    { userId: VICTIM_CUST, roleIds: [viewer.id, superRole.id] },
    { actorUserId: SUPER },
  );
  check(
    "SEC: granting super_admin to a target carrying a deny override is REFUSED (phantom prevention)",
    !phantomGrant.ok && phantomGrant.error === "conflict",
  );

  // ── REGRESSION: attaching a role on CREATE/INVITE needs the grant verb ───────
  // A users:create-only delegate (NO users:roles) may mint a plain account but may
  // NOT attach roles to it — the grant power is its own slice (users:roles).
  const creatorRole = await rbacService.createRole({ key: "__esctest-creator", name: "ESC creator", description: null, is_system: false });
  await rbacService.setRolePermissions(creatorRole.id, ["users:view", "users:create"]);
  const CREATOR = "__esctest-creator-u";
  await mk(CREATOR);
  await rbacService.assignRoleToUser(CREATOR, creatorRole.id);
  const createWithRole = await createUserWorkflow(
    { email: "__esctest-cwr@example.test", firstName: "C", lastName: "WR", password: "correct horse battery staple", roleIds: [viewer.id] },
    { actorUserId: CREATOR },
  );
  check("SEC: users:create-only delegate CANNOT attach a role on create (needs users:roles)", !createWithRole.ok && createWithRole.error === "forbidden");
  const inviteWithRole = await inviteUserWorkflow(
    { email: "__esctest-iwr@example.test", firstName: "I", lastName: "WR", roleIds: [viewer.id] },
    { actorUserId: CREATOR },
  );
  check("SEC: users:create-only delegate CANNOT attach a role on invite (needs users:roles)", !inviteWithRole.ok && inviteWithRole.error === "forbidden");
  const createNoRole = await createUserWorkflow(
    { email: "__esctest-cnr@example.test", firstName: "C", lastName: "NR", password: "correct horse battery staple", roleIds: [] },
    { actorUserId: CREATOR },
  );
  check("SEC: …but CAN create a plain account with no roles", createNoRole.ok);

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
      /* best-effort cleanup */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
