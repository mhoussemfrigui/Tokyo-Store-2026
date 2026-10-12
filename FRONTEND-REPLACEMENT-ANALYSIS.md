# Tokyo-Store — A–Z Architecture Analysis & Frontend-Replacement Map

> **Purpose.** A full, code-verified walkthrough of the platform, written through one lens:
> **the owner intends to keep the current backend and completely replace the frontend.**
> Every section ends by answering *how is this wired to the UI, and what does a new frontend need?*
>
> **Method.** A 14-agent sweep (13 domain investigators + a completeness critic, ~2.3M tokens)
> read the current code directly. **Code is the source of truth**; the repo's own docs
> (`docs/architecture.md`, `docs/modules.md`, `API.md`, `REQUIREMENTS.md`, …) were used as a map
> but several have drifted (see [Appendix A](#appendix-a--counts--doc-drift)). `ANALYSIS.md`,
> `AUDIT-REPORT.md`, `PLAN.md`, `docs/az-analysis-2026-10-02.md` are explicitly **historical** and
> were not relied on. File:line citations throughout point at current code.
>
> _Generated 2026-10-08._

---

## 0. TL;DR — the verdict

- The system is **one Next.js 16 process** that is simultaneously the storefront, the admin
  back-office, an ERP/headless REST API, cron, payment webhooks, and machine surfaces
  (feeds/sitemap/`llms.txt`/markdown twins). Internally it is a **Medusa-inspired modular
  monolith**: the real business logic lives in **framework-agnostic TypeScript** (`src/modules`,
  `src/workflows`, `src/associations`, `src/events`, most of `src/lib`) over a **135-table
  PostgreSQL 16** database. **That core — the backend you want to keep — is cleanly separable in
  principle.** Next.js is "only" the delivery shell.

- **But the frontend reaches the backend through three transports, and two of them are
  Next-only and cannot be used by any non-Next frontend:**
  1. **RSC direct imports** — Server Components read data by importing `src/lib/api/*` and module
     `queries.ts` *in-process*. **No HTTP.** (All storefront & admin reads.)
  2. **Server Actions** — `'use server'` functions in `src/lib/actions/*` (83 files, ~396
     exported actions) imported straight into client components. Next-RPC. (All mutations.)
  3. **REST** — `src/app/api/**` (60 routes). Framework-agnostic HTTP — **the only transport a
     separate frontend can consume.**

- **The REST surface that exists today is an ERP / external-integration API plus a partial
  headless *content* bundle — NOT a customer-facing storefront API.** It covers catalog reads,
  ERP order/customer/stock/warranty sync, `/api/content` (site chrome + public settings),
  `/api/blog`, `/api/reviews`, and the first-party `/api/store/search`. **The entire transactional
  storefront — cart, checkout, payment init/verify, account self-service, wishlist, loyalty,
  review submission, appointments, newsletter, and even email/password login — has no
  customer-facing HTTP endpoint at all.** Those are 100% Server Actions + cookie state.

- **Good news (the leverage point):** business logic lives in `src/workflows/*`, and the existing
  REST write routes are already thin wrappers over those same workflows. So the missing endpoints
  are **new thin HTTP shims over existing workflows**, not a logic rewrite. A new frontend that
  calls the same workflows inherits all emails, audit, outbound webhooks, cache invalidation,
  loyalty, and inventory side-effects **for free** (they ride an in-process event bus after each
  workflow commits).

- **Three decisions dominate the cost** and must be made before the work can be sized — see
  [§15](#15-the-decisions-that-gate-the-plan): **(a)** is the **admin** in scope, or only the
  storefront? **(b)** will the new frontend be **same-origin** (behind the same domain) or a
  **separate-origin** app/SPA? **(c)** is the Next app **retained as the HTTP backend host**
  (serving REST, `/cdn`, feeds, webhooks, cron, boot timers), or fully extracted?

- **Two "frontend-only" assumptions that are actually backend work:** there are **no translation
  columns** anywhere in the schema — a **multilingual / RTL** rebuild needs backend schema changes;
  and there is **no customer media-upload path** — review photos / warranty attachments are
  net-new backend.

---

## 1. System overview & tech stack

| Layer | Technology |
|---|---|
| Runtime | **Next.js 16** (App Router) + **React 19**, single Node process, `output: standalone` |
| Language | TypeScript (strict), path alias `@/* → ./src/*` |
| Database | **PostgreSQL 16** + **pgvector**, **Drizzle ORM** (`casing: snake_case`), PgBouncer (transaction pooling) |
| Auth | **better-auth** (Drizzle adapter + `twoFactor` + `nextCookies` plugins) |
| Media | **sharp** pipeline + **SeaweedFS** (S3-compatible) behind a same-origin `/cdn` proxy |
| Email | provider-agnostic: **Resend** / SMTP / sendmail / console |
| AI | Anthropic + OpenAI-compatible (OpenRouter/DeepSeek) for content-gen + embeddings |
| Payments | **ClicToPay** (Monétique Tunisie) + **Flouci** + COD (Tunisian market) |
| Styling | **Tailwind v4** + a minimal hand-rolled shadcn subset, DB-driven theme tokens |
| Deploy | **Coolify** / Docker: `app`, `postgres` (pgvector), `seaweedfs`, `pgbouncer`; cron = external scheduled task |
| Money | integer **millimes** (1 TND = 1000); columns named `*_cents` hold millimes — never ÷100 |
| IDs | **uuid v7** everywhere via a hand-written `uuid_generate_v7()` plpgsql function |

**Heritage note.** The backend is a re-skinned "Game Zone" codebase; load-bearing `gz_` / `gz.*`
identifiers are kept on purpose (the session cookie is `gz.session_token`, `src/proxy.ts:43`; the
cart cookie `gz.cart_token`). These are not dead code — don't rename them.

**Scale (reconciled counts — see [Appendix A](#appendix-a--counts--doc-drift)):** 1,790 TS/TSX
files · ~44 module folders · 135 DB tables · 202 hand-authored migrations · 177 workflow functions
· 227 typed events / 40 subscribers · 60 `app/api` route files (+8 non-`/api` route handlers) ·
83 `'use server'` files / ~396 actions · 762 `server-only` files · 290 `'use client'` files ·
156 `page.tsx` (~107 admin, ~49 storefront).

---

## 2. The layering model

```
src/
  modules/<domain>/      schema.ts (Drizzle tables) · service.ts (CRUD, server-only)
                         queries.ts (reads, server-only) · index.ts (barrel)
  associations/          cross-module JOIN tables + join-helper services (no cross-module FKs)
  workflows/<domain>/    orchestration: zod → db.transaction(services) → post-commit bus.emit
  events/                in-process pub/sub bus + 40 subscribers (emails, audit, webhooks, cache…)
  lib/                   cross-cutting utils + db + THE TRANSPORT LAYERS:
      lib/api/*          RSC read facades (server-only)          ← Transport 1 (reads)
      lib/actions/*      'use server' Server Actions             ← Transport 2 (mutations)
      lib/api-auth/*     REST guards (route-catalog, scopes…)    ← governs Transport 3
  app/                   Next routes: (shop)/ admin/ api/ (documents)/ + cdn, feeds, md, sitemap…
  components/            React UI: ui/ admin/ storefront/ cart/ blog/ consent/ tracking/ …
```

**The five non-negotiable rules** (`REQUIREMENTS.md:15`, `docs/modules.md`), all verified holding:
1. One folder per domain (recursively — `catalog/` and `cms/` are parents whose children repeat
   the shape, e.g. `src/modules/catalog/product/{schema,service,queries,index}.ts`).
2. **No cross-module foreign keys in Drizzle code** — only `auth/schema.ts` and `blog/schema.ts`
   use `.references()` (both intra-module); cross-module links are bare `uuid`/`text` "soft FKs",
   with the real `FOREIGN KEY` added by hand in migration SQL. Joins live in `src/associations/`.
3. **Services do CRUD; workflows orchestrate; pages/actions never mutate directly.** Services are
   deliberately hidden from the module barrel (`src/modules/catalog/index.ts`).
4. **Events decouple side-effects** — workflows emit; subscribers react (in-process bus).
5. **Validate at the boundary** — zod `safeParse` inside the `workflow()` wrapper.

Plus codebase-wide conventions: money-as-millimes (`src/lib/price.ts:22`), uuid v7
(`src/lib/db/columns.ts`), soft deletes (`deleted_at`, partial-unique indexes scoped
`WHERE deleted_at IS NULL`), hand-authored migrations (snapshots frozen at 0007 so
`db:generate`/`db:push` are **guard-disabled**), FKs/CHECKs in raw SQL, PgBouncer constraints
(no `LISTEN/NOTIFY`, no session `SET`), and "`pnpm typecheck` is the real gate" (the build runs
with `typescript.ignoreBuildErrors: true` and type-checks as a separate Docker layer).

**Request lifecycles:**
- **Read (RSC):** `proxy.ts` (edge cookie gate, no DB) → layout (site-mode / RBAC shell) → page
  guard (`requirePermission`) → **direct in-process import** of `lib/api/*` or module `queries.ts`
  → Drizzle → pg Pool. **No HTTP hop.** (`src/app/(shop)/(shell)/[slug]/page.tsx:19-87`.)
- **Mutation (Server Action):** client `<form action>`/`useTransition` → `'use server'` action →
  `requirePermission` → parse/validate → `workflows.<ns>.<op>(input, {actorUserId, ip})` →
  `db.transaction` → post-commit `bus.emit` → subscribers fan out → `revalidatePath`/`refresh`.
- **REST:** `app/api/<res>/route.ts` → `enforceExternalApi(req, id)` (key/scope/public gate) →
  the **same workflow** the dashboard uses → standardized JSON envelope.

**What is framework-agnostic vs Next-bound** — the crux in one table:

| Layer | Nature | A non-Next frontend… |
|---|---|---|
| `modules/*`, `workflows/*`, `associations/*`, `events/*`, most `lib/*` + the DB | Agnostic business logic, but `server-only` + DB-bound | …**cannot import it** (compiled for the Next server). Reusable only *in-process* behind an HTTP layer. |
| **Transport 1** `lib/api/*` RSC reads | `server-only` in-process reads | …needs a **new HTTP read** per facade. |
| **Transport 2** `lib/actions/*` Server Actions | Next-RPC | …**cannot call them**; needs **new REST** per mutation. |
| **Transport 3** `app/api/**` REST | Framework-agnostic HTTP | …**can use as-is**, for what it covers (see §9). |

`762` files begin with `import "server-only"` — a compile-time wall that makes the data layer
impossible to import from a client bundle or a non-Next process.

---

## 3. Data layer & database — the durable asset

The database is the real, reusable asset. **The schema needs zero changes for a frontend swap;
the work is a transport layer, not a data migration.**

- **135 tables**, schema-per-module, re-exported through the single Drizzle barrel
  `src/lib/db/schema.ts` (forgetting a re-export silently hides a table from drizzle-kit).
- **Extensions** (in migration SQL): `pgcrypto`, `pg_trgm`, `btree_gin`, `unaccent` (baseline),
  `vector`/pgvector (`0112`), `pg_stat_statements` (`0124`). **The Coolify Postgres image must be a
  pg16+pgvector build** or `0112` fails.
- **uuid v7** via a hand-written `uuid_generate_v7()` plpgsql function (time-ordered, smaller
  indexes). **Money = integer millimes** in `*_cents` columns (single source `src/lib/price.ts:22`).
- **French FTS** via a custom `fr_unaccent` text-search config; `search_vector tsvector GENERATED
  ALWAYS STORED` columns on products/blog/brands/categories/pages with partial GIN indexes.
  **Semantic search**: `products.embedding vector(1536)` (OpenAI `text-embedding-3-small`) + HNSW,
  gated behind `search.semantic_enabled`.
- **Migrations:** 202 hand-authored SQL files (`0000` squash baseline + `0001`→`0201`) with a
  matching `meta/_journal.json`. Many real indexes (trigram GIN, BRIN, functional, partial-unique)
  exist **only in raw SQL** — a schema-only read understates the index set.
- **DB client** (`src/lib/db/client.ts`): one `server-only` `pg.Pool` per process (HMR-guarded on
  `globalThis`), `POOL_MAX` 12 prod/5 dev, 10s statement timeout enforced twice, `withLongStatement()`
  escape hatch. Migrator uses a cross-process advisory lock and a direct (non-PgBouncer) connection.
- **Denormalised counters** maintained by the service/workflow layer inside transactions:
  `products.rating`/`reviews_count`, `customer_profiles.cumulative_spend_cents`/
  `credit_balance_cents`/`loyalty_level_id`, `users.name`. **A new frontend must treat these
  read-only.**

**Entity groups:** Identity/auth (`users`, `sessions`, `accounts`, `two_factors` — better-auth,
`text` PKs + camelCase, deviating from the norm) · Customers (`customer_profiles`, `addresses`,
segment engine with a `rule_tree jsonb`) · Catalog (`products` is the widest table; variants,
brands, categories, collections, EAV attributes, reviews, tier-release) · Commerce (`carts`,
`cart_items`, `orders`, `order_items`, refunds, shipments, returns — orders **snapshot**
product/variant/warranty/address so history survives catalog edits) · CMS (`site_settings`,
`banners`, `nav_*`, `pages`, `faqs`, `trust_badges`) · Promotions/loyalty/credit (credit is an
**append-only ledger**) · Media · Fiscal (`document_sequences`, gapless legal numbering) · Ops
(`audit_log`, `webhook_events`, `api_keys`, `app_secrets` encrypted at rest).

---

## 4. Backend domain modules (inventory)

44 module folders. Each is `schema.ts` + `service.ts` (CRUD) + `queries.ts` (reads) + `index.ts`
(barrel). Services are hidden; workflows orchestrate.

### Commerce group

| Module | Owns | Responsibility |
|---|---|---|
| `catalog/product` | `products`, `product_variants`, `product_variant_values` | Core product+variant catalog, identifiers, pricing, warranty/tax overrides, drip/early-access, tier-release |
| `catalog/category` · `brand` · `collection` | `categories`/`brands`/`collections` | Hierarchical tree, brand master, merchandising collections |
| `catalog/attribute` | 5 EAV tables | Enum values + numeric/text scalars, assignments, per-category filter facets |
| `catalog/review` (+ `product-gen`, `content-gen`) | `product_reviews` + AI gen jobs/drafts | Reviews w/ moderation + AI generation pipelines |
| `cart` · `cart-event` | `carts`, `cart_items`, `cart_events` | Cart CRUD, guest-merge, checkout lock, add-to-cart analytics |
| `order` | 8 tables (orders, items, history, refunds, shipments, returns…) | **Largest module** (~55 service methods): full lifecycle, fulfilment, RMA, analytics |
| `payment` | `payment_provider_settings` | Per-gateway config (gateway logic in `lib/payments`) |
| `promotion` | promotions + redemptions + targets | Discount engine: scope/trigger/type, live-window matching, redemption ledger |
| `gift-card` · `credit` | `gift_cards`, `customer_credit_entries` | Gift cards + **store-credit "coins" ledger** (13 entry kinds) |
| `loyalty` | `loyalty_levels`, life-stage claims | **"Le Cercle de Famille"** tier engine (coins wallet is `credit`, not here) |
| `delivery` · `tax` · `currency` | agents/zones/rates, tax rules, currencies | Shipping matrix, TVA rule tiers, **single active display currency** (no FX conversion) |
| `stock-location` · `stock-movement` · `stock-transfer` | levels, ledger, transfers | Multi-location inventory engine (atomic, advisory-locked); the true source of truth for stock |
| `wishlist` · `warranty-claim` | wishlists, `warranty_claims` | Favorites (public profiles, guest-merge) + SAV/RMA claims |

> **Nuance:** "fidélité" REST endpoints (`/api/loyalty/movements`, `/api/customers/[id]/loyalty`)
> actually serialize the **credit** ledger + the profile's level — loyalty owns tiers, credit owns
> the spendable balance.

### Platform / content / ops group

`cms` (banner, navigation, page, faq, setting, trust_badge) · `showcase` · `media` · `blog` ·
`authors` · `customer` · `business` (B2B) · `rbac` · `auth` · `oauth` · `api-key` · `api-settings`
· `webhook` (inbound idempotency) · `webhook-endpoints` (outbound ERP queue) · `mailing` ·
`newsletter` · `appointments` · `search` · `ai` · `ai-jobs` · `ai-assign` · `import` · `audit` ·
`redirects` · `document` (fiscal counters) · `instance` (uptime) · `jobs` (cron run log).

Most are **admin-only**; the storefront-facing ones a rebuild cares about are: `cms` (content
model), `media` (asset URLs), `search`, `cms/setting` (settings), `auth`/`rbac`, `customer`,
`newsletter`, `appointments`, `blog`/`authors`.

---

## 5. Orchestration — workflows, events, subscribers

- **Workflows** (`src/workflows/*`, **177 functions** in ~30 namespaces, registry at
  `src/workflows/index.ts`) are the **true mutation API**. Called as
  `workflows.order.place(input, { actorUserId, ip })`. **They never read cookies/session/request
  themselves** — the caller resolves identity and passes a `ctx`. This is the single most important
  fact for a frontend swap: **the authorization boundary lives in the callers (actions/routes),
  not the workflows.** Workflows return a `WorkflowResult = ok(data) | fail(code, message)` and
  never throw for expected failures; the `workflow()` wrapper maps Postgres errors to clean
  `conflict`/`validation` codes so API callers get 4xx, not 500.
- **Event bus** (`src/events/bus.ts`): in-process, **non-durable**, best-effort. `emit()` awaits
  all subscribers but **swallows their failures** — a side-effect can never fail the workflow.
  "Graduates to pg-boss when we need persistence." Actor rides in `meta`, never the payload.
- **227 typed events / 52 domains** (`src/events/types.ts`), with a generated runtime catalog
  (`src/lib/api-auth/event-catalog.ts`, drift-tested) and a computed severity model.
- **40 subscribers** drive: structured logging, **dual audit log**, **outbound ERP webhook
  enqueue** (durable `webhook_deliveries` + cron drain), transactional + marketing **emails**,
  loyalty accrual, gift-card issuance, inventory alerts + auto-transfer + delivery-note issuance,
  pgvector re-embedding, media (S3) cleanup, and **cache invalidation** (`revalidateTag`).

> **Reuse win:** a new frontend that calls the same workflows (via new REST shims) gets **all** of
> these side-effects for free — no reimplementation. **But** the Next process must keep running:
> subscribers are registered at boot (`instrumentation.ts`), and two internal timers (AI
> review-gen scheduler + metrics sampler) live there too.
>
> **Note:** `src/workflows/cart/` emits **zero** events (the cart is deliberately event-free; cache
> refresh happens in the action via Next 16 `refresh()`).

---

## 6. ⭐ The three backend→frontend transports (the spine)

This is the heart of the replacement decision. Everything the current frontend touches is one of
three transports; a non-Next frontend can only use the third.

### Transport 1 — RSC direct imports (ALL reads)

Every storefront & admin page is a Server Component that imports `src/lib/api/*.ts`
(`products.ts` 81 KB, `categories.ts`, `cms.ts`, `content.ts`, `blog.ts`, `brands.ts`,
`collections.ts`, `orders.ts`, `reviews.ts`, `customers.ts`, `nav-composer.ts`,
`main-nav-items.ts`, …) and module `queries.ts` **directly, in-process**. No HTTP, no
serialization. **A non-Next frontend cannot import these**, and crucially the storefront DTOs are
**richer** than the external REST read shapes — they fold in live promotions, per-viewer
early-access/drip gating, media-URL resolution, and currency that the cached/ERP `/api/products`
read deliberately excludes (`src/lib/api/products.ts:77-94`). So even where a REST read exists, it
likely won't match a storefront PDP/grid without new work.

### Transport 2 — Server Actions (ALL mutations)

`src/lib/actions/*` — **83 `'use server'` files, ~396 exported `*Action` functions** (all directive
files live here; other `lib` files only mention the string in comments). Imported directly into
~200 client components via `useActionState`+`<form action>` or `await` inside `useTransition`.
Compiled to opaque internal POSTs keyed by build-time action ids via the React Flight protocol —
**there is no stable URL or schema a non-Next client could call.**

- ~54 exports are **storefront/self-service** (the test-enforced `PUBLIC_ACTIONS` allow-list in
  `route-invariants.test.ts` is the project's own storefront-vs-admin map); ~342 are **RBAC-gated
  admin** actions.
- Actions are **thin shells** over workflows, but they carry boundary concerns the workflows do
  **not**: Postgres-backed **rate limiting**, **cookie** management (`gz.cart_token`, `gz.coupon`,
  `gz.promo`), safe-redirect allow-listing, guest-vs-owner access resolution, and **cache
  revalidation**. Any new REST layer must re-home these.

### Transport 3 — REST (`app/api/**`, the only reusable path)

60 route files, governed by one enforcement layer (`src/lib/api-auth/*`) whose **source of truth is
`route-catalog.ts`** (machine-enforced against disk by `route-invariants.test.ts`). Three tiers:
`external` (key-gated ERP/data API), `first-party` (same-origin storefront helpers), `infra` (auth,
webhooks, cron, admin JSON, health). See [§9](#9-the-rest-api-contract) for the full inventory.

**The defining fact:** Transport 3 is an **ERP/integration API + a partial headless *content*
bundle**, not a customer storefront API. See the gap tables in [§14](#14-the-replaceability-map).

---

## 7. Auth, sessions, RBAC & API keys

- **better-auth** with Drizzle; the only HTTP entry is the catch-all `GET/POST /api/auth/[...all]`.
  Methods: email/password (scrypt, 12-char min, mandatory email verification by default),
  Google/Facebook OAuth (fails closed unless both creds + admin toggle), opt-in TOTP 2FA, and
  **unauthenticated guests** (opaque `gz.cart_token` cookie; guest orders claimed to an account
  only after email verification).
- **🔴 Critical:** better-auth's **email/password HTTP endpoints are DISABLED** — `/sign-in/email`,
  `/sign-up/email`, `/request-password-reset`, `/reset-password`, `/change-password`,
  `/change-email`, `/update-user`, `/delete-user`, `/verify-password`, and the 2FA
  verify-backup/OTP/get-totp-uri paths all **404 over HTTP** (`AUTH_HTTP_DISABLED_PATHS` in
  `src/lib/auth/policy.ts:127-149`, applied at `server.ts:209`). They run **only in-process from
  Server Actions**, which add the Postgres throttles, audit, and signup invariants the raw
  endpoints lack. **What remains HTTP-usable:** `get-session`, `sign-out`, `sign-in/social`, OAuth
  callbacks, emailed verify/reset GET links, and TOTP enable/verify.
- **Sessions:** server-side rows + an **HttpOnly, `SameSite=Lax`, `Secure`-in-prod cookie**
  (`gz.session_token`). One session type per user; storefront vs admin differ only by RBAC +
  routing. Policy is admin-tunable (expiry 7d, etc.). Authorization resolves **live per request**,
  so disabling/demoting a user bites immediately.
- **RBAC** (`src/lib/rbac/*`, `src/lib/auth/session.ts`): **role-only** (the legacy `users.role`
  enum was retired in migrations 0192/0193). Permissions are a **code registry** of
  `<module>:<action>` (~70 modules); the DB stores only grants + a per-user allow/deny overlay.
  Gates: `requireSession` (redirect), `requirePermission`/`requirePermissionAny`/`requireAdminArea`
  (**404** on deny so admin routes stay undiscoverable), `requireSuperAdmin` (`*` step-up for
  destructive ops). Escalation guards + a "last super-admin" floor prevent lockout.
- **External API keys** (`gz_live_…`, SHA-256 hashed): scoped (`<resource>:read|write` + coarse
  `read`/`write`/`full`), per-key rate-limited (120/min), and **re-checked each request against the
  key creator's *current* RBAC grants** (a demoted creator's key dies). **This is an ERP/data API,
  not a per-customer API** — a key sees *all* orders/customers; it can never be a storefront
  browser credential.
- **🔴 No CORS anywhere** in the codebase, and better-auth `trustedOrigins` only trusts
  `BETTER_AUTH_URL` + `NEXT_PUBLIC_SITE_URL` + an operator CSV. `/api/store/search` and `/api/track`
  are `requireFirstParty` (same-origin, explicitly "a speed-bump, not auth"). CSP keeps
  `'unsafe-inline'` on `script-src` for RSC hydration.

> **Consequence:** auth is built for a **same-origin** Next frontend. A **separate-origin** frontend
> hits three hard blockers — credential endpoints 404'd, `SameSite=Lax` cookie unusable
> cross-origin, and no CORS — and would need: new REST auth endpoints (or re-enabled disabled paths
> + re-homed guards), a CORS layer, `trustedOrigins` additions, and `SameSite=None;Secure` + CSRF
> tokens or a bearer/JWT scheme.

---

## 8. The purchase funnel — the deepest coupling

The most stateful, most tightly-coupled flow, and the single biggest backend-exposure gap.

```
[cookie gz.cart_token]                    [DB: carts + cart_items]
  addToCartAction (Server Action) → workflows.cart.add
        ▼
  CART (one row per guest-token OR per user; merged on login)
        │ applyCouponAction → gz.coupon cookie ; /promo/<slug> → gz.promo cookie
        ▼
  CHECKOUT  (RSC /checkout reads cart + live-reprices + resolves delivery/tax/member/credit;
             checkout-form.tsx is a client component)
        │ placeOrderFromCartAction / placeQuickOrderAction (Server Actions)
        ▼
  placeOrderWorkflow (src/workflows/order/place-order.ts, 1469 lines)
     • ONE tx: lock+clear cart (idempotency), insert order status=pending,
       race-safe stock decrement, settle store credit, atomic coupon burn
     • emits order.created   (NOT order.paid yet)
        ▼
  COD → pending→preparing→…→delivered (stamps paid_at)
  online → initiatePaymentWorkflow (zero-total settled without gateway; else store
           payment_reference, return redirectUrl)
        ▼  window.location.href = redirectUrl → gateway hosted page → customer pays
  THREE idempotent settlement paths (all re-verify against the gateway API, claim via
  webhook_events unique index so pending→paid happens exactly once):
     (a) RSC return page  /order/[id]?pay=return   (confirmPaymentWorkflow in-process)
     (b) REST webhook     POST /api/webhooks/{clictopay,flouci}
     (c) REST cron        POST /api/cron/payments  (reconcile, ~12 min)
```

Key facts a rebuild must honor:
- **Cart is server-side DB rows** keyed by `user_id` or the **`gz.cart_token` httpOnly cookie**
  (30-day). All 6 mutations are Server Actions; **no `/api/cart` exists.**
- **`cart_items.unit_price_cents` is frozen/stale** — fine only for the header count. Every
  displayed and charged price comes from a **live re-price** (`priceCartLinesLive()`,
  `src/lib/cart/live-lines.ts:49`). **A rebuild reading `unit_price_cents` directly would
  show/charge wrong prices.**
- **Checkout reads are pure RSC** (`/checkout/page.tsx`): no HTTP checkout/preview endpoint exists.
- **Payment is redirect + server-side verify** (no trusted push). ClicToPay + Flouci + COD; money
  is millimes; charges `amountDueCents` (total − applied credit).
- **🔴 The gateway return URL is origin-baked:** `initiatePaymentWorkflow` sets
  `returnUrl = ${resolvePublicOrigin()}/order/${id}?pay=return`, and that **RSC** performs
  settlement. `NEXT_PUBLIC_SITE_URL` / `BETTER_AUTH_URL` are **inlined at `next build`**. A split
  frontend must host a server route at that exact path (or expose `POST /orders/:id/confirm-payment`
  and re-point the returnUrl + rebuild + update the payment-provider console).
- **Reusable as-is:** the webhooks (`/api/webhooks/*`) and reconcile cron guarantee eventual
  settlement regardless of the UI.

---

## 9. The REST API contract (what's reusable as-is)

`route-catalog.ts` tiers every route. Enforcement (`enforce.ts`): a global `apiEnabled`
kill-switch → public-read toggle (per-IP limited, PII reads can never be made public) → scoped API
key. Standard envelope: `{ data }` / `{ error, code, fieldErrors? }`; workflow fail-codes map to
HTTP (`validation`→400, `conflict`/`out_of_stock`→409, `not_found`→404, `payment_unverified`→503).

**Bucket A — External / ERP data API** (key-gated; GET reads individually public-toggleable unless
PII): `/api/products` (+`[slug]`, `/attributes`), `/api/categories` (+`/attributes`), `/api/brands`,
`/api/collections`, `/api/attributes` (+`/values`), `/api/stock` (+`/movements` 🔒),
`/api/orders` (+`[id]`, `/status`, `/history`, `/refunds`, `/returns`, `/shipments`,
`/delivery-outcome` — all 🔒 PII, key-only), `/api/customers` (+`[id]`, `/loyalty` 🔒),
`/api/loyalty/movements` 🔒, `/api/warranty-claims` (+`[id]` 🔒), **`/api/content`** (headless chrome
bundle), `/api/blog` (+`[slug]`), `/api/reviews` (read-only). `content`/`blog`/`reviews` reads need
**no RBAC grant** (storefront-public). `POST /api/orders` is an **offline ERP/POS push**
(`createFromLines`, cash/bank_transfer/cod) — **not** the online storefront checkout.

**Bucket B — First-party** (same-origin + per-IP limit, no key): `/api/store/search` (FTS/trigram
autocomplete, tier-filtered for signed-in viewers), `/api/track` (funnel mirror, currently a no-op
sink).

**Bucket C — Admin JSON** (12 routes, session-cookie + `requirePermission`, writes add
`assertSameOrigin`): media browse/upload/import-url, metrics poll, CSV exports, demo seed/clear
(super-admin), one-time bootstrap. **Not** a reusable framework-agnostic API — tied to the Next
session.

**Bucket D — Auth:** `/api/auth/[...all]` (see §7 for the disabled set).
**Bucket E — Webhooks:** `/api/webhooks/{clictopay,flouci}` (no signature; order re-verified).
**Bucket F — Cron:** 12 routes behind `Bearer CRON_SECRET` (one `/dispatch` heartbeat runs all due
jobs).
**Bucket G — Health:** `/api/health`.

**Non-`/api` HTTP handlers a new frontend may keep/reuse:** `/cdn/[...path]` (media proxy),
`/feeds/[file]` (Merchant XML + OpenAI ACP JSON), `/sitemap.xml`, `/robots.txt`,
`/manifest.webmanifest`, `/llms.txt`, `/md/[...path]` (markdown twin), `/promo/[slug]` (sets promo
cookie), `/(documents)/facture/[id]` (customer fiscal receipt — RSC, UUID-bearer), admin CSV
exports.

> **There is no OpenAPI/Swagger.** The authoritative, runnable contract is the test suite —
> `external-api-contract.test.ts`, `route-invariants.test.ts`, `keyset-cursor.test.ts`,
> `public-gating.test.ts`, `content-public.test.ts`. **Treat these as the spec** and run them
> against any new endpoints. (External list endpoints use keyset cursors + a `rawCount` field.)

---

## 10. The storefront today (rebuild checklist)

Routes live under `src/app/(shop)/(shell)/`. Three nested layouts: root (`<html lang="fr-TN">` +
DB-driven theme CSS + SEO metadata), `(shop)` (thin maintenance gate + 404 boundary), `(shell)`
(chrome + all providers). **The shell assembles its chrome from ~15 RSC-direct backend reads in one
`Promise.all`** (categories, settings, footer/banners, cart summary, theme, trust badges, currency,
nav roots, user, business memberships) — zero HTTP.

- **One universal resolver** `[slug]/page.tsx` (1742 lines): redirect rule → smart collection →
  race(category|product|brand) → CMS page → 404. Categories, products, brands, and CMS pages share
  a flat `/<slug>` namespace.
- **One client listing component** `category-client.tsx` (3121 lines) does **all** filtering /
  sorting / faceting / pagination **client-side** over the full `baseProducts` array the RSC passes
  in — zero server calls. The server ships the entire scoped product set per request.
- **PDP** (`renderProductView`) is the heaviest surface: ~12 parallel reads, per-viewer draft +
  early-access gating, live per-variant promotion repricing, and a hand-built JSON-LD `@graph`.
- **No i18n library** — UI copy is hardcoded **French**, `<html lang="fr-TN">` is static, no locale
  routing, no RTL/Arabic path. **A multilingual rebuild is greenfield** (and needs backend schema
  work — see §13).
- **No cart drawer** — the cart is a full page at `/panier`; header icons are plain `<Link>`s.
- **Mandatory, contractual Kawn attribution** (`src/components/kawn-attribution.tsx`) renders in
  the footer of every public page and must be carried forward verbatim (no disable setting).
- Email/password auth uses Server Actions; **OAuth + 2FA** go through the better-auth client to
  `/api/auth/[...all]` (reusable HTTP).

**Rebuild data-flow matrix** (every surface is RSC-read + Server-Action-write today):

| Surface | Reads today | Writes today | Verdict |
|---|---|---|---|
| Shell chrome (nav/footer/cart badge) | RSC: categories, nav, settings, cart summary, theme | — | `/api/content` covers *some*; new REST for nav-composed/cart-count |
| Home `/` | RSC: `getHomeBlocks`+`resolveHomeBlocks` | — | **New REST** (home blocks) |
| Category/brand/collection/search listings | RSC (one big payload) | client-side filter | **New REST** (client facets reusable) |
| PDP | RSC (~12 reads, enriched DTO) | `addToCartAction`, quick-order, review | **New REST** (enriched read + cart + quick-order) |
| `/panier` cart | RSC: cart + live pricing + promo | cart + coupon actions | **New REST** (cart CRUD + coupon) |
| `/checkout` | RSC: cart, delivery, tax, credit, member | `placeOrderFromCartAction` | **New REST** (preview + place-order) |
| `/order/[id]`, `/verify` | RSC: `findOrderById` (UUID-bearer) | gateway controls | **New REST** (session/UUID order read) |
| `/account` (+ orders) | RSC: huge aggregation across ~10 modules | ~12 action modules | **New REST** (large) |
| `/favoris` + wishlist | RSC: cookie wishlist + products | wishlist actions | **New REST** |
| `/fidelite`, `/mes-credits` | RSC: loyalty/credit | loyalty / QR actions | **New REST** |
| `/blog/*` | RSC: blog service | comment actions | REST exists for reads (`/api/blog`); comments new |
| Auth cluster | RSC + client | email/pw actions; OAuth/2FA via `/api/auth` | **Mixed** — `/api/auth` reusable; email/pw new |
| `/pro/*`, `/parrainage` | RSC: business/referral | business / cercle actions | **New REST** |
| Legal/CMS pages | RSC: settings/CMS page blocks | — | **New REST** (page bodies) |

---

## 11. The DB-driven presentation layer (CMS / theme / settings)

This is the storefront's entire **configurability surface**, and it is the single largest REST gap.
Everything here is read at render time by **RSC importing `server-only` functions**. The one HTTP
escape hatch, `GET /api/content`, exposes only **site chrome + a public subset of settings** — it
does **not** expose the home-block layout, CMS page bodies, the composed mega-menu dropdowns,
category-grid banner targeting, showcase config, or per-entity FAQ.

- **Storage:** typed relational tables (`banners`, `nav_menus`/`nav_items`, `trust_badges`,
  `faqs`, `pages`) + a key/value **`site_settings`** store + **JSON block arrays** (`home.blocks`
  is a settings row; `pages.blocks` is a column; `nav_items.config` is jsonb).
- **Block builders:** home (20 block types) and pages (22 types) are ordered JSON instance arrays
  over a shared pure core (`src/lib/pages/block-model.ts`); legacy relational section tables are
  read-only fallback. Read+resolve is `getHomeBlocks`/`resolveHomeBlocks` and
  `getPageForRender`/`resolvePageBlocks` (batch media + per-block products).
- **Navigation:** flat menus (`listMainMenu`/`listFooterColumns` — **in** `/api/content`) vs the
  **composed mega-menu** (`getComposedNavRoots`, columns/blocks resolved against the live catalog —
  **not** in `/api/content`), both with dead-link pruning + redirect re-admission.
- **Theme:** `getThemeConfig` validates `theme.*` and `buildThemeCss()` emits
  `.storefront{--primary;--gold;--radius;--font-body}` injected as an inline `<style>` in the root
  layout; a pre-paint dark-mode `<script>` toggles `.dark`. **A new frontend gets the raw token
  values over `/api/content` but must reimplement the CSS-var injection, the `globals.css`
  token→utility mapping, favicon/OG resolution, and dark-mode logic.**

**What `/api/content` covers vs the gaps:**

| Presentation surface | In `/api/content`? | New-frontend need |
|---|---|---|
| Theme token *values*, public settings subset | ✅ | Reuse values; reimplement the CSS pipeline |
| Flat `main` menu, footer columns | ✅ | Reuse |
| Hero / header-strip / footer banners, trust badges, logo, currency | ✅ | Reuse (⚠️ verify footer/trust *appearance* keys are in the allow-list) |
| **Composed mega-menu dropdowns** | ❌ | **New REST** |
| **Home block layout** | ❌ | **New REST** |
| **CMS / legal / custom page bodies** | ❌ | **New REST** |
| **Category-grid banner targeting** | ❌ | **New REST** |
| **Showcase page config + pins** | ❌ | **New REST** |
| **Maison-explore footer nav** | ❌ | **New REST** |
| **Per-entity FAQ** (PDP/category/brand) | ❌ | **New REST** |

---

## 12. The admin back office

A large, mature, **deeply Next-coupled** back-office: **~107 `page.tsx` routes across 15 sections**
(system 26, catalog 21, cms 11, blog 10, orders 7, businesses 6, users 5, …), rendered as RSC that
read module `queries.ts`/`service.ts` **directly in-process**, with every mutation routed through
Server Actions. It is the **heaviest consumer of the Server-Action layer** — ~81% (161/199) of
action-importing components are admin. The REST layer is marginal here (12 `/api/admin/*` routes,
hit from ~6 `fetch` sites).

- Three-layer RBAC: layout (coarse area gate, 404 if no grant) → each page `requirePermission`
  (102/107) → each action re-checks server-side. Nav visibility is presentational only.
- Settings model: admin **writes** `site_settings` (via `workflows.cms.upsertSettingsBatch`); the
  storefront **reads** the same keys. So a replaced storefront still reads those keys; the settings
  *writer* stays with whatever owns the admin.
- Lists are **server-rendered HTML tables** with URL/keyset pagination (`@tanstack/react-table` is
  used in exactly **one** file). Forms are large multi-tab client forms persisting through one
  Server Action.

**Of the 83 action files, only ~19 are shared with the storefront; ~64 are admin-only.** This is
the scoping pivot: replacing **only the storefront** leaves the entire admin + its Server-Action +
RSC machinery untouched; replacing the **admin too** means building REST equivalents for
essentially all ~396 actions plus HTTP reads for ~100 pages — a 5–6× larger undertaking.

---

## 13. Integrations & infra

| Area | What | Frontend-replacement verdict |
|---|---|---|
| **Media** | SeaweedFS S3 + sharp (JPEG/webp/avif variants + détourage); served at same-origin `/cdn/[...path]` | **`/cdn` is reusable HTTP as-is.** But `next/image` optimization is lost (use `<picture>` over stored variants); URL-resolution is RSC (though `/api/*` JSON already returns resolved URLs). Upload is admin-only REST + a Server Action. `.original.*` keys are staff-gated. |
| **Email / mailing** | Provider-agnostic (Resend/SMTP/sendmail), durable `email_logs` queue, consent gate, RFC-8058 unsubscribe | **Backend-only, inherited as-is.** Only HTTP surface is `POST /api/unsubscribe/one-click`. Newsletter signup is a Server Action → needs a REST shim. `/se-desabonner` is a storefront page to rebuild. |
| **AI** | `generateText`/`embed` chokepoints (SSRF-guarded), content/product/review gen, ai-assign | **Backend-only**, driven by admin Server Actions. Storefront-facing surface = `GET /api/store/search` (first-party-gated). |
| **SEO / feeds** | feeds, llms.txt, robots, sitemap, md-twin (HTTP) + JSON-LD builders & `generateMetadata` (RSC) | HTTP routes **reusable**; **all JSON-LD + `<head>` metadata must be reimplemented** in the new frontend. |
| **Tracking / consent** | GTM/GA4/Meta Pixel + Consent Mode, `tokyo.consent` cookie, funnel `track()` | **Almost entirely client React → reimplement.** `/api/track` is a first-party-gated **no-op sink** today. To keep server+email consent agreeing, reproduce the `tokyo.consent` cookie contract. |
| **Cron / jobs** | one `/api/cron/dispatch` heartbeat (external scheduler) runs 12 jobs; internal boot timers | **Backend-only, inherited as-is.** Requires the Next process to stay alive. |
| **UI component library** | `src/components/ui` = **7 files** (minimal shadcn subset); ~121 component files total; `globals.css` 1137 lines | **A new frontend inherits NONE of the React components — total rebuild.** Portable only as raw design tokens / theme CSS. |
| **Deploy** | multi-stage Dockerfile (webpack standalone), entrypoint migrations + secret bootstrap, compose: app/postgres(pgvector)/seaweedfs/pgbouncer | Backend infra **inherited as-is**. `proxy.ts` edge logic (admin/account gate, md negotiation) is Next-specific → reimplement. Several env vars are **baked at `next build`** → a runtime/origin change needs a rebuild. |

---

## 14. The replaceability map

Every storefront capability sorted into the three migration verdicts.

### ✅ Reusable as-is over HTTP (framework-agnostic today)

- **Catalog reads:** `/api/products` (+slug/attributes), `/api/categories`, `/api/brands`,
  `/api/collections`, `/api/attributes`, `/api/stock` — key-gated, GET public-toggleable.
  ⚠️ These are **ERP-shaped / thinner** than storefront DTOs (no live promo enrichment, early-access
  gating, warranty cascade) — a storefront PDP/grid likely needs enriched endpoints.
- **Content/editorial:** `GET /api/content` (chrome bundle + public settings), `/api/blog`
  (+slug), `/api/reviews` (read-only).
- **Search:** `GET /api/store/search` — ⚠️ **same-origin-gated** (cross-origin needs the gate
  relaxed or a key-gated equivalent; loses tier-gated results without session).
- **Media:** `GET /cdn/[...path]` + the resolved URLs already embedded in `/api/*` JSON.
- **Auth (partial):** session read, social sign-in, OAuth callbacks, emailed links, TOTP card.
- **Backend-owned infra:** payment webhooks, reconcile cron, feeds/robots/llms/sitemap/md,
  `/promo/[slug]`, outbound ERP webhooks.
- **Warranty writes** are already REST-only (`/api/warranty-claims`).

### 🟡 Must build a new REST shim (logic exists in workflows; only the HTTP layer is missing)

The repo's own API notes recommend exactly this — thin `/api/store/*` routes wrapping
`workflows.{cart,order,promotion,auth}`. **This is wrapping, not reimplementation** — but each shim
must re-home the action-level concerns (session/actor resolution, rate limiting, cookie/cache
handling). The build list:

1. **Cart** — `GET /cart` (lines + **live pricing** + applied promo + credit balance), `POST/PATCH/
   DELETE /cart/items`, by-slug add/remove, merge-on-login. (No `/api/cart` exists.)
2. **Coupon** — `POST`/`DELETE /cart/coupon` (today cookie-based `gz.coupon`/`gz.promo`).
3. **Checkout preview** — `GET /checkout/preview` (priced cart + delivery options + tax + member +
   credit) — the largest single read-side gap (pure RSC today).
4. **Place order** — `POST /orders` + `POST /orders/quick` returning `{orderId, orderNumber,
   redirectUrl?}`; `POST /orders/:id/resume-payment`, `POST /orders/:id/cancel`. ⚠️ Decide the
   **gateway return-URL** strategy (see §8).
5. **Customer order read** — session/UUID-bearer `GET /orders/:id` + my-orders list (the ERP
   `/api/orders` is key-gated PII, unusable per-session).
6. **Account self-service** — profile, addresses, set-default, email/password change.
7. **Auth (email/password)** — signup, signin, 2FA step, password-reset request/consume (the
   better-auth HTTP paths are disabled; see §7).
8. **Wishlist** — toggle, get-slugs (guest-merge), public-favorites.
9. **Review submission** and **blog comments**.
10. **Newsletter subscribe**; **gift-card redeem**; **loyalty mode / Cercle invites / life-stage**;
    **appointments** (book + availability + cancel); **B2B /pro portal**.
11. **CMS/presentation reads:** home blocks, CMS page bodies, composed mega-menu, category-grid
    banners, showcase config, per-entity FAQ, maison-explore nav (see §11).
12. **Per-session wallet/loyalty reads:** credit balance + history, loyalty tier.

### 🔴 Must be rebuilt in the new stack (no backend reuse)

- The entire **React component library** (ui kit, storefront + admin components, the one hook),
  **theme CSS pipeline**, **JSON-LD + `<head>` metadata**, **tracking/consent client UX**, and the
  **`proxy.ts` edge logic** (admin gate, markdown negotiation).
- **i18n/RTL** if desired — **and this requires backend schema work**: there are **no translation
  columns** on products/categories/CMS/pages (only a `lang` tag on reviews). Multilingual is *not*
  a frontend-only change.
- **Customer-generated media** (review photos, warranty attachments) — **no upload path exists**;
  net-new backend.

---

## 15. The decisions that gate the plan

These three answers change the scope by multiples. **Make them before sizing the work.**

**(A) Is the admin in scope, or storefront-only?**
"Completely replace the frontend" taken literally includes the admin. But the admin is ~107 pages +
~342 admin-only actions with essentially **no REST**, so including it multiplies the shim surface
~5–6×. Storefront-only is dramatically cheaper and leaves a working back-office in place.

**(B) Same-origin or separate-origin?**
- **Same-origin** (new frontend served behind the same domain — e.g. another SSR framework, or an
  SPA reverse-proxied under the same host): cookies, CSRF, `requireFirstParty`, and most of auth
  **keep working** with minimal change. Strongly the lower-risk path.
- **Separate-origin** (distinct app/SPA/mobile origin): requires a **new CORS layer**,
  `trustedOrigins` additions, `SameSite=None;Secure` + CSRF tokens or a **bearer/JWT** scheme, a
  cart/wishlist/consent **token** scheme (today those are httpOnly cookies), relaxing the
  first-party gate, and re-enabling or re-shimming the disabled auth endpoints.

**(C) Keep the Next app as the HTTP backend host, or extract fully?**
Retaining the Next process as the backend host is strongly recommended: it keeps `/cdn`, feeds,
sitemap, `md`, `/api/*`, webhooks, cron, and the **boot-time subscriber registration + internal
timers** (`instrumentation.ts`) alive. If the Next process is removed, all of those must be
re-hosted — and the event subscribers/cron that drive emails, audit, webhooks, loyalty, and cache
invalidation would silently stop.

**(D) Is multilingual/RTL a goal?** If yes, scope backend schema work (translation
columns/tables) — it contradicts "backend untouched."

---

## 16. Recommended migration strategy

The lowest-risk, highest-reuse path, consistent with "keep the backend":

1. **Keep the Next app as the backend host** (decision C = retain). It continues to serve the
   REST API, `/cdn`, feeds, webhooks, cron, and the boot subscribers/timers.
2. **Add a thin customer-facing "store BFF" REST namespace** (e.g. `/api/store/*`) that wraps the
   existing `workflows.*` and `lib/api/*`/module `queries.ts` — the [§14 🟡 build list]. Re-home the
   action-level concerns (session/actor resolution via the existing `session.ts` guards, rate
   limiting via `lib/rate-limit.ts`, cookie/cache handling) into these handlers. Reuse the existing
   workflow error-code → HTTP-status mapping. Treat the contract tests as the spec and extend them.
3. **Prefer same-origin for the new storefront** (decision B) so cookies/CSRF/first-party gates keep
   working. If separate-origin is required, budget the CORS + `SameSite=None` + token-scheme +
   auth-endpoint work explicitly up front.
4. **Keep the admin on Next** unless it is explicitly in scope (decision A). If it must be replaced,
   plan a second, much larger phase that REST-exposes the ~396 actions + ~100 page reads.
5. **Rebuild the presentation layer** (components, theme CSS pipeline, JSON-LD/metadata,
   tracking/consent) in the new stack, reproducing the `tokyo.consent` cookie contract and the
   mandatory Kawn footer attribution.
6. **Decide the payment return-URL strategy early** (host a route at `/order/[id]?pay=return` that
   confirms, or add `POST /orders/:id/confirm-payment` + re-point + rebuild). The webhooks/cron
   provide a settlement safety net regardless.
7. **Validate** against the existing contract tests + a field-by-field diff of each new store
   endpoint vs the RSC DTO it replaces (the known-unverified "read parity" question).

---

## 17. Risks, gotchas & sharp edges

- **Live-pricing parity:** never read `cart_items.unit_price_cents` for display/charge — always the
  live re-price (`priceCartLinesLive`), kept in sync with place-order.
- **Enriched vs ERP read shapes:** `/api/products` excludes live promotions + early-access gating
  that the storefront PDP needs — don't assume the ERP read drives a storefront page.
- **Origin baking:** `NEXT_PUBLIC_SITE_URL`, `BETTER_AUTH_URL`, `S3_PUBLIC_URL`, `MEDIA_CDN_URL`,
  `CSP_EXTRA_HOSTS` are inlined at `next build`; changing the origin needs a rebuild + OAuth/payment
  console updates.
- **Rate-limit IP collapse:** the DB-backed limiter keys on the **last** `X-Forwarded-For` hop and
  **fails open** on DB error — a BFF/proxy must forward XFF exactly or all clients collapse to one IP
  and per-user throttles (auth/cart/review/order) break.
- **Cache loss:** `revalidatePath`/`revalidateTag`/`'use cache'` and `next/image` are Next-only; a
  non-Next frontend must own its caching/ISR and image optimization.
- **Media orphan sweep:** any new content-writing path with inline images must stay lock-step with
  the media reference-matchers, or the reclaim sweep will delete in-use images.
- **Fiscal receipt:** `/(documents)/facture/[id]` is a legally-required printable receipt (RSC,
  UUID-bearer) — reimplement or keep as a Next route.
- **The Kawn footer attribution is contractual** and non-removable.

---

## Appendix A — counts & doc drift

Reconciled against current code (the critic re-counted where investigators disagreed). **The repo
docs' inventory numbers have drifted; structural claims still hold.** Treat any count in the docs as
a lead to grep, not a fact.

| Metric | Current (code) | Stale doc value |
|---|---|---|
| Migrations | **202** (`0000`+`0001..0201`) | `REQUIREMENTS.md` says 0138/next-0139; `modules.md` next-0140 |
| `app/api` route files | **60** (+8 non-`/api` handlers) | `architecture.md` "52 files" |
| `'use server'` files | **83** (all in `src/lib/actions`) | `architecture.md` "70" |
| Exported `*Action` fns | **~396** (grep); generated catalog ~394 | `API.md` "~324" in one place |
| Module folders | **~44** | `architecture.md` "39" |
| Workflow functions | **177** (~30 namespaces) | — |
| Events / subscribers | **227** / **40** | `architecture.md` "subscribers 37" |
| DB tables | **135** | — |
| `server-only` files | **762** | — |
| `'use client'` files | **290** | — |

**Other drift found:** `docs/security.md` still claims the `users.role='admin'→'*'` bridge is live
(retired in 0192/0193 — authz is role-only); `docs/cms-content-model.md`'s summary table frames
pages as relational sections (now the `pages.blocks` JSON composer; sections are read-only legacy).

---

## Appendix B — one-paragraph answer to "can I keep the backend and replace the frontend?"

**Yes — the backend is cleanly reusable, because its value lives in framework-agnostic
`workflows/*` + `modules/*` + `lib/*` + the DB, and the existing REST routes already wrap those
workflows.** The catch is that *today* the frontend reaches that backend almost entirely through two
**Next-only** transports (RSC direct imports for reads, Server Actions for writes), and the one
framework-agnostic transport (REST) is an **ERP/integration + headless-content** API, not a
customer storefront API. So "keeping the backend" in practice means **building a new customer-facing
REST layer (thin shims over existing workflows/queries) for the entire transactional + account +
CMS-presentation surface**, keeping the Next process alive as the backend host, and choosing
**same-origin** to avoid the auth/CORS/cookie cliff. Do that, and the new frontend inherits the
whole domain engine — orders, payments, loyalty, emails, audit, webhooks, search, media — unchanged.
