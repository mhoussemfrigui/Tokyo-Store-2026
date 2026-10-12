"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { workflows } from "@/workflows";
import { getAuth, twoFactorChallengeKeyFromHeaders } from "@/lib/auth/server";
import { authQueries } from "@/modules/auth";
import { requirePermission, requireSession } from "@/lib/auth/session";
import { assertActorOutranksTarget } from "@/lib/rbac/guards";
import { getClientIp } from "@/lib/client-ip";
import { checkRateLimit } from "@/lib/rate-limit";
import { bus } from "@/events/bus";
import { maskEmail } from "@/lib/email/util";
import { TWO_FACTOR_CHALLENGE_RATE_LIMIT } from "@/lib/auth/two-factor-challenge";
import { authService } from "@/modules/auth/service";
import { type ActionState } from "@/lib/actions/types";

/**
 * Toggle the signed-in user's OAuth auto-link opt-in (Profil → security). When
 * OFF (default) a Google sign-in cannot silently link onto this email/password
 * account — which would bypass TOTP 2FA (see the `account.create.before` gate in
 * lib/auth/server.ts). The user turns it ON to allow — and thereby link — Google
 * sign-in. Returns the new value so the toggle can reflect it.
 */
export async function setOauthAutolinkAction(enabled: boolean): Promise<{ ok: boolean; enabled: boolean }> {
  const session = await requireSession();
  // A server action is a public endpoint: never trust the argument's type (a
  // truthy string would otherwise reach the boolean column).
  if (typeof enabled !== "boolean") return { ok: false, enabled: false };
  await authService.setOauthAutolink(session.user.id, enabled);
  revalidatePath("/account");
  return { ok: true, enabled };
}

/**
 * Server Actions — the only path from forms in client components to
 * domain workflows. They run on the server, with `cookies()` / `headers()`
 * available, and never expose business logic to the bundle.
 *
 * Pattern:
 *   - parse `FormData`
 *   - call the workflow with caller context (IP, actor)
 *   - on success: redirect or return a "success" shape
 *   - on validation/business failure: return `{ ok: false, ... }` so the
 *     client renders inline errors via `useActionState`.
 *
 * Throwing here triggers Next.js's error boundary — reserve for genuine
 * server errors.
 */

async function ipFromHeaders(): Promise<string | null> {
  return getClientIp(await headers());
}

// ─────────────────────────────────────────────────────────── signup
export async function signupAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  // Per-IP throttle. Better Auth's `/sign-up/email` limiter only guards its own
  // HTTP endpoint; this server action calls the workflow in-process and would
  // otherwise bypass it, letting a script rapidly probe `email_taken` to
  // enumerate which addresses have accounts (and spam the verification mailer).
  // 5/60s leaves a human ample margin for a couple of validation retries.
  const signupIp = (await ipFromHeaders()) ?? "anon";
  const signupEmail = String(formData.get("email") ?? "").trim().toLowerCase();
  // Per-IP throttle (a single source sweeping a wordlist) AND a per-EMAIL throttle
  // (one address probed from many rotating IPs). The workflow already returns an
  // identical generic response for new vs existing emails, so this is defence in
  // depth against automated enumeration / mailer spam rather than the primary
  // control. Skip the per-email bucket when no email was supplied (validation
  // will reject it anyway).
  const [signupRl, emailRl] = await Promise.all([
    checkRateLimit({ bucket: `signup:ip:${signupIp}`, max: 5, windowSeconds: 60 }),
    signupEmail
      ? checkRateLimit({ bucket: `signup:email:${signupEmail}`, max: 4, windowSeconds: 3600 })
      : Promise.resolve({ ok: true as const }),
  ]);
  if (!signupRl.ok || !emailRl.ok) {
    await bus
      .emit("auth.rate_limited", {
        kind: !signupRl.ok ? "signup_ip" : "signup_email",
        subjectMasked: signupEmail ? maskEmail(signupEmail) : null,
        ip: signupIp === "anon" ? null : signupIp,
      })
      .catch(() => {});
    return { ok: false, error: "rate_limited", message: "Trop de tentatives — réessayez plus tard." };
  }

  const result = await workflows.auth.signup(
    {
      firstName: String(formData.get("firstName") ?? ""),
      lastName: String(formData.get("lastName") ?? ""),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      password: String(formData.get("password") ?? ""),
      marketingOptIn: formData.get("marketingOptIn") === "on",
      terms: formData.get("terms") === "on",
    },
    { ip: signupIp === "anon" ? null : signupIp },
  );

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  }

  return {
    ok: true,
    message: "Compte créé. Vérifiez votre email pour activer votre compte.",
  };
}

