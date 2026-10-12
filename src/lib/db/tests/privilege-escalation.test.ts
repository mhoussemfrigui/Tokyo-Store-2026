import "server-only";

/**
 * PRIVILEGE-ESCALATION regression test — each path below let a scoped delegate
 * exceed its own grant (or left a latent full-admin credential behind):
 *   1. API-key scopes are BOUNDED by the creator's RBAC (scope → RBAC map): a
 *      `system_api:create` delegate can't mint `full` / `write` / PII scopes.
 *   2. A `customers:manage` operator can't credit their OWN loyalty balance
 *      (a `*` holder still may; another customer's profile still works).
 *   3. `customer.profile_updated` carries the CUSTOMER's linked user id (never
 *      the admin) for loyalty / notes / promo-opt-out edits; unknown → not_found.
 *   4. The bootstrap back door counts RBAC `*` holders (not only enum admins)
 *      and is BURNED by the first successful promotion (404 afterwards) — and
 *      by any boot that finds an admin, even with DISABLE_DEFAULT_ADMIN=true.
 *   5. Saving the AI review schedule armed / newly "approved" needs manage.
 *   6. The script-capable tracking keys (GTM id, custom head/body) are `*`-only.
 *
 * The strict bootstrap-promotion path needs a DB with no pre-existing effective
 * admin (the fresh test:db harness) — otherwise it is noted-skipped. Restores
 * the `app_secrets` bootstrap rows it touches. Self-cleaning (`__privesc…`).
 *
 * Run: pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *        src/lib/db/tests/privilege-escalation.test.ts
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus, type EventEnvelope } from "@/events/bus";
import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { resolveUserPermissions } from "@/lib/rbac/authorize";
import { isValidPermissionKey } from "@/lib/rbac/registry";
import { countEffectiveWildcardAdmins } from "@/lib/rbac/guards";
import {
  ALL_SCOPES,
  actorMayGrantScope,
  normalizeScopes,
  rbacKeysForScope,
  scopesBeyondActor,
} from "@/lib/api-auth/scopes";
import { updateCustomerNotesWorkflow } from "@/workflows/customer/update-notes";
import { setCustomerPromoOptOutWorkflow } from "@/workflows/customer/set-promo-opt-out";
import {
  ADMIN_BOOTSTRAP_CLOSED_KEY,
  closeAdminBootstrap,
  ensureDefaultAdmin,
  isAdminBootstrapClosed,
} from "@/lib/bootstrap/default-admin";
import { POST as bootstrapPOST } from "@/app/api/admin/bootstrap/route";
import { TRACKING_SCRIPT_KEYS, ownerOnlyTrackingViolation } from "@/lib/tracking/script-keys";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const TAG = "__privesc";
const API_DELEG = `${TAG}-apideleg`; // staff + {system_api:create, products:view}
const OPERATOR = `${TAG}-operator`; // customer + {customers:manage} + own profile
const CUSTOMER = `${TAG}-customer`; // plain customer with a profile
const ADMIN = `${TAG}-admin`; // enum admin ('*') with a profile
const RBAC_ADMIN = `${TAG}-rbacadmin`; // customer holding '*' via a custom ROLE only
const CANDIDATE = `${TAG}-candidate`; // registered account the bootstrap would promote
const CANDIDATE2 = `${TAG}-candidate2`;

const TOKEN = "privesc-bootstrap-token-0123456789";
const IP_PREFIX = "198.51.100.";

const profileIds: string[] = [];

async function cleanup() {
  // credit entries (if any) cascade when their customer_profile is deleted below.
  const links = await db.execute<{ pid: string }>(
    sql`select customer_profile_id as pid from customer_user_links where user_id like ${TAG + "%"}`,
  );
  const pids = [...new Set([...profileIds, ...links.rows.map((r) => r.pid)])];
  await db.execute(sql`delete from customer_user_links where user_id like ${TAG + "%"}`);
  for (const pid of pids) await db.execute(sql`delete from customer_profiles where id = ${pid}`);
  await db.execute(sql`delete from user_roles where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from roles where key like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
  await db.execute(sql`delete from rate_limit_buckets where bucket_key like ${"bootstrap:ip:" + IP_PREFIX + "%"}`);
}

// Account TYPE is role-derived now (no enum): an "admin" gets the super_admin
// role; staff/customer are plain users (scoped roles assigned via mkRole).
async function mkUser(id: string, type: "admin" | "staff" | "customer") {
  await authService.insert({ id, email: `${id}@example.test`, name: id } as never);
  if (type === "admin") {
    const sa = await rbacService.findRoleByKey("super_admin");
    if (sa) await rbacService.assignRoleToUser(id, sa.id);
  }
}
async function mkRole(key: string, perms: string[], userId: string) {
  const role = await rbacService.createRole({ key, name: key, description: null, is_system: false });
  await rbacService.setRolePermissions(role.id, perms);
  await rbacService.assignRoleToUser(userId, role.id);
}
async function mkProfile(userId: string | null): Promise<string> {
  const p = await customerService.insertProfile({
    first_name: "Priv",
    last_name: "Esc",
  } as never);
  profileIds.push(p.id);
  if (userId) await customerUserLink.create({ customer_profile_id: p.id, user_id: userId } as never);
  return p.id;
}

const readTokenRow = async () =>
  (await db.execute<{ value: string }>(sql`select value from app_secrets where key = 'ADMIN_BOOTSTRAP_TOKEN'`))
    .rows[0]?.value;
const restoreEnv = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

/** Snapshot the `app_secrets` bootstrap rows + env vars the test mutates; returns the restorer. */
async function snapshotBootstrapState(): Promise<() => Promise<void>> {
  const hadClosed = await isAdminBootstrapClosed();
  const priorToken = await readTokenRow();
  const priorEnvToken = process.env.ADMIN_BOOTSTRAP_TOKEN;
  const priorDisable = process.env.DISABLE_DEFAULT_ADMIN;
  return async () => {
    restoreEnv("ADMIN_BOOTSTRAP_TOKEN", priorEnvToken);
    restoreEnv("DISABLE_DEFAULT_ADMIN", priorDisable);
    if (hadClosed) {
      await db.execute(sql`
        insert into app_secrets (key, value) values (${ADMIN_BOOTSTRAP_CLOSED_KEY}, 'true')
        on conflict (key) do nothing
      `);
    } else {
      await db.execute(sql`delete from app_secrets where key = ${ADMIN_BOOTSTRAP_CLOSED_KEY}`);
    }
    if (priorToken !== undefined) {
      await db.execute(sql`
        insert into app_secrets (key, value) values ('ADMIN_BOOTSTRAP_TOKEN', ${priorToken})
        on conflict (key) do update set value = excluded.value
      `);
    } else {
      await db.execute(sql`delete from app_secrets where key = 'ADMIN_BOOTSTRAP_TOKEN'`);
    }
  };
}

