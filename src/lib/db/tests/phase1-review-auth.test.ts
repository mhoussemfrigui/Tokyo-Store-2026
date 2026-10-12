import "server-only";

/**
 * Phase-1 review regressions — auth / settings (DB, in-process Better Auth).
 *
 *   1. API keys are re-checked against their CREATOR at request time: a key a
 *      delegate minted works while the delegate still holds the grant, and gets
 *      403 (reason "scope") once the role is removed or the account disabled; an
 *      enum `admin` creator always passes; a creator-less key keeps reading.
 *   2. Self-service 2FA is audited SERVER-side (Better Auth hooks — they run for
 *      in-process `auth.api.*` calls exactly like HTTP ones): a signed-in
 *      enrolment confirm emits `user.two_factor_enabled`, a 2FA SIGN-IN verify
 *      does not, re-enabling while ON is refused (no silent secret rotation), a
 *      wrong-password disable emits nothing, a real disable emits
 *      `user.two_factor_disabled` — the account as actor each time. The 2FA
 *      endpoints with no app caller are 404 over HTTP.
 *   3. Better Auth 1.6 answers a duplicate sign-up with a SYNTHETIC,
 *      never-inserted id — the premise of the row-existence guards in
 *      default-admin / create-user / invite-user.
 *   4. `countEffectiveWildcardAdmins` (the last-admin floor primitive) counts
 *      only ACTIVE RBAC `*` holders (role-only — the enum was retired); a
 *      disabled `*` holder never counts.
 *   5. Session-gated mailing actions (source-level): the template reset is
 *      audited; the global toggles go through the settings workflow and emit
 *      only for real changes.
 *
 * Self-cleaning (`__p1rev…`). Run against the isolated test DB:
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… EMAIL_PROVIDER=console \
 *     pnpm exec tsx --conditions=react-server src/lib/db/tests/phase1-review-auth.test.ts
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import type { EventEnvelope } from "@/events/types";
import { getAuth } from "@/lib/auth/server";
import { requireApiKey } from "@/lib/api-auth/require-api-key";
import { countEffectiveWildcardAdmins } from "@/lib/rbac/guards";
import { apiKeyService } from "@/modules/api-key";
import { authService } from "@/modules/auth/service";
import { accounts } from "@/modules/auth/schema";
import { rbacService } from "@/modules/rbac/service";

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

const TAG = "__p1rev";
const BASE = "http://localhost:3000/api/auth";

async function cleanup() {
  await db.execute(sql`delete from api_keys where name like ${TAG + "%"}`);
  await db.execute(sql`delete from user_roles where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from roles where key like ${TAG + "%"}`);
  await db.execute(sql`delete from verifications where value like ${TAG + "%"}`);
  await db.execute(sql`delete from audit_log where actor_user_id like ${TAG + "%"} or target_id like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"} or email like ${TAG + "%"}`);
}

// Account TYPE is role-derived now (no enum): an "admin" gets the super_admin
// role; staff/customer are plain users (any scoped role is assigned separately).
const mkUser = async (id: string, type: "admin" | "staff" | "customer") => {
  await authService.insert({ id, email: `${id}@example.test`, name: id, emailVerified: true } as never);
  if (type === "admin") {
    const sa = await rbacService.findRoleByKey("super_admin");
    if (sa) await rbacService.assignRoleToUser(id, sa.id);
  }
};

// ── minimal RFC 6238 TOTP (Better Auth: SHA-1, 30 s, 6 digits; the URI secret
//    is the base32 of the raw secret string) ──
function base32Decode(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const out: number[] = [];
  let value = 0;
  let bits = 0;
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const idx = A.indexOf(ch);
    if (idx < 0) continue;
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 255);
    }
  }
  return Buffer.from(out);
}
function totpFromUri(uri: string): string {
  const secret = base32Decode(new URL(uri).searchParams.get("secret") ?? "");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac("sha1", secret).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

/** Tiny cookie jar over Better Auth's `returnHeaders` Set-Cookie output. */
class Jar {
  private m = new Map<string, string>();
  absorb(h: Headers | null | undefined): void {
    for (const c of h?.getSetCookie() ?? []) {
      const [pair, ...attrs] = c.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.m.delete(name);
      else this.m.set(name, value);
    }
  }
  headers(): Headers {
    return new Headers({ cookie: [...this.m].map(([k, v]) => `${k}=${v}`).join("; ") });
  }
}

