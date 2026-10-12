import "server-only";

import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";

import { db } from "@/lib/db/client";
import { dispatchEmail } from "@/modules/mailing";
import { firstNameOf, maskEmail } from "@/lib/email/util";
import { serverEnv } from "@/lib/env";
import { getClientIp } from "@/lib/client-ip";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  captureInviteUrl,
  consumePendingInvite,
  hasPendingInvite,
} from "@/lib/auth/invite-context";
import { resolveSocialCredentials } from "@/lib/auth/social-config";
import { readChangeEmailClaim, withVerifyEmailCallback } from "@/lib/auth/verify-email-link";
import {
  TWO_FACTOR_CHALLENGE_COOKIE,
  TWO_FACTOR_CHALLENGE_RATE_LIMIT,
  twoFactorChallengeKey,
  twoFactorChallengeKeyFromCookieHeader,
} from "@/lib/auth/two-factor-challenge";
import {
  AUTH_HTTP_DISABLED_PATHS,
  AUTH_POLICY,
  AUTH_RATE_LIMITS,
  EMAIL_VERIFICATION_REQUIRED_KEY,
  SESSION_POLICY_BOUNDS,
  SESSION_POLICY_KEYS,
  oauthAutolinkGate,
  isOAuthCallbackPath,
} from "@/lib/auth/policy";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { DEFAULT_SITE_NAME } from "@/lib/seo/config";
import { authService } from "@/modules/auth/service";
import { isInternalAccount } from "@/lib/rbac/roster";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { newsletterService } from "@/modules/newsletter/service";
import { claimGuestOrdersAfterVerification } from "@/lib/order/claim-guest-orders";
import { bus } from "@/events/bus";

// Register subscribers exactly once per server process.
import "@/events/subscribers";

// Use Better Auth's expected table names. We aliased them via the schema
// re-exports under the same identifiers so the adapter introspection works.
import { accounts, sessions, users, verifications, twoFactors } from "@/modules/auth/schema";

/**
 * Better Auth configuration.
 *
 * - Email + password (scrypt hash, managed by Better Auth)
 * - Email verification mandatory before first sign-in
 * - Password reset by emailed link, 1h validity
 * - Sessions: HttpOnly Secure SameSite=Lax cookie, 7-day expiry, rotation
 *
 * Email is sent through our provider abstraction (`sendEmail`) so swapping
 * Resend ↔ SMTP is an env change, not a code change. Audit events fire from
 * subscribers — Better Auth doesn't know they exist.
 *
 * IMPORTANT: never call this file from client code. Only Server Components,
 * Server Actions, Route Handlers, and scripts.
 */
// Origins Better Auth will trust for CSRF/origin checks. Always trusts the
// canonical `BETTER_AUTH_URL`; production deployments also trust the public
// site URL since Coolify can route them onto different hostnames.
function buildTrustedOrigins(): string[] {
  const origins = new Set<string>();
  if (serverEnv.BETTER_AUTH_URL) origins.add(serverEnv.BETTER_AUTH_URL);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (siteUrl) origins.add(siteUrl);
  // Localhost is implicitly allowed in dev; in prod the operator can extend
  // this via the BETTER_AUTH_TRUSTED_ORIGINS env var (CSV). Each entry is
  // VALIDATED (parseable origin; https-only in prod) before it widens the trust
  // set — a stray wildcard / typo / http entry is dropped with a warning rather
  // than silently trusted (a trusted origin relaxes Better Auth's CSRF/origin
  // check, so it must never be a misconfiguration knob).
  const extra = process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  if (extra) {
    for (const raw of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
      try {
        const u = new URL(raw);
        if (serverEnv.NODE_ENV === "production" && u.protocol !== "https:") {
          console.warn(`[auth] ignoring non-https BETTER_AUTH_TRUSTED_ORIGINS entry: ${raw}`);
          continue;
        }
        origins.add(u.origin);
      } catch {
        console.warn(`[auth] ignoring malformed BETTER_AUTH_TRUSTED_ORIGINS entry: ${raw}`);
      }
    }
  }
  return Array.from(origins);
}

