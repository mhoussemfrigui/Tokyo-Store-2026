import "server-only";

import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { getAuth } from "@/lib/auth/server";
import { db } from "@/lib/db/client";
import { countEffectiveWildcardAdmins } from "@/lib/rbac/guards";
import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";

/**
 * Ensure a usable admin account exists on first boot.
 *
 * The whole point of this is to make first-time Coolify deploys "click
 * deploy → sign in" instead of "click deploy → grep token from logs → curl
 * a bootstrap endpoint → sign in".
 *
 * Decision matrix on every boot:
 *
 *   1. Any ACTIVE effective admin (an RBAC `*`
 *      holder) already exists?                                   → close the
 *      ADMIN_BOOTSTRAP_TOKEN back door (see below), then skip
 *      (evaluated EVEN with DISABLE_DEFAULT_ADMIN=true — the token
 *       flow those installs use must be burned once it has served)
 *   1b. DISABLE_DEFAULT_ADMIN=true?                              → skip
 *      (no admin yet: the bootstrap-token route stays the way in)
 *   2. `app_secrets` has `DEFAULT_ADMIN_BOOTSTRAPPED='true'`?    → skip
 *      (operator either already used the bootstrap admin or
 *       deliberately removed it — don't recreate)
 *   3. A user with the default email already exists (but holds
 *      no admin role)?                                           → skip
 *      (operator probably created the account manually; promote
 *       via /api/admin/bootstrap or /admin/users instead)
 *   4. Otherwise: create houssem@kawn.me with a random 24-char
 *      password, force-verify, assign the super_admin RBAC role, link a
 *      customer profile, log + persist — and close the bootstrap back door.
 *
 * BOOTSTRAP BACK DOOR (`POST /api/admin/bootstrap` + ADMIN_BOOTSTRAP_TOKEN):
 * the token is auto-generated + persisted in `app_secrets` by init-secrets and
 * printed once to the container log. Once the store HAS an admin it is only a
 * latent credential (log / DB-backup leak → full admin), so it is burned:
 * `closeAdminBootstrap()` deletes the persisted token and records
 * `ADMIN_BOOTSTRAP_CLOSED`, which makes the route 404 and init-secrets stop
 * loading / regenerating the token on later boots. To deliberately re-open it
 * (true lockout recovery): `DELETE FROM app_secrets WHERE key =
 * 'ADMIN_BOOTSTRAP_CLOSED';` then restart (a fresh token is generated + logged).
 *
 * To opt out entirely (e.g. you want to use the bootstrap-token flow):
 *   set DISABLE_DEFAULT_ADMIN=true in Coolify env.
 *
 * To force a re-create after deleting the row:
 *   DELETE FROM users WHERE email = 'houssem@kawn.me';
 *   DELETE FROM app_secrets WHERE key IN
 *     ('DEFAULT_ADMIN_BOOTSTRAPPED','DEFAULT_ADMIN_EMAIL');
 *   -- restart the container. (No password row exists — it is never persisted.)
 */

const FALLBACK_EMAIL = "houssem@kawn.me";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Operators can seed the bootstrap admin at their OWN real address via
// DEFAULT_ADMIN_EMAIL. That matters because the self-serve email change sends
// its confirmation to the CURRENT mailbox (see lib/auth/server.ts) — seeding a
// real, receivable address means the operator can later change it securely
// (and avoids ever needing to). A blank/invalid value falls back to the store
// default; an existing install keeps whatever it already bootstrapped.
const DEFAULT_EMAIL = (() => {
  const raw = (process.env.DEFAULT_ADMIN_EMAIL ?? "").trim().toLowerCase();
  return EMAIL_RE.test(raw) && raw.length <= 254 ? raw : FALLBACK_EMAIL;
})();
const PASSWORD_BYTES = 18; // 18 random bytes → 24 base64url chars (no pad)

