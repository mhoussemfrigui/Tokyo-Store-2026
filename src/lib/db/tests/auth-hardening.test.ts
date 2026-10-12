import "server-only";

/**
 * Auth-surface hardening regression test (identity-01/02/05/09).
 *
 *   - identity-01: the credential endpoints the app serves IN-PROCESS are 404
 *     over HTTP (disabledPaths), the endpoints the client really uses stay
 *     reachable, a direct HTTP 2FA verify shares the per-challenge Postgres cap
 *     (keyed on the exact, signature-checked challenge cookie Better Auth
 *     verifies — a decoy `*.two_factor` cookie can't mint a fresh bucket, and
 *     verifyTwoFactorAction derives the same key),
 *     and the route handler keys Better Auth's limiter on the TRUSTED (last) XFF
 *     hop, so a rotating fake leading entry no longer earns a fresh bucket.
 *   - identity-02: a duplicate-email signup returns the generic success and
 *     creates NOTHING (no orphan profile / link, no second `user.created`).
 *   - identity-05: authService.findByEmail is an exact case-insensitive match
 *     (`_` / `%` are not wildcards).
 *   - identity-09: a social provider is registered only when its admin toggle is
 *     ON (credentials alone no longer keep a hidden provider live), and nulled
 *     credentials unregister it.
 *
 * Self-cleaning (`__authhard…`; the social settings + oauth row are restored).
 *
 * Run: pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *        src/lib/db/tests/auth-hardening.test.ts
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { getAuth, resetAuthInstance, twoFactorChallengeKeyFromHeaders } from "@/lib/auth/server";
import {
  TWO_FACTOR_CHALLENGE_COOKIE,
  readCookieLikeBetterAuth,
  twoFactorChallengeKey,
  verifySignedCookieValue,
} from "@/lib/auth/two-factor-challenge";
import { AUTH_HTTP_DISABLED_PATHS, AUTH_RATE_LIMITS } from "@/lib/auth/policy";
import { invalidateSocialConfigCache, socialEnvLock } from "@/lib/auth/social-config";
import { encryptSecret, isEncryptionConfigured } from "@/lib/crypto/secrets";
import { authService } from "@/modules/auth/service";
import { oauthSettingsService, oauth_provider_settings } from "@/modules/oauth";
import { settingService } from "@/modules/cms/setting/service";
import { site_settings } from "@/modules/cms/setting/schema";
import { signupWorkflow } from "@/workflows/auth/signup";
import { POST as authRoutePost } from "@/app/api/auth/[...all]/route";

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

const TAG = "__authhard";
const BASE = "http://localhost:3000/api/auth";
const ORIGIN = "http://localhost:3000";
const GOOGLE_TOGGLE = "auth.social.google_enabled";

async function cleanup() {
  await db.execute(sql`
    delete from customer_user_links
    where user_id in (select id from users where email like ${TAG + "%"})
       or customer_profile_id in (select id from customer_profiles where first_name like ${TAG + "%"})`);
  await db.execute(sql`delete from customer_profiles where first_name like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"} or email like ${TAG + "%"}`);
  await db.execute(sql`delete from email_logs where to_email like ${TAG + "%"}`);
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function main() {
  await cleanup();
  const auth = await getAuth();

  // ── identity-01: disabled credential endpoints ──
  console.log("disabledPaths — credential endpoints are in-process only:");
  const disabled = new Set<string>(AUTH_HTTP_DISABLED_PATHS);
  for (const p of [
    "/sign-in/email",
    "/sign-up/email",
    "/request-password-reset",
    "/reset-password",
    "/send-verification-email",
    "/change-password",
    "/change-email",
    "/update-user",
    "/delete-user",
    "/verify-password",
    "/two-factor/verify-backup-code",
  ]) {
    check(`${p} is disabled over HTTP`, disabled.has(p));
  }
  for (const p of [
    "/get-session",
    "/sign-out",
    "/sign-in/social",
    "/verify-email",
    "/two-factor/enable",
    "/two-factor/verify-totp",
    "/two-factor/disable",
  ]) {
    check(`${p} stays reachable (not disabled)`, !disabled.has(p));
  }
  check(
    "buildAuth wires the list (options.disabledPaths)",
    JSON.stringify(auth.options.disabledPaths) === JSON.stringify([...AUTH_HTTP_DISABLED_PATHS]),
  );
  check(
    "dead /forget-password rate-limit rule removed",
    !("/forget-password" in (AUTH_RATE_LIMITS.rules as Record<string, unknown>)),
  );

  const signIn = await auth.handler(post("/sign-in/email", { email: `${TAG}-x@example.test`, password: "x".repeat(12) }));
  check("POST /sign-in/email → 404", signIn.status === 404);
  const signUp = await auth.handler(
    post("/sign-up/email", { email: `${TAG}-y@example.test`, password: "x".repeat(12), name: "Y" }),
  );
  check("POST /sign-up/email → 404", signUp.status === 404);
  const reqReset = await auth.handler(post("/request-password-reset", { email: `${TAG}-x@example.test` }));
  check("POST /request-password-reset → 404", reqReset.status === 404);
  const backup = await auth.handler(post("/two-factor/verify-backup-code", { code: "0000000000" }));
  check("POST /two-factor/verify-backup-code → 404", backup.status === 404);
  const session = await auth.handler(new Request(`${BASE}/get-session`));
  check("GET /get-session still served (200)", session.status === 200);
  const resetLink = await auth.handler(
    new Request(`${BASE}/reset-password/${TAG}-bogus-token?callbackURL=%2Freset-password`),
  );
  check("GET /reset-password/:token (emailed link) still served (not 404)", resetLink.status !== 404);

  // Direct HTTP TOTP verify with a pending challenge cookie draws from the SAME
  // per-challenge bucket as verifyTwoFactorAction (8 / 15 min) — even when every
  // guess comes from a different IP (Better Auth's own limiter never trips here).
  // The challenge is what Better Auth sets after a correct password: a SIGNED
  // cookie under the exact name the plugin verifies.
  console.log("2FA per-challenge cap on the HTTP verify-totp path:");
  const actx = await auth.$context;
  const chalName = actx.createAuthCookie(TWO_FACTOR_CHALLENGE_COOKIE).name;
  const sign = (token: string) =>
    `${token}.${createHmac("sha256", actx.secret).update(token).digest("base64")}`;
  const bucketOf = (token: string) => `2fa-verify:chal:${twoFactorChallengeKey(token)}`;
  const bucketCount = async (bucket: string) =>
    (
      await db.execute<{ n: number }>(
        sql`select coalesce(max(count), 0)::int as n from rate_limit_buckets where bucket_key = ${bucket}`,
      )
    ).rows[0].n;
  const guess = (cookie: string, ip: string) =>
    auth.handler(
      post("/two-factor/verify-totp", { code: "000000" }, { cookie, origin: ORIGIN, "x-forwarded-for": ip }),
    );

  const challenge = `${TAG}-${randomUUID()}`;
  const plainCookie = `${chalName}=${encodeURIComponent(sign(challenge))}`;
  const statuses: number[] = [];
  for (let i = 1; i <= 9; i++) statuses.push((await guess(plainCookie, `198.51.100.${i}`)).status);
  check("first 8 guesses are not rate-limited", statuses.slice(0, 8).every((s) => s !== 429));
  check("9th guess on the same challenge → 429", statuses[8] === 429);
  check("…counted in the per-challenge bucket (2fa-verify:chal:<sha256/24 of the token>)",
    (await bucketCount(bucketOf(challenge))) === 9);
  check(
    "verifyTwoFactorAction's key (twoFactorChallengeKeyFromHeaders) is the same bucket",
    (await twoFactorChallengeKeyFromHeaders(new Headers({ cookie: plainCookie }))) === twoFactorChallengeKey(challenge),
  );

  // Decoys: a random `x<i>.two_factor` cookie BEFORE the real one (plus quoted /
  // unencoded / duplicated / bare-name / base64-padding-bit variants of the real
  // challenge) must NOT mint a fresh bucket per guess — Better Auth verifies the
  // exact name's first occurrence, and so does the key.
  console.log("2FA per-challenge cap — decoy cookies can't widen the budget:");
  const decoyed = `${TAG}-${randomUUID()}`;
  const signed = sign(decoyed);
  const enc = encodeURIComponent(signed);
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const sig = signed.slice(signed.lastIndexOf(".") + 1);
  const padVariant = `${decoyed}.${sig.slice(0, 42)}${B64[B64.indexOf(sig[42]) ^ 1]}=`;
  const junk = () => randomBytes(16).toString("hex");
  const variants = [
    () => `${chalName}=${enc}`,
    () => `${chalName}="${enc}"`,
    () => `${chalName}=${signed}`,
    () => `${chalName}=${enc}; ${chalName}=${junk()}`,
    () => `two_factor=${junk()}; ${chalName}=${enc}`,
    () => `${chalName}=${encodeURIComponent(padVariant)}`,
  ];
  const decoyStatuses: number[] = [];
  const actionKeys: (string | null)[] = [];
  for (let i = 1; i <= 9; i++) {
    const cookie = `x${i}.two_factor=${junk()}; ${variants[(i - 1) % variants.length]()}`;
    decoyStatuses.push((await guess(cookie, `198.51.100.${10 + i}`)).status);
    actionKeys.push(await twoFactorChallengeKeyFromHeaders(new Headers({ cookie })));
  }
  check("first 8 decoyed guesses are not rate-limited", decoyStatuses.slice(0, 8).every((s) => s !== 429));
  check("9th decoyed guess on the same challenge → 429", decoyStatuses[8] === 429);
  check("…all 9 charged the REAL challenge's bucket", (await bucketCount(bucketOf(decoyed))) === 9);
  check(
    "verifyTwoFactorAction derives the real challenge's key for every decoyed header",
    actionKeys.every((k) => k === twoFactorChallengeKey(decoyed)),
  );

  // Unsigned / forged challenge → no key, no bucket row (Better Auth rejects it).
  const forged = `${TAG}-forged-${randomUUID()}`;
  const forgedCookie = `${chalName}=${encodeURIComponent(`${forged}.${"A".repeat(43)}=`)}`;
  const forgedRes = await guess(forgedCookie, "198.51.100.30");
  check("forged challenge → rejected, not rate-limited", forgedRes.status !== 429 && forgedRes.status !== 200);
  check("forged challenge charges no bucket", (await bucketCount(bucketOf(forged))) === 0);
  check(
    "forged challenge → no action key",
    (await twoFactorChallengeKeyFromHeaders(new Headers({ cookie: forgedCookie }))) === null,
  );
  check(
    "real signed value under a non-exact name (x.two_factor) → no action key",
    (await twoFactorChallengeKeyFromHeaders(new Headers({ cookie: `x.two_factor=${enc}` }))) === null,
  );
  await db.execute(
    sql`delete from rate_limit_buckets where bucket_key in (${bucketOf(challenge)}, ${bucketOf(decoyed)})`,
  );

  console.log("readCookieLikeBetterAuth / verifySignedCookieValue — better-call semantics:");
  check("first occurrence wins", readCookieLikeBetterAuth("a=1; a=2", "a") === "1");
  check("surrounding quotes stripped + %-decoded", readCookieLikeBetterAuth('a="x%20y"', "a") === "x y");
  check("malformed escape keeps the raw value", readCookieLikeBetterAuth("a=%E0%A4%A", "a") === "%E0%A4%A");
  check("segment without '=' skipped", readCookieLikeBetterAuth("junk; a=1", "a") === "1");
  check("exact name only (no suffix match)", readCookieLikeBetterAuth("x.a=1", "a") === null);
  check("empty value → null", readCookieLikeBetterAuth("a=; b=2", "a") === null);
  check("valid signature → token", verifySignedCookieValue(signed, actx.secret) === decoyed);
  check("padding-bit signature variant → same token", verifySignedCookieValue(padVariant, actx.secret) === decoyed);
  check("wrong secret → null", verifySignedCookieValue(signed, `${actx.secret}x`) === null);
  check("unsigned value → null", verifySignedCookieValue(decoyed, actx.secret) === null);

  // The route handler rewrites XFF to the trusted LAST hop: a rotating fake
  // leading entry from one real client IP shares ONE Better Auth bucket.
  console.log("route handler — Better Auth limiter keys on the trusted XFF hop:");
  const routeStatuses: number[] = [];
  for (let i = 1; i <= 6; i++) {
    const res = await authRoutePost(
      post("/two-factor/verify-totp", { code: "000000" }, {
        "x-forwarded-for": `192.0.2.${i}, 203.0.113.77`,
      }),
    );
    routeStatuses.push(res.status);
  }
  check("first 5 (rule max) pass the limiter", routeStatuses.slice(0, 5).every((s) => s !== 429));
  check("6th from the same real IP → 429 despite a new leading XFF", routeStatuses[5] === 429);

  // ── identity-05: exact email match ──
  console.log("findByEmail — exact, case-insensitive, no wildcards:");
  await authService.insert({
    id: `${TAG}-jean`,
    email: `${TAG}-jean.dupont@example.test`,
    name: "Jean Dupont",
    role: "customer",
  } as never);
  check(
    "'_' is not a wildcard (jean_dupont ≠ jean.dupont)",
    (await authService.findByEmail(`${TAG}-jean_dupont@example.test`)) === null,
  );
  check(
    "'%' is not a wildcard",
    (await authService.findByEmail(`${TAG}-%@example.test`)) === null,
  );
  check(
    "case + surrounding spaces still match",
    (await authService.findByEmail(`  ${TAG.toUpperCase()}-Jean.Dupont@Example.TEST `))?.id === `${TAG}-jean`,
  );

  // ── identity-02: duplicate signup creates nothing ──
  console.log("signup — duplicate email is a silent no-op:");
  let userCreated = 0;
  bus.on("user.created", async (e) => {
    if (String((e.payload as { email?: string }).email ?? "").startsWith(TAG)) userCreated++;
  });
  const email = `${TAG}-dup-${randomUUID().slice(0, 8)}@example.test`;
  const base = { email, password: "correct horse battery staple", terms: true };
  const first = await signupWorkflow({ ...base, firstName: `${TAG}First`, lastName: "Owner" }, { ip: null });
  check("first signup succeeds", first.ok && !first.data.alreadyRegistered && !!first.data.userId);
  const second = await signupWorkflow(
    { ...base, firstName: `${TAG}Attacker`, lastName: "Evil", phone: "+21611111111" },
    { ip: null },
  );
  check(
    "duplicate signup → generic success flagged alreadyRegistered",
    second.ok && second.data.alreadyRegistered === true && second.data.userId === "",
  );
  const [{ n: userRows }] = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from users where email = ${email}`)
  ).rows;
  check("exactly one users row", userRows === 1);
  const [{ n: attackerProfiles }] = (
    await db.execute<{ n: number }>(
      sql`select count(*)::int as n from customer_profiles where first_name = ${TAG + "Attacker"}`,
    )
  ).rows;
  check("no orphan profile for the duplicate attempt", attackerProfiles === 0);
  const [{ n: orphanLinks }] = (
    await db.execute<{ n: number }>(sql`
      select count(*)::int as n from customer_user_links l
      join customer_profiles p on p.id = l.customer_profile_id
      left join users u on u.id = l.user_id
      where p.first_name like ${TAG + "%"} and u.id is null`)
  ).rows;
  check("no link to a nonexistent user", orphanLinks === 0);
  check("user.created emitted once (no welcome email to the real owner)", userCreated === 1);

  // ── identity-09: the admin toggle gates the PROVIDER, not just the button ──
  console.log("social providers — toggle gates registration:");
  const envLocked = socialEnvLock("google");
  const priorRow = await oauthSettingsService.get("google");
  const [priorSetting] = await db.select().from(site_settings).where(eq(site_settings.key, GOOGLE_TOGGLE));
  const hadKey = isEncryptionConfigured();
  if (!hadKey) process.env.PAYMENT_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const setToggle = (value: string) =>
    settingService.upsert({ key: GOOGLE_TOGGLE, value, type: "boolean", group_key: "auth", label: "Connexion Google — activée" });
  const rebuild = async () => {
    invalidateSocialConfigCache();
    resetAuthInstance();
    return getAuth();
  };
  try {
    await oauthSettingsService.upsert({
      provider: "google",
      client_id_enc: encryptSecret(`${TAG}-client-id`),
      client_secret_enc: encryptSecret(`${TAG}-client-secret`),
    });

    await setToggle("false");
    let a = await rebuild();
    check("credentials + toggle OFF → provider NOT registered", !a.options.socialProviders?.google);
    const offRes = await a.handler(post("/sign-in/social", { provider: "google", callbackURL: "/" }));
    check("POST /sign-in/social (google) refused while OFF", offRes.status >= 400);

    await setToggle("true");
    a = await rebuild();
    check("credentials + toggle ON → provider registered", !!a.options.socialProviders?.google);
    const onRes = await a.handler(post("/sign-in/social", { provider: "google", callbackURL: "/" }));
    check("POST /sign-in/social (google) served while ON", onRes.status === 200);
    // Drop the OAuth state row that started flow persisted (identifier = state).
    const authUrl = ((await onRes.json().catch(() => null)) as { url?: string } | null)?.url;
    const state = authUrl ? new URL(authUrl).searchParams.get("state") : null;
    if (state) await db.execute(sql`delete from verifications where identifier = ${state}`);

    // What clearOAuthCredentialsAction writes: both ciphertexts nulled.
    await oauthSettingsService.upsert({ provider: "google", client_id_enc: null, client_secret_enc: null });
    const cleared = await oauthSettingsService.get("google");
    check("clearing nulls both stored ciphertexts", !cleared?.client_id_enc && !cleared?.client_secret_enc);
    a = await rebuild();
    if (envLocked.id && envLocked.secret) {
      console.log("  (GOOGLE_* env set — env still wins after a DB clear; skipping unregister check)");
    } else {
      check("cleared credentials → provider unregistered even with toggle ON", !a.options.socialProviders?.google);
    }
  } finally {
    if (priorRow) {
      await oauthSettingsService.upsert({
        provider: "google",
        client_id_enc: priorRow.client_id_enc,
        client_secret_enc: priorRow.client_secret_enc,
      });
    } else {
      await db.delete(oauth_provider_settings).where(eq(oauth_provider_settings.provider, "google"));
    }
    if (priorSetting) {
      await settingService.upsert({ ...priorSetting });
    } else {
      await db.delete(site_settings).where(eq(site_settings.key, GOOGLE_TOGGLE));
    }
    if (!hadKey) delete process.env.PAYMENT_ENCRYPTION_KEY;
    invalidateSocialConfigCache();
    resetAuthInstance();
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