/**
 * Social OAuth providers, registered only when BOTH credentials resolve to a
 * non-empty value AND the admin toggle is ON. Credentials come from
 * `resolveSocialCredentials` (src/lib/auth/social-config.ts): a set env var
 * (`GOOGLE_*` / `FACEBOOK_*`) FORCE-OVERRIDES the admin-saved, encrypted DB
 * value. The admin toggles (`auth.social.google_enabled` /
 * `auth.social.facebook_enabled`, Admin → Clients → Connexion & comptes) gate
 * the PROVIDER itself, not just the storefront button (pages-config.ts applies
 * the same rule for button visibility): switched off, the provider isn't
 * registered, so POST /api/auth/sign-in/social and /api/auth/callback/<provider>
 * reject it — hiding the button alone left a live hidden sign-in/sign-up path.
 * Fails CLOSED: a settings read error registers no provider.
 *
 * Because Better Auth captures these at instance construction, credentials +
 * toggles are resolved when the (lazy, cached) auth instance is first built; the
 * admin save action calls `resetAuthInstance()` so a change applies on the next
 * request without a redeploy.
 *
 * Callback URL to whitelist in each provider console:
 * `<BETTER_AUTH_URL>/api/auth/callback/google` (resp. `/facebook`) — better-auth
 * derives the redirect_uri from `baseURL` (= BETTER_AUTH_URL, set below), NOT from
 * NEXT_PUBLIC_SITE_URL, so the whitelisted origin MUST equal BETTER_AUTH_URL or the
 * provider returns redirect_uri_mismatch. The admin panel surfaces this exact URL.
 */
async function buildSocialProviders(): Promise<BetterAuthOptions["socialProviders"]> {
  const [creds, settings] = await Promise.all([
    resolveSocialCredentials().catch(() => ({ google: null, facebook: null })),
    getSettingsMap().catch(() => ({}) as Record<string, string | null>),
  ]);
  const enabled = (provider: "google" | "facebook"): boolean => {
    const v = settings[`auth.social.${provider}_enabled`]?.trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes" || v === "on";
  };
  const social: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  if (creds.google && enabled("google")) {
    social.google = {
      clientId: creds.google.clientId,
      clientSecret: creds.google.clientSecret,
    };
  }
  if (creds.facebook && enabled("facebook")) {
    social.facebook = {
      clientId: creds.facebook.clientId,
      clientSecret: creds.facebook.clientSecret,
    };
  }
  return social;
}

/**
 * Admin-tunable session policy (Système → Utilisateurs → Sessions). Read from
 * `site_settings` with the `AUTH_POLICY` constants as defaults + safety clamps.
 * Better Auth captures these at instance build, so the save action calls
 * `resetAuthInstance()` to apply them without a redeploy.
 *
 * NOTE on the cookie cache: it only caches the SESSION payload for reads; our
 * gates (`requireSession`/`requirePermission`/`requireAdminArea`/`getCurrentUser`)
 * re-fetch the user row every gated request, so a disabled/demoted account is
 * still blocked LIVE regardless of this value. Raising it is a perf/UX trade-off
 * — the residual is that an explicit force-logout (session-row delete) can take
 * up to `cookieCacheMinutes` to bite (disable is the immediate kill switch).
 */
async function resolveSessionPolicy() {
  let s: Record<string, string | null> = {};
  try {
    s = await getSettingsMap();
  } catch {
    // settings table unavailable on a cold boot → fall back to the constants
  }
  const num = (key: string, c: { def: number; min: number; max: number }): number => {
    const v = Number(s[key]);
    return Number.isFinite(v) && v >= c.min && v <= c.max ? Math.round(v) : c.def;
  };
  return {
    expiresDays: num(SESSION_POLICY_KEYS.expiresDays, SESSION_POLICY_BOUNDS.expiresDays),
    updateAgeDays: num(SESSION_POLICY_KEYS.updateAgeDays, SESSION_POLICY_BOUNDS.updateAgeDays),
    cookieCacheMinutes: num(
      SESSION_POLICY_KEYS.cookieCacheMinutes,
      SESSION_POLICY_BOUNDS.cookieCacheMinutes,
    ),
    // Default ON (AUTH_POLICY.requireEmailVerification); only the literal "false"
    // disables the unverified-login block. Admin-tunable on /admin/users/settings.
    requireEmailVerification:
      s[EMAIL_VERIFICATION_REQUIRED_KEY] === "false"
        ? false
        : AUTH_POLICY.requireEmailVerification,
  };
}

/**
 * Build a fresh Better Auth instance. Async because the social-provider
 * credentials are resolved from the DB (admin panel) with env override. Called
 * once per process (lazily, via `getAuth`) and again after `resetAuthInstance`.
 */