// ─────────────────────────────────────────────────────────── signin
export async function signinAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  // CRITICAL: this server action calls `auth.api.signInEmail` IN-PROCESS, which
  // bypasses Better Auth's HTTP `/sign-in/email` rate limiter (that only runs in
  // the route handler). So the policy rule for it is dead on the real login path
  // — we throttle here, Postgres-backed (cross-pod), for customer AND staff/admin
  // logins. Per-IP caps a single source; per-ACCOUNT caps distributed credential
  // stuffing against one target (a botnet rotating IPs). Message is NEUTRAL +
  // identical regardless of whether the account exists, so it's not an
  // enumeration/lockout oracle.
  const ip = (await ipFromHeaders()) ?? "anon";
  const ipRl = await checkRateLimit({ bucket: `signin:ip:${ip}`, max: 8, windowSeconds: 60 });
  const acctRl = email
    ? await checkRateLimit({ bucket: `signin:acct:${email}`, max: 15, windowSeconds: 900 })
    : { ok: true };
  if (!ipRl.ok || !acctRl.ok) {
    await bus
      .emit("auth.rate_limited", {
        kind: !ipRl.ok ? "signin_ip" : "signin_account",
        subjectMasked: email ? maskEmail(email) : null,
        ip: ip === "anon" ? null : ip,
      })
      .catch(() => {});
    return {
      ok: false,
      error: "rate_limited",
      message: "Trop de tentatives. Réessayez dans quelques minutes.",
    };
  }

  const result = await workflows.auth.signin(
    {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      rememberMe: formData.get("rememberMe") === "on",
    },
    { ip: ip === "anon" ? null : ip },
  );

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  }

  // After success, redirect to the "from" param if present, else /account.
  // Safe-redirect: only allow same-origin paths. `from.startsWith("/")` alone
  // is NOT enough — `//evil.com` is protocol-relative and the browser would
  // navigate off-origin. Backslashes are also browser-normalised to slashes
  // on some platforms (CVE-class open-redirect bypass).
  const from = formData.get("from");
  const dest = safeRedirectPath(typeof from === "string" ? from : null) ?? "/account";

  // 2FA enabled → credentials passed but NO session yet. Send the user to the
  // second-factor step, preserving the intended destination. The session is
  // minted only after a successful TOTP / backup-code verify there.
  if (result.data.twoFactorRequired) {
    redirect(`/login/2fa?from=${encodeURIComponent(dest)}`);
  }
  redirect(dest);
}

/**
 * Second-factor verification (the /login/2fa step). After a 2FA-enabled sign-in
 * the session is NOT yet minted; this verifies a TOTP code (or a backup code)
 * and Better Auth then sets the session cookie (flushed by nextCookies). The
 * disabledAt ban hook runs at THAT session-mint, so a disabled user can't slip
 * through. Rate-limited per IP because `auth.api.*` bypasses Better Auth's HTTP
 * limiter — a 6-digit code must not be brute-forceable.
 */
export async function verifyTwoFactorAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const code = String(formData.get("code") ?? "").trim();
  const useBackup = formData.get("mode") === "backup";
  if (!code) return { ok: false, error: "validation", message: "Code requis." };

  // 2FA is the LAST gate, reached only AFTER a correct password, so the verify
  // endpoint must be hard to grind. Better Auth has no per-account 2FA lockout and
  // the in-process auth.api.verify* bypasses its HTTP limiter, so add BOTH a
  // per-IP cap AND a per-CHALLENGE cap keyed on the pending two-factor cookie. The
  // per-challenge cap binds the guess budget to the single obtained challenge so a
  // botnet rotating IPs can't widen it (mirrors the per-account cap on primary
  // sign-in). The cookie value is hashed so no challenge token lands in a key.
  const ip = (await ipFromHeaders()) ?? "anon";
  // Keyed on the EXACT challenge cookie Better Auth verifies (its real name,
  // first occurrence, signature checked) — the same key the HTTP verify-totp
  // hook charges, so a decoy `*.two_factor` cookie can't mint a fresh bucket.
  const chalKey = await twoFactorChallengeKeyFromHeaders(await headers());
  const [ipRl, chalRl] = await Promise.all([
    checkRateLimit({ bucket: `2fa-verify:ip:${ip}`, max: 6, windowSeconds: 300 }),
    chalKey
      ? checkRateLimit({ bucket: `2fa-verify:chal:${chalKey}`, ...TWO_FACTOR_CHALLENGE_RATE_LIMIT })
      : Promise.resolve({ ok: true as const }),
  ]);
  if (!ipRl.ok || !chalRl.ok) {
    await bus
      .emit("auth.rate_limited", { kind: "two_factor", ip: ip === "anon" ? null : ip })
      .catch(() => {});
    return { ok: false, error: "rate_limited", message: "Trop de tentatives. Réessayez plus tard." };
  }

  try {
    const auth = await getAuth();
    const hdrs = await headers();
    if (useBackup) {
      await auth.api.verifyBackupCode({ body: { code }, headers: hdrs });
    } else {
      await auth.api.verifyTOTP({ body: { code }, headers: hdrs });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ACCOUNT_DISABLED/i.test(msg)) {
      return { ok: false, error: "account_disabled", message: "Ce compte a été désactivé. Contactez le support." };
    }
    // A wrong/expired second factor — record it for the security trail (no PII;
    // the challenge holder is not yet a full session). Best-effort.
    await bus
      .emit("user.two_factor_failed", { mode: useBackup ? "backup" : "totp", ip: ip === "anon" ? null : ip })
      .catch(() => {});
    return {
      ok: false,
      error: "invalid_code",
      message: useBackup ? "Code de secours invalide." : "Code invalide ou expiré.",
    };
  }

  const from = formData.get("from");
  redirect(safeRedirectPath(typeof from === "string" ? from : null) ?? "/account");
}

