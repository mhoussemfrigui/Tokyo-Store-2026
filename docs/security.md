# Security baseline

What's protected, where, and how to add a feature without weakening it.

Every control below is wired in code today (paths are clickable). When you
change one of these surfaces, update this file in the same PR.

## Threat model (in scope)

This project is a public e-commerce site with an admin panel. We protect
against:

- Credential stuffing / brute force on `/api/auth/*` and our own public
  endpoints (newsletter, bootstrap, search, order placement)
- Account enumeration via auth flows
- Session survival after an account is disabled / demoted (stolen or
  long-lived cookie, or a standing API key)
- CSRF on mutations (Server Actions **and** bare `POST /api/admin/*` routes)
- XSS via admin-authored rich text (TipTap output: blog, aid, product, CMS,
  legal)
- SQL injection via crafted form input
- Privilege escalation (a customer making themselves admin; a delegated role
  reaching owner-level surfaces such as the mail transport, tracking scripts,
  payment credentials or the site URL; removing the last admin to zero out
  the panel)
- Bearer URLs (order ids, reset / invite / unsubscribe tokens) leaking to
  third-party tags
- File-upload abuse (path traversal, oversized files, non-image MIME, EXIF
  leakage)
- SSRF via the server-side "import image from URL" feature (cloud-metadata,
  RFC1918, DNS-rebinding)
- Payment settlement spoofing / double-settlement via replayed webhooks
- Secrets at rest (payment credentials, encryption key) readable from a DB
  dump
- Unbounded PII-bearing log growth (audit / search / webhook ledgers)

Out of scope (handled by Coolify / Cloudflare): volumetric DDoS, IP-level
rate limiting, TLS termination, WAF. (The app still runs its own per-IP /
per-account Postgres buckets on auth, order placement, search, newsletter,
coupons and partner invites — see the table.)

## Controls in place

