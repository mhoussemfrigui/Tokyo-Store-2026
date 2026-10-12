# Pre-production sign-off — residual items

> **⚠️ Historical snapshot (2026-06-26) — superseded.** This is a dated
> point-in-time record; its counts (migration chain, API action/event totals,
> etc.) reflect that moment and have since drifted (the chain is now at `0125`;
> next `0126`). Later A–Z rescans supersede it. Kept as a launch-era audit
> record, not a live reference — do not line-edit its counts. Status changes
> since then are appended as dated follow-ups at the end.

A near-final full-stack rescan (security + perf + DB + API/webhooks + module
harmony + dead code + edge cases + tests + docs, every finding adversarially
verified) confirmed **49 findings (0 critical, 1 high, 16 medium, 32 low)**.

The HIGH + all security-relevant + all correctness/DB/API/doc/test findings were
**fixed and committed** (see the `fix(preprod): … rescan batch N` commits). This
file records the items deliberately **deferred** — each is either an owner product
decision, an architectural change too risky to make blind right before launch
without a staging runtime to verify, or low-impact polish — so the sign-off is
honest about what ships as known residual.

## Owner decision required

- ✅ **RESOLVED (2026-06-26 round 3, owner-directed)** — **2FA was bypassable via linked
  Google social login.** Now gated PER USER: an OAuth account can no longer silently link
  onto an existing email/password account (the 2FA bypass) unless that user opted in via
  `users.oauth_autolink` (migration 0099, default FALSE). Enforced by a new
  `account.create.before` hook (`src/lib/auth/server.ts`) that throws `FORBIDDEN` unless the
  target user (identified as having a `credential` account) opted in; fresh social sign-ups
  (no password account) are unaffected. The user manages it from **Profil → Connexion
  sociale**; to link Google they enable it, then sign in with Google. Tests:
  `oauth-autolink.test.ts`. NOTE: Google sign-in is OFF until creds are set in
  /admin/system/auth — **verify the full Google OAuth flow on a staging deploy before relying
  on it** (the OAuth callback path can't be exercised locally).

## Deferred — architectural / needs staging verification

- **CSP `script-src 'unsafe-inline'` with no nonce** (`src/lib/security/headers.ts`).
  XSS mitigation is effectively off. A per-request nonce (proxy → header → layout
  inline scripts → `'nonce-…' 'strict-dynamic'`) is the fix, but flipping CSP blind
  can white-screen the whole site; it needs a CSP-capable staging deploy to verify.
  **Tracked as the next security-hardening step.**
- **Storefront category/brand page enriches the ENTIRE descendant product set**
  (`listProductsByCategory` → `productsForIds`). Intentional: the client needs the
  full set for faceted filtering. Acceptable at the current sub-thousand-SKU scale;
  the markdown/feed paths were already moved to paged loaders. **Future:** move
  sort/filter/pagination server-side for very large categories.
- **Storefront chrome (`(shop)/layout.tsx`) re-fetched per request** — prime
  `'use cache'` + `cacheTag` candidates (nav/banners/settings; the
  invalidate subscribers already bust those tags). Deferred to avoid a cache-
  invalidation regression right before launch; it's the documented next perf step.

## Deferred — single-replica deploy assumption (document at the infra layer)

- **Better Auth HTTP rate limiter uses in-process memory** (`rateLimit.storage:"memory"`)
  and **per-instance background timers** (`src/instrumentation.ts`: runtime sampler +
  heartbeat) assume ONE app replica. Before scaling Coolify past 1 instance: move the
  rate-limit + invite-context markers to a shared store and add leader-election for the
  alert-emitting sampler. The review scheduler is already multi-instance-safe.

## Deferred — low impact / tracked debt

- **AI provider base-URL SSRF TOCTOU** (`src/lib/ai/guard-base-url.ts`): the guard
  resolves DNS then `fetch()` re-resolves (no socket pinning like the media importer).
  Bounded by the admin-config trust boundary; socket-pinning is the future hardening.
- **Operator order-line edit emits no `product.*` stock events** (`edit-items.ts`):
  same pattern as the cancel/refund/return restock events just wired (batch 3), lower-
  traffic path. (#37)
- ✅ RESOLVED — **Free-shipping-only coupons now burn a per-user redemption and
  enforce `max_uses_per_user`** (migration `0116` `free_shipping` marker + the
  free-ship-burn wiring: `place-order.ts` sets `free_shipping = couponZeroedShipping`
  and `promotionService.countRedemptionsByUser` counts it). A free-ship coupon that
  confers no benefit (fee already 0 via pickup/in-store or a member threshold)
  correctly does NOT burn a use. See `docs/database.md` (migration 0116).
- **`editOrderItemsWorkflow` can edit a pending ONLINE order with a live gateway
  session** — `confirmPayment` fails closed on amount mismatch (no money/stock
  corruption); the customer re-initiates via `resumeOrderPaymentAction`.
- **Test debt:** extract the coupon final-discount math (`coupon-eligibility.ts`) and
  the reconcile-cron auto-cancel decision (`reconcile-pending-payments.ts`) into pure
  helpers with DB-free tests (mirrors `decideConfirmation`); add a full place-order
  total-composition test.
- **Micro-perf / a11y polish:** home hero `<Image priority>` preloads a desktop-only
  image on mobile; PDP has a few sequential awaits that could join the main
  `Promise.all`; cart panel doesn't surface per-product limit hints; mobile express
  bottom-sheet lacks a focus trap.

---

## 2026-06-26 — final pre-production rescan (round 2)

A second exhaustive full-stack rescan (front + back; security, DB stability/perf,
API/webhooks, SEO, frontend perf, module linkage, settings conflicts, hardcode hunt,
dead code, edge cases, docs — 28 scan agents, every non-low finding adversarially
verified). **81 raw findings → 80 kept (1 refuted): 0 critical, 4 high, 18 medium,
58 low (44 doc-freshness).** Live-verified on the running dev stack (storefront +
admin auth + SEO surfaces, zero console/network errors).

**Fixed + verified this round:**

- **HIGH — PDP review JSON-LD now gated on `reviews.enabled`** (`[slug]/page.tsx`): a
  product with ≥5 approved reviews no longer ships `aggregateRating`/`review[]` markup
  after an admin disables reviews (Google rich-results policy: markup must match the
  visible page).
- **HIGH — account marketing opt-OUT now works** (`lib/actions/customer.ts`): an
  unchecked "recevoir les offres" box is now an explicit `false`, not a silent no-op
  (the always-rendered checkbox previously made opting out impossible — GDPR-relevant).
- **HIGH — média orphan/reference checks now include `collections`**
  (`modules/media/queries.ts`): collection hero/OG images are no longer mis-counted as
  orphans or shown as 0-reference (silently deletable). Verified the SQL executes.
- **HIGH — PgBouncer no longer rejects every app connection** (both compose files):
  added `statement_timeout,lock_timeout,idle_in_transaction_session_timeout` to
  `IGNORE_STARTUP_PARAMETERS` (the pool forwards `statement_timeout` as a startup param;
  PgBouncer rejected it). Runbook §"Enabling PgBouncer" corrected to (a) acknowledge the
  connect-hook session SETs + ignore-vs-enforce nuance and (b) require migrations to run
  on a DIRECT connection (session advisory lock + session GUCs are not pooler-safe).
- **MED — `email_change` confirmation token now redacted** in `email_logs`
  (`modules/mailing/dispatch.ts`): single-use account-security token no longer persisted
  in plaintext / resendable.
- **MED (SEO) — subcategory `/[parent]/[sub]` page** now honours the leaf's
  `noindex` / `canonical_url` / `og_image_media_id` overrides AND emits
  `CollectionPage + BreadcrumbList + ItemList (+ FAQPage)` JSON-LD, at parity with the
  root category page. Verified live on `/accessoires/sacs-a-main`.
- **MED — demo Fidélité FAQ** rewritten to the canonical tiers (Classique/Silver/Gold/
  Diamond, 1 pt/TND) — was describing a removed Bronze/Argent/Or/Platine ladder.
- **LOW — web manifest `theme_color`** fallback changed from the stale Game-Zone blue
  `#0131B4` to the olive brand default. Verified live (`#4E6F3D`).
- **Dead code** removed (zero callers, typecheck green): `businessService.{listMembers,
  assignMemberLevel}`, `wishlistService.count`, `deliveryService.getZone`.
- **Docs/comments (~50 items)** brought to current: migration chain → 0097/98 files,
  API.md action/event counts → 297/185, ClicToPay-webhook-now-exists across FORK/
  deployment docs, médiathèque collections coverage, REQUIREMENTS/`.env.example`
  EMAIL_PROVIDER+CRON_SECRET scope, site-map nav/home/cron/admin drift, ANALYSIS.md
  marked a superseded snapshot, and stale code comments (`proxy.ts` "two jobs"→three,
  nav `internal_kind` kinds, telemetry service name, showcase "Précommandes", PLAN/
  database Game-Zone leftovers).

**Test-infrastructure issues found (not product bugs, fix before relying on CI):**

- `pnpm test` / `pnpm test:pure` **fail on Windows** — the scripts chain ~95 `tsx`
  invocations with `&&`, exceeding cmd.exe's 8191-char command-line limit. Run tests via
  a loop/runner script (each file passes individually) or split the script.
- 8 test files (those importing the `@/workflows` barrel) **fail at import** under
  `tsx --conditions=react-server` on **Node 24** with `React.createContext is not a
  function` — the workflow graph transitively pulls `next/navigation`'s client router
  context into the server-conditioned test. 90/98 files pass; isolate the client import
  or pin the test Node version.

**Deferred / owner-decision (not changed — product or risk call):**

- ✅ **RESOLVED (2026-06-26 round 3)** — **Flouci "Mode sandbox" toggle was functionally
  dead.** Added `providerSupportsTestMode()` (pure, in `lib/payments/shared.ts`); the
  admin payments panel now hides the sandbox toggle + amber warning for Flouci (showing
  an "env is set by credentials" note instead), the API/webhooks panel hides its mode
  pill, and the save action no longer writes Flouci's `test_mode`. New invariant in
  `payment-gateway-completeness.test.ts` asserts the capability matches each client's
  actual `testMode` use. ClicToPay's real toggle is unchanged.
- ✅ **RESOLVED (2026-06-26 round 3)** — **Checkout showed a flat courier fee but charged
  the per-zone rate under region pricing.** Extracted a pure free-threshold/zone rule
  (`lib/checkout/delivery-fee.ts`) shared by the authoritative `resolveDelivery` AND the
  display path; `listDeliveryOptions` is now region-aware and `buildRegionAgentFeeIndex`
  feeds the client checkout form + express buy-block so each courier's fee is recomputed
  the instant the customer picks their gouvernorat — equal to what's charged. Express
  region field also converted free-text → constrained governorate select. New tests:
  `delivery-fee.test.ts` (pure) + display==charge invariants in `delivery-zone.test.ts`.
  Zero behaviour change when region pricing is off (the index is empty).
- ✅ **RESOLVED (2026-06-26 round 3)** — **Delivery-zone governorate match was accent/
  name-form sensitive.** Added one shared `normalizeGovernorate` (accent- + case-fold) used
  by `resolveZoneForRegion`, the Phase-2 zone index, and the client lookup — so "Béja" and
  "beja" match. Admin zone `governorates` are now `canonicalizeGovernorateList`-normalized on
  save (accent/case + dropped "La"/"Le" article → official name), the misleading placeholder
  ("Manouba" → "La Manouba") + a helper note were added, and the express region field is now
  the constrained governorate select (all storefront region inputs are now canonical selects).
  Tests: normalize/canonicalize cases in `delivery-fee.test.ts` + an accent zone-match case in
  `delivery-zone.test.ts`.
- ✅ **RESOLVED (2026-06-26 round 3)** — **`findOrderByNumber` wrapped `upper()`** around the
  indexed column → seq scan. Added migration **0098** with a functional index
  `orders_order_number_upper_idx ON orders (upper(order_number))`; verified via `EXPLAIN`
  (`SET enable_seqscan=off` → `Index Scan using orders_order_number_upper_idx`, exact
  `Index Cond`). Query unchanged (now index-backed); schema NOTE + call-site comment added;
  migration-chain doc counts bumped to 0098 / 99 files.
- ✅ **RESOLVED (2026-06-26 round 3)** — **Home was a `'use client'` wrapper with no client
  code.** `HomePageClient` + the 4 static blocks (fifty-fifty, appointment, complications,
  editorial-split) are now SERVER components — only `HomeHero` (carousel) and `ProductRail`
  remain client islands, cutting the home's client JS. Verified live: all blocks render, the
  hero carousel still switches slides, no new console errors. (Filename `home-client.tsx`
  kept to avoid churn; a doc note marks it as a server component.)
- ✅ **RESOLVED (2026-06-26 round 3)** — **`THEME_DEFAULTS` hex ≠ the `.storefront` globals.css
  defaults.** `buildThemeCss` injects a `.storefront{…}` `<style>` (DB theme or THEME_DEFAULTS)
  that overrides the static `.storefront` rule. The static rule used hsl() approximations for
  the 8 theme-driven tokens (`--primary`/-foreground, `--foreground`/-card/-popover, `--ring`,
  `--gold`/-foreground), so a cold-DB render (injection skipped) looked subtly different. Set
  those static fallbacks to the EXACT `THEME_DEFAULTS` hex + reciprocal KEEP-IN-SYNC comments in
  both files — zero change on normal renders (verified live: olive #4E6F3D, gold #886E5C, onyx
  #2B2825, 12px radius), cold-DB now matches. (Non-theme tokens like `--secondary`/`--olive`
  stay scope-local hsl; note they're a slightly different olive than `--primary` — left as a
  pre-existing design detail, not unified, to avoid a visible colour change.)
- Round-1 deferred items: **2FA-via-Google-link is now RESOLVED** (see "Owner decision
  required" above — per-user `oauth_autolink` gate, migration 0099). Still deferred with
  rationale: **CSP `script-src 'unsafe-inline'` no-nonce** (flipping CSP blind can
  white-screen the site — needs a CSP-capable staging deploy; the `unsafe-inline` +
  nonce-TODO is documented in `lib/security/headers.ts`), and the **single-replica
  assumptions** (in-memory auth rate-limiter + per-instance timers in `instrumentation.ts` —
  documented in `docs/security.md` "What's still open" + the runbook scale-out section).
  Also unchanged: full-descendant category enrich, per-request chrome caching.

---

## 2026-09-23 — follow-up (A–Z audit + fix program)

Status changes to items above, from the commits `77b7163`…`866522c`:

- ✅ **RESOLVED — test runner on Windows / Node 24.** The `test:pure` / `test:db`
  chains are split into numbered sub-scripts (`test:pure:1`–`2`,
  `test:db:1`–`3`) that stay under `cmd.exe`'s ~8191-char limit;
  `test-chain-integrity.test.ts` enforces the split (< 7500 chars per script)
  and that every test file is wired exactly once. The full suite (104 pure +
  115 DB files at `866522c`) runs green on Node 24.12 — the
  `React.createContext` import failure no longer occurs. See [DEVELOPMENT.md §6b](../DEVELOPMENT.md#6b-tests).
- **Resume payment (« Reprendre le paiement »)** now verifies the order's
  PREVIOUS gateway session before opening a new one: if it was already paid,
  the order is settled and the customer is sent to the confirmed order page
  (`/order/<id>?pay=return`) instead of paying twice; an amount mismatch or an
  unreachable gateway refuses the retry (fail-closed, the old reference is kept).
- **Recette item (ClicToPay):** `orderNumber` is `<order_number>-<ms timestamp>`
  when that fits ClicToPay's AN..32, otherwise it is compacted to
  `<order_number without dashes><base36 timestamp>` (last 32 chars). Confirm on
  the SMT recette that a compacted `orderNumber` is accepted when an order
  prefix longer than 2 characters is configured.

## Follow-up — 2026-09-30 (OAuth auto-link default flipped + social 2FA gate)

- **OAuth auto-link default is now ON** (migration **0157**, superseding the
  default-FALSE state recorded above under "Owner decision required"):
  `users.oauth_autolink` defaults TRUE and existing rows were backfilled, so a
  verified-email Google sign-in links onto a matching **non-2FA** account
  automatically. The security invariant is unchanged and strengthened — an account
  with **TOTP 2FA enabled is ALWAYS blocked** from a silent social link/sign-in
  regardless of the flag, now enforced at BOTH the first link
  (`account.create.before`) AND a repeat sign-in with an already-linked provider
  (`session.create.before`, which closes the OAuth-callback path the TOTP plugin
  never intercepted). The decisions are the pure `oauthAutolinkGate` +
  `isOAuthCallbackPath` (`src/lib/auth/policy.ts`), covered by `auth-policy.test.ts`.
  A non-2FA user can still fail-closed by turning the toggle OFF.
- The OAuth **redirect_uri** better-auth sends is derived from `BETTER_AUTH_URL`
  (not `NEXT_PUBLIC_SITE_URL`); the /admin/system/auth panel now shows the
  `BETTER_AUTH_URL`-based callback and warns when the two origins differ — whitelist
  that exact origin in the Google/Facebook console. Facebook does not guarantee an
  email; a no-email sign-in fails with `error=email_not_found` and a French message
  (no account is created). The staging-verify caveat for the full OAuth flow stands.

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](../CREDITS.md).