async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function apiKeyCreatorRecheck() {
  console.log("1. API key — request-time creator re-check:");
  const DEL = `${TAG}-del`;
  const OWNER = `${TAG}-owner`;
  await mkUser(DEL, "staff");
  await mkUser(OWNER, "admin");
  const role = await rbacService.createRole({ key: `${TAG}-orders`, name: `${TAG} orders`, description: null, is_system: false });
  await rbacService.setRolePermissions(role.id, ["orders:view", "orders:manage"]);
  await rbacService.assignRoleToUser(DEL, role.id);

  const kDel = await apiKeyService.create({ name: `${TAG}-del`, scopes: ["orders:write"], expiresAt: null, createdBy: DEL });
  const kOwner = await apiKeyService.create({ name: `${TAG}-owner`, scopes: ["full"], expiresAt: null, createdBy: OWNER });
  const kNone = await apiKeyService.create({ name: `${TAG}-none`, scopes: ["products:read"], expiresAt: null, createdBy: null });
  const req = (plaintext: string) =>
    new Request("http://localhost:3000/api/orders", { headers: { authorization: `Bearer ${plaintext}` } });

  const ok1 = await requireApiKey(req(kDel.plaintext), "orders:write");
  check("delegate key works while the creator holds orders:manage", ok1.ok === true);

  const denials: EventEnvelope[] = [];
  bus.on("api_key.auth_failed", (env) => {
    if (env.payload.scope === "orders:write") denials.push(env as EventEnvelope);
  });

  await rbacService.removeRoleFromUser(DEL, role.id);
  const denied = await requireApiKey(req(kDel.plaintext), "orders:write");
  check("…403 once the creator's role is removed (key scope alone no longer enough)", !denied.ok && denied.response.status === 403);
  if (!denied.ok) {
    const body = (await denied.response.json()) as { error?: string };
    check("…with the creator-grant message", /créateur de cette clé/.test(body.error ?? ""));
  }
  check(
    "…recorded as api_key.auth_failed reason « scope » (never sampled)",
    denials.some((e) => (e.payload as { reason?: string }).reason === "scope"),
  );
  check("…read of the same resource is denied too (no orders:view left)", !(await requireApiKey(req(kDel.plaintext), "orders:read")).ok);

  await rbacService.assignRoleToUser(DEL, role.id);
  check("re-granting the role restores the key", (await requireApiKey(req(kDel.plaintext), "orders:write")).ok);
  await authService.disable(DEL);
  check("a DISABLED creator's key is refused (empty permission set)", !(await requireApiKey(req(kDel.plaintext), "orders:write")).ok);

  check("enum admin creator (`*`) keeps a full key working", (await requireApiKey(req(kOwner.plaintext), "orders:write")).ok);
  check("…including PII reads", (await requireApiKey(req(kOwner.plaintext), "customers:read")).ok);
  check("creator-less key still reads (writes stay refused by requireApiActor)", (await requireApiKey(req(kNone.plaintext), "products:read")).ok);

  await db.execute(
    sql`delete from rate_limit_buckets where bucket_key in (${`apikey:${kDel.row.id}`}, ${`apikey:${kOwner.row.id}`}, ${`apikey:${kNone.row.id}`})`,
  );
}