| Risk                                | Mitigation                                                                                                                                                  | Where                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Credential stuffing / brute force   | The email/password forms submit through SERVER ACTIONS that call `auth.api.*` IN-PROCESS. The matching raw Better Auth endpoints are **404 over HTTP** (`disabledPaths` = `AUTH_HTTP_DISABLED_PATHS`: `/sign-in/email`, `/sign-up/email`, `/request-password-reset`, `/reset-password`, `/send-verification-email`, `/change-password`, `/change-email`, `/update-user`, `/delete-user`, `/verify-password`, `/two-factor/{verify-backup-code,generate-backup-codes,get-totp-uri,send-otp,verify-otp}`), so the only way in is through the actions, which apply **our own** Postgres fixed-window buckets and emit the audit events: `signinAction` (per-IP 8/min **and** per-account 15/15 min, neutral message), `signupAction` (per-IP 5/min **and** per-email 4/h), `requestPasswordResetAction` (per-IP 3/min **and** per-email 3/h, `pwreset:email:`, neutral response), `resetPasswordAction` (per-IP 5/min), `verifyTwoFactorAction` (per-IP 6/5 min **and** per-challenge 8/15 min). A trip on the sign-in, sign-up, reset-request or 2FA buckets emits `auth.rate_limited` (the reset-link consume bucket just refuses). What stays on HTTP (`/get-session`, `/sign-out`, `/sign-in/social`, `/callback/*`, `/verify-email`, `GET /reset-password/:token`, `/two-factor/{enable,verify-totp,disable}`) is covered by Better Auth's per-endpoint limiter (`AUTH_RATE_LIMITS.rules`); the `/api/auth` route first rewrites `X-Forwarded-For` to the trusted last hop (`getClientIp`), so a spoofed leading entry can't mint a fresh bucket per request. A direct HTTP `/two-factor/verify-totp` carrying a sign-in challenge draws from the SAME per-challenge bucket as the action (`hooks.before`). Cron endpoints get the bucket via `guardCron` (10/min per IP, BEFORE the secret check). | [`src/lib/auth/policy.ts`](../src/lib/auth/policy.ts) (`AUTH_HTTP_DISABLED_PATHS`, `AUTH_RATE_LIMITS`), [`src/lib/auth/server.ts`](../src/lib/auth/server.ts) (`disabledPaths`, `hooks`, `rateLimit`), [`src/app/api/auth/[...all]/route.ts`](../src/app/api/auth/%5B...all%5D/route.ts), [`src/lib/actions/auth.ts`](../src/lib/actions/auth.ts), [`src/lib/cron/guard.ts`](../src/lib/cron/guard.ts), [`src/lib/rate-limit.ts`](../src/lib/rate-limit.ts) (`rate_limit_buckets`) |
| Account enumeration                 | `requestPasswordResetAction` always returns the same generic message; sign-in errors are generic ("Email ou mot de passe incorrect"); `signupAction` returns the SAME generic success for a new and an already-registered address (a duplicate creates nothing: no profile, link or `user.created` event) and is throttled per IP + per email; the newsletter subscribe action returns **one** neutral message for created/reactivated/already-active (no "déjà inscrit·e" leak). | [`src/lib/actions/auth.ts`](../src/lib/actions/auth.ts), [`src/workflows/auth/signup.ts`](../src/workflows/auth/signup.ts), [`src/lib/actions/newsletter.ts`](../src/lib/actions/newsletter.ts)    |
| Session survives disable/demote     | `disabledAt` gate: `requireSession` / `requirePermission` / `getCurrentUser` re-fetch the live row each request and reject a disabled account even with a valid cookie (the RBAC gates resolve a disabled account to NO permissions). Disabling deletes the user's sessions **and revokes every API key they created** (keys never traverse the login ban). A demotion from Admin, or to Client, deletes the user's sessions; RBAC role changes need no revocation (permissions resolve live). | [`src/lib/auth/session.ts`](../src/lib/auth/session.ts), [`src/lib/rbac/authorize.ts`](../src/lib/rbac/authorize.ts), [`src/workflows/auth/disable-user.ts`](../src/workflows/auth/disable-user.ts), [`src/workflows/auth/change-role.ts`](../src/workflows/auth/change-role.ts) |
| Session cookies                     | `HttpOnly + Secure (prod) + SameSite=Lax`, 7-day TTL, sliding refresh once/day, `gz` cookie prefix (defaults — admin-tunable within `SESSION_POLICY_BOUNDS`; the cookie cache is capped at 30 min) | [`src/lib/auth/server.ts`](../src/lib/auth/server.ts) (`session`, `advanced`), [`src/lib/auth/policy.ts`](../src/lib/auth/policy.ts)                                                   |
| Weak passwords                      | 12-char minimum (OWASP ASVS 5 / NIST 800-63B single-factor), 128 max — applies to new signups + resets                                                     | [`src/lib/auth/server.ts`](../src/lib/auth/server.ts) (`minPasswordLength: 12`)                                                 |
| Reset-link / token validity         | `resetPasswordTokenExpiresIn` is wired from `AUTH_POLICY.passwordResetExpiresMinutes` (60), so the enforced expiry can't drift from the displayed policy or the "60 min" email copy. The reset page sets `Referrer-Policy: no-referrer` so the URL-embedded token can't leak via Referer on any navigation away. | [`src/lib/auth/server.ts`](../src/lib/auth/server.ts), [`src/app/(shop)/reset-password/page.tsx`](../src/app/(shop)/reset-password/page.tsx) |
| Prod transport / MITM               | Boot guard refuses to start in production when `BETTER_AUTH_URL` isn't `https://` (the auth callback + its token would otherwise travel in clear) — mirrors the existing localhost guard. | [`src/lib/env.ts`](../src/lib/env.ts) (`assertProductionSecrets`)                                                               |
| CSRF (auth)                         | Better Auth origin check against `trustedOrigins` + SameSite cookies                                                                                       | [`src/lib/auth/server.ts`](../src/lib/auth/server.ts) (`buildTrustedOrigins`)                                                   |
| CSRF (admin API routes)             | `assertSameOrigin` compares `Origin`/`Referer` against the env allow-list; state-changing methods with no `Origin` are hard-rejected (403, no body)        | [`src/lib/auth/origin.ts`](../src/lib/auth/origin.ts)                                                                           |
| XSS in admin rich text              | One shared sanitizer `sanitizeRichHtml` (isomorphic-dompurify, `USE_PROFILES: { html: true }`) at **every** render site — strips `<script>`, inline handlers, `javascript:` URLs; plus a post-pass that drops any `<img src>` not pointing at our own `/cdn/` proxy. | [`src/lib/sanitize/rich-html.ts`](../src/lib/sanitize/rich-html.ts) (used by blog/aid/legal/product renderers)                  |
| SQL injection                       | Drizzle parameterized queries everywhere; the handful of `db.execute(sql\`…\`)` blocks (rate limiter, retention purges, bootstrap) interpolate only typed bindings, never raw user input | module `service.ts` files                                                                                                      |
| Privilege escalation                | The `/admin` shell is gated by `resolveAdminShellAccess` (any grant); per-page/per-action `requirePermission(module, action)` (or `requirePermissionAny` for multi-role surfaces) enforces the rest and records a denial as `rbac.permission_denied`. Authorization resolves **live per request** through the RBAC engine (`resolveUserPermissions`) — no cached grants, so revoking a role / disabling a user takes effect on the next request. The legacy `users.role='admin'` enum maps to the `'*'` wildcard. Aggregate pages behind the bare area gate (`requireAdminArea`: the `/admin` dashboard, the Système index) gate every data block per module — the dashboard's `resolveDashboardAccess` needs `dashboard:view` **plus** the source module's `view`, so a scoped delegate never sees revenue or customer emails they are denied elsewhere. Admin pages never call another module's permission-gated Server Action during render: each secondary widget is soft-checked with `permissionSetAllows` and hidden without the grant (enforced by `page-guards.test.ts`). **No-privilege-above-your-own** (`src/lib/rbac/guards.ts`): a non-wildcard delegate cannot grant a system role or any permission it lacks (nor author a role carrying one), cannot mint/promote an enum `admin`, and cannot reset/disable/re-target an account more privileged than itself — only a wildcard admin can. The enum role and RBAC roles are independent: `changeRoleWorkflow` refuses → Client while the account holds ANY RBAC role and Admin → Staff while an RBAC role still grants `*` (remove the roles first). Segregation of duties: arming the AI review scheduler (or making it publish `approved`) needs `reviews:manage`; AI auto-assign apply also needs `products:update`. | [`src/lib/auth/session.ts`](../src/lib/auth/session.ts), [`src/lib/rbac/authorize.ts`](../src/lib/rbac/authorize.ts), [`src/lib/rbac/guards.ts`](../src/lib/rbac/guards.ts), [`src/lib/rbac/dashboard-access.ts`](../src/lib/rbac/dashboard-access.ts), [`src/workflows/auth/change-role.ts`](../src/workflows/auth/change-role.ts) |
| Owner-only (`*`) surfaces           | Settings that execute code, move money, or re-route mail / URLs require the RBAC `*` wildcard on top of the module grant (a delegate's form renders them disabled or omits them; a crafted post is refused): **mail transport** (provider / SMTP / sendmail / provider secrets) and the **account-security email templates** (`password_reset`, `email_verification`, `email_change`, `user_invitation`, `purge_confirmation` — `critical`, never disableable; override / reset / re-enable need `*`), so a `system_mail` delegate can't redirect or rewrite reset / invite links; **custom tracking code** (`tracking.custom_head` / `custom_body`) and the **GTM container id** (`TRACKING_SCRIPT_KEYS`) — the admin shares the storefront origin + session cookie, so any storefront script runs as a staff visitor (GA4 / Pixel ids stay under `system_analytics:update`, format-allow-listed); **payment merchant credentials** (ClicToPay userName/password, Flouci app token/secret) and the sandbox flag — `system_payments:update` only toggles gateways and COD; **`seo.site_url`** (it also drives payment return/callback URLs, email links, Pro invite links and order QR codes; must be a bare https origin); **off-site redirect destinations** — direct, through an internal rule chaining into an off-site rule, or by moving an off-site rule's source — on form save, activation toggle and CSV import (a delegate's off-site CSV rows are skipped and counted; off-site rules are always stored as temporary: 301/308 → 307); an **AI provider base-URL change** when its key comes from env (a delegate may only keep it or reset it to the provider default; with a stored DB key the delegate must re-enter the key in the same save). **Store-wide destructive ops** — purge-and-relaunch (plus an emailed one-time code), `POST /api/admin/system/demo?op=clear` (whole-store, NOT demo-scoped) and data-job `clean` — take the module grant first (404 on deny), then the `*` step-up via `requireSuperAdmin` / `checkSuperAdmin` (a refusal is recorded as `rbac.permission_denied` on module `*`). | [`src/lib/auth/super-admin.ts`](../src/lib/auth/super-admin.ts), [`src/lib/actions/mailing.ts`](../src/lib/actions/mailing.ts), [`src/lib/tracking/script-keys.ts`](../src/lib/tracking/script-keys.ts), [`src/lib/payments/settings-plan.ts`](../src/lib/payments/settings-plan.ts), [`src/lib/actions/seo.ts`](../src/lib/actions/seo.ts), [`src/lib/actions/redirects.ts`](../src/lib/actions/redirects.ts), [`src/lib/ai/validate-base-url.ts`](../src/lib/ai/validate-base-url.ts) (`aiBaseUrlChangeRefusal`) |
| Last-admin lockout                  | Every path that can remove `*` has a floor, and every floor counts **effective** super-admins (enum `admin` ∪ active RBAC-`*` holders — `countEffectiveWildcardAdmins`, `countWildcardAdminsExcludingRole` for the role-edit floor, the same set inlined in `demoteAdminAtomic`; a disabled account never counts): `demoteAdminAtomic` (enum **demotion**, under a `FOR UPDATE` lock over that set inside one transaction — refuses when no other would remain); `assertDisableKeepsAnAdmin` (**disable/delete** — `disableUserWorkflow` + `deleteCustomerWorkflow`); `assertRoleChangeKeepsAnAdmin` (RBAC **role assignment** that drops a `*`-carrying role, self-targeted included); `assertRoleWildcardRemovalKeepsAnAdmin` (**deleting a role** or dropping `*` from its grants). The three non-enum floors are **unlocked** best-effort reads with an accepted small-N TOCTOU residual (two simultaneous last-two removals could both pass the read before either writes; recoverable by re-granting in the DB or re-opening the bootstrap route — see below) | [`src/modules/auth/service.ts`](../src/modules/auth/service.ts), [`src/lib/rbac/guards.ts`](../src/lib/rbac/guards.ts), [`src/workflows/rbac/assign-roles.ts`](../src/workflows/rbac/assign-roles.ts), [`src/workflows/rbac/manage-roles.ts`](../src/workflows/rbac/manage-roles.ts) |
| Admin route discovery               | RBAC gates return **404, not 403** — non-staff get the root 404 from the admin layout, so they can't tell an admin route exists; a staff member denied a page (or hitting an unknown id) gets `src/app/admin/not-found.tsx` inside the admin shell (HTTP 404, copy that doesn't say whether the page is missing or forbidden) | [`src/lib/auth/session.ts`](../src/lib/auth/session.ts) (`requireAdminArea` / `requirePermission` / `requirePermissionAny` → `notFound()`), [`src/app/admin/not-found.tsx`](../src/app/admin/not-found.tsx) |
| Malformed `[id]` route → DB 500     | `isUuid()` shape-check at the top of every dynamic admin/order page; bad ids `notFound()` before any `::uuid` cast                                          | [`src/lib/utils/uuid.ts`](../src/lib/utils/uuid.ts)                                                                             |
| Mass assignment                     | Zod schemas pick only allowed fields at the workflow boundary — never `...formData` into Drizzle                                                           | `src/workflows/**`                                                                                                             |
| File-upload abuse                   | MIME allow-list (jpg/png/webp/avif/gif), per-deploy byte cap (default 8 MB), sharp normalises orientation + optionally strips EXIF, re-encodes to webp/avif/jpeg | [`src/modules/media/processor.ts`](../src/modules/media/processor.ts), [`src/modules/media/limits.ts`](../src/modules/media/limits.ts) |
| SSRF on URL image import / outbound webhooks | Scheme allow-list, no embedded creds, DNS resolved up-front with **every** A/AAAA record required public (blocks loopback/RFC1918/CGNAT/link-local incl. `169.254.169.254`/ULA/IPv4-mapped), socket pinned to the validated IP (anti-rebinding), redirects not followed, streamed size cap. Outbound webhook deliveries to admin-supplied endpoint URLs go through the generic sibling `ssrfSafeRequest` (same classifier + pinning, hard timeout, response body read capped at 64 KiB) | [`src/lib/media/fetch-remote-image.ts`](../src/lib/media/fetch-remote-image.ts), [`src/lib/net/ssrf-fetch.ts`](../src/lib/net/ssrf-fetch.ts) |
| `<Image>` optimizer SSRF            | `images.remotePatterns` built from `S3_PUBLIC_URL` + known hosts; loopback/private IPs blocked unless `S3_PUBLIC_URL` is itself local (dev only)           | [`next.config.ts`](../next.config.ts)                                                                                           |
| Payment settlement spoof / replay   | **Both** gateway callbacks are **unsigned** — we trust nothing: look the order up by the reference stored at init, re-verify against the gateway API, and settle exactly once via the `webhook_events` idempotency ledger (`claim`/`release`). Flouci **and** ClicToPay each have a real-time webhook (`/api/webhooks/{flouci,clictopay}`) sharing one idempotent handler; the customer-return verify path and the reconcile cron are the same-decision fallbacks, all idempotent. | [`src/app/api/webhooks/flouci/route.ts`](../src/app/api/webhooks/flouci/route.ts), [`src/app/api/webhooks/clictopay/route.ts`](../src/app/api/webhooks/clictopay/route.ts), [`src/modules/webhook/service.ts`](../src/modules/webhook/service.ts), [`src/workflows/order/gateway-payment.ts`](../src/workflows/order/gateway-payment.ts) |
| Keyed external order API abuse      | `/api/orders*` is API-key-gated (scope `orders:read`/`orders:write`); writes additionally require the key to have an owner (`requireApiActor`) and can **never** be made public. `PATCH …/status` runs the SAME server state machine as the dashboard (payment-method-aware transition graph), so an ERP cannot jump or re-open a terminal status: an illegal jump → 409 `invalid_transition`, → `refunded` with nothing on the refund ledger → 409 `refund_required`, and cancelling a PENDING online order first re-verifies the payment with the gateway (409 `conflict` if captured, 503 `payment_unverified` if the gateway is unreachable — fail closed). `externalRef` linking is audited (`order.edited`); collisions return 409 `already_linked` / `external_ref_conflict` (not a 500). The serialised DTO (`serializeOrder`) carries no internal-only columns such as the audit trail; `userId` is the account id (null = guest). | [`src/app/api/orders/[id]/status/route.ts`](../src/app/api/orders/%5Bid%5D/status/route.ts), [`src/lib/api/orders.ts`](../src/lib/api/orders.ts), [`src/lib/api-auth/enforce.ts`](../src/lib/api-auth/enforce.ts) (`workflowErrorStatus`), [`src/workflows/order/transition-status.ts`](../src/workflows/order/transition-status.ts) |
| API key scope creep                 | A key can never exceed its creator's own admin grants. Each scope maps to dashboard RBAC keys (`rbacKeysForScope`: coarse `write` / `full` need `*`; e.g. `orders:write` needs `orders:manage`, `customers:read` needs `customers:view`; unknown scope → `*`, fail closed). Checked at mint time (the create form greys out ungrantable scopes) **and re-checked on every request** against the creator's CURRENT RBAC (`actorMayGrantScope` in `requireApiKey`): a demoted or disabled creator's key answers 403 on out-of-grant scopes. Disabling a user (or « Supprimer le client » on a customer-role account) also revokes all their keys, and re-enabling does not revive them; the key list shows « Créée par ». Operational impact: an ERP key minted by an admin who is later demoted stops working — mint integration keys under a dedicated service account. | [`src/lib/api-auth/scopes.ts`](../src/lib/api-auth/scopes.ts), [`src/lib/api-auth/require-api-key.ts`](../src/lib/api-auth/require-api-key.ts) |
| Order spam / checkout abuse         | `placeOrderFromCartAction` + `placeQuickOrderAction` are throttled BEFORE the workflow: per IP 6/10 min (every validated attempt counts; skipped when the IP is unknown), per contact phone (last 8 digits) 4/10 min and per email 4/10 min — the phone/email buckets are only *peeked* before and *counted* after a successful placement, so a third party can't lock a victim's number or inbox by spamming refused attempts. Buckets `order:ip|phone|email:*` in `rate_limit_buckets`; fails **open** on a limiter DB error (never blocks a genuine sale). The express master switch `checkout.quick.enabled` and the payment-method toggles are enforced server-side; an email submitted while the email field is hidden is discarded on BOTH the cart and express paths (receipts can't be aimed at an arbitrary inbox). Free-text fields are capped by `ORDER_FIELD_MAX` (name 120, address 300, city/region 120, postal code 20, phone 32, email 254, notes 1000) on every order path. Operator (caisse / manual order) and ERP paths are not throttled. | [`src/lib/checkout/place-order-guards.ts`](../src/lib/checkout/place-order-guards.ts), [`src/lib/actions/order.ts`](../src/lib/actions/order.ts), [`src/lib/checkout/order-field-max.ts`](../src/lib/checkout/order-field-max.ts) |
| Bearer URLs → third-party tags      | Order ids are UUID v7 (~74 random bits + ms timestamp): unguessable but a **bearer capability** — they open `/order/<uuid>` (summary incl. contact email), `/order/verify/<uuid>` (public summary, the QR target) and, for GUEST orders only, `/facture/<uuid>` (full receipt) plus guest cancel. A REGISTERED order's `/facture/<uuid>` needs the owner's session or staff `orders:view` (signed out → `/login?from=…`, anyone else → 404). Tags never get these URLs raw: `redactTrackedUrl` scrubs `page_location` (`/order/:id`, `/order/verify/:id`, `/facture/:id`, `/account/orders/:id`; drops `token` / `t` / `k` params, also inside `from=`); GA4 receives it at the global `gtag('set')` scope (never config scope); NO tag or owner snippet loads on `TAG_FREE_PATHS` (`/reset-password`, `/verify-email`, `/se-desabonner`); the Meta Pixel's automatic pushState PageView is disabled (`PageLocationSync` sends scrubbed PageViews and skips bearer URLs) and, on a bearer landing, its autoConfig is off and the init PageView skipped. GTM setup the owner must do: see Operating notes. | [`src/lib/tracking/redact-url.ts`](../src/lib/tracking/redact-url.ts), [`src/components/tracking/tracking-scripts.tsx`](../src/components/tracking/tracking-scripts.tsx), [`src/components/tracking/page-location-sync.tsx`](../src/components/tracking/page-location-sync.tsx), [`src/app/(documents)/facture/[id]/page.tsx`](../src/app/(documents)/facture/%5Bid%5D/page.tsx) |
| Secrets at rest                     | Payment credentials (`payment_provider_settings`) and social-login OAuth credentials (`oauth_provider_settings`) encrypted AES-256-GCM before storage; key auto-provisioned/persisted in `app_secrets` (env wins). Decrypt is forgiving (lost key ⇒ "not configured", never a crash). Admin pages forward only the narrowed `<prefix>.*` slice of `getSettingsMap()` to client panels so other panels' `*_enc` blobs never reach the browser. OAuth credential save / « Supprimer les identifiants » (erase) go through `upsert-oauth-settings.ts` and emit `auth.oauth_settings_updated {provider, changedFields}` with the admin as actor (never a value); an env var still takes precedence over the stored pair. | [`src/lib/crypto/secrets.ts`](../src/lib/crypto/secrets.ts), [`src/workflows/auth/upsert-oauth-settings.ts`](../src/workflows/auth/upsert-oauth-settings.ts) |
| Public favorites profile enumeration | `/u/<slug>` returns **404, never 403** when the feature flag is off, the slug is unknown, the owner set it private, or the owner's account is disabled — the cases are indistinguishable (no enumeration). Feature is **off by default** (`social.favorites_public_enabled`); a guest (token) list can never be public (app + a DB CHECK `wishlists_public_requires_user`); only a chosen pseudonym is shown (real name/email/user_id never rendered); slug validator blocks a reserved/route-shadowing handle; page is `noindex`. | [`src/app/(shop)/u/[slug]/page.tsx`](../src/app/(shop)/u/%5Bslug%5D/page.tsx), [`src/modules/wishlist/service.ts`](../src/modules/wishlist/service.ts) (`findPublicBySlug`), [`src/lib/wishlist/public-slug.ts`](../src/lib/wishlist/public-slug.ts) |
| Self-serve change-password           | Verifies the CURRENT password (Better Auth `changePassword`), then `revokeOtherSessions: true` invalidates every OTHER session (a leaked cookie elsewhere dies; this device stays signed in). Per-user rate-limited (5/min); generic error never says which field was wrong. Audited server-side: a Better Auth `hooks.after` on `/change-password` emits `user.password_changed` (warn, user as actor); the raw endpoint is 404 over HTTP. | [`src/lib/actions/customer.ts`](../src/lib/actions/customer.ts) (`changePasswordAction`), [`src/lib/auth/server.ts`](../src/lib/auth/server.ts) (`hooks.after`) |
| Email change (account takeover)     | A completed change is caught in `databaseHooks.user.update` (the `/verify-email` click) and emits `user.email_changed` (both addresses masked, warn); the newsletter row follows the account. **KNOWN GAP (owner decision pending — the seeded-admin runbook changes its email here):** Better Auth 1.6 reads `sendChangeEmailConfirmation`, not the configured `sendChangeEmailVerification`, so the link goes to the NEW address and one click applies the change — a hijacked session can move the email without the current mailbox. | [`src/lib/auth/server.ts`](../src/lib/auth/server.ts) (`user.changeEmail`, `databaseHooks.user.update`) |
| Sensitive data in logs              | Passwords / tokens never enter event payloads — the registry in `events/types.ts` is the chokepoint. The wildcard audit subscriber writes whatever the payload carries, so keep it clean there. Settings audit rows carry before → after values only for security-relevant keys (`isSensitiveSettingKey`; every other key is name-only), and never for a secret-bearing key (`isSecretSettingKey`: `*_enc`, password, secret, token, api_key); an outbound webhook endpoint is audited with its destination host, never the full URL. A `*` (all-events) outbound-webhook subscription does NOT receive `auth.*`, `rbac.*`, `api_key.*`, `user.*` or `data.*` events (PII / security telemetry) — an integration must subscribe to one by exact name. The AI per-item log (`ai_job_logs`) only ever stores model OUTPUT-derived text (sliced), never a provider key (the key never leaves `generateText`). | [`src/events/types.ts`](../src/events/types.ts), [`src/events/subscribers/audit-everything.ts`](../src/events/subscribers/audit-everything.ts), [`src/lib/cms/sensitive-settings.ts`](../src/lib/cms/sensitive-settings.ts), [`src/events/subscribers/dispatch-webhooks.ts`](../src/events/subscribers/dispatch-webhooks.ts) (`SECURITY_DOMAINS`) |
| AI provider key leak / abuse        | Every model call funnels through the single `generateText` chokepoint: the key is resolved env→encrypted-DB **inside** the call and is **never logged, returned, or written to `ai_job_logs`**; a 30 s `AbortController` + `cache:"no-store"` bound each request. Each AI surface is RBAC-gated by the module it writes (single-field gen → `<feature>:update`, bulk start → `products:manage`, auto-assign apply → also `products:update`, reads → `:view`) and per-actor rate-limited (`ai:gen:<user>` 90/min, `ai:bulk:<user>` 10/h) so a compromised admin session can't fan thousands of paid calls. Repointing a provider's base URL (which would carry its key to the new host) is owner-gated — see « Owner-only surfaces » (`aiBaseUrlChangeRefusal`). | [`src/lib/ai/client.ts`](../src/lib/ai/client.ts), [`src/lib/actions/ai-generate.ts`](../src/lib/actions/ai-generate.ts), [`src/lib/actions/product-generation.ts`](../src/lib/actions/product-generation.ts), [`src/workflows/ai/upsert-provider-settings.ts`](../src/workflows/ai/upsert-provider-settings.ts) |
| AI provider base-URL SSRF           | The admin-set provider `baseUrl` is fetched server-side **with the API key in a header**, so it's validated on save (`validateAiBaseUrl`): http/https only, and link-local / cloud-metadata hosts (`169.254.0.0/16`, the full `fe80::/10`, `metadata.google.internal`, AWS IMDS over IPv6 `fd00:ec2::254`, Alibaba `100.100.100.200`, incl. IPv4-mapped IPv6 forms) are rejected — blocks instance-credential theft via `169.254.169.254`. At REQUEST time `assertAiBaseUrlSafe` re-validates and DNS-resolves the host (any link-local / metadata record → refused) and the fetch uses `redirect: "manual"`; the socket is NOT pinned to the checked IP (rebinding residual — DNS pinning deferred). Private/loopback hosts stay allowed for self-hosted/proxied LLMs. | [`src/lib/ai/validate-base-url.ts`](../src/lib/ai/validate-base-url.ts), [`src/lib/ai/guard-base-url.ts`](../src/lib/ai/guard-base-url.ts), [`src/workflows/ai/upsert-provider-settings.ts`](../src/workflows/ai/upsert-provider-settings.ts) |
| Unbounded PII log growth            | `CRON_SECRET`-gated purge hard-deletes the unbounded/PII tables per `RETENTION_TARGETS` / `RETENTION_WINDOWS` in 5000-row batches: `search_log` (admin `search.purge_months`, default 90d), `webhook_events` >90d, `webhook_deliveries` >90d (outbound payload snapshots), `audit_log` (admin `audit.retention_months`, default 360d), `job_run_log` >90d, ephemeral `qb-` `carts` >2d, stale guest `carts` >60d and guest `wishlists` >180d (both since last activity), **`email_logs` >180d** (recipient address + rendered body PII; pinned rows kept), `mailing_sends` >540d, `cart_events` >180d (add-to-cart analytics), `instance_heartbeats` >90d, `ai_call_logs` >14d, plus expired `sessions` + `verifications` (Better Auth runs no cleanup of its own). The two admin-configurable windows fail **closed**: a settings-read error skips that purge instead of falling back to a shorter default. Shared body in `src/lib/retention/run.ts`. | [`src/lib/retention/windows.ts`](../src/lib/retention/windows.ts), [`src/app/api/cron/retention/route.ts`](../src/app/api/cron/retention/route.ts) |
| HTTP headers                        | HSTS (2y, preload), `X-Frame-Options=SAMEORIGIN`, `X-Content-Type-Options=nosniff`, `Referrer-Policy`, `Permissions-Policy`, and a **dynamic CSP** built from env: the object-store host (`S3_PUBLIC_URL`) + CDN host(s) (`MEDIA_CDN_URL`) in `img-src` / `connect-src` / **`media-src`** (`'self' blob:` + those hosts — a hosted product video is a raw `<video src>`); **`frame-src`** limited to YouTube (`www.youtube.com`, `www.youtube-nocookie.com`), GTM and the Google Maps embed origins (`https://www.google.com`, `https://maps.google.com` — `site.map_embed_url` is validated on write to an https Google Maps embed URL); plus the analytics/marketing tag hosts (GTM / GA4 / `*.google-analytics` / `connect.facebook.net` / `www.facebook.com`) and common custom-tag vendors (TikTok / Hotjar / Clarity / LinkedIn). Any other custom-tag host → `CSP_EXTRA_HOSTS` (see modules.md §7.4). `MEDIA_CDN_URL` and `CSP_EXTRA_HOSTS` are **build args** compiled into the served headers — changing either requires a rebuild (the compose passes them as build args and runtime env). | [`src/lib/security/headers.ts`](../src/lib/security/headers.ts) (`buildCsp`, `buildSecurityHeaders`), wired by [`next.config.ts`](../next.config.ts) `headers()`, [`Dockerfile`](../Dockerfile) (`ARG`)                                                                 |
| Open redirect after sign-in         | `safeRedirectPath` allow-lists same-origin paths only — rejects `//host`, backslash, control chars, `javascript:`                                          | [`src/lib/actions/auth.ts`](../src/lib/actions/auth.ts)                                                                         |
| Audit-log evasion                   | Append-only: no update/delete endpoint. The wildcard subscriber records every emitted event. Security transitions are audited SERVER-side so a direct HTTP call can't skip them: self-service 2FA enable/disable and password change via Better Auth `hooks.after`; security-relevant settings (`auth.*`, `checkout.payment.*`, `seo.site_url`, `site.mode`, consent / redirects toggles, contact channels, `*_url` / `*.href` destinations — `isSensitiveSettingKey`) at **warn** with « before → after » (`upsertSetting` skips unchanged rows, so only real changes audit); API access toggles (kill-switches, routes opened/closed to the public) with before → after, only on a real change; outbound webhook endpoint creation/revocation at warn; bulk exports (customers, guests, orders, audit, newsletter — each still `:view`-gated) emit `data.exported {resource, count}` at warn with the actor. | [`src/events/subscribers/audit-everything.ts`](../src/events/subscribers/audit-everything.ts), [`src/lib/cms/sensitive-settings.ts`](../src/lib/cms/sensitive-settings.ts), [`src/events/severity.ts`](../src/events/severity.ts) |

## Admin bootstrap — two paths, password never persisted

A fresh Coolify deploy must reach a signed-in admin without manual SQL. Two
mechanisms cover that, and **neither writes a plaintext password anywhere**:

1. **Default admin (automatic).** On first boot
   [`src/lib/bootstrap/default-admin.ts`](../src/lib/bootstrap/default-admin.ts)
   (run from `instrumentation.ts`) creates `houssem@kawn.me` with a random
   24-char password, force-verifies it, and prints the password **once** to
   stdout. The password is never stored — storing it next to
   `BETTER_AUTH_SECRET` would turn any DB-read primitive into instant admin.
   Miss the banner → reset via `/forgot-password`. It self-skips if an active
   effective admin already exists (enum `admin` or an RBAC `*` holder), if the
   `DEFAULT_ADMIN_BOOTSTRAPPED` flag is set in `app_secrets`, or if the email is
   already taken. Opt out entirely with `DISABLE_DEFAULT_ADMIN=true`. It also
   assigns the **`super_admin` RBAC role** (seeded by migration 0033) so the
   account is a first-class super_admin under the role model, not only via the
   legacy `role='admin'` → `'*'` bridge.

2. **Bootstrap token (manual, one-shot).** `POST /api/admin/bootstrap` promotes
   an already-registered user to admin, gated by `ADMIN_BOOTSTRAP_TOKEN`
   (auto-generated and persisted by `init-secrets` on first boot, printed once)
   ([`src/app/api/admin/bootstrap/route.ts`](../src/app/api/admin/bootstrap/route.ts)).
   The route returns **404** when the token is unset or empty (no signal it
   exists), rate-limits per IP (5 / 5 min), compares the token in **constant
   time** (`timingSafeEqual`), and also 404s whenever an active effective admin
   exists (`countEffectiveWildcardAdmins`: enum `admin` ∪ RBAC `*`). It assigns
   the `super_admin` RBAC role on promotion. The door is **burned** as soon as
   any admin exists — when the default admin is created, on the first
   successful promotion, or on any boot that finds an active admin (including
   `DISABLE_DEFAULT_ADMIN=true` installs): the persisted token row is deleted and
   `ADMIN_BOOTSTRAP_CLOSED` is recorded, so the route 404s for good and
   `init-secrets` stops exporting or regenerating the token. To deliberately
   re-open it after a true lockout: `DELETE FROM app_secrets WHERE
   key='ADMIN_BOOTSTRAP_CLOSED';` then restart (a fresh token is generated and
   printed once). An `ADMIN_BOOTSTRAP_TOKEN` key present but EMPTY in the
   container env also disables it (it must actually reach the container, i.e.
   be passed through the compose file).

On an existing-DB upgrade, migration **0034** backfills the `super_admin` role
to every current `role='admin'` user (idempotent), so `user_roles` reflects
reality without any manual step. Migrations apply automatically on deploy — the
container entrypoint runs `migrate.cjs` before `node server.js`, ahead of the
first-boot default-admin creation.

## Separate connection points (customers vs. staff)

Customers and staff have distinct sign-in entry points (one Better Auth
instance underneath):

- **Customers** → `/login` (storefront). `/account` requires a session cookie;
  the proxy redirects there if missing.
- **Staff / admin** → a dedicated page at `/admin-login` (outside the gated
  `/admin/*` segment so an unauthenticated visitor can reach it). With the
  default path, an unauthenticated hit on `/admin` redirects here (not to the
  customer login).
- **Editable admin URL** — set `ADMIN_LOGIN_PATH` to a secret path (e.g.
  `/staff-x7k2`); the Edge proxy (`src/proxy.ts`) rewrites it to the physical
  `/admin-login` route AND 404s the default, so the secret path is the only
  working entry. **When a secret path is set, an unauthenticated `/admin` returns
  404, not a redirect** — redirecting would leak the secret slug in the
  `Location` header; staff use the secret path directly. Env-only (no DB) so it's
  safe on the Edge runtime. See
  [`src/lib/auth/admin-path.ts`](../src/lib/auth/admin-path.ts).

Authorization is unchanged: signing in at `/admin-login` only mints a session;
the `/admin` layout still enforces RBAC (a non-admin who signs in there 404s).

While the storefront is in maintenance / coming-soon (`site.mode`), the auth
continuation pages stay reachable in a bare shell (no catalogue chrome):
`/login` (+ `/login/2fa`, where `/admin-login` sends a TOTP-enabled admin),
`/forgot-password`, `/reset-password`, `/verify-email` and `/se-desabonner`
(`SITE_GATE_EXEMPT_PATHS`, keyed on the `x-tokyo-pathname` header the proxy
always overwrites, so a client can't spoof it). A client nav guard hard-reloads
any navigation from them to a gated route. `/register` stays gated. See
Operating notes → maintenance for the gate's scope.

## Adding a feature — security checklist

Before merging, walk this list:

- [ ] **Auth gate** — does this need `requireSession()` or
      `requirePermission(module, action)`? (RBAC gates 404, never 403.)
      `requireAdminArea()` is only for pages that load no module data or gate
      every block by its own grant (allow-listed in `route-invariants.test.ts`).
      An admin page must not call another module's permission-gated action
      during render — soft-check with `permissionSetAllows` and hide the widget.
- [ ] **Owner-level?** — does the surface execute code on the storefront,
      move money, send mail through a new transport, or re-route URLs /
      links? Then it also needs the `*` wildcard (see « Owner-only surfaces »);
      an irreversible store-wide op uses `requireSuperAdmin` / `checkSuperAdmin`.
- [ ] **Grant ceiling** — anything that mints a credential or role (API key
      scopes, role editor, invites) must stay within the actor's own grants.
- [ ] **Disable honoured** — gating through the session helpers means a
      disabled/demoted account is rejected on its next request automatically.
- [ ] **Input** — every field validated with Zod at the boundary
      (action/route). Dynamic `[id]` routes call `isUuid()` first.
- [ ] **No mass assignment** — the workflow accepts a typed object, not raw
      FormData.
- [ ] **Read scoping** — does the user have permission to see *this row*?
      (addresses scoped to their `customer_profile_id`; order secrets only to
      the order owner.)
- [ ] **Audit** — if a mutation matters, emit an event. The wildcard
      subscriber writes the audit log automatically. Never put a password or
      token in the payload. A bulk export emits `data.exported`. A new event in
      a security domain (`auth` / `rbac` / `api_key` / `user` / `data`) is kept
      out of `*` webhook subscriptions automatically.
- [ ] **CSRF** — Server Actions and the auth handler are origin-checked. A
      bare `POST /api/admin/...` route must call `assertSameOrigin(request)`.
- [ ] **XSS** — any HTML rendered from admin input goes through
      `sanitizeRichHtml` at the render site (not just at write time).
- [ ] **Secrets** — never logged, never embedded in events, never returned
      from an API response. Provider credentials go through
      `encryptSecret`/`decryptSecret`.
- [ ] **Rate limit** — Better Auth's limiter only guards routes hit DIRECTLY
      over HTTP; the email/password + 2FA flows run in-process via `auth.api.*`
      from server actions (their raw endpoints are 404 over HTTP), so each is
      throttled with our own `checkRateLimit` (sign-in per-IP + per-account,
      signup per-IP + per-email, reset request per-IP + per-email, reset
      consume, 2FA-verify per-IP + per-challenge). Same for order placement
      (`order:*`), partner invites / accounts (`pro-invite:*`, `pro-create:*`)
      and coupons. Any new public anonymous endpoint must do the same with a
      per-IP bucket; a new Better Auth endpoint the app calls in-process belongs
      in `AUTH_HTTP_DISABLED_PATHS`.
- [ ] **SSRF** — any server-side fetch of an admin-supplied URL must reuse
      `fetchRemoteImage` / `ssrfSafeRequest` (or their IP classifier), never a
      bare `fetch`.
- [ ] **Bearer URLs** — a new route whose URL is itself a credential (token in
      the path or query) goes in `TAG_FREE_PATHS` or `BEARER_PATH_RULES`
      (`src/lib/tracking/redact-url.ts`) so third-party tags never see it.
- [ ] **Error messages** — generic for auth flows, specific for validation.

## Operating notes

- **`CRON_SECRET`** gates all seven cron endpoints (retention, mailing,
  birthday, review-request, payments, abandoned-orders, webhooks) through one
  shared `guardCron`: per-IP rate limit (10/min) **first** (throttled ⇒
  **429**), then the optional `CRON_ALLOWED_IPS` allow-list (comma-separated;
  unlisted IP ⇒ **403**, so a leaked secret alone can't trigger the jobs from an
  arbitrary host), then unset secret ⇒ **503** (feature off, never runs
  unguarded), wrong value ⇒ **401** (constant-time compare). The
  rate-limit-first ordering is what stops a bearer-token brute force / repeated
  expensive-trigger probe. Optional, min 16 chars
  ([`src/lib/env.ts`](../src/lib/env.ts) + [`.env.example`](../.env.example)).
  Wire the Coolify scheduled tasks (e.g. a **daily** `curl -X POST -H
  "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/retention`) — see
  [docs/deployment-coolify.md](./deployment-coolify.md) for the full schedule.
- **`ADMIN_BOOTSTRAP_TOKEN`** is auto-generated (48 hex chars) and persisted by
  `init-secrets`, printed once, and burned automatically once an admin exists
  (see « Admin bootstrap » above) — nothing to unset by hand. If you supply your
  own, make it unguessable (the env schema only enforces ≥ 8 chars).
- **`PAYMENT_ENCRYPTION_KEY`** is auto-provisioned and persisted in
  `app_secrets` on first boot — set it in Coolify only to supply or rotate it
  yourself. A lost/rotated key makes saved gateway credentials read as "not
  configured"; the admin re-enters them. Plaintext is never logged.
- **`BETTER_AUTH_SECRET`** is validated at runtime: a build-time placeholder,
  an example value, or anything < 32 chars throws on boot
  ([`src/lib/env.ts`](../src/lib/env.ts)). It also encrypts every stored 2FA
  TOTP secret + backup codes — **rotating it invalidates all 2FA enrolments**
  (users must re-enrol; admins can clear a stuck enrolment, see 2FA below).
- **Two-factor auth (2FA)** — optional, opt-in TOTP via the Better Auth
  `twoFactor` plugin, available to ALL roles, default OFF. Enabled from
  `/account` (scan a QR, confirm a code, save backup codes shown ONCE); the
  `twoFactorEnabled` flag flips true only AFTER a verified code
  (`skipVerificationOnEnable: false`), so a mistyped setup can't lock the user
  out. Sign-in with 2FA on returns no session — the user completes
  `/login/2fa` (TOTP or a backup code), and the disabledAt ban hook still runs
  at that session-mint. Secret + backup codes are stored ENCRYPTED (above) and
  never returned to the client. Recovery: backup codes, or an AUDITED admin
  "Réinitialiser la 2FA" that clears the enrolment (the admin can never read the
  secret). The per-challenge guess cap (8 / 15 min) is keyed on a sha256 of the
  VERIFIED challenge token, read from the exact signed cookie Better Auth
  verifies (first occurrence, signature checked — `two-factor-challenge.ts`);
  `verifyTwoFactorAction` and a direct HTTP `/two-factor/verify-totp` share that
  key, so decoy `*.two_factor` cookies or re-encoded values can't widen the
  budget and an unsigned cookie charges nothing. Self-service enable/disable is
  audited server-side (`user.two_factor_enabled` / `user.two_factor_disabled`
  from Better Auth `hooks.after`, direct HTTP calls included);
  `/two-factor/enable` is refused while 2FA is already on (no silent secret
  rotation — disable first); `/two-factor/get-totp-uri`, `send-otp`,
  `verify-otp` and the backup-code endpoints are 404 over HTTP. The Sécurité
  2FA-adoption signal counts only enforced 2FA (`users.two_factor_enabled`); an
  abandoned enrolment (a `two_factors` row with `verified=false`) reports as
  "without 2FA". NOTE: 2FA gates the email/password login only — a Google social
  sign-in mints a session directly and does NOT prompt for TOTP (accepted
  limitation for the storefront audience).
- **Email verification is mandatory** before first sign-in. The default-admin
  bootstrap and the token route both force-verify the seeded/promoted account.
- **Session cookie** is `gz.session_token` (`__Secure-gz.session_token` in
  prod, from `useSecureCookies`).
- **Better Auth uses scrypt** for password hashing. To switch to argon2id,
  install `@node-rs/argon2` and add the plugin in
  [`src/lib/auth/server.ts`](../src/lib/auth/server.ts).
- **Audit log is append-only.** No update/delete endpoint by design — the
  retention cron (and its manual twin, the « Purge » tab of
  `/admin/system/audit`) is the only thing that removes rows, using the
  admin-configurable `audit.retention_months` window (default 12 months /
  360-day fallback). The journal's CSV export is itself audited
  (`data.exported`).
- **Maintenance / coming-soon gate scope** (`site.mode`). The (shop) layout
  replaces every storefront page with the maintenance scene (`noindex`) for
  non-staff; signed-in staff (any admin grant) bypass it. The non-page public
  surfaces are closed too through `isSiteGatedForViewer()`: `/api/store/search`
  returns empty results, `/feeds/*` and the `/md` twins 404, `sitemap.xml` is
  empty, `robots.txt` serves `Disallow: /` and `llms.txt` (which checks
  `isSiteGated` directly) a minimal body. The cookie-free machine files
  (sitemap, robots, llms, feeds) have no staff bypass. Mode
  lookup fails **open** (settings error ⇒ live), the staff bypass fails
  **closed**. NOT covered (owner decision, see « What's still open »): page
  `generateMetadata` output (titles, descriptions, OG images of product /
  category URLs), the RSC payload of a crafted client-navigation request,
  storefront Server Actions (cart, order placement) and the key-gated
  `/api/*` tier (its public routes are not site-mode gated by policy).
- **Bearer-URL hygiene with GTM** (owner setup in the tag manager, not code).
  GTM stores: create a Data Layer Variable `page_location`; fire the GA4
  page_view EVENT tag on the Custom Event trigger `gz_page_location` (sent once
  per path, landing included) with the event parameter page_location =
  `{{DLV page_location}}`; set `send_page_view = false` in the Google tag so the
  landing isn't counted twice; turn OFF GA4 enhanced measurement « Page changes
  based on browser history events » and any History Change page_view trigger
  (they fire with the raw URL). Direct-GA4 stores (no GTM): nothing to map. In
  all cases consider GA4 Data stream → Redact data (query parameters `token`,
  `t`, `k`, `from`). Optionally turn the Meta Pixel's autoConfig off store-wide
  (gives up Meta's automatic button / microdata events).

## What's still open

- App-level rate limiter runs **per Postgres row, not per edge** — it caps our
  own endpoints but volumetric DDoS is still Coolify/Cloudflare's job.
- **Better Auth's own limiter is per-process** (`rateLimit.storage: "memory"`):
  fine for the documented single-instance deploy, but multi-pod scale-out (the
  same change-window that enables the PgBouncer pooler) MUST first switch it to a
  shared backend (Redis `secondary-storage` / `database`), else the effective
  per-account login / reset cap multiplies by the pod count. Single-pod is a hard
  deploy invariant until then.
- **Per-instance background timers assume one replica** (`src/instrumentation.ts`:
  the runtime resource sampler + the app-instance heartbeat). On scale-out, every
  pod would run its own sampler (duplicate/contending alert emission) and its own
  heartbeat row — move the alert-emitting sampler behind leader-election and treat
  heartbeats as per-pod before adding a second replica. (The review scheduler is
  already multi-instance-safe via a row lock.) Part of the same single-pod
  invariant as the rate limiter above — see `docs/deploy-runbook.md` §"Enabling
  PgBouncer (multi-instance scale-out)".
- Passkeys (WebAuthn) via the Better Auth plugin (TOTP 2FA is now shipped — see
  above). Optionally: per-account hard lockout.
- **OAuth auto-link + social 2FA are gated** (migrations 0099 + 0157): the
  per-user `users.oauth_autolink` flag controls whether a verified-email social
  sign-in links onto an existing email/password account. It was opt-in / default
  FALSE under 0099; migration **0157 flipped the default to TRUE** (and backfilled
  existing rows), so a Google sign-in whose email matches a non-2FA account now
  links automatically. The always-on invariant — independent of the flag — is the
  **2FA carve-out**: BOTH the `account.create.before` gate (the FIRST link) AND the
  `session.create.before` gate (a REPEAT sign-in with an already-linked provider —
  the OAuth callback isn't intercepted by the TOTP plugin, so this closes that
  bypass too) in `src/lib/auth/server.ts` ALWAYS refuse the silent social
  link/sign-in for an account with TOTP 2FA enabled — such an account must complete
  a full password + TOTP sign-in, never a Google/Facebook callback. The decisions
  are the pure, unit-tested `oauthAutolinkGate` + `isOAuthCallbackPath` in
  `src/lib/auth/policy.ts` (a refactor dropping the 2FA branch fails
  `auth-policy.test.ts`). A non-2FA user can still fail-closed by turning the
  toggle OFF (Profil → Connexion Google automatique). Fresh social sign-ups are
  unaffected. The `auth.social.<provider>_enabled` toggle gates the provider
  itself (switched off, it isn't registered, so `/sign-in/social` +
  `/callback/<provider>` reject it — not just the button; a settings read error
  registers none). NOTE: verify against a real Google OAuth flow on a staging
  deploy before relying on it (Google sign-in is off until creds are set in
  /admin/system/auth).
- **Maintenance gate leaks (owner decision).** While `site.mode` is
  maintenance / coming_soon, page `generateMetadata` output (product / category
  titles, descriptions, OG images), the RSC payload of a crafted
  client-navigation request and the storefront Server Actions (cart, order
  placement) are not gated — only the page body is. The key-gated `/api/*`
  tier's public routes are not site-mode gated either (policy). A pre-launch
  catalogue can therefore still be enumerated by a determined client; closing
  it needs a per-page / per-action gate.
- **Email-change confirmation goes to the NEW address** (Better Auth 1.6 key
  mismatch — see the « Email change » row). Owner decision pending because the
  seeded-admin runbook relies on changing the admin email.
- **Bearer-URL follow-ups (owner).** A separate QR verify credential or a
  signed `?k=` for guest order / receipt links; an httpOnly-cookie handoff for
  the `/reset-password` token (it still rides in the URL,
  mitigated by `no-referrer` + tag-free pages); an opaque v2 unsubscribe token
  (today's embeds the address).
- AI provider base URL: the request-time DNS check doesn't pin the socket to
  the checked IP (DNS-rebinding residual; link-local / metadata targets only).
- IP allow-list for admin routes (today: `requirePermission` + origin check +
  audit are the gates).
- CSP is dynamic but still permits inline styles / some `unsafe-*` for the
  current third-party set — tighten to `strict-dynamic` + nonce once the host
  list stabilises.
- Subresource integrity for external scripts (none currently embedded).
- Right-to-erasure flow (delete customer + cascade soft-delete via a
  subscriber on `user.deleted`). Partial today: « Supprimer le client »
  (`deleteCustomerWorkflow`) soft-deletes the profile and addresses, disables a
  customer-role login (revoking its sessions and API keys), withdraws marketing
  consent (profile opt-in + newsletter row via `unsubscribeEmailFromMarketing`)
  and forces the public favourites page private. Disabling an account also
  withdraws marketing consent (not restored on re-enable — run last and
  best-effort, so it never blocks the disable or its audit rows), and a
  disabled owner's `/u/<slug>` page 404s until re-enabled.
- Webhook source-IP allow-list per provider (Flouci is API-re-verified, so
  this is defence-in-depth, not load-bearing).
- File virus scan hook (ClamAV via a future job, when upload volume justifies
  it).

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](../CREDITS.md).