function generatePassword(): string {
  return randomBytes(PASSWORD_BYTES)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** `app_secrets` marker: the one-shot bootstrap route is permanently closed. */
export const ADMIN_BOOTSTRAP_CLOSED_KEY = "ADMIN_BOOTSTRAP_CLOSED";

/** Has the bootstrap back door been closed (burned)? A missing table reads as open. */
export async function isAdminBootstrapClosed(): Promise<boolean> {
  try {
    const result = await db.execute<{ key: string }>(
      sql`SELECT key FROM app_secrets WHERE key = ${ADMIN_BOOTSTRAP_CLOSED_KEY}`,
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Atomically CLAIM the bootstrap door: inserts the closed marker iff absent.
 * Returns true for the single caller that closed it (so two concurrent valid
 * bootstrap requests can't both promote), false when it was already closed.
 */
export async function claimAdminBootstrap(): Promise<boolean> {
  const result = await db.execute<{ key: string }>(sql`
    INSERT INTO app_secrets (key, value) VALUES (${ADMIN_BOOTSTRAP_CLOSED_KEY}, 'true')
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `);
  return result.rows.length > 0;
}

/** Undo a claim whose promotion then failed (so the operator can retry). */
export async function releaseAdminBootstrapClaim(): Promise<void> {
  await db.execute(sql`DELETE FROM app_secrets WHERE key = ${ADMIN_BOOTSTRAP_CLOSED_KEY}`);
}

/**
 * Burn the bootstrap back door: record the closed marker and delete the
 * persisted ADMIN_BOOTSTRAP_TOKEN, so the route 404s from now on and
 * init-secrets neither re-exports nor regenerates the token on later boots.
 * Idempotent.
 */
export async function closeAdminBootstrap(): Promise<void> {
  await db.execute(sql`
    INSERT INTO app_secrets (key, value) VALUES (${ADMIN_BOOTSTRAP_CLOSED_KEY}, 'true')
    ON CONFLICT (key) DO NOTHING
  `);
  await db.execute(sql`DELETE FROM app_secrets WHERE key = 'ADMIN_BOOTSTRAP_TOKEN'`);
}

async function appSecretsHasBootstrappedFlag(): Promise<boolean> {
  try {
    const result = await db.execute<{ value: string }>(
      sql`SELECT value FROM app_secrets WHERE key = 'DEFAULT_ADMIN_BOOTSTRAPPED'`,
    );
    return result.rows[0]?.value === "true";
  } catch {
    // app_secrets table may not exist yet on the very first boot if for
    // some reason migrations haven't run. Treat that as "not bootstrapped"
    // so we proceed normally — the inserts below will fail loudly if the
    // table is truly missing, and the next boot retries.
    return false;
  }
}

export async function ensureDefaultAdmin(): Promise<void> {
  // (1) Any ACTIVE effective admin (an RBAC `*` holder)? Burn the
  // bootstrap back door (no-op once closed — also migrates installs whose token
  // predates the closing logic), then skip. Runs BEFORE the DISABLE_DEFAULT_ADMIN
  // opt-out on purpose: those are exactly the installs that use the token flow,
  // so they must get their token burned too once an admin exists. A fresh
  // DISABLE_DEFAULT_ADMIN install has no admin yet, so its door stays open.
  if ((await countEffectiveWildcardAdmins()) > 0) {
    if (!(await isAdminBootstrapClosed())) {
      await closeAdminBootstrap().catch((err) =>
        console.error("[default-admin] could not close the bootstrap back door", err),
      );
    }
    return;
  }

  if (process.env.DISABLE_DEFAULT_ADMIN === "true") {
    console.log("[default-admin] DISABLE_DEFAULT_ADMIN=true — skipping.");
    return;
  }

  // (2) Already done this dance?
  if (await appSecretsHasBootstrappedFlag()) {
    console.log(
      "[default-admin] previously bootstrapped (DEFAULT_ADMIN_BOOTSTRAPPED " +
        "flag set). To force recreate, delete the row and the user, then restart.",
    );
    return;
  }

  // (3) Email already taken?
  const existingUser = await authService.findByEmail(DEFAULT_EMAIL);
  if (existingUser) {
    console.log(
      `[default-admin] ${DEFAULT_EMAIL} already exists. ` +
        `Promote via /admin/users or /api/admin/bootstrap.`,
    );
    return;
  }

  // (4) Create.
  const password = generatePassword();
  let newUserId: string | null = null;
  let racedConverge = false;
  let signUpError: unknown = null;
  try {
    const auth = await getAuth();
    const result = await auth.api.signUpEmail({
      body: { email: DEFAULT_EMAIL, password, name: "Admin" },
      headers: new Headers(),
    });
    // Better Auth 1.6 (autoSignIn:false) answers a DUPLICATE email with a
    // SYNTHETIC user — a freshly generated, never-inserted id — instead of
    // throwing. Trust the id only once its row exists; otherwise this boot lost
    // the race below (and its password was never applied).
    if (await authService.findById(result.user.id)) newUserId = result.user.id;
  } catch (err) {
    signUpError = err;
  }
  if (!newUserId) {
    // Concurrency (EC-4): two near-simultaneous boots (rolling deploy / multiple
    // instances) can both pass the no-admin / no-flag / no-email checks before
    // either inserts; the loser's signUpEmail then either hits the email-unique
    // constraint (throw) or gets Better Auth's synthetic duplicate (phantom id).
    // Rather than bail (leaving this boot without granting the role or marking
    // the flag until the NEXT boot), converge on the row the winner created and
    // fall through — every step below is idempotent.
    const raced = await authService.findByEmail(DEFAULT_EMAIL);
    if (raced) {
      console.log("[default-admin] account already created by a concurrent boot — converging.");
      newUserId = raced.id;
      racedConverge = true;
    } else {
      console.error(
        "[default-admin] signUpEmail failed — skipping. You can still bootstrap " +
          "via the ADMIN_BOOTSTRAP_TOKEN flow.",
        signUpError,
      );
      return;
    }
  }

  // Force-verify so they can sign in even if the email provider isn't wired yet
  // (verification link delivery would otherwise gate first sign-in).
  await authService.update(newUserId, {
    emailVerified: true,
    disabledAt: null,
  });

  // Assign the super_admin RBAC role — this grant IS the admin access now that
  // the legacy enum→'*' bridge is retired (there is no account-type column left
  // to set). It is therefore NOT best-effort: if it fails (e.g. the super_admin
  // role row is missing because migration 0033's seed never ran — a drizzle-kit
  // `db:push` provisioning skips the hand-written INSERTs), the account we just
  // created holds NO access. We must NOT mark the bootstrap done or burn the
  // ADMIN_BOOTSTRAP_TOKEN back door in that case, or we'd strand a powerless
  // "admin" with no in-app recovery. Bail instead — the token flow (which grants
  // the role itself) stays open, and the next boot re-points the operator there.
  let granted = false;
  try {
    granted = await rbacService.grantRoleByKey(newUserId, "super_admin");
  } catch (err) {
    console.error("[default-admin] super_admin role assignment threw", err);
  }
  if (!granted) {
    console.error(
      "[default-admin] super_admin role not granted (role row missing? run migration 0033). " +
        "Leaving the bootstrap OPEN so the account can be recovered via /api/admin/bootstrap " +
        "(ADMIN_BOOTSTRAP_TOKEN) once the role is seeded — NOT marking bootstrap done.",
    );
    return;
  }

  // Customer profile + bridge link so /account works out of the box.
  try {
    const link = await customerUserLink.findByUserId(newUserId);
    if (!link) {
      const profile = await customerService.insertProfile({
        first_name: "Admin",
        last_name: "Admin",
      });
      await customerUserLink.create({
        user_id: newUserId,
        customer_profile_id: profile.id,
      });
    }
  } catch (err) {
    // Profile failure shouldn't block sign-in — log and move on.
    console.error("[default-admin] customer profile creation failed", err);
  }

  // Mark the bootstrap as done so subsequent boots don't recreate the
  // admin. The PASSWORD IS NOT PERSISTED — keeping plaintext credentials
  // in the same table as BETTER_AUTH_SECRET would let any DB-read primitive
  // (backup leak, SQL injection on an unrelated module, an over-privileged
  // operator) yield instant admin. The operator captures the password from
  // the stdout banner below; if they miss it, they reset via
  // `/forgot-password` (the seeded admin email is houssem@kawn.me by default,
  // or whatever DEFAULT_ADMIN_EMAIL was set to).
  await db.execute(sql`
    INSERT INTO app_secrets (key, value) VALUES
      ('DEFAULT_ADMIN_BOOTSTRAPPED', 'true'),
      ('DEFAULT_ADMIN_EMAIL', ${DEFAULT_EMAIL})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);
  // An admin now exists → the token-based back door has no purpose left.
  await closeAdminBootstrap().catch((err) =>
    console.error("[default-admin] could not close the bootstrap back door", err),
  );

  if (racedConverge) {
    // The account (and its password) were created by the concurrent boot that
    // won the signup race; the password generated here was never applied, so we
    // must NOT print it. The operator captured it from the winner's banner, or
    // resets via /forgot-password.
    console.log(
      `[default-admin] role + flag converged for ${DEFAULT_EMAIL} ` +
        "(password set by the concurrent boot — use /forgot-password if unknown).",
    );
    return;
  }

  console.log("");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log("  ✨  DEFAULT ADMIN ACCOUNT CREATED");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log(`  email     : ${DEFAULT_EMAIL}`);
  console.log(`  password  : ${password}`);
  console.log("");
  console.log("  → sign in at  /admin-login  (the staff portal; or your secret");
  console.log("    ADMIN_LOGIN_PATH if set. The same account also works at the");
  console.log("    public /login — /admin itself is gated by RBAC.)");
  console.log("  → change email/password at  /account");
  console.log("");
  console.log("  This banner is the ONLY copy of the password — it is NOT");
  console.log("  written to the database. If you miss it, request a password");
  console.log("  reset from /forgot-password.");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log("");
}