/**
 * Allow-list a same-origin redirect path. Returns null if `value` looks
 * dangerous (off-origin, protocol-relative, javascript:, etc.).
 */
function safeRedirectPath(value: string | null): string | null {
  if (!value) return null;
  // Must start with exactly one slash followed by NOT another slash and NOT a backslash.
  if (!/^\/(?![/\\])/.test(value)) return null;
  // No control chars, no whitespace. Block-list is intentional (XSS guard).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\s]/.test(value)) return null;
  // No `javascript:` style trickery (defensive — the leading-slash check
  // already blocks this, but cheap to double-belt).
  if (/^\s*javascript:/i.test(value)) return null;
  return value;
}

// ─────────────────────────────────────────────────────────── signout
export async function signoutAction(): Promise<never> {
  const session = await requireSession();
  await workflows.auth.signout({ userId: session.user.id });
  redirect("/");
}

// ─────────────────────────────────────────────────────────── password reset request
export async function requestPasswordResetAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  // Per-IP AND per-EMAIL throttle. The workflow runs in-process (Better Auth's
  // own `/request-password-reset` is 404 over HTTP — policy.ts), so no Better
  // Auth limiter covers it. Per-IP caps a single source; per-email caps one
  // victim's mailbox being bombed from rotating IPs (and the mailer quota
  // burnt). On throttle we return the SAME generic message so the limit is
  // invisible to the caller (no enumeration); the trip is recorded for the
  // Sécurité view (`auth.rate_limited`, masked subject).
  const ip = (await ipFromHeaders()) ?? "anon";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const [ipRl, emailRl] = await Promise.all([
    checkRateLimit({ bucket: `pwreset:ip:${ip}`, max: 3, windowSeconds: 60 }),
    email
      ? checkRateLimit({ bucket: `pwreset:email:${email}`, max: 3, windowSeconds: 3600 })
      : Promise.resolve({ ok: true as const }),
  ]);
  if (ipRl.ok && emailRl.ok) {
    await workflows.auth.requestPasswordReset(
      { email: String(formData.get("email") ?? "") },
      { ip },
    );
  } else {
    await bus
      .emit("auth.rate_limited", {
        kind: "password_reset",
        subjectMasked: email ? maskEmail(email) : null,
        ip: ip === "anon" ? null : ip,
      })
      .catch(() => {});
  }

  // Always the same message — prevent enumeration.
  return {
    ok: true,
    message:
      "Si un compte existe avec cet email, vous recevrez un lien de réinitialisation dans quelques instants.",
  };
}

// ─────────────────────────────────────────────────────────── reset password
export async function resetPasswordAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  // Per-IP throttle on the token CONSUME step. The request step
  // (requestPasswordResetAction) is already throttled, but Better Auth's
  // `/reset-password` HTTP limiter doesn't cover this in-process workflow call —
  // without it an attacker could grind reset tokens (defence-in-depth; tokens
  // are high-entropy + single-use + 1h-expiring, so this just caps the rate).
  const ip = (await ipFromHeaders()) ?? "anon";
  const rl = await checkRateLimit({ bucket: `pwreset:consume:ip:${ip}`, max: 5, windowSeconds: 60 });
  if (!rl.ok) {
    return { ok: false, error: "rate_limited", message: "Trop de tentatives — réessayez plus tard." };
  }

  const result = await workflows.auth.resetPassword({
    token: String(formData.get("token") ?? ""),
    newPassword: String(formData.get("newPassword") ?? ""),
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  }
  return { ok: true, message: "Mot de passe mis à jour. Vous pouvez vous connecter." };
}