async function buildAuth() {
  const sessionPolicy = await resolveSessionPolicy();
  return betterAuth({
  appName: DEFAULT_SITE_NAME,
  baseURL: serverEnv.BETTER_AUTH_URL,
  secret: serverEnv.BETTER_AUTH_SECRET,
  trustedOrigins: buildTrustedOrigins(),

  // The credential endpoints the app serves IN-PROCESS (server actions →
  // workflows) are 404 over HTTP: a direct POST /api/auth/sign-in/email (etc.)
  // would otherwise skip the per-account throttle, the audit events and the
  // signup invariants those actions add. Checked only by Better Auth's HTTP
  // router, so `auth.api.*` keeps working. List + rationale: policy.ts.
  disabledPaths: [...AUTH_HTTP_DISABLED_PATHS],

  // /two-factor/verify-totp must stay reachable over HTTP (the /account 2FA
  // card confirms enrolment through authClient), but the SIGN-IN challenge can
  // be verified there too — skipping verifyTwoFactorAction's Postgres
  // per-challenge cap (a botnet with the password could spread TOTP guesses
  // over many IPs). A direct HTTP hit carrying a pending challenge cookie
  // therefore draws from the SAME `2fa-verify:chal:<hash>` bucket (same limits).
  // The key comes from the EXACT cookie the plugin verifies, read with Better
  // Auth's own signed-cookie getter (first occurrence, signature checked) — a
  // decoy `*.two_factor` cookie can't mint a fresh bucket per guess, and an
  // unsigned one charges nothing (two-factor-challenge.ts).
  // `ctx.request` is only set on HTTP calls, so the in-process verify (already
  // counted by the action) isn't double-counted.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // /two-factor/enable on an account that ALREADY has 2FA would silently
      // rotate the authenticator secret and hand out fresh backup codes (the
      // plugin re-creates the row as verified, the flag stays true, nothing is
      // audited). The /account card only offers « Désactiver » while 2FA is on,
      // so refuse it: disable first (audited below), then re-enrol. The flag is
      // read from the DB, not the (possibly cookie-cached) session. No session →
      // fall through to the endpoint's own 401.
      if (ctx.path === "/two-factor/enable") {
        const session = await getSessionFromCtx(ctx);
        if (!session?.session) return;
        const row = await authService.findById(session.user.id);
        if (row?.twoFactorEnabled) {
          throw new APIError("BAD_REQUEST", {
            message: "La double authentification est déjà active. Désactivez-la d'abord pour la reconfigurer.",
          });
        }
        return;
      }
      if (!ctx.request || ctx.path !== "/two-factor/verify-totp") return;
      const token = await ctx.getSignedCookie(
        ctx.context.createAuthCookie(TWO_FACTOR_CHALLENGE_COOKIE).name,
        ctx.context.secret,
      );
      if (!token) return; // signed-in enrolment confirm / no valid pending challenge
      const rl = await checkRateLimit({
        bucket: `2fa-verify:chal:${twoFactorChallengeKey(token)}`,
        ...TWO_FACTOR_CHALLENGE_RATE_LIMIT,
      });
      if (!rl.ok) {
        await bus
          .emit("auth.rate_limited", { kind: "two_factor", ip: getClientIp(ctx.request.headers) })
          .catch(() => {});
        throw new APIError("TOO_MANY_REQUESTS", {
          message: "Trop de tentatives. Réessayez plus tard.",
        });
      }
    }),
    // SERVER-SIDE audit of the self-service security transitions. The /account
    // 2FA card runs them over HTTP (authClient), so a client-called audit action
    // could be skipped (direct POST /api/auth/two-factor/disable) or forged.
    // After-hooks run for HTTP AND in-process calls, and only a SUCCESSFUL call
    // (the returned value is not an error) is recorded:
    //   - /change-password (changePasswordAction, in-process — the current
    //     password was re-verified) → user.password_changed;
    //   - /two-factor/disable → user.two_factor_disabled;
    //   - /two-factor/verify-totp on a SIGNED-IN request that flipped the flag
    //     → user.two_factor_enabled. Mirrors the plugin's own enrolment branch:
    //     it flips the flag (and mints `newSession` with it on) only when the
    //     request's session user had it OFF — so a session-refresh cookie or a
    //     re-verify while 2FA is already on never reads as an "enable". The
    //     sign-in challenge verify has no session on the request, so a 2FA
    //     login never counts.
    // Audit failure is logged, never surfaced: the change itself is committed.
    after: createAuthMiddleware(async (ctx) => {
      if (
        ctx.path !== "/change-password" &&
        ctx.path !== "/two-factor/disable" &&
        ctx.path !== "/two-factor/verify-totp"
      ) {
        return;
      }
      const returned = ctx.context.returned;
      if (isAPIError(returned) || returned instanceof Error) return;
      const signedIn = ctx.context.session?.session ? ctx.context.session : null;
      if (!signedIn) return;
      const userId = signedIn.user.id;
      const reqHeaders = ctx.request?.headers ?? ctx.headers;
      const meta = { actorUserId: userId, actorIp: reqHeaders ? getClientIp(reqHeaders) : null };
      if (ctx.path === "/change-password") {
        await bus
          .emit("user.password_changed", { userId }, meta)
          .catch((err) => console.error("[auth] password change audit failed", err));
        return;
      }
      if (ctx.path === "/two-factor/disable") {
        await bus
          .emit("user.two_factor_disabled", { userId }, meta)
          .catch((err) => console.error("[auth] 2FA disable audit failed", err));
        return;
      }
      const wasOn = Boolean((signedIn.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled);
      const fresh = ctx.context.newSession?.user as { id: string; twoFactorEnabled?: boolean | null } | undefined;
      if (!wasOn && fresh?.id === userId && fresh.twoFactorEnabled) {
        await bus
          .emit("user.two_factor_enabled", { userId }, meta)
          .catch((err) => console.error("[auth] 2FA enable audit failed", err));
      }
    }),
  },

  socialProviders: await buildSocialProviders(),

  // Account linking — DON'T trust every OAuth provider to auto-link onto an
  // existing email/password account. Better Auth's default would link any
  // provider whose returned email is "verified"; a provider that can be coaxed
  // into asserting a victim's email (Facebook has historically returned emails
  // that aren't provably owner-verified) would then let an attacker link onto —
  // and sign in as — an existing account, including a staff/admin. We restrict
  // auto-linking to Google (strong email verification); Facebook sign-ins only
  // create their own new account and never silently attach to an existing one.
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: [...AUTH_POLICY.trustedLinkingProviders],
    },
  },

  // Per-process in-memory sliding-window rate limit. Fine for the single-
  // instance Coolify deploy pattern; switch storage to "secondary-storage"
  // + Redis when scaling out across multiple app pods. "database" mode
  // would need an extra Drizzle table wired into the adapter schema, which
  // is overkill for the small request rates expected.
  rateLimit: {
    enabled: true,
    window: AUTH_RATE_LIMITS.windowSeconds,
    max: AUTH_RATE_LIMITS.maxPerWindow,
    customRules: { ...AUTH_RATE_LIMITS.rules },
    storage: "memory",
  },

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
      // Maps the twoFactor plugin's `twoFactor` model → our `two_factors` table.
      twoFactor: twoFactors,
    },
  }),

  emailAndPassword: {
    enabled: true,
    // Admin-tunable (auth.email_verification_required, default ON). When OFF,
    // Better Auth stops blocking unverified logins; the verification email is
    // still sent on signup so users can verify later. resetAuthInstance() on
    // save rebuilds this instance so the toggle takes effect immediately.
    requireEmailVerification: sessionPolicy.requireEmailVerification,
    // OWASP ASVS 5 / NIST SP 800-63B-2025 recommend 12+ chars when the only
    // factor (AUTH_POLICY.minPasswordLength). Existing passwords aren't
    // re-validated, so this only affects new signups + password resets.
    minPasswordLength: AUTH_POLICY.minPasswordLength,
    maxPasswordLength: AUTH_POLICY.maxPasswordLength,
    autoSignIn: false, // Force verify-email step before first session.
    // Revoke ALL existing sessions when a password is reset via the emailed
    // link. Without this, the canonical "I think I'm compromised → reset my
    // password" flow changes the credential but leaves a hijacked session
    // alive. Brings the unauthenticated reset path in line with the admin
    // set-password + self-service change-password flows, which already revoke.
    revokeSessionsOnPasswordReset: true,
    // Wire the policy constant through so the reset-link validity ACTUALLY
    // matches what the Security diagnostics tab displays (and the 60-minute
    // wording in the email/invite templates). Without this Better Auth falls
    // back to its own 1h default — which happens to coincide today, but left
    // unwired the displayed policy would silently drift if the constant changed.
    resetPasswordTokenExpiresIn: 60 * AUTH_POLICY.passwordResetExpiresMinutes,
    sendResetPassword: async ({ user, url }, request) => {
      // Admin invitations piggyback on the reset-password flow: the invite
      // workflow marks the email (see lib/auth/invite-context.ts) before
      // creating the account, and we swap in the invitation template here.
      // Same link, same validity — only the wording differs. The marker is
      // consumed only AFTER a successful send, so a failed dispatch leaves it
      // in place and a retry (« Envoyer un lien de réinitialisation ») still
      // goes out with the invitation wording as the invitee's first email.
      if (hasPendingInvite(user.email)) {
        // Stash the set-password link so the inviting admin can be SHOWN it
        // (reveal-on-demand) to relay manually if the email doesn't arrive.
        captureInviteUrl(user.email, url);
        const result = await dispatchEmail({
          key: "user_invitation",
          to: user.email,
          variables: {
            first_name: firstNameOf(user.name),
            invite_url: url,
            expires_minutes: 60,
          },
        });
        if (result.sent) consumePendingInvite(user.email);
      } else {
        await dispatchEmail({
          key: "password_reset",
          to: user.email,
          variables: {
            first_name: firstNameOf(user.name),
            reset_url: url,
            expires_minutes: 60,
          },
        });
      }
      // Both branches emit — this event is the audit trail for the link send.
      await bus.emit(
        "user.password_reset_requested",
        { userId: user.id, email: user.email, ip: getIp(request) },
        { actorUserId: user.id, actorIp: getIp(request) },
      );
    },
    onPasswordReset: async ({ user }, request) => {
      await bus.emit(
        "user.password_reset_completed",
        { userId: user.id, email: user.email, ip: getIp(request) },
        { actorUserId: user.id, actorIp: getIp(request) },
      );
    },
  },

  emailVerification: {
    autoSignInAfterVerification: true,
    sendOnSignUp: true,
    expiresIn: 60 * 60 * AUTH_POLICY.emailVerificationExpiresHours,
    // Once mailbox ownership is PROVEN, claim any guest orders placed with this
    // verified email (and retro-credit their coins) — the email alone is the
    // gate, the phone plays no part. Deliberately NOT done at signup time —
    // there the email is still unverified attacker-supplied input, so claiming
    // then would let a stranger orphan a guest-only customer's order history.
    // Then emit `user.email_verified` (audit + webhooks): the emailed link is
    // handled HERE (GET /api/auth/verify-email), never by a workflow, so this
    // hook is the one place every self-service verification passes — signup
    // links AND the new address of a completed email change (Better Auth runs
    // it for both). Best-effort: a failure here must never break the
    // verification flow.
    afterEmailVerification: async (user, request) => {
      try {
        await claimGuestOrdersAfterVerification({ userId: user.id, email: user.email });
      } catch (err) {
        console.error("[auth] post-verification guest-order claim failed", err);
      }
      await bus
        .emit(
          "user.email_verified",
          { userId: user.id, email: user.email },
          { actorUserId: user.id, actorIp: getIp(request) },
        )
        .catch((err) => console.error("[auth] email-verified audit failed", err));
    },
    sendVerificationEmail: async ({ user, url }) => {
      // Admin-invited accounts skip the verification email entirely: the
      // invite workflow marks the address BEFORE creating the user (so this
      // fires mid-signUpEmail while the marker is set), then marks the email
      // verified itself — the invitation's set-password link proves mailbox
      // ownership. Without this guard the invitee would receive BOTH a
      // "confirmez votre email" (whose link auto-signs them in with a password
      // they don't know) AND the invitation, with contradictory instructions.
      if (hasPendingInvite(user.email)) return;
      await dispatchEmail({
        key: "email_verification",
        to: user.email,
        variables: {
          first_name: firstNameOf(user.name),
          // Land the click on the storefront result page (success / « lien
          // expiré » in French) instead of Better Auth's silent `/` default; a
          // caller-chosen callback (change-email → /account) is kept.
          verify_url: withVerifyEmailCallback(url),
          expires_hours: 24,
        },
      });
    },
  },

  // Self-serve email change. Better Auth 1.6 reads `sendChangeEmailConfirmation`
  // (NOT `sendChangeEmailVerification`): because the current address is verified
  // it dispatches the confirmation to the CURRENT email — clicking it applies
  // the change, and the new address then re-enters the normal verification flow.
  // This blocks account takeover: an attacker with a hijacked session still
  // can't move the email without access to the current mailbox. The completed
  // change is audited via databaseHooks.user.update.
  //
  // Bootstrap note: the seeded admin changes its email through this same flow,
  // so its current address must be receivable — seed it at a real mailbox with
  // DEFAULT_ADMIN_EMAIL before first boot (see docs/deploy-runbook.md), or add a
  // real-email admin via the /admin/users invite flow (that link IS receivable).
  user: {
    changeEmail: {
      enabled: true,
      sendChangeEmailConfirmation: async ({
        user,
        newEmail,
        url,
      }: {
        user: { email: string; name: string };
        newEmail: string;
        url: string;
      }) => {
        await dispatchEmail({
          key: "email_change",
          to: user.email,
          variables: {
            first_name: firstNameOf(user.name),
            new_email: newEmail,
            verify_url: url,
            expires_minutes: 60,
          },
        });
      },
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * sessionPolicy.expiresDays,
    updateAge: 60 * 60 * 24 * sessionPolicy.updateAgeDays,
    cookieCache: {
      // 0 minutes ⇒ disable the cache entirely (always re-read the session row).
      enabled: sessionPolicy.cookieCacheMinutes > 0,
      maxAge: 60 * sessionPolicy.cookieCacheMinutes,
    },
  },

  databaseHooks: {
    user: {
      update: {
        /**
         * Completed sign-in EMAIL CHANGE → audit + newsletter follow-up. The
         * change is applied inside Better Auth when the change-email link is
         * clicked (GET /verify-email, `updateUserByEmail(old → new)`), so no
         * action or workflow sees it — this is the one place it can be caught,
         * for HTTP and in-process calls alike. The token Better Auth has JUST
         * verified carries both addresses (`email` = old, `updateTo` = new); a
         * plain signup verification has no `updateTo` and is ignored, as is
         * every other user update (2FA flag, name…).
         *
         * Emits `user.email_changed` (warn — the key account-takeover step) with
         * both addresses MASKED, and re-keys the old address's newsletter row so
         * marketing consent follows the account (newsletterService
         * .followEmailChange). Best-effort: the change is already committed.
         */
        after: async (user, ctx) => {
          if (ctx?.path !== "/verify-email") return;
          const change = readChangeEmailClaim((ctx.query as { token?: unknown } | undefined)?.token);
          if (!change || change.newEmail !== String(user.email ?? "").toLowerCase()) return;
          try {
            await newsletterService.followEmailChange(change.oldEmail, change.newEmail);
          } catch (err) {
            console.error("[auth] newsletter follow-up of an email change failed", err);
          }
          const reqHeaders = ctx.request?.headers ?? ctx.headers;
          await bus
            .emit(
              "user.email_changed",
              {
                userId: user.id,
                oldEmailMasked: maskEmail(change.oldEmail),
                newEmailMasked: maskEmail(change.newEmail),
              },
              { actorUserId: user.id, actorIp: reqHeaders ? getClientIp(reqHeaders) : null },
            )
            .catch((err) => console.error("[auth] email change audit failed", err));
        },
      },
    },
    session: {
      create: {
        /**
         * Enforcement at session-mint time — the SINGLE chokepoint every sign-in
         * path goes through: email/password, Google/Facebook OAuth callbacks, and
         * the verify-email auto-sign-in. Two guards:
         *
         * (1) BAN — Better Auth knows nothing about our soft-disable (`disabledAt`);
         *     without this a banned customer could mint a fresh session by signing
         *     in with a social provider, voiding the admin kick/ban/delete controls.
         *
         * (2) 2FA-ON-SOCIAL — the twoFactor plugin only challenges the CREDENTIAL
         *     sign-in paths (/sign-in/email|username|phone-number), NOT the OAuth
         *     callback. So a 2FA account signing in via an ALREADY-LINKED
         *     Google/Facebook account would mint a session WITHOUT its TOTP second
         *     factor — a silent 2FA bypass (account.create.before only guards the
         *     FIRST link, which fires once). We block the session-mint for a 2FA user
         *     on the OAuth callback path, forcing a full password + TOTP sign-in —
         *     the exact invariant account.create.before documents. Scoped to the
         *     callback path via `isOAuthCallbackPath(ctx.path)` because the credential
         *     path legitimately creates its session at /two-factor/verify-totp (after
         *     TOTP), which must NOT be blocked.
         *
         * On the OAuth callback path both refusals throw a FOUND redirect to the
         * storefront /login with an ?error= code (friendly French copy via
         * oauth-errors.ts) instead of Better Auth's raw JSON 403; on every other
         * path the ban throws FORBIDDEN ACCOUNT_DISABLED, which the signin workflow
         * catches and maps. `ctx` is the request-scoped auth context (the same one
         * databaseHooks.user.update.after reads `ctx.path` from). No session row or
         * cookie is created because the throw aborts createSession before either.
         */
        before: async (session, ctx) => {
          const onOAuthCallback = isOAuthCallbackPath(
            (ctx as { path?: string } | undefined)?.path,
          );
          const user = await authService.findById(session.userId);
          if (!user || user.disabledAt) {
            if (onOAuthCallback) throw oauthLoginRedirect("account_disabled");
            throw new APIError("FORBIDDEN", { message: "ACCOUNT_DISABLED" });
          }
          if (user.twoFactorEnabled && onOAuthCallback) {
            throw oauthLoginRedirect("two_factor_required");
          }
        },
      },
    },
    account: {
      create: {
        /**
         * OAuth auto-link GATE — closes the 2FA-bypass-via-Google-link vector.
         *
         * Better Auth auto-links a verified-email social account (Google, per
         * `trustedProviders`) onto an EXISTING email/password account. The
         * subsequent session is minted via the OAuth callback WITHOUT the
         * account's TOTP second factor — a silent 2FA bypass. We block that
         * silent merge unless the target user opted in (`oauthAutolink`).
         *
         *   - credential (email/password) account → never gated (return).
         *   - OAuth account onto a user with NO password account → a fresh
         *     social sign-up, allowed (return).
         *   - OAuth account onto a user that HAS a password account → a link onto
         *     an existing identity. As of migration 0157 `oauthAutolink` defaults
         *     ON, so this link is ALLOWED by default — EXCEPT: (a) if the user has
         *     2FA enabled it is ALWAYS blocked (a TOTP account must complete a full
         *     password + TOTP sign-in, never a Google callback — the same invariant
         *     session.create.before enforces on REPEAT social sign-in), and (b) if
         *     the user explicitly turned the toggle OFF it throws (fail-closed).
         *
         * The decision is the pure, unit-tested `oauthAutolinkGate` (policy.ts) so
         * the 2FA branch can't be silently dropped by a refactor. NOTE: verify this
         * against a real Google OAuth flow on a staging deploy before relying on it
         * (Google is off until creds are set).
         */
        before: async (account) => {
          if (account.providerId === "credential") return;
          const hasPassword = await authService.userHasCredentialAccount(account.userId);
          if (!hasPassword) return; // fresh social sign-up — not a merge (fast path, skips the user read).
          const user = await authService.findById(account.userId);
          const decision = oauthAutolinkGate({
            providerId: account.providerId,
            hasPasswordAccount: true,
            twoFactorEnabled: Boolean(user?.twoFactorEnabled),
            oauthAutolink: Boolean(user?.oauthAutolink),
          });
          if (decision === "block") throw new APIError("FORBIDDEN", { message: "OAUTH_AUTOLINK_DISABLED" });
        },
        /**
         * Social sign-up → customer profile. Email/password sign-ups go
         * through `workflows.auth.signup`, which creates the customer
         * profile + link itself (steps 2–3); OAuth sign-ups bypass that
         * workflow entirely — Better Auth inserts the user + account rows on
         * the callback. This hook mirrors those steps so a Google/Facebook
         * user also gets a customer_profile, the user↔profile link, and the
         * `user.created` side effects (welcome email, audit).
         *
         * Best-effort by contract: any failure is logged and swallowed —
         * profile creation must NEVER break the OAuth flow. This hook fires only
         * when an ACCOUNT row is inserted (first social sign-up, or the first time
         * a NEW provider is linked) — NOT on a repeat sign-in with an
         * already-linked provider — so it does NOT self-heal a partial failure for
         * the same provider. To avoid leaving an orphan customer_profile (one with
         * no link) if the link insert fails, the two writes are compensated: a
         * failed link rolls back the just-created profile (mirrors signup.ts).
         */
        after: async (account) => {
          if (account.providerId === "credential") return; // email+password — workflow owns it
          try {
            const existing = await customerUserLink.findByUserId(account.userId);
            if (existing) return; // already linked (e.g. provider linked onto an existing account)

            const user = await authService.findById(account.userId);
            if (!user) return;

            // Only PLAIN customer accounts get a customer profile. Better Auth
            // links a verified-email social account onto an existing user
            // implicitly — when a staff/admin signs in with Google, this hook
            // fires for their fresh account row; without this guard they'd get a
            // bogus customer_profile plus a re-fired `user.created` (welcome
            // email, audit entry). A fresh social sign-up is a plain customer, so
            // it passes; an internal account (any effective role grant or allow
            // override — the same rule as the derived account type) is skipped.
            if (await isInternalAccount(user.id)) return;

            // "Mohamed Frigui" → first = "Mohamed", last = "Frigui"; OAuth
            // names can be a single word or empty, so fall back to "Client".
            const parts = (user.name ?? "").trim().split(/\s+/).filter(Boolean);
            const firstName = parts[0] || "Client";
            const lastName = parts.slice(1).join(" ");

            const profile = await customerService.insertProfile({
              first_name: firstName,
              last_name: lastName,
              phone: null,
              marketing_opt_in: false,
            });
            // Compensate a failed link so we never strand an orphan profile (a
            // customer_profile with no customer_user_links row): the unique indexes
            // can't dedup a freshly-minted profile, and this hook won't re-fire for
            // the same provider. Mirrors the signup workflow's rollback.
            try {
              await customerUserLink.create({
                user_id: account.userId,
                customer_profile_id: profile.id,
              });
            } catch (linkErr) {
              await customerService.softDeleteProfile(profile.id).catch(() => {});
              throw linkErr;
            }

            await bus.emit(
              "user.created",
              { userId: account.userId, email: user.email, name: user.name, ip: null },
              { actorUserId: account.userId },
            );

            // A PROVIDER-VERIFIED email (Google) proves mailbox ownership just
            // like the verification link, but never goes through it — so claim
            // the guest orders placed with it here (afterEmailVerification does
            // it for email sign-ups). An unverified provider email (Facebook
            // often) gets Better Auth's verification mail instead, whose click
            // claims then.
            if (user.emailVerified) {
              try {
                await claimGuestOrdersAfterVerification({ userId: user.id, email: user.email });
              } catch (err) {
                console.error("[auth] social-signup guest-order claim failed", err);
              }
            }
          } catch (err) {
            console.error("[auth] social-signup profile creation failed", err);
          }
        },
      },
    },
  },

  advanced: {
    cookiePrefix: AUTH_POLICY.cookiePrefix,
    useSecureCookies: serverEnv.NODE_ENV === "production",
    defaultCookieAttributes: {
      sameSite: AUTH_POLICY.cookieSameSite,
      httpOnly: AUTH_POLICY.cookieHttpOnly,
    },
  },

  plugins: [
    // Optional, OPT-IN TOTP two-factor (default OFF for every account; users
    // turn it on from /account). `skipVerificationOnEnable: false` means the
    // `twoFactorEnabled` flag only flips true AFTER the user proves the
    // authenticator works (verify a code) — so a mistyped setup can't lock them
    // out. The TOTP secret + backup codes are encrypted with BETTER_AUTH_SECRET
    // (rotating that key invalidates all enrolments — see docs/security.md).
    // Available to ALL roles (customer + staff/admin). It must come BEFORE
    // nextCookies() (which has to stay last to flush Set-Cookie from actions).
    twoFactor({
      issuer: DEFAULT_SITE_NAME,
      totpOptions: { period: 30, digits: 6 },
      backupCodeOptions: { amount: 10, length: 10 },
      skipVerificationOnEnable: false,
    }),
    // Must be last — handles cookie writes from Server Actions in Next.js.
    nextCookies(),
  ],
  });
}