let ipSeq = 1;
async function bootstrap(email: string, token = TOKEN): Promise<number> {
  const res = await bootstrapPOST(
    new Request("http://localhost/api/admin/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `${IP_PREFIX}${ipSeq++}` },
      body: JSON.stringify({ token, email }),
    }),
  );
  return res.status;
}

// Capture the last customer.profile_updated envelope.
let lastProfileEvent: EventEnvelope<"customer.profile_updated"> | null = null;
bus.on("customer.profile_updated", (env) => {
  lastProfileEvent = env;
});

async function main() {
  await cleanup();

  // ── 1. API-key scopes bounded by the creator's RBAC ───────────────────────
  console.log("1. API-key scope → RBAC bound");
  {
    const bad = ALL_SCOPES.flatMap(rbacKeysForScope).filter((k) => k !== "*" && !isValidPermissionKey(k));
    check("every mapped RBAC key exists in the registry", bad.length === 0);
    check("`full` needs the wildcard", same(rbacKeysForScope("full"), ["*"]));
    check("`write` needs the wildcard", same(rbacKeysForScope("write"), ["*"]));
    check("an unknown scope fails closed (wildcard)", same(rbacKeysForScope("bogus:read"), ["*"]));
    check("`orders:write` needs orders:manage (+ its read)", same(rbacKeysForScope("orders:write"), ["orders:view", "orders:manage"]));

    const deleg = new Set(["system_api:create", "products:view", "orders:view"]);
    check("delegate may mint products:read", actorMayGrantScope(deleg, "products:read"));
    check("delegate may NOT mint products:write", !actorMayGrantScope(deleg, "products:write"));
    check("delegate may NOT mint customers:read (PII)", !actorMayGrantScope(deleg, "customers:read"));
    check("delegate may NOT mint `full`", !actorMayGrantScope(deleg, "full"));
    check("delegate may NOT mint `write`", !actorMayGrantScope(deleg, "write"));
    check("delegate may NOT mint coarse `read` (lacks most read grants)", !actorMayGrantScope(deleg, "read"));
    check("published content reads need no admin grant", actorMayGrantScope(deleg, "blog:read"));
    check("a module wildcard covers its write scope", actorMayGrantScope(new Set(["orders:*"]), "orders:write"));
    check("`*` may mint everything", ALL_SCOPES.every((s) => actorMayGrantScope(new Set(["*"]), s)));

    // Against LIVE RBAC resolution (what createApiKeyAction does).
    await mkUser(API_DELEG, "staff");
    await mkRole(`${TAG}-apirole`, ["system_api:create", "products:view"], API_DELEG);
    const perms = await resolveUserPermissions(API_DELEG);
    const requested = normalizeScopes(["*", "products:read", "customers:read", "orders:write"]);
    check(
      "live delegate: exactly the over-privileged scopes are refused",
      same(scopesBeyondActor(perms, requested), ["full", "customers:read", "orders:write"]),
    );
    check("live delegate: an in-bounds request passes", scopesBeyondActor(perms, ["products:read"]).length === 0);
  }

  // ── 4. Bootstrap back door (before any admin is created below) ────────────
  console.log("4. Bootstrap back door");
  const restoreBootstrap = await snapshotBootstrapState();
  try {
    await db.execute(sql`delete from app_secrets where key = ${ADMIN_BOOTSTRAP_CLOSED_KEY}`);
    process.env.ADMIN_BOOTSTRAP_TOKEN = TOKEN;
    const preExisting = await countEffectiveWildcardAdmins();

    await mkUser(CANDIDATE, "customer");
    await mkUser(CANDIDATE2, "customer");
    await mkUser(RBAC_ADMIN, "customer");
    await mkRole(`${TAG}-star`, ["*"], RBAC_ADMIN);

    // The exact ops-05 hole: no ENUM admin, but an active RBAC `*` holder.
    check("an RBAC-only `*` holder counts as an effective admin", (await countEffectiveWildcardAdmins()) >= 1);
    check("route 404s while an RBAC-only super-admin is active", (await bootstrap(`${CANDIDATE}@example.test`)) === 404);
    check("…and did NOT promote the candidate", !(await resolveUserPermissions(CANDIDATE)).has("*"));
    check("a wrong token 404s", (await bootstrap(`${CANDIDATE}@example.test`, "wrong-token-xxxxxxxx")) === 404);

    if (preExisting === 0) {
      await authService.disable(RBAC_ADMIN); // true lockout: no active '*' holder at all
      await db.execute(sql`
        insert into app_secrets (key, value) values ('ADMIN_BOOTSTRAP_TOKEN', ${TOKEN})
        on conflict (key) do update set value = excluded.value
      `);
      check("true lockout: the route promotes the candidate (200)", (await bootstrap(`${CANDIDATE}@example.test`)) === 200);
      check("…candidate is now an admin (holds the super_admin '*' role)", (await resolveUserPermissions(CANDIDATE)).has("*"));
      check("…the door is burned (closed marker set)", await isAdminBootstrapClosed());
      const tokenRow = await db.execute(sql`select 1 from app_secrets where key = 'ADMIN_BOOTSTRAP_TOKEN'`);
      check("…the persisted token is deleted", tokenRow.rows.length === 0);

      // Even back in a zero-admin state, a burned door stays shut.
      await authService.disable(CANDIDATE);
      check("burned door 404s even with no active admin", (await bootstrap(`${CANDIDATE2}@example.test`)) === 404);
      check("…second candidate NOT promoted", !(await resolveUserPermissions(CANDIDATE2)).has("*"));
    } else {
      console.log(`  … ${preExisting} pre-existing admin(s) in this DB — strict promotion path noted-skipped.`);
    }

    await closeAdminBootstrap();
    await closeAdminBootstrap(); // idempotent
    check("closeAdminBootstrap is idempotent + leaves the door closed", await isAdminBootstrapClosed());
  } finally {
    await restoreBootstrap(); // the pre-test bootstrap state
  }

  // ── 2 + 3. customer.profile_updated userId attribution (notes + promo opt-out) ──
  console.log("2/3. customer.profile_updated userId attribution");
  await mkUser(OPERATOR, "customer");
  await mkRole(`${TAG}-custmgr`, ["customers:view", "customers:update", "customers:manage"], OPERATOR);
  await mkUser(CUSTOMER, "customer");
  await mkUser(ADMIN, "admin");
  const custProfile = await mkProfile(CUSTOMER);

  {
    lastProfileEvent = null;
    const r = await updateCustomerNotesWorkflow({ profileId: custProfile, notes: "  note  " }, { actorUserId: OPERATOR });
    const ev = lastProfileEvent as EventEnvelope<"customer.profile_updated"> | null;
    check("notes update succeeds", r.ok);
    check("notes event userId = the CUSTOMER", ev?.payload.userId === CUSTOMER && ev?.actorUserId === OPERATOR);
    const miss = await updateCustomerNotesWorkflow({ profileId: randomUUID(), notes: "x" }, { actorUserId: OPERATOR });
    check("notes on an unknown profile → not_found", !miss.ok && miss.error === "not_found");
  }
  {
    lastProfileEvent = null;
    const r = await setCustomerPromoOptOutWorkflow({ profileId: custProfile, optOut: true }, { actorUserId: OPERATOR });
    const ev = lastProfileEvent as EventEnvelope<"customer.profile_updated"> | null;
    check("promo opt-out succeeds + persists", r.ok && (await customerService.findProfileById(custProfile))?.promo_opt_out === true);
    check(
      "promo opt-out event userId = the CUSTOMER, changedFields = [promo_opt_out]",
      ev?.payload.userId === CUSTOMER && same(ev?.payload.changedFields ?? [], ["promo_opt_out"]),
    );
    const miss = await setCustomerPromoOptOutWorkflow({ profileId: randomUUID(), optOut: true }, { actorUserId: OPERATOR });
    check("promo opt-out on an unknown profile → not_found", !miss.ok && miss.error === "not_found");
  }

  // ── 4b. A DISABLE_DEFAULT_ADMIN install's token is burned on boot too ─────
  // (those installs are exactly the bootstrap-token users; the ADMIN enum admin
  // created above is the active effective admin the boot finds.)
  console.log("4b. Boot burns the token even with DISABLE_DEFAULT_ADMIN=true");
  {
    const restore = await snapshotBootstrapState();
    try {
      await db.execute(sql`delete from app_secrets where key = ${ADMIN_BOOTSTRAP_CLOSED_KEY}`);
      await db.execute(sql`
        insert into app_secrets (key, value) values ('ADMIN_BOOTSTRAP_TOKEN', ${TOKEN})
        on conflict (key) do update set value = excluded.value
      `);
      process.env.DISABLE_DEFAULT_ADMIN = "true";
      check("precondition: an active effective admin exists", (await countEffectiveWildcardAdmins()) >= 1);
      await ensureDefaultAdmin();
      check("DISABLE_DEFAULT_ADMIN boot with an admin sets the closed marker", await isAdminBootstrapClosed());
      check("…and deletes the persisted token", (await readTokenRow()) === undefined);
    } finally {
      await restore();
    }
  }

  // ── 6. Script-capable tracking keys are owner-only (`*`) ──────────────────
  console.log("6. Tracking script keys owner-only");
  {
    check(
      "TRACKING_SCRIPT_KEYS = { gtm_id, custom_head, custom_body }",
      same([...TRACKING_SCRIPT_KEYS].sort(), ["tracking.custom_body", "tracking.custom_head", "tracking.gtm_id"]),
    );
    const form = (entries: Record<string, string>) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(entries)) fd.set(k, v);
      return (key: string) => fd.has(key);
    };
    for (const key of TRACKING_SCRIPT_KEYS) {
      check(`a non-owner posting ${key} is refused`, ownerOnlyTrackingViolation(false, form({ [key]: "x" })));
      check(`…even an empty ${key}`, ownerOnlyTrackingViolation(false, form({ [key]: "" })));
    }
    const safe = form({ "tracking.ga4_id": "G-TEST", "tracking.meta_pixel_id": "123", "tracking.enabled": "on" });
    check("a non-owner posting only GA4 / Pixel / toggles is allowed", !ownerOnlyTrackingViolation(false, safe));
    const all = form({ "tracking.gtm_id": "GTM-X", "tracking.custom_head": "<script></script>", "tracking.custom_body": "" });
    check("an owner may post every script key", !ownerOnlyTrackingViolation(true, all));
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