// ─────────────────────────────────────────────────────────── admin: disable/enable + force logout
export async function disableUserAction(userId: string): Promise<ActionState> {
  const session = await requirePermission('users', 'manage');
  const result = await workflows.auth.disableUser(
    { userId },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/users");
  return { ok: true, message: "Compte désactivé." };
}

export async function enableUserAction(userId: string): Promise<ActionState> {
  const session = await requirePermission('users', 'manage');
  const result = await workflows.auth.enableUser(
    { userId },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/users");
  return { ok: true, message: "Compte réactivé." };
}

export async function forceLogoutUserAction(userId: string): Promise<ActionState> {
  const session = await requirePermission('users', 'manage');
  const result = await workflows.auth.forceLogout(
    { userId },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/users");
  return {
    ok: true,
    message: `Sessions révoquées (${result.data.revokedCount}).`,
  };
}

// ─────────────────────────────────────────────────────────── admin: toggle email-verified
/**
 * Flip the `email_verified` flag on a user. Useful when an admin has
 * out-of-band confirmation (e.g. the customer called) and wants to skip
 * the email round-trip, or when reverting a wrongful auto-verification.
 *
 * SECURITY: flipping `email_verified` ON without the user proving mailbox
 * ownership is an account-takeover-enabling action (verify a squatted email,
 * then trigger a password reset to the attacker's mailbox). It is therefore
 * gated on THREE controls, none of which auto-trust the caller:
 *   1. `requirePermission('users','manage')` — the RBAC gate.
 *   2. `assertActorOutranksTarget` (inside the workflow) — a manager may not
 *      flip the flag of a higher-privileged target.
 *   3. a prominent, ALWAYS-on `user.email_verified_admin_override` audit event
 *      (warn severity, both directions) so the override is never silent and
 *      stands out on the Sécurité page vs. the routine verify flow.
 * The UI requires an explicit confirmation dialog before calling this.
 */
export async function toggleEmailVerifiedAction(userId: string): Promise<ActionState> {
  const session = await requirePermission('users', 'manage');
  const user = await authQueries.findUserById(userId);
  if (!user) {
    return { ok: false, error: "not_found", message: "Utilisateur introuvable." };
  }
  const next = !user.emailVerified;
  const result = await workflows.auth.setEmailVerified(
    { userId: user.id, verified: next },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/users");
  return {
    ok: true,
    message: next ? "Email marqué vérifié." : "Email marqué non vérifié.",
  };
}

// ─────────────────────────────────────────────────────────── admin: trigger password reset
/**
 * Admin-initiated reset: looks up the user's email, then invokes the
 * standard public flow which sends them a reset link via the configured
 * mailer. Returns the same generic success message either way.
 */
export async function triggerPasswordResetAction(userId: string): Promise<ActionState> {
  const session = await requirePermission('users', 'manage');
  const user = await authQueries.findUserById(userId);
  if (!user) {
    return { ok: false, error: "not_found", message: "Utilisateur introuvable." };
  }
  // A non-wildcard actor may not send a reset link for a higher-privileged
  // target (the link would let the actor seize a super_admin's account).
  const outranked = await assertActorOutranksTarget(session.user.id, user.id);
  if (outranked) return outranked;
  // Per-actor throttle (AUTH-1): mirror the public reset action so a delegated
  // users-manager (or a hijacked staff session) can't loop this to mail-bomb a
  // target / burn mailer quota. Better Auth's own limiter doesn't cover this
  // in-process call.
  const ip = (await ipFromHeaders()) ?? "anon";
  const rl = await checkRateLimit({
    bucket: `pwreset:admin:${session.user.id}`,
    max: 5,
    windowSeconds: 60,
  });
  if (!rl.ok) {
    return { ok: false, error: "rate_limited", message: "Trop de demandes. Réessayez dans une minute." };
  }
  await workflows.auth.requestPasswordReset(
    { email: user.email },
    { ip },
  );
  revalidatePath("/admin/users");
  return {
    ok: true,
    message: "Lien de réinitialisation envoyé à l'utilisateur.",
  };
}