export type Auth = Awaited<ReturnType<typeof buildAuth>>;

/**
 * Lazily-built, process-cached Better Auth instance.
 *
 * Why lazy + async (instead of a top-level `const auth = betterAuth(...)`):
 * the social-provider credentials are resolved from the DB (admin panel) with
 * env override, which is async. Caching the build PROMISE means concurrent
 * first-callers share a single build, and a DB hiccup degrades gracefully
 * (social off) without crashing the whole auth module at import time.
 *
 * Every consumer awaits `getAuth()`; the route handler re-resolves it per
 * request (cheap — cached). After the admin saves new OAuth credentials,
 * `resetAuthInstance()` drops the cache so the next `getAuth()` rebuilds with
 * the fresh credentials — no redeploy needed.
 */
let authInstance: Promise<Auth> | null = null;

export function getAuth(): Promise<Auth> {
  return (authInstance ??= buildAuth());
}

/** Drop the cached instance so the next `getAuth()` rebuilds (e.g. after the
 *  admin changes the Google/Facebook credentials). */
export function resetAuthInstance(): void {
  authInstance = null;
}

/**
 * Per-challenge 2FA rate-limit key for the request `headers` carry — for
 * verifyTwoFactorAction, whose in-process `auth.api.verifyTOTP` reads the same
 * Cookie header. Cookie name + secret come from the live auth context, so it is
 * the exact challenge Better Auth will verify and the SAME key the HTTP
 * verify-totp hook charges (null when there is no validly signed challenge).
 */
