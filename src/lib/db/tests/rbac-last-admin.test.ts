import "server-only";

/**
 * LAST-ADMIN FLOOR regression test — the lockout-prevention invariant.
 *
 * The store must never be left with ZERO effective super-admins. Access is
 * role-only now (the legacy `users.role` enum was retired): `*` is held via an
 * RBAC role that grants it — the seeded `super_admin` role or any custom role
 * carrying `*`. `assertDisableKeepsAnAdmin` / `assertRoleChangeKeepsAnAdmin`
 * refuse a disable / role-strip that would drop the global count of effective
 * `*` holders to zero. A regression here bricks the admin panel for everyone, so
 * pin it.
 *
 * Robust in any DB: the core assertion is that the guard's decision MATCHES the
 * live admin count. The strict "deny the last admin" paths additionally require a
 * clean admin population, so they run only when the DB has no pre-existing
 * effective admin (the fresh `test:db` harness) — otherwise they're noted-skipped
 * so a populated dev DB doesn't false-fail. Self-cleaning (`__floortest…`).
 *
 * Run: pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *        src/lib/db/tests/rbac-last-admin.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { resolveUserPermissions } from "@/lib/rbac/authorize";
import {
  assertDisableKeepsAnAdmin,
  assertRoleChangeKeepsAnAdmin,
  assertRoleWildcardRemovalKeepsAnAdmin,
  countEffectiveWildcardAdmins,
} from "@/lib/rbac/guards";
import { disableUserWorkflow } from "@/workflows/auth/disable-user";

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

const A = "__floortest-a"; // effective '*' via the seeded super_admin role
const B = "__floortest-b"; // customer carrying a custom '*' role (RBAC admin)
const STAR = "__floortest-star"; // custom role key granting '*'
const PHANTOM = "__floortest-phantom"; // super_admin ROLE + a deny override → NOT a '*' holder

async function cleanup() {
  await db.execute(sql`delete from user_permissions where user_id like '__floortest%'`);
  await db.execute(sql`delete from user_roles where user_id like '__floortest%'`);
  await db.execute(sql`delete from roles where key like '__floortest%' or name like '__floortest%'`);
  await db.execute(sql`delete from users where id like '__floortest%' or email like '__floortest%'`);
}

async function main() {
  await cleanup();
  // Access is role-only: an "admin" is seeded by granting the super_admin role.
  const mk = async (id: string, type: "admin" | "customer") => {
    await authService.insert({ id, email: `${id}@example.test`, name: id } as never);
    if (type === "admin") {
      const sa = await rbacService.findRoleByKey("super_admin");
      if (sa) await rbacService.assignRoleToUser(id, sa.id);
    }
  };

  // Effective admins ALREADY in the DB (e.g. a dev default admin). On the fresh
  // test:db harness this is 0, which unlocks the strict "deny the last" paths.
  const preExisting = await countEffectiveWildcardAdmins();
  const cleanDb = preExisting === 0;
  if (!cleanDb) {
    console.log(`  … ${preExisting} pre-existing admin(s) in this DB — strict last-admin paths noted-skipped.`);
  }

  await mk(A, "admin");

  // CORE INVARIANT (robust everywhere): the disable guard denies IFF the target
  // is the last effective '*' holder — i.e. the decision tracks the live count.
  {
    const others = await countEffectiveWildcardAdmins(A);
    const denial = await assertDisableKeepsAnAdmin(A);
    check("disable-guard decision matches the live admin count", (denial !== null) === (others === 0));
    if (cleanDb) {
      check("the LAST effective admin cannot be disabled (denied)", denial !== null && denial.error === "forbidden");
    }
  }

  // B = a CUSTOMER carrying a custom '*' role → an effective admin via RBAC. The
  // floor MUST count it (an account can hold '*' while also owning a customer
  // profile, since the role editor reaches customer-360 accounts).
  await mk(B, "customer");
  const star = await rbacService.createRole({ key: STAR, name: "__floortest star", description: null, is_system: false });
  await rbacService.setRolePermissions(star.id, ["*"]);
  await rbacService.assignRoleToUser(B, star.id);

  check(
    "an RBAC-'*' customer counts as an effective admin (A no longer the last)",
    (await assertDisableKeepsAnAdmin(A)) === null,
  );

  // Allow path via the REAL workflow: A (wildcard) disables B, A remains → ok.
  const disB = await disableUserWorkflow({ userId: B }, { actorUserId: A });
  check("disabling one of two admins succeeds (the other remains)", disB.ok);

  // ── PHANTOM super-admin: a super_admin-ROLE holder with ANY deny override is
  // NOT a literal '*' holder (the overlay materializes '*' into concrete keys and
  // drops the token), so the gate denies it super-admin. The floor MUST agree, or
  // it would count the phantom and let the last REAL admin be stripped → lockout.
  // Environment-independent (delta), so it runs on a populated dev DB too.
  await mk(PHANTOM, "admin"); // grants the super_admin role → counts for now
  const beforeDeny = await countEffectiveWildcardAdmins();
  await rbacService.setUserPermissionOverrides(PHANTOM, [{ permission: "blog:create", effect: "deny" }]);
  check(
    "the gate drops a role-'*' holder's literal '*' once it has a deny override",
    !(await resolveUserPermissions(PHANTOM)).has("*"),
  );
  check(
    "the floor stops counting that phantom (matches the gate — no lockout window)",
    (await countEffectiveWildcardAdmins()) === beforeDeny - 1,
  );
  // Clearing the deny restores it as a true effective admin on both sides.
  await rbacService.setUserPermissionOverrides(PHANTOM, []);
  check(
    "clearing the deny restores the phantom to a counted effective admin",
    (await resolveUserPermissions(PHANTOM)).has("*") && (await countEffectiveWildcardAdmins()) === beforeDeny,
  );
  await db.execute(sql`delete from user_roles where user_id = ${PHANTOM}`);
  await db.execute(sql`delete from users where id = ${PHANTOM}`);

  if (cleanDb) {
    // B is disabled again → A is the sole effective admin.
    check("last admin disable denied again once the other is disabled", (await assertDisableKeepsAnAdmin(A)) !== null);

    // Make the RBAC-'*' customer the SOLE admin, then exercise the ROLE-CHANGE
    // floor: stripping its '*' role (desired = []) is refused; a change that keeps
    // a '*' role is allowed.
    await authService.enable(B); // B active again (RBAC-'*')
    await authService.disable(A); // A out → B is the only effective admin
    check("stripping the last RBAC-'*' admin's role is REFUSED", (await assertRoleChangeKeepsAnAdmin(B, [])) !== null);
    check("a role change that keeps a '*' role is allowed", (await assertRoleChangeKeepsAnAdmin(B, [star.id])) === null);

    // ROLE-MANAGEMENT floor (delete / strip the '*' role itself). B (customer)
    // holds '*' SOLELY via STAR, A is disabled → deleting or emptying STAR would
    // remove the last effective admin and must be REFUSED.
    check(
      "deleting/stripping the sole '*'-carrying role is REFUSED (no other admin remains)",
      (await assertRoleWildcardRemovalKeepsAnAdmin(star.id)) !== null,
    );
    // Re-enable A (super_admin role) → '*' now also comes from A, independent of
    // STAR, so removing STAR is allowed again.
    await authService.enable(A);
    check(
      "…allowed once another '*' source (A's super_admin role) exists",
      (await assertRoleWildcardRemovalKeepsAnAdmin(star.id)) === null,
    );
  }

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