async function twoFactorAudit() {
  console.log("2. Self-service 2FA — server-side audit + enable-while-on guard:");
  const auth = await getAuth();
  const actx = await auth.$context;
  const U = `${TAG}-2fa`;
  const email = `${U}@example.test`;
  const PW = "Correct-horse-battery-9";
  await mkUser(U, "customer");
  await db.insert(accounts).values({
    id: `${U}-acc`,
    userId: U,
    accountId: U,
    providerId: "credential",
    password: await actx.password.hash(PW),
  });

  const events: EventEnvelope[] = [];
  const capture = (env: EventEnvelope) => {
    if ((env.payload as { userId?: string }).userId === U) events.push(env);
  };
  bus.on("user.two_factor_enabled", capture as never);
  bus.on("user.two_factor_disabled", capture as never);
  const count = (name: string) => events.filter((e) => e.name === name).length;

  const jar = new Jar();
  const signIn = await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true });
  jar.absorb(signIn.headers);

  const en = await auth.api.enableTwoFactor({ body: { password: PW }, headers: jar.headers() });
  check("enable (flag still off) is allowed and returns a TOTP URI", typeof en.totpURI === "string");
  check("enable alone emits nothing (not enrolled until confirmed)", events.length === 0);

  const v = await auth.api.verifyTOTP({ body: { code: totpFromUri(en.totpURI) }, headers: jar.headers(), returnHeaders: true });
  jar.absorb(v.headers);
  check("signed-in enrolment confirm → user.two_factor_enabled (once)", count("user.two_factor_enabled") === 1);
  check("…actor = the account itself", events[0]?.actorUserId === U);
  check("…flag now on in the DB", (await authService.findById(U))?.twoFactorEnabled === true);

  // Silent secret rotation is refused while 2FA is on.
  const secretOf = async () =>
    (
      await db.execute<{ secret: string }>(sql`select secret from two_factors where user_id = ${U}`)
    ).rows[0]?.secret;
  const before = await secretOf();
  check(
    "re-enable while 2FA is ON is refused",
    await throws(() => auth.api.enableTwoFactor({ body: { password: PW }, headers: jar.headers() })),
  );
  check("…the authenticator secret is unchanged", (await secretOf()) === before && before !== undefined);

  // A 2FA SIGN-IN (challenge cookie, no session) must not count as an enable.
  const chal = new Jar();
  const signIn2 = await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true });
  chal.absorb(signIn2.headers);
  check("sign-in on a 2FA account asks for the second factor", (signIn2.response as { twoFactorRedirect?: boolean }).twoFactorRedirect === true);
  const v2 = await auth.api.verifyTOTP({ body: { code: totpFromUri(en.totpURI) }, headers: chal.headers(), returnHeaders: true });
  chal.absorb(v2.headers);
  check("a 2FA sign-in verify emits NO two_factor_enabled", count("user.two_factor_enabled") === 1);

  check(
    "wrong-password disable is refused…",
    await throws(() => auth.api.disableTwoFactor({ body: { password: "wrong-password-123" }, headers: chal.headers() })),
  );
  check("…and emits nothing", count("user.two_factor_disabled") === 0);

  await auth.api.disableTwoFactor({ body: { password: PW }, headers: chal.headers() });
  check("disable → user.two_factor_disabled (once)", count("user.two_factor_disabled") === 1);
  check(
    "…actor = the account itself",
    events.find((e) => e.name === "user.two_factor_disabled")?.actorUserId === U,
  );
  check("…flag off in the DB", (await authService.findById(U))?.twoFactorEnabled === false);

  // HTTP surface: the 2FA endpoints no app code calls are 404.
  for (const p of ["/two-factor/get-totp-uri", "/two-factor/send-otp", "/two-factor/verify-otp"]) {
    const res = await auth.handler(
      new Request(`${BASE}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: chal.headers().get("cookie") ?? "" },
        body: JSON.stringify({ password: PW, code: "000000" }),
      }),
    );
    check(`POST ${p} → 404`, res.status === 404);
  }

  // 3. Better Auth's synthetic duplicate (premise of the existence guards).
  console.log("3. Duplicate sign-up → synthetic, never-inserted id:");
  const dup = await auth.api.signUpEmail({ body: { email, password: "Another-password-42", name: "dup" } });
  check("duplicate sign-up does not throw and returns an id", typeof dup.user?.id === "string");
  check("…that id is NOT the real account", dup.user.id !== U);
  check("…and has no users row (authService.findById → null)", (await authService.findById(dup.user.id)) === null);
}

async function demotionFloor() {
  console.log("4. Effective-admin floor counts RBAC '*' holders (role-only, no enum):");
  const A = `${TAG}-adm-a`; // admin via the super_admin role
  const B = `${TAG}-own-b`; // staff + a custom '*'-granting role
  // Baseline BEFORE seeding, so the assertions are robust to the admins the
  // test DB already holds (deltas, never absolute counts).
  const base = await countEffectiveWildcardAdmins();
  await mkUser(A, "admin");
  await mkUser(B, "staff");
  const star = await rbacService.createRole({ key: `${TAG}-star`, name: `${TAG} star`, description: null, is_system: false });
  await rbacService.setRolePermissions(star.id, ["*"]);
  await rbacService.assignRoleToUser(B, star.id);

  check(
    "both new '*' holders (A via super_admin, B via a custom role) are counted",
    (await countEffectiveWildcardAdmins()) === base + 2,
  );
  check(
    "excluding A, the other new admin B still remains above baseline",
    (await countEffectiveWildcardAdmins(A)) === base + 1,
  );

  // A disabled '*' holder never counts — it can't act, so it can't satisfy the floor.
  await authService.disable(B);
  check(
    "a disabled '*' holder drops out of the live admin count",
    (await countEffectiveWildcardAdmins()) === base + 1,
  );
  check(
    "excluding the last active new admin A, only the baseline admins remain",
    (await countEffectiveWildcardAdmins(A)) === base,
  );
}

function mailingSource() {
  console.log("5. Mailing actions (source-level — session-gated):");
  const src = readFileSync(join(process.cwd(), "src", "lib", "actions", "mailing.ts"), "utf8");
  const body = (name: string) => {
    const start = src.indexOf(`export async function ${name}`);
    const next = src.indexOf("\nexport ", start + 1);
    return start < 0 ? "" : src.slice(start, next < 0 ? undefined : next);
  };
  const reset = body("resetEmailTemplateAction");
  check("template reset emits mailing.template_updated", /bus\.emit\(\s*"mailing\.template_updated"/.test(reset));
  check("…with the acting admin", reset.includes("actorUserId: session.user.id"));
  const toggles = body("saveMailGlobalTogglesAction");
  check("global toggles no longer write through settingService.upsert", !toggles.includes("settingService.upsert("));
  check("…they go through workflows.cms.upsertSetting with the actor", /workflows\.cms\.upsertSetting\(\s*w,\s*actor\)/.test(toggles));
  check("…and emit the summary only when something changed", /if \(changedFields\.length > 0\)/.test(toggles));

  const tf = readFileSync(join(process.cwd(), "src", "lib", "actions", "two-factor.ts"), "utf8");
  check("client-called 2FA audit action removed", !tf.includes("recordSelfTwoFactorAction"));
}

async function main() {
  await cleanup();
  await apiKeyCreatorRecheck();
  await twoFactorAudit();
  await demotionFloor();
  mailingSource();
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