export async function twoFactorChallengeKeyFromHeaders(headers: Headers): Promise<string | null> {
  const ctx = await (await getAuth()).$context;
  return twoFactorChallengeKeyFromCookieHeader(
    headers.get("cookie"),
    ctx.createAuthCookie(TWO_FACTOR_CHALLENGE_COOKIE).name,
    ctx.secret,
  );
}

/**
 * A FOUND (302) redirect to the storefront /login carrying an `?error=<code>`
 * that oauth-errors.ts maps to French copy — so a refused OAuth callback (banned
 * account, or a 2FA account blocked from the social path) lands on a friendly page
 * instead of Better Auth's raw JSON 403. Mirrors Better Auth's own `ctx.redirect`
 * (a FOUND APIError with a `location` header, which the router's onError passes
 * through as a 302). Uses NEXT_PUBLIC_SITE_URL because /login is a storefront route.
 */
function oauthLoginRedirect(code: string): APIError {
  const base = serverEnv.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  return new APIError("FOUND", undefined, new Headers({ location: `${base}/login?error=${code}` }));
}

/** Best-effort client IP extraction from a Better Auth request context. */
function getIp(request: unknown): string | null {
  if (!request || typeof request !== "object") return null;
  const headers = (request as { headers?: Headers }).headers;
  if (!headers) return null;
  return getClientIp(headers);
}
