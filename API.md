# API surface

The `/api/*` endpoints exposed by the app. They fall in five buckets:

> **The external data API is wider than the products/categories/brands/
> attributes/stock examples below.** It also includes the ERP **orders** read +
> push surface (order push, status, shipments, returns, refunds — key-ONLY, see
> Orders), the ERP **customers** + stock **movement** feeds (key-ONLY) and
> the read-only **headless content** surface (`/api/content`, `/api/blog`,
> `/api/reviews`).
> [route-catalog.ts](src/lib/api-auth/route-catalog.ts) is the authoritative list.

1. **Auth** (`/api/auth/*`) — handled by Better Auth's catch-all route.
2. **External data API** (`/api/products`, `/api/categories`, `/api/brands`,
   `/api/attributes`, `/api/stock`, `/api/orders`, `/api/customers`, …) — a
   **key-gated CRUD surface** for ERP / external consumers. Reads need a scoped
   API key unless an admin opts the specific route public; writes always need a
   key. Plus first-party same-origin helpers (`/api/store/search`,
   `/api/track`), the public liveness/readiness probe (`/api/health`) and the
   RFC 8058 one-click unsubscribe target (`/api/unsubscribe/one-click`, HMAC
   token in the URL — the `List-Unsubscribe` target of marketing mail; POST opts
   out and answers 200 even for an invalid token (500 only when a genuine opt-out
   fails), GET never unsubscribes and 303s to
   `/se-desabonner?token=`).
3. **Admin API** (`/api/admin/*`) — JSON endpoints behind a per-module
   `requirePermission(module, action)` guard (store-wide destructive ops add the
   super-admin `*` step-up — `checkSuperAdmin` / `requireSuperAdmin`,
   [src/lib/auth/super-admin.ts](src/lib/auth/super-admin.ts)).
4. **Webhooks** (`/api/webhooks/*`) — callbacks from payment gateways.
5. **Ops** (`/api/cron/retention`, `/api/cron/mailing`, `/api/cron/birthday`,
   `/api/cron/review-request`, `/api/cron/payments`, `/api/cron/abandoned-orders`,
   `/api/cron/webhooks`) — secret-gated scheduled jobs.

The **authoritative inventory** of every `/api/*` route — its tier, domain, and
(for the external API) the scope it requires — lives in
[src/lib/api-auth/route-catalog.ts](src/lib/api-auth/route-catalog.ts). That
file drives the admin route-inventory tab, the per-route public toggle, and
request enforcement, so it never drifts from the handlers. This document is a
prose companion; the catalog is the source of truth.

A few **public** HTTP endpoints sit **outside** `/api/*` (no key/scope
enforcement) and are registered in the inventory under `APP_ROUTE_HANDLERS`
(`cdn.proxy`, `feeds.products`, `agents.markdown`, `promo.url`; the same array
also lists the session-gated admin CSV exports `admin.orders.export` /
`admin.audit.export`, see [Customer exports](#customer-exports--csv-downloads)):

**Media proxy** — `GET/HEAD /cdn/<...path>`
([src/app/cdn/[...path]/route.ts](src/app/cdn/[...path]/route.ts)). It relays a
public S3 object through the app origin (so `next/image` can fetch +
transcode it and CSP only needs `img-src 'self'`). No auth, no presigning —
public objects only. Path traversal is rejected (segments may not start with
`.`, contain `..`, or NUL). A successful body (200–206 / 304) gets a 1-year
`immutable` cache (storage keys are random-UUID-prefixed, so a key never changes
meaning); any error status is `no-store` so a transient 403/503 can't become a
permanently-broken image. Upstream failures return a generic **502** (the raw
error would leak the internal object-store hostname). Kept originals
(`<base>.original.<ext>`) are staff-only: **404** for anonymous callers,
`private, no-store` for a session holding `media:view`.

**Product feeds** — `GET /feeds/<filename>`
([src/app/feeds/[file]/route.ts](src/app/feeds/[file]/route.ts), ISR
`revalidate=1800`). Serves the **Google Merchant** RSS 2.0 XML or the **OpenAI
Agentic-Commerce-Protocol** JSON, selected by matching `<filename>` against the
admin-configured + **enabled** paths in SEO → Flux (a disabled/unknown filename →
404). Both feeds default **OFF**. Public + `X-Robots-Tag: noindex`, sitemap-
excluded. Settings: `seo.feed_google_enabled`/`seo.feed_google_path`,
`seo.feed_acp_enabled`/`seo.feed_acp_path`, `seo.feed_seller_name`,
`seo.feed_store_country`, `seo.feed_target_countries`,
`seo.feed_return_policy_url`, `seo.feed_privacy_url`, `seo.feed_tos_url`. The feed
exposes the SAME published catalogue as `/api/products`, mapped once per ISR
window. While the store is in maintenance / coming-soon (`site.mode`) every feed
returns 404.

**Markdown for Agents** — `GET /md/<...path>`
([src/app/md/[...path]/route.ts](src/app/md/[...path]/route.ts),
`force-dynamic`). Clean Markdown twins of content pages for AI agents. Not hit
directly: the edge proxy ([src/proxy.ts](src/proxy.ts)) rewrites a markdown-
shaped storefront request (a `.md` suffix OR `Accept: text/markdown`) here; a
normal browser (`Accept: text/html`) is never matched. Toggle
`seo.markdown_agents_enabled` (default **ON**; off → 404). Every response carries
`Content-Type: text/markdown`, `Vary: Accept`, `X-Robots-Tag: noindex`, and (on
success) `x-markdown-tokens` + `Link: <canonical-html-url>; rel="canonical"`.
Generated from the SAME data layer as the pages (never scrapes HTML),
`noindex` + sitemap-excluded. Twins follow the HTML page's rules: prices
include live promotions like the PDP, `/parent/sub` is validated like the page,
and the frontmatter `url` + `Link` use the page canonical (`canonical_url`
override, flat `/sub`). Anonymous responses are cacheable
(`public, max-age=300, s-maxage=900`); signed-in ones are `private, no-store`.
During maintenance / coming-soon every twin 404s (staff bypass).

**Promo URL** — `GET /promo/<slug>`
([src/app/promo/[slug]/route.ts](src/app/promo/[slug]/route.ts)). A route handler,
not a page: it honours an admin redirect first, then, for a LIVE `url`-trigger
promotion, sets the httpOnly `gz.promo` cookie (a lookup key only; cart, checkout
and quick-buy re-validate the promotion) and 307s to `/`. An unknown or expired
slug redirects to `/` without a cookie.

---

## Auth — `/api/auth/*`

Provided by Better Auth via the catch-all handler at
[src/app/api/auth/[...all]/route.ts](src/app/api/auth/[...all]/route.ts).

What stays reachable over HTTP:

| Method | Path                                | Body                                                | Notes                                          |
| ------ | ----------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| GET    | `/api/auth/get-session`             | —                                                   | Returns `{ user, session }` or `null`          |
| POST   | `/api/auth/sign-out`                | —                                                   | Clears session                                 |
| POST   | `/api/auth/sign-in/social`          | `{ provider, callbackURL }`                         | Google / Facebook — only while the provider is enabled (`auth.social.<provider>_enabled` registers or drops the provider itself) |
| GET/POST | `/api/auth/callback/<provider>`   | —                                                   | OAuth return. A failed callback lands on `/login?from=<dest>&error=<code>` |
| GET    | `/api/auth/verify-email?token=…&callbackURL=…` | —                                        | Emailed link: marks the email verified, then redirects to `/verify-email?confirmed=1` (success, `?error=` or incomplete state) |
| GET    | `/api/auth/reset-password/:token`   | —                                                   | Emailed reset / invitation link (redirects to the reset page) |
| POST   | `/api/auth/two-factor/enable`       | `{ password }`                                      | Opt-in 2FA — returns `{ totpURI, backupCodes }` (flag flips only after verify). Refused (400) while 2FA is already on — disable first |
| POST   | `/api/auth/two-factor/verify-totp`  | `{ code }`                                          | Confirm enrolment / complete a 2FA sign-in     |
| POST   | `/api/auth/two-factor/disable`      | `{ password }`                                      | Turn 2FA off                                   |

**Disabled over HTTP (404 — in-process only).** The credential endpoints are
listed in `disabledPaths` (`AUTH_HTTP_DISABLED_PATHS`,
[src/lib/auth/policy.ts](src/lib/auth/policy.ts)): `sign-in/email`,
`sign-up/email`, `request-password-reset`, `POST reset-password`,
`send-verification-email`, `change-password`, `change-email`, `update-user`,
`delete-user`, `verify-password`, `two-factor/verify-backup-code`,
`two-factor/generate-backup-codes`, `two-factor/get-totp-uri`,
`two-factor/send-otp`, `two-factor/verify-otp`. The app reaches them only through
server actions → `workflows.auth.*` ([src/workflows/auth/](src/workflows/auth)),
which call Better Auth's server API (`auth.api.*` from
[src/lib/auth/server.ts](src/lib/auth/server.ts)) in-process and add what the raw
endpoints lack: Postgres per-IP + per-account throttles, audit events and the
signup invariants (customer profile + link). Session cookie: `gz.session_token`.

The `two-factor/*` routes come from the Better Auth `twoFactor` plugin (opt-in
TOTP). Self-service enable / disable (and the in-process change-password) are
audited server-side by Better Auth hooks, direct HTTP calls included. A direct
HTTP `two-factor/verify-totp` draws from the SAME per-challenge bucket as the
`/login/2fa` server action (8 attempts / 15 min, keyed on the signed challenge
cookie). The route rewrites `X-Forwarded-For` to the trusted client IP
(`getClientIp`) before Better Auth's own limiter runs — see
[docs/security.md](docs/security.md).

---

## Health — `/api/health`

```
GET /api/health            # liveness
GET /api/health?ready=1    # readiness
```

Liveness returns `{ status: "ok", uptime, timestamp }` with `Cache-Control:
no-store` and never touches env or the DB (the container HEALTHCHECK / Coolify
probe). `?ready=1` is an opt-in readiness probe for monitoring: it also validates
the server env and runs `SELECT 1` (2 s timeout), answering `{ status, uptime,
timestamp, checks: { env, db } }` — **503** + `status: "not-ready"` when either
fails. Booleans only (the route is public); the result is cached ~5 s and
concurrent probes share one check.

---

## External data API — `/api/products`, `/api/categories`, `/api/brands`, `/api/attributes`, `/api/stock`

A **key-gated CRUD API** for ERP / external integrations (catalogue sync,
warehouse stock, partner feeds). It is **not** public read-only and it is
**not** the storefront's render path — Server Components call
`src/lib/api/products.ts` / `categories.ts` / `brands.ts` directly. The write
endpoints are thin wrappers over the **same admin workflows** the dashboard
uses (the actor is the API key's owner), so validation, dedup (sku/gtin/
externalRef collisions → 409), the audit log, and cache invalidation all fire.

### Auth model

Every external route runs `enforceExternalApi(request, "<routeId>")` first
([src/lib/api-auth/enforce.ts](src/lib/api-auth/enforce.ts)), which fails
**closed**:

1. **Global kill-switch.** When the external API is disabled
   (`apiSettings.apiEnabled === false`), **nothing** passes — not a valid key,
   not a public route → **503** `{ error: "L'API externe est désactivée." }`.
   It fails **closed**: a settings-read error also answers 503 (not cached, so
   the next request retries).
2. **Reads** require a scoped key **by default**. An admin may opt an
   individual *read* route public (`apiSettings.publicRoutes`, default empty —
   the toggle list is `TOGGLEABLE_PUBLIC_ROUTES`, the read routes flagged
   `canBePublic`; PII-bearing reads — orders, customers, the stock
   movement feeds — are key-ONLY and excluded). A public read needs no key but
   is per-IP rate-limited. **A caller that presents a key on a public route is
   served the keyed view** (drafts, `externalRef`, no embargo, per-key rate
   limit): an invalid key is still a 401/403 there, never silently downgraded to
   the public view. Only a request with no credential (or a non-Bearer
   `Authorization`, e.g. a proxy's Basic auth) reads anonymously.
3. **Writes always require a key** — they can never be made public.

Credentials: `Authorization: Bearer <key>` **or** `X-API-Key: <key>`. A key
carries a set of scopes; a route declares the concrete scope it needs (see the
table). Scope grammar
([src/lib/api-auth/scopes.ts](src/lib/api-auth/scopes.ts)):

- per-resource `"<resource>:<action>"` — e.g. `products:write`, `stock:read`;
- coarse `read` (any `:read`) · `write` (any `:read`+`:write`) · `full`
  (everything). `write` implies `read`.
- Resources: `products`, `categories`, `stock`, `brands`, `attributes`,
  `orders`, `customers` (read + write) and `content`, `blog`,
  `reviews` (**read-only** — no write route exists, so the key form offers only
  `:read` for them).

**A key never exceeds its creator's own admin permissions.** Each scope maps to
the dashboard grants that do the same thing (`SCOPE_RBAC`): e.g. `customers:read`
needs Clients → voir (`customers:view`), `orders:write` needs Commandes → gérer
(`orders:manage`), and the coarse `write` / `full` need the super-admin `*`. The
bound is checked when the key is minted AND on every request against the
creator's CURRENT permissions: once the creator is demoted, loses the role or is
disabled, the key answers **403** « Le créateur de cette clé ne dispose plus de
ce droit. » on the out-of-grant scopes (logged as `api_key.auth_failed`, reason
`scope`). The key list shows « Créée par » — mint ERP keys under a service
account that keeps its grants.

Error contract:

| Status | When                                                                              |
| ------ | --------------------------------------------------------------------------------- |
| 503    | External API disabled (kill-switch, or its settings unreadable), `Cache-Control: no-store` |
| 503    | `payment_unverified` — cancelling a pending online order while the gateway can't be reached; retry later |
| 401    | Missing/blank key on a non-public route — **`WWW-Authenticate: Bearer`** header   |
| 401    | Invalid or expired key (never says which — no key-existence leak)                 |
| 403    | Valid key but wrong scope for the route                                           |
| 403    | « Le créateur de cette clé ne dispose plus de ce droit. » — the key's creator no longer holds the dashboard grant behind the scope |
| 403    | Write with a key not associated to any user (null actor → `requireApiActor`)      |
| 429    | Rate limit: **120/min per key**, or **60/min per IP** on a public read            |
| 400    | Malformed input (`validation`) — a non-UUID id (`22P02`), an unknown referenced entity (`23503`), an impossible date (`22007`/`22008`, e.g. `2025-02-30`), or a rejected attribute scalar/value, **never a 500**. Carries `fieldErrors` keyed by field when the workflow names one |
| 404    | Not-found — the referenced product/category/brand/order/customer does not exist  |
| 409    | Current-state conflict — a duplicate sku/gtin/externalRef (`conflict`); an `in_use` delete (an attribute still bound to a variant/facet/tax rule); a category/brand delete while live promotions target it; an illegal order status jump (`invalid_transition`); → refunded with no refund recorded (`refund_required`); an ERP re-link (`already_linked`, `external_ref_conflict`); a variable→simple demotion while live variants exist (`has_variants`); fulfilment refusals (`invalid_status`, `exceeds_remaining`, `not_paid`, `fully_refunded`); order-push stock/availability (`out_of_stock`, `product_unavailable`, `promotion_expired`); DB contention (deadlock / lock timeout — retry) |
| 422    | Well-formed but unprocessable order push — `empty_cart`, `min_order`, `min_purchase_qty`, `max_purchase_qty`, `account_required`, `delivery_unavailable` (fix the payload) |

Foreseeable bad input never surfaces a 500: the shared `workflow()` catch maps
`22P02`/`22007`/`22008`/`23503` to 400 and `23505` to 409, the DELETE routes
UUID-guard the id before the lookup, and every routine business rejection has a
4xx mapping (`workflowErrorStatus` in
[enforce.ts](src/lib/api-auth/enforce.ts); a test fails if a new fail code
reachable from an external route is left unmapped). An ERP gets a clean
`{ error, code, fieldErrors? }` body it can act on.

**Caching.** Keyed reads are `private, no-store` (by-reference lookups
`no-store`). A public read sets a short shareable cache: category tree/list,
brands, attributes and the headless content `s-maxage=300, swr=600`, reviews
`s-maxage=120, swr=300`, by-reference lookups `private, max-age=0`. Public
**product** list and `/api/products/[slug]` may return a per-viewer body, so they answer `public, s-maxage=60, swr=300` only when the
request carries no storefront session cookie and `private, no-store` when it does
— with `Vary: Cookie` on both. Keyed (trusted) callers may read **drafts /
inactive** rows so an ERP can create-then-verify; public callers see only
published/active, non-embargoed rows (404 otherwise), and `externalRef` is
stripped from public product reads.

A product read (`GET /api/products`, by-ref or list, and `GET
/api/products/[slug]`) returns the storefront `Product` DTO PLUS the uuid `id`,
`externalRef`, `stockQty`, and the per-product purchase-qty limits
`minPurchaseQty` / `maxPurchaseQty` (both `null` = no limit; `maxPurchaseQty: 1`
= sold individually; enforced at add-to-cart, set-quantity, and order placement —
the order gate aggregates the qty PER PRODUCT across variant lines)
(`ApiProduct`, [src/lib/api/products.ts](src/lib/api/products.ts)).
`minPurchaseQty` / `maxPurchaseQty` are also **writable** on create/update
(POST/PUT/PATCH); each must be a positive integer with `max ≥ min`.
For a **variable** product it additionally exposes `variants[]` — each with `id`,
`label`, `sku`, `priceCents`, `oldPriceCents`, `inStock`, `stockQty`, `isDefault`,
`optionValueIds`, `image` and `imageAlt` — plus `variantOptions[]` (the picker
axes). This is intended ERP exposure: a headless / ERP client needs each child
variant's SKU + stock to sync inventory back to the parent product.

**Price contract.** Every product read (list, `/api/products/[slug]`, and the
`?sku=` / `?gtin=` / `?externalRef=` lookups) returns the SAME **effective**
public price: `priceCents` / `oldPriceCents` (and `variants[].priceCents`) include
live automatic promotions — what a shopper pays right now. `basePriceCents` /
`baseOldPriceCents` carry the **stored** product price (the value POST/PUT/PATCH
`priceCents` / `oldPriceCents` write). Compare and round-trip those, never the
promo-lowered `priceCents`.

The DTO also carries the per-product **SEO overrides**: `metaTitle`,
`metaDescription`, `canonicalUrl`, `noindex`, `ogImage`, and `sameAs[]` — the
official external URLs (validated absolute http(s)) for the product. `sameAs` is
**writable** on create/update (POST/PUT/PATCH) as free text, one URL per line.
Note the read API returns `sameAs[]` regardless of the `seo.product_sameas_enabled`
admin switch — that switch only gates the storefront `Product.sameAs` JSON-LD
emission, not this data field.

### Route surface (scope in parentheses)

Enumerated from [route-catalog.ts](src/lib/api-auth/route-catalog.ts). All
read routes EXCEPT the PII-bearing ones (orders, customers, the stock
movement feeds — key-ONLY) are public-toggleable; all write routes always
require a key.

**Products** (`/api/products`)

| Method | Path                              | Scope            | Notes                                                              |
| ------ | --------------------------------- | ---------------- | ------------------------------------------------------------------ |
| GET    | `/api/products`                   | `products:read`  | List, OR look up by ref `?sku=` / `?gtin=` / `?externalRef=`; else `?category=<slug>` (`[a-z0-9-]`, 400 on garbage), `?limit=1–100` (24), `?offset≥0`. → `{ products, pagination: { limit, offset, count, rawCount, nextOffset } }`. **Page with `offset = nextOffset`** (= offset + rawCount; `null` once the catalogue ends) — never stop on `count < limit`: a public page can come back thinned or even empty mid-catalogue (the public published/active filter). `rawCount` = rows the page consumed before that filter (keyed callers: `rawCount === count`). |
| GET    | `/api/products/[slug]`            | `products:read`  | One product by slug → `{ product }` or 404.                        |
| POST   | `/api/products`                   | `products:write` | Create → `createProduct` workflow (201).                           |
| PUT    | `/api/products`                   | `products:write` | Upsert by reference (`matchBy: externalRef \| sku \| gtin`).       |
| PATCH  | `/api/products`                   | `products:write` | Update (`productId` in body); sparse — only sent keys apply.       |
| DELETE | `/api/products`                   | `products:write` | Archive by `productId \| externalRef \| sku \| gtin` (query or body). Also releases, in the same transaction, the product's variants (soft-deleted, SKU/GTIN freed, stock 0), its per-location stock levels, and its attribute-value assignments. |
| GET    | `/api/products/[slug]/attributes` | `products:read`  | Assigned attribute value ids + number/text scalars (`?by=slug\|sku\|gtin\|externalRef\|id`). |
| PUT    | `/api/products/[slug]/attributes` | `products:write` | Replace `attributeValueIds` and/or set `attributeScalars`. Values of an INACTIVE (non-deleted) attribute are accepted; an unknown or soft-deleted value id → 400 « Valeur d'attribut inconnue : <id>. » |

Product write rules (POST / PUT / PATCH):

- `stockQty: null` = untracked (clears a tracked quantity). A `stockQty` sent
  without `inStock` re-derives availability by the shared sold-out rule (see
  Stock below). Optional `expectedStockQty` enables compare-and-set: if the
  committed `stock_qty` differs, the write is refused with 409 `conflict`
  (`fieldErrors.stockQty`).
- A `productType: "variable"` product cannot be published without at least one
  live variant: a create with `productType: "variable"` + `publish: true`, or an
  update that sends `productType` / `publish` and leaves the product published +
  variable with no live variant, → 400 (`fieldErrors.productType`). Create it as
  a draft, add variants in the admin « Variantes » tab, then publish. Demoting to
  `simple` while live variants exist → 409 `has_variants`.
- `gtin` must be 8–14 digits when set or changed (400, `fieldErrors.gtin`); an
  unchanged legacy value is accepted.
- `brandId: null` removes the brand link; omit the key to leave it unchanged.
- `product.updated` fires only when something actually changed (see
  [WEBHOOKS.md](WEBHOOKS.md)).

**Categories** (`/api/categories`)

| Method | Path                                | Scope              | Notes                                                            |
| ------ | ----------------------------------- | ------------------ | ---------------------------------------------------------------- |
| GET    | `/api/categories`                   | `categories:read`  | Tree (default), `?flat=1` flat list, or by ref `?externalRef=`/`?slug=`/`?id=`. |
| POST   | `/api/categories`                   | `categories:write` | Create (201).                                                    |
| PUT    | `/api/categories`                   | `categories:write` | Upsert by reference (`matchBy: externalRef \| slug`).            |
| PATCH  | `/api/categories`                   | `categories:write` | Update (`categoryId` in body).                                   |
| DELETE | `/api/categories`                   | `categories:write` | Archive by `categoryId \| externalRef \| slug` (query or body).  |
| GET    | `/api/categories/[slug]/attributes` | `categories:read`  | Ordered filter-attribute ids for the category (`?by=slug\|externalRef\|id`). |
| PUT    | `/api/categories/[slug]/attributes` | `categories:write` | Replace the whole filter set (`attributeIds`).                   |

**Brands** (`/api/brands`)

| Method | Path           | Scope          | Notes                                                                       |
| ------ | -------------- | -------------- | --------------------------------------------------------------------------- |
| GET    | `/api/brands`  | `brands:read`  | List (`?search=`, `?limit=1–500` (200), `?offset`), or by ref `?externalRef=`/`?slug=`/`?id=`. |
| POST   | `/api/brands`  | `brands:write` | Create (201). Optional `taxRateBps` (POST/PUT/PATCH): brand-level TVA override in basis points, integer 0–10000 (1900 = 19 %); `null` clears it (inherit); out of range → 400. |
| PUT    | `/api/brands`  | `brands:write` | Upsert by reference (`matchBy: externalRef \| slug`).                       |
| PATCH  | `/api/brands`  | `brands:write` | Update (`brandId` in body).                                                 |
| DELETE | `/api/brands`  | `brands:write` | Archive by `brandId \| externalRef \| slug` (query or body).                |

**Attributes** (`/api/attributes`, `/api/attributes/values`)

| Method | Path                      | Scope              | Notes                                                       |
| ------ | ------------------------- | ------------------ | ----------------------------------------------------------- |
| GET    | `/api/attributes`         | `attributes:read`  | Active attributes + nested values (`?limit=1–500` (200), `?offset`). |
| POST   | `/api/attributes`         | `attributes:write` | Create an attribute (+ optional initial values) (201).      |
| PATCH  | `/api/attributes`         | `attributes:write` | Update an attribute (`attributeId` in body).                |
| DELETE | `/api/attributes`         | `attributes:write` | Archive an attribute (`id` in query or body).               |
| POST   | `/api/attributes/values`  | `attributes:write` | Create a value (`{ attributeId, label, slug?, displayOrder? }`) (201). |
| PATCH  | `/api/attributes/values`  | `attributes:write` | Update a value (`valueId` in body).                         |
| DELETE | `/api/attributes/values`  | `attributes:write` | Delete a value (`id` in query or body).                     |

**Stock** (`/api/stock`)

| Method | Path          | Scope          | Notes                                                                          |
| ------ | ------------- | -------------- | ------------------------------------------------------------------------------ |
| GET    | `/api/stock`  | `stock:read`   | View a product OR variant pool (`?productId\|externalRef\|sku\|gtin\|variantId\|variantSku`). |
| PATCH  | `/api/stock`  | `stock:write`  | `{ ref, stockDelta: ±N, note? }` atomic add/remove, OR `{ ref, stockQty?, inStock?, note? }` absolute set (`stockQty: null` = untracked). Race-safe SQL (composes with the order decrement), ledgered. A delta on an untracked line → 422; a removal below 0 → 409 `insufficient`; lock contention → 409 (retry). |

`stockQty` is always the cached TOTAL (sum across active locations); per-location
detail stays admin-only. Availability rules:

- **Sold-out rule.** Without `inStock`, a quantity write (delta or set)
  re-derives availability: a sold-out line (qty ≤ 0) is re-listed when the new
  qty > 0, a line reaching 0 is de-listed, and a line an operator deliberately
  delisted (`inStock: false` with units left) stays delisted. A first tracked
  quantity > 0 on an UNTRACKED line marked out of stock counts as a restock
  (re-listed). The response `inStock` is the value actually written. Same rule
  as the admin editors and the order restock
  ([in-stock-rule.ts](src/lib/inventory/in-stock-rule.ts)).
- **Shared-stock variable products.** A `variantId` / `variantSku` ref reads and
  writes the PARENT pool's quantity (`pool: true` in the view), but `inStock` is
  the variant's own flag: a PATCH `inStock` writes only that variant, and the
  reported `inStock` is `variant.in_stock && parent.in_stock`.
- **Events.** `product.restocked` fires when either the row (the pool) or the
  addressed variant becomes available. A decrease that crosses the low-stock
  threshold or reaches 0 raises the same `product.stock_low` /
  `product.stock_depleted` operator alerts as a sale (when the Alertes toggle is
  on).

**Orders — ERP two-way** (`/api/orders`). Order reads expose customer PII (name,
email, phone, shipping address, payment reference) so they are **key-ONLY** —
`canBePublic: false`, never eligible for the public toggle. The API reads orders +
all their sub-streams, **pushes new orders** (POST), and pushes fulfilment
(status/shipments/returns/refunds) — each write a thin wrapper over the same
workflow the dashboard uses.

| Method | Path                      | Scope          | Notes                                                                                          |
| ------ | ------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| GET    | `/api/orders`             | `orders:read`  | Incremental sync: `?status=`, `?since=` + `?sinceId=` (keyset on `updated_at, id`), `?limit=1–200` (50) → `{ orders, pagination: { limit, count, nextSince, nextId } }` (see [Incremental sync](#incremental-sync-keyset-cursors)). OR one order by `?externalRef=` / `?orderNumber=` → `{ orders: [0–1] }`. Key-ONLY. |
| POST   | `/api/orders`             | `orders:write` | **ERP/POS order push** → 201 `{ data: <order> }` — see [Order push](#order-push--post-apiorders) below. |
| GET    | `/api/orders/[id]`        | `orders:read`  | One order WITH its lines → `{ data }` or 404. Key-ONLY.                                         |
| PATCH  | `/api/orders/[id]/status` | `orders:write` | Push status + tracking `{ status?, paymentReference?, notes?, externalRef?, unlink? }` → `{ data: <order> }`. Same payment-method-aware state machine as the dashboard. `paymentReference` / `notes` are written ON the transition, so they require `status` (400 otherwise). ERP link (`externalRef` / `unlink`): see « External reference » below. |
| GET/POST | `/api/orders/[id]/shipments` | `orders:read/write` | GET: parcels (per-line `shippedQuantity`, `trackingRef`, per-parcel BL number). POST: create a parcel `{ lines, trackingRef?, deliveryMethod?, markShipped? }` (over-ship guard → 409 `exceeds_remaining`; 409 `conflict` once the refund ledger covers the order total). |
| GET/POST/PATCH | `/api/orders/[id]/returns` | `orders:read/write` | GET: returns + items. POST: open `{ items (or lines): [{orderItemId, quantity, conditionNote?}], reasonCode?, reason?, comment? }` — refused (400) when the order's goods never left the warehouse (e.g. marked `refunded` straight from `paid`). PATCH: `{ returnId, action: receive\|reject }` (receive = restock + ledger); `returnId` must be the uuid of a return of THIS order (404 otherwise, 400 when malformed). |
| POST | `/api/orders/[id]/delivery-outcome` | `orders:write` | Inbound external-livraison hook: report a failed delivery (parcel undelivered/returned) on a **shipped** order → opens a pending « retour d'expédition » (RTO) over the shipped lines. `{ reason? (shipment reason code), reasonText?, carrier?, trackingRef?, attempts?, restockable? (false = lost/written-off), lines? }`. Receiving that return (PATCH `/returns` `receive`) restocks + cancels the order. |
| GET/POST | `/api/orders/[id]/refunds` | `orders:read/write` | GET: refund ledger. POST: `{ amountCents, reason? }` — a positive integer (no negative/correcting entries), capped at the remaining refundable amount (409 `exceeds_remaining`; `not_paid` for an unsettled order — cancel it instead; `fully_refunded`). A full refund reverses promos and restocks only goods that never left the warehouse (judged from the history: status shipped/delivered, any BL, or any status-history row through shipped/delivered). |
| GET    | `/api/orders/[id]/history` | `orders:read`  | Status-change history (from/to transitions).                                                   |

`[id]` is the order uuid OR its `externalRef`; a uuid-shaped value that is not a
local id falls back to the `externalRef` lookup (an ERP keying its orders by its
own UUIDs still resolves). Order DTOs carry `userId` — the storefront account id
(`null` = guest), the join key shared with `ApiCustomer.userId`.

Status PATCH specifics: cancelling a PENDING online (Flouci / ClicToPay) order
first re-verifies the payment with the gateway — 409 `conflict` when a capture is
found or detected, or while the gateway still reports the session `pending` and
it was (re)initiated < 30 min ago (« Paiement en cours chez la banque … » — retry
later); 503 `payment_unverified` when the gateway can't be reached. An illegal
jump → 409 `invalid_transition`; → `refunded` with no refund on the ledger → 409
`refund_required`; cancelling once a parcel (BL) exists → 409 `conflict` (use a
return); forward transitions of a fully-refunded order whose goods never left →
409 `conflict` (only cancelled / refunded stay reachable).

**Customers — ERP sync** (`/api/customers`). PII → **key-ONLY** (`admin_notes`
never exposed). Registered profiles only (guests are order-derived — see
`/api/orders`). `ApiCustomer` carries `userId` — the linked storefront account
(`null` for a standalone profile, e.g. one the ERP created), the join key to the
order feeds.

| Method | Path                        | Scope             | Notes |
| ------ | --------------------------- | ----------------- | ----- |
| GET    | `/api/customers`            | `customers:read`  | Incremental sync (`?since=&sinceId=`, keyset on `updated_at, id`) → `{ customers, pagination: { limit, count, nextSince, nextId } }`, OR one by `?externalRef=`/`?email=`/`?phone=`. |
| POST/PUT/PATCH | `/api/customers`    | `customers:write` | POST create · PUT upsert (by `id`, falling back to `externalRef`; create-or-update) · PATCH update `{ externalRef\|id, firstName?, lastName?, phone?, marketingOptIn?, birthday? }`. `birthday` must be a real `YYYY-MM-DD` date (400, `fieldErrors.birthday`). **Linking** an existing storefront customer: `PUT { id, externalRef }` (ERP flow: `GET ?email=` → `id` → PUT). Re-sending the same ref is an idempotent no-op (no write, no event); a different ref on an already-linked profile → 409 `conflict` with `fieldErrors.externalRef = "already_linked"`; a ref owned by another customer → 409. |
| GET    | `/api/customers/[id]`       | `customers:read`  | Full profile + addresses (`[id]` = uuid or `externalRef`; a uuid-shaped non-local id falls back to `externalRef`). |

**Movements** (append-only ledgers, key-ONLY, incremental `?since=&sinceId=` on
`created_at, id`):

| Method | Path                     | Scope          | Notes |
| ------ | ------------------------ | -------------- | ----- |
| GET    | `/api/stock/movements`   | `stock:read`   | Stock ledger (`order\|cancellation\|refund\|return\|api_delta\|api_set\|admin`); filter by product ref / `?variantId`/`?orderId`/`?reason`. `return` rows of SHARED-pool variants are product-level (`variantId: null`, the variant id in `note`), like the order and restock rows. |

**Outbound webhooks (ERP push).** The store pushes its event stream to registered
ERP endpoints in real time (signed HMAC, retry + back-off) so an ERP needn't poll.
See [WEBHOOKS.md § Outbound webhooks](WEBHOOKS.md) + Admin → Système → API &
Webhooks → Webhooks sortants (ERP).

**Headless content** (read-only — `content`/`blog`/`reviews` are
read-only domains; no write routes are wired). Public-toggleable; the public
path returns published/active rows only. `/api/content` filters `site_settings`
to a public prefix allow-list (`site. social. nav. theme. seo. checkout.
shipping. reviews. consent. tracking.` — `tracking.custom_head` /
`tracking.custom_body` excluded) and drops any secret-looking key
(payment/mail/`_enc`/token — see [src/lib/api/content.ts](src/lib/api/content.ts)).
The whole `seo.*` SEO config is intentionally public (it already shapes the
public robots.txt / sitemap.xml / JSON-LD / product feeds): `seo.org_type`,
`seo.robots_extra_disallow`, `seo.sitemap_extra_urls`, `seo.social_*`,
`seo.knows_about`, `seo.llms_txt`, the feed identity + toggles (`seo.feed_*`), the
`seo.markdown_agents_enabled` toggle, etc. `/api/blog` `body` is serialised
through `sanitizeRichHtml` (the
storefront's pass: scripts and `on*` handlers stripped, media restricted to the
same-origin `/cdn/…` paths — relative, so a head on another origin prefixes the
store origin). A post / article whose category is deactivated returns
`category: null`, and `?category=<inactive slug>` returns an empty list.

| Method | Path               | Scope           | Notes                                                                                       |
| ------ | ------------------ | --------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/api/content`     | `content:read`  | One headless render bundle: hero/header/footer banners, quick buttons, header + footer nav, logo, public settings subset. The nav drops links whose category / brand target is deactivated or deleted (they would 404), unless an active redirect still serves the stored URL. |
| GET    | `/api/blog`        | `blog:read`     | Published posts (`?limit=1–50`, `?cursor=`, `?category=<slug>`); `?categories=1` → category list. |
| GET    | `/api/blog/[slug]` | `blog:read`     | One published post by slug → `{ post }` or 404.                                             |
| GET    | `/api/reviews`     | `reviews:read`  | Approved reviews + summary for one product (`?product=`/`?slug=`/`?sku=`/`?gtin=`/`?externalRef=`/`?id=`, `?rating=1–5`, `?limit=1–100`). Internal fields (user id, source, status) never exposed. Public (toggled) callers: `reviews.enabled` off → empty items + a zero summary. Keyed callers are unaffected. |

#### Order push — `POST /api/orders`

```
{ lines: [{ sku|gtin|externalRef|productId, variantId?|variantSku?, quantity }],
  contactEmail, contactPhone?, shipping: { fullName, streetLine1, streetLine2?, city, region?, postalCode?, phone? },
  deliveryMethod?: home_delivery|drive_by_pickup|in_store, deliveryAgentId?, pickupLocationId?,
  paymentChannel: cash|bank_transfer|cod, paymentReference?, promotionCode?, notes?, externalRef?,
  userId? | customerId? | customerExternalRef?, attachByEmail? }
```

Live-prices every line (a pushed price is never trusted), then runs the same
`placeOrderWorkflow` as a web checkout (atomic stock decrement, tax, promo). `cash` / `bank_transfer` are settled `paid` at once; `cod` stays
`pending` until delivery. A variable product line needs `variantId|variantSku`.

- **Customer.** Attach the sale with ONE of `userId` (account id,
  as the order feeds and `ApiCustomer.userId` carry it), `customerId`
  (profile uuid or its externalRef) or `customerExternalRef`. An unknown
  identifier, a profile with no online account (`userId: null`), or more than one
  identifier → 400 `validation` with `fieldErrors` on that field — never a silent
  guest order. `attachByEmail: true` stays a best-effort match on `contactEmail`;
  with none of these the order is a guest order.
- **Lines.** Several lines resolving to the same product / variant are merged
  (quantities summed) before the min/max-quantity and stock checks.
- **Promotion.** An unknown, inactive or expired `promotionCode` → 400
  (`fieldErrors.promotionCode`); the order is not placed.
- **Delivery.** The storefront delivery-method toggles (`delivery.*_enabled`)
  don't bind an ERP push, but `deliveryAgentId` / `pickupLocationId` are still
  validated (enabled, matching kind) → 422 `delivery_unavailable` otherwise. A
  pickup method with no `pickupLocationId` is stored as that method with a 0 fee
  (counter sale). Never silently re-routed to home delivery.
- **Validation.** Errors carry `fieldErrors` keyed by top-level field
  (`contactEmail`, `shipping`, `lines`, …). Text caps: fullName 120,
  streetLine1/2 300, city/region 120, postalCode 20, phone/contactPhone 32,
  contactEmail 254, notes 1000, externalRef 200 — an over-long field → 400 with a
  message naming the field and its cap.
- **Conflicts.** A duplicate `externalRef` → 409 `conflict` (the unique index is
  the race backstop). Stock / availability refusals → 409, policy refusals
  (minimum order, per-product quantity limits, account required) → 422.

#### Incremental sync (keyset cursors)

`/api/orders`, `/api/customers` and `/api/stock/movements` share one keyset
([src/lib/api/keyset.ts](src/lib/api/keyset.ts)):

- `pagination.nextSince` is **microsecond-precise**
  (`YYYY-MM-DDTHH:MM:SS.ffffffZ`). Pass it back **verbatim** together with
  `nextId` as `?since=&sinceId=`; the next page is strictly after that cursor, so
  the boundary row is never re-sent and a page of rows sharing one timestamp
  never loops. (`?since=` alone is the legacy inclusive watermark.)
- An empty page returns `nextSince: null` / `nextId: null`: you are caught up —
  keep your last cursor and poll again later.
- Feeds only return rows older than ~5 s (settle window), so a transaction that
  commits late is never skipped; a row written just now appears on the next poll.
- `since` must be a real calendar date/time (e.g. `2025-02-30` → 400); a
  malformed `sinceId` is ignored (inclusive watermark).

## First-party storefront search — `/api/store/search`

```
GET /api/store/search?q=<query>                  # cross-table search, per-kind cap = configured autocomplete limit (default 6)
GET /api/store/search?q=<query>&kinds=product    # restrict kinds (csv)
GET /api/store/search?q=<query>&limit=12         # 1–25, default = search.autocomplete_limit (6 out of the box)
```

Returns `{ query, total, hits }` where each hit is
`{ kind, id, slug, title, snippet, href, imageUrl, imageAlt, priceCents, oldPriceCents }`
(`priceCents`/`oldPriceCents` are product-only, null otherwise — and despite
the name, `priceCents` holds **millimes**, see `src/lib/price.ts`).

> **Tunable.** The per-kind default limit and the minimum query length are
> operator-set in **Système → Recherche → Réglages** (`search.autocomplete_limit`,
> default 6, clamped 1–25; `search.min_query_length`, default 2, clamped 1–4).
> Disabled kinds (`search.kind_*`) are dropped from results. See
> [docs/modules.md §7.6](docs/modules.md).

- Kinds: `product | category | brand | blog_post | page`.
- Backed by the Postgres FTS (`fr_unaccent` config + generated
  `search_vector` columns) + `pg_trgm` hybrid in
  [src/modules/search](src/modules/search). Search-log telemetry is
  fire-and-forget inside the service.
- **First-party, same-origin only.** The route runs `requireFirstParty()`
  ([src/lib/api-auth/same-origin.ts](src/lib/api-auth/same-origin.ts)) — a
  cross-origin browser call (or a bare server-to-server / curl call with no
  `Sec-Fetch-Site`/Origin/Referer signal) gets **403** `{ error: "Origine
  non autorisée." }`. This is a CSRF speed-bump, not auth; external consumers
  use the key-gated `/api/*` data surface, not this. The real controls are the
  per-IP rate limit (below) and the FTS sanitisation in the service.
- Queries under `search.min_query_length` characters (default 2) return an
  empty result without touching the DB; queries are trimmed and capped at 150
  characters (`MAX_SEARCH_QUERY_LENGTH`) in the search service.
- Rate-limited to 60 requests/min per IP → 429 with `Retry-After` (checked
  before the config read so a too-short flood can't sidestep it).
- While the store is in maintenance / coming-soon (`site.mode`) it returns an
  empty result (`no-store`); staff sessions bypass, like the storefront.
- Anonymous results are edge-cached briefly (`max-age=10, s-maxage=30,
  stale-while-revalidate=60`) so autocomplete bursts don't hammer Postgres. Failures return an empty 200 with
  `Cache-Control: no-store` (never 500, never cache-poisoned).

## First-party funnel telemetry — `/api/track`

```
POST /api/track
{ "event": "add_to_cart", "payload": { ... } }
```

Server-side mirror of the client `track()` helper (GA4-style funnel
events: `view_item`, `add_to_cart`, `begin_checkout`, `purchase`, …).
**First-party, same-origin only** — `requireFirstParty()` returns **403**
`{ error: "Origine non autorisée." }` for a cross-origin or non-browser
caller; it is not a public ingestion endpoint. There is no key (events fire
for anonymous visitors). **Until a server fan-out is wired, production answers
`{ ok: true, skipped: "no_sink" }` right after the same-origin check, with zero
DB work** (`serverMirrorActive()`,
[src/lib/tracking/server-mirror.ts](src/lib/tracking/server-mirror.ts)), and the
client funnel does not POST. When active (development today), the route runs a
server-side consent check that mirrors the client, THEN the per-IP rate limit
(60/min → 429), the 8 KB body cap (413, measured on the actual body, not a
spoofable `Content-Length`) and the event-name allowlist (400). The master switch
(`tracking.enabled`, default OFF) is checked first — off →
`{ ok: true, skipped: "tracking_disabled" }`. Then « Bypass »
(`tracking.bypass_consent`), a disabled banner (`consent.enabled`), or Consent
Mode `off` (`tracking.consent_mode`) all collect freely; otherwise the event is
dropped with `{ ok: true, skipped: "no_consent" }` unless the `tokyo.consent`
cookie grants analytics, the category is still offered
(`consent.analytics_enabled`) and the decision was recorded under the current
`consent.revision` (the cookie's `v` must be ≥ the revision — a bump voids
earlier decisions, same rule as the client's `hasConsent()`). The six gate keys
come from ONE cached read (tag `site:settings`, 60 s revalidate). Today it's a
hook point (dev-only logging); future fan-out to Meta CAPI / GA4 Measurement
Protocol happens here.

Adding a new **external API** endpoint (the recipe — see also the canonical
inventory in [route-catalog.ts](src/lib/api-auth/route-catalog.ts)):
1. Register the route in
   [src/lib/api-auth/route-catalog.ts](src/lib/api-auth/route-catalog.ts) —
   give it an `id`, method, path, resource + action (the `ext(...)` helper
   derives the scope and the public-toggle flag).
2. Create `src/app/api/<path>/route.ts` and gate **every** handler with
   `enforceExternalApi(request, "<id>")`; writes additionally call
   `requireApiActor(gate)` to attribute the change to the key's owner.
3. Do the work through a **workflow** (the same one the dashboard uses); return
   via `workflowResponse(result)`.

```ts
import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { requireApiActor } from "@/lib/api-auth/actor";
import { readJsonObject, workflowResponse, workflowInput } from "@/lib/api-auth/respond";
import { workflows } from "@/workflows";

export async function POST(request: Request) {
  const gate = await enforceExternalApi(request, "products.create"); // 401/403/429/503 handled here
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);                               // 403 if the key has no owner
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);                      // 400 on non-object body
  if (!parsed.ok) return parsed.response;

  const result = await workflows.catalog.createProduct(
    workflowInput(parsed.body),
    { actorUserId: actor.actorUserId },
  );
  return workflowResponse(result, 201); // maps validation→400, conflict→409, not_found→404, …
}
```

---

## Admin API — `/api/admin/*`

All admin endpoints open with an RBAC guard — a fine-grained
`await requirePermission(module, action)` (e.g. `media:view`,
`customers:view`, `system_performance:view`); store-wide destructive operations
additionally require the super-admin `*` wildcard (`checkSuperAdmin` /
`requireSuperAdmin`). When the caller is unauthenticated or lacks the
permission, the handler returns **404** (not 401/403) — Tokyo Store
deliberately doesn't leak the existence of admin routes to anonymous
traffic (a disabled account resolves to no permissions). Mutating endpoints additionally enforce a
same-origin check (`assertSameOrigin`, [src/lib/auth/origin.ts](src/lib/auth/origin.ts))
as CSRF defense, since Better Auth's `trustedOrigins` only covers `/api/auth/*`.

### Bootstrap — `POST /api/admin/bootstrap`

```
POST /api/admin/bootstrap
Content-Type: application/json

{ "token": "<ADMIN_BOOTSTRAP_TOKEN>", "email": "user@example.com" }
```

Promotes an existing user (registered at `/register`) to `role=admin`,
marks their email verified, and ensures a customer profile + link exists
so `/account` works. This is the manual alternative to the automatic
first-boot default admin (see
[src/lib/bootstrap/default-admin.ts](src/lib/bootstrap/default-admin.ts)).
Behaviour:

- If `ADMIN_BOOTSTRAP_TOKEN` is unset (or < 8 chars) → 404 (endpoint hidden).
- Rate-limited to 5 attempts / 5 min per IP → 404.
- Malformed body / token too short → 400 (Zod validation).
- Wrong token → 404 (constant-time compare, no leak).
- The door is **burned** → 404 for good, or any **active effective admin** exists
  (enum `admin` OR an RBAC `*` holder, disabled accounts excluded) → 404.
- Valid + non-existent user → 404.
- Valid + existing user → 200 `{ ok: true, userId }` (also grants the
  `super_admin` RBAC role; concurrent valid requests can't both mint an admin).

**One-shot, closed automatically.** The token is burned as soon as any admin
exists — when the default admin is created, on the first successful call here,
or on any boot that finds an active admin (including `DISABLE_DEFAULT_ADMIN`
installs): the persisted `ADMIN_BOOTSTRAP_TOKEN` row is deleted and
`ADMIN_BOOTSTRAP_CLOSED` recorded, so the route 404s from then on and
init-secrets stops exporting or regenerating the token. No manual "unset the
env var" step is needed. To deliberately re-open it after a true lockout:
`DELETE FROM app_secrets WHERE key='ADMIN_BOOTSTRAP_CLOSED';` then restart (a
fresh token is generated and printed once) — see
[src/lib/bootstrap/default-admin.ts](src/lib/bootstrap/default-admin.ts).

### Metrics — `GET /api/admin/metrics`

Live snapshot powering the Infrastructure → Performance overview (client poll).
Gated on `system_performance:view` (404s otherwise). Returns
`{ events: { counts, totalEvents, uniqueEvents, startedAt, uptimeMs },
runtime: { ramPct, cpuPct, eventLoopLagMs, db:{ latencyMs, ok }, memory, pool,
uptimeMs, instanceId, … } }`. Both halves are **process-local** — they reflect
the ONE Node instance that served the request and reset on every restart/replica
boot. `no-store`, Node runtime.

### Media library — `GET /api/admin/media`

```
GET /api/admin/media                         # paginated list
GET /api/admin/media?q=<search>              # filter by filename
GET /api/admin/media?cursor=<iso-timestamp>  # next page
GET /api/admin/media?limit=24                # 1–100, default 24
GET /api/admin/media?ids=<uuid>,<uuid>       # batch lookup (max 50, for MediaPicker hydration)
```

Returns `{ items: MediaCard[], nextCursor }` — each item also carries
`variants { webp, avif, original }` URLs and `createdAt`. Powers the
`<MediaPicker>` browse drawer used by every admin form that owns an image field
(a role editing those modules needs the Médiathèque grants `media:view` /
`media:create` to attach images) and the Médiathèque « Charger plus ». Bad UUIDs
in `ids=` are silently dropped.

### Media upload — `POST /api/admin/media/upload`

```
POST /api/admin/media/upload
Content-Type: multipart/form-data

file=<File>
scope=products|categories|brands|cms|uploads
altText=<optional>
```

Same-origin-gated, `media:create`. Rejects non-images (415) and oversized bodies
(413). **Rate-limited per admin** — `checkRateLimit({ bucket: "media-upload:<uid>",
max: 30, windowSeconds: 60 })` → **429** on exceed — so a compromised/automated
session can't loop the heavy sharp+S3 pipeline. The **same bucket** is shared by
the Médiathèque page's `uploadMediaAction` server action (the UI drives the
action, not this route), so the 30/min budget is one per-admin cap across both.
Runs the configured sharp pipeline (see `/admin/media/settings` and
[docs/media.md](docs/media.md)) — webp/avif variants per the live
`media_settings` row. Returns `{ id, url }`.

### Media import from URL — `POST /api/admin/media/import-url`

```
POST /api/admin/media/import-url
{ "url": "https://…", "scope": "products", "altText": "…" }
```

Server downloads the URL (SSRF-hardened, see
`src/lib/media/fetch-remote-image.ts`), runs it through the same media
pipeline, returns `{ id, url }`. SSRF/validation failures map to 400.

Rate-limited per admin — this path does an outbound fetch + sharp re-encode per
call, so a compromised session can't use it as an egress/CPU amplifier:
`checkRateLimit({ bucket: "media-import:<uid>", max: 30, windowSeconds: 60 })`
→ **429** ("Trop de requêtes…") on exceed. The **same bucket** is shared by
`importMediaFromUrlAction` (the Médiathèque page's import button), so the two
surfaces share one per-admin budget and the action can't sidestep the cap.

### Customer exports — CSV downloads

| Method | Path                                  | Permission         | Returns                                                            |
| ------ | ------------------------------------- | ------------------ | ------------------------------------------------------------------ |
| GET    | `/api/admin/customers/export`         | `customers:view`   | Registered customers (profile + email), keyset-paged up to 10 000 rows; beyond that a trailing marker row + `X-Export-Truncated: 1` |
| GET    | `/api/admin/customers/guests/export`  | `invites:view`     | Guest clients grouped by contact phone, with order counts + spend  |
| GET    | `/api/admin/newsletter/export`        | `newsletter:view`  | Streamed, complete (uncapped) CSV of newsletter subscribers, filtered by `?status=active\|inactive\|all&q=` (the panel's filters) |
| GET    | `/admin/orders/export`                | `orders:view`      | `?ids=<uuid>&ids=…` → those orders; no params → the 1 000 most recent (µs keyset), with a trailing marker row + `X-Export-Truncated: 1` past the cap and `X-Export-Cap` on every full export |
| GET    | `/admin/system/audit/export`          | `system_audit:view` | The Journal's filters + date window (Africa/Tunis days), keyset-paged up to `MAX_EXPORT_ROWS = 50 000` with a trailing truncation marker row |

The two customer exports are UTF-8 CSV with BOM + CRLF so Excel opens them
cleanly; every cell goes through `csvCell` (formula-injection safe). Every export
is audited: it emits `data.exported { resource, count }` (resource `customers` /
`guests` / `newsletter` / `orders` / `audit`) with the downloading admin as actor
— row count only, never the data. The two `/admin/*` exports are route handlers outside
`/api` (inventory: `APP_ROUTE_HANDLERS`).

### Demo data — `POST /api/admin/system/demo`

```
POST /api/admin/system/demo            # import the demo catalogue
POST /api/admin/system/demo?op=clear   # WHOLE-STORE clear (not demo-scoped) — super-admin '*' only
```

Same-origin-gated (send an `Origin` header matching the site — a POST with
neither Origin nor Referer is rejected); requires `system_demo:manage` (404
otherwise); unknown `op` values → 400. Exists for curl-based ops (CI smoke tests,
post-deploy verification); the admin UI runs the same segment functions through
the data-job runner instead (import segments on `/admin/system/import-demo`,
« Tout nettoyer » in CMS → Réglages).

- **Import** answers **409** `{ error: { code: "busy" } }` while an import /
  clean job is running or a purge is in progress (same single-flight bar as the
  data-jobs).
- **`op=clear` is NOT scoped to demo rows**: it hard-deletes every product (with
  reviews / wishlists / variants / stock), attribute, banner, brand, FAQ and menu,
  archives every customer profile, and resets only unedited demo settings. It additionally
  requires the super-admin `*` wildcard (**403** otherwise) and answers **409**
  `busy` while an import / clean job or a purge runs.

On success both bust the cached storefront (`revalidatePath('/', 'layout')` +
the shared `STOREFRONT_BULK_TAGS`; the catalogue-feed import the workflow detaches
is busted by the job poller when it finishes) and return `{ ok: true, counts }`.

### Import template — `GET /api/admin/import/template`

```
GET /api/admin/import/template?format=csv   # example CSV feed
GET /api/admin/import/template?format=xml   # example Google Merchant XML feed
```

Admin-gated (`requirePermission("system_import", "view")` → 404 for
anonymous/non-admin or an admin lacking the import permission). Streams a
downloadable example feed (`Content-Disposition: attachment`) for the
catalogue importer. Unknown/missing `format` → 400. Read-only GET — no
same-origin concern, like the CSV exports.

---

## Ops — `POST /api/cron/*`

All seven cron routes share one auth contract — per-IP rate limit, then a
constant-time `Authorization: Bearer <CRON_SECRET>` compare (`guardCron`,
[src/lib/cron/guard.ts](src/lib/cron/guard.ts)): **429** when throttled, **503**
when the secret is unset (the job never runs unguarded), **401** on mismatch.
After auth, all seven run through ONE executor (`runScheduledJob`,
[src/lib/jobs/run-job.ts](src/lib/jobs/run-job.ts)): a per-job kill-switch
(`jobs.<key>.enabled` in `site_settings`, toggled from the dashboard — a paused
job records a `skipped` run and returns **200** without doing work, so the
external scheduler keeps firing harmlessly) → `runAndLog` (a THROW is recorded
`failed`, never an unlogged 500) → exactly one `ok`/`skipped`/`failed` row in
`job_run_log` (response carries `{ ok, status, … }` plus the job's counters;
**500** when the run is recorded `failed`). The same executor backs the
dashboard "run now" (trigger `manual`, which bypasses the pause and needs no
`CRON_SECRET`). Surfaces in the admin "Tâches planifiées" dashboard (8 jobs: these
seven + the internal `review_generation`). Wire each to a Coolify scheduled task —
see [docs/deployment-coolify.md](docs/deployment-coolify.md).

| Path                       | Cadence        | Does                                                              |
| -------------------------- | -------------- | ---------------------------------------------------------------- |
| `/api/cron/retention`      | daily          | Purges PII-bearing log tables past their window (below).         |
| `/api/cron/mailing`        | every ~2 min   | Drains the email send queue (campaigns + automation fan-outs).   |
| `/api/cron/birthday`       | daily ~00:10   | Sends today's birthday gift-code emails (idempotent per year).   |
| `/api/cron/review-request` | daily          | Sends post-delivery review-request emails.                       |
| `/api/cron/payments`       | every ~12 min  | Re-verifies + settles ONLINE orders stuck `pending` against the gateway (rescues a closed return tab on ClicToPay/Flouci, or a crash between the webhook claim and the status transition). |
| `/api/cron/abandoned-orders` | ~hourly      | Cancels orders stuck `pending` past the abandon window (`ABANDONED_ORDER_HOURS`, default 48h) and RESTORES the stock reserved at placement — covers UNCONFIRMED COD, online orders with no gateway reference, and anything aged out of `/api/cron/payments`. Never cancels operator-confirmed orders (`confirmed_at`), ERP-pushed orders (`external_ref`) or point-less counter sales settled offline (caisse « Non payé »); a pickup order naming a point (drive / retrait en magasin, COD) IS swept. An online order with a gateway reference is re-verified first and skipped unless definitively unpaid. |
| `/api/cron/webhooks`       | every ~2 min   | Drains the OUTBOUND webhook queue (job `webhook_dispatch`): signed POSTs to the subscribed ERP endpoints with retry + back-off — see [WEBHOOKS.md § Outbound webhooks](WEBHOOKS.md). |

### `POST /api/cron/retention`

```
POST /api/cron/retention
Authorization: Bearer <CRON_SECRET>
```

Scheduled data-retention purge. Hard-deletes PII-bearing / unbounded tables past
their window — the fifteen targets of the `RETENTION_TARGETS` inventory
([src/lib/retention/windows.ts](src/lib/retention/windows.ts)), which also drives
the Database tab, the job description and the run summary:

| Target            | Retention |
| ----------------- | --------- |
| `search_log`      | **`search.purge_months` × 30** (default 3 months ≈ 90d; resolved at purge time, service clamps 7–730d). |
| `webhook_events`  | 90 days (payment idempotency ledger) |
| `webhook_deliveries` | 90 days (outbound ERP delivery log) |
| `audit_log`       | **`audit.retention_months` × 30** (default 12 months ≈ 360d; resolved at purge time from Journal d'audit → Réglages, service clamps 1–60 months). |
| ephemeral carts (`carts`, token `qb-…`) | 2 days |
| guest carts (`carts`, no user, token not `qb-…`) | 60 days of no activity (cart row + lines) |
| guest `wishlists` (token, no user) | 180 days of no activity |
| `job_run_log`     | 90 days   |
| `email_logs`      | 180 days (pinned rows excluded) |
| `mailing_sends`   | 540 days  |
| `cart_events`     | 180 days  |
| `app_instance_heartbeats` | 90 days |
| `ai_call_logs`    | 14 days   |
| sessions / verifications | by expiry (`expires_at < now()`) |

The two configurable windows fail **closed**: if the settings read fails, the
`search_log` and `audit_log` purges are SKIPPED (`errors.searchLog` /
`errors.auditLog` = `settings_unavailable`, run recorded failed) — never run with
a shorter default. `RETENTION_WINDOWS.<key>` (90d / 360d) is only the displayed
default. Purges run two at a time, high-volume tables last (the big log tables
delete in 5 000-row batches, no `RETURNING` floods); each target is isolated
(one failure doesn't abort the others).

Auth contract: `guardCron` (above) — `CRON_SECRET` (env, optional, min 16 chars)
compared in constant time against the `Authorization: Bearer` header; **503**
when the secret is unset (the purge never runs unguarded), **401** on mismatch.

Response: `{ ok, status, deleted, errors }` where `deleted` carries a count per
target (`searchLog, webhookEvents, webhookDeliveries, auditLog, ephemeralCarts,
guestCarts, guestWishlists, jobRunLog, emailLogs, mailingSends, cartEvents,
instanceHeartbeats, aiCallLogs, expiredSessions, expiredVerifications`) — 200 when
every purge succeeded, 500 when any failed. The `search_log` window is
admin-configurable from **Système → Recherche → Purge** and honoured by the cron,
the dashboard "Run now", and the per-tab manual purge alike.

Wire it to a daily Coolify scheduled task — see
[docs/deployment-coolify.md](docs/deployment-coolify.md) §12.

---

## Webhooks — `/api/webhooks/*`

| Method   | Path                       | Provider  | Verification                              |
| -------- | -------------------------- | --------- | ----------------------------------------- |
| GET/POST | `/api/webhooks/flouci`     | Flouci    | API re-verify of `payment_id` via `verify_payment` (no HMAC) |
| GET/POST | `/api/webhooks/clictopay`  | ClicToPay | API re-verify of `orderId` via `getOrderStatusExtended.do` (no HMAC) |

**Both gateways** fire a silent server-to-server callback; neither is
HMAC-signed, so the shared handler
([src/lib/payments/webhook-handler.ts](src/lib/payments/webhook-handler.ts))
re-verifies against the provider API before settling. **Flouci** posts to
`/api/webhooks/flouci`; **ClicToPay** posts/redirects to
`/api/webhooks/clictopay` (the `dynamicCallbackUrl` passed to `register.do`).
Both are per-IP rate-limited (300/min, fail-open) and answer **503** while the
admin webhooks switch is off or the gateway can't be verified (so the gateway
retries), **200** for a terminal outcome or an unknown reference.
The customer return to `/order/[id]?pay=return` and the `/api/cron/payments`
reconcile sweep are the backups for a closed return tab. See
[WEBHOOKS.md](WEBHOOKS.md) for the full flow (init → redirect → verify,
idempotency, money units).

---

## Adding a new endpoint

Pick the tier; each has its own guard convention:

```
src/app/api/
├── products|categories|brands|… /route.ts  # EXTERNAL data API — key-gated
│                                            #   register in route-catalog.ts,
│                                            #   gate with enforceExternalApi()
│                                            #   (see the external-API recipe above)
├── admin/<resource>/route.ts               # admin-only — gate with requirePermission(module, action)
├── store/<resource>/route.ts               # first-party — requireFirstParty() + rate-limit
├── webhooks/<provider>/route.ts            # gateway callbacks — idempotent
└── cron/<job>/route.ts                     # scheduled — Bearer secret
```

For an **external/ERP** route use the `enforceExternalApi()` + `requireApiActor()`
pattern shown under [External data API](#external-data-api--apiproducts-apicategories-apibrands-apiattributes-apistock)
above, and register it in
[src/lib/api-auth/route-catalog.ts](src/lib/api-auth/route-catalog.ts) so the
inventory, the public toggle, and enforcement stay in sync.

For an **admin / first-party / cron** route, the handler is still a thin
workflow wrapper:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/session"; // or requireFirstParty / Bearer check
import { workflows } from "@/workflows";

const Body = z.object({ /* ... */ });

export async function POST(request: Request) {
  await requirePermission("<module>", "<action>"); // tier guard FIRST (404 when denied)
  const json = await request.json().catch(() => null);
  const parsed = Body.safeParse(json);        // validate — never parse(req.body) into a workflow
  if (!parsed.success) {
    return NextResponse.json({ error: "validation" }, { status: 400 });
  }
  const result = await workflows.<domain>.<action>(parsed.data, { /* ctx */ });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result.data, { status: 200 });
}
```

Rules:
- **Guard first.** Run the tier guard (`enforceExternalApi` / `requirePermission` /
  `requireFirstParty` / Bearer compare) before reading the body. A mutating admin
  route also calls `assertSameOrigin`.
- **Validate before the workflow.** Never `parse(req.body)` straight in.
- **Workflows do the work.** Routes are thin wrappers.
- **Idempotency for callbacks.** Webhooks must re-handle the same payload
  safely.
- **Don't scatter ad-hoc logging** in handlers — emit a typed event; the
  structured-logger subscriber writes one JSON line per event (via `console.log`)
  for the log shipper. See `src/events/subscribers/structured-logger.ts`.

## Rate limiting

App-level rate limiting lives in [src/lib/rate-limit.ts](src/lib/rate-limit.ts):
a Postgres-backed fixed-window counter (atomic upsert into the raw-SQL
`rate_limit_buckets` table — no Redis, PgBouncer-safe). Expired buckets
are pruned opportunistically from the hot path. Current consumers:

- External API, keyed — **120/min per key** (`apikey:<keyId>`, in
  [require-api-key.ts](src/lib/api-auth/require-api-key.ts))
- External API, public read — **60/min per IP** (`pubapi:<routeId>:<ip>`, in
  [enforce.ts](src/lib/api-auth/enforce.ts); applied only when a read route is
  opted public, since those skip the per-key limit)
- `/api/store/search` — 60/min per IP
- `/api/track` — 60/min per IP (only when the server mirror is active, after the
  consent gate)
- `/api/webhooks/{flouci,clictopay}` — 300/min per IP per provider (fail-open)
- `/api/admin/media/upload` **and** `uploadMediaAction` — 30/min per admin (shared bucket `media-upload:<uid>`)
- `/api/admin/media/import-url` **and** `importMediaFromUrlAction` — 30/min per admin (shared bucket `media-import:<uid>`)
- `/api/admin/bootstrap` — 5 / 5 min per IP
- order placement (cart + express server actions) — 6 / 10 min per IP, 4 / 10 min
  per phone (last 8 digits) and per email (`order:ip|phone|email:*`); operator and
  ERP-push orders are not throttled
- sign-in / sign-up / password reset / 2FA server actions (per IP + per account /
  email), newsletter signup + other public server actions

Both external-API limiters fail **open** on a DB hiccup (a transient limiter
error never hard-blocks a valid key or a legitimate visitor).

Better Auth's own per-endpoint limiter (in-memory, per process —
`AUTH_RATE_LIMITS` in [policy.ts](src/lib/auth/policy.ts): 30/min default,
5/min on the 2FA endpoints, 10/min on `verify-email`) covers what `/api/auth/*`
still serves over HTTP; it keys on the trusted client IP (the route rewrites
`X-Forwarded-For`). The credential endpoints are disabled over HTTP and
throttled by the server actions above.

Reading order before exposing a new endpoint:

1. [docs/security.md](docs/security.md) — what to check
2. [docs/modules.md](docs/modules.md) — where the logic should live
3. [WEBHOOKS.md](WEBHOOKS.md) — only if it's a callback

---

# Decoupling guide — building or swapping the frontend

This section maps the **entire backend contract** so a new frontend can be built,
or the current design swapped, against documented surfaces. Everything here is
also browsable in the admin **Système → API & Webhooks** section (one tab per
surface), and is **machine-enforced** so the docs can't silently drift:

| Surface | Authoritative source | Drift test | Admin tab |
| --- | --- | --- | --- |
| HTTP endpoints (external/ERP + first-party + infra + metadata) | [route-catalog.ts](src/lib/api-auth/route-catalog.ts) `ALL_HTTP_ENDPOINTS` | [route-invariants.test.ts](src/lib/db/tests/route-invariants.test.ts) (catalog ⇔ disk) | Endpoints HTTP / API externe (ERP) |
| Internal **write** API (server actions) — **394** | [internal-api-catalog.ts](src/lib/api-auth/internal-api-catalog.ts) (generated) | [internal-api-catalog.test.ts](src/lib/db/tests/internal-api-catalog.test.ts) (catalog = disk, permission keys = RBAC registry) | API interne (actions) |
| Bus **events** — **226** (52 domains) | [event-catalog.ts](src/lib/api-auth/event-catalog.ts) (generated) | [event-catalog.test.ts](src/lib/db/tests/event-catalog.test.ts) | Évènements |

Regenerate the two generated catalogs after adding an action/event or changing a
guard: `pnpm gen:api-catalog` (runs
`node scripts/gen-internal-api-catalog.mjs && node scripts/gen-event-catalog.mjs`).

## The three contract layers

1. **External HTTP API** (`/api/*`, key-gated) — the headless contract for ERP /
   external tools **and** the path a non-Next frontend would use. Documented in
   full above. Read = scoped key (some opt-in public); write = scoped key, never
   public.
2. **Internal write API = server actions** — the storefront/admin call ~324
   `*Action` functions (React Server Actions) for every mutation. These are
   same-origin, session/RBAC-guarded, and **not** HTTP-addressable from another
   origin. A Next.js frontend reuses them directly; a non-Next frontend must go
   through the HTTP API (or new routes must be added — see gaps below).
3. **Read = RSC + services** — storefront pages render server-side from service
   methods (`*Service`/queries). Much of this is *also* exposed over HTTP
   (catalogue, content, search), but some is RSC-only (cart, applied promotions).

## Read / Write over HTTP — per-domain matrix

What a **non-Next** headless frontend can do over HTTP **today**:

| Domain | Read via HTTP | Write via HTTP |
| --- | --- | --- |
| Catalogue (products/categories/brands/attributes) | ✅ `/api/products`, `/api/categories`, `/api/brands`, `/api/attributes` | ✅ keyed `POST`/`PUT`/`PATCH`/`DELETE` (`*:write`) — `PUT` = upsert by reference (`matchBy: externalRef`) |
| Stock | ✅ `/api/stock`, `/api/stock/movements` | ⚠️ `/api/stock` (ERP, keyed) + actions |
| Orders | ✅ `/api/orders`, `/api/orders/[id]` + sub-streams (keyed) | ⚠️ ERP/POS only (keyed): order push `POST /api/orders` (offline channels cash / bank_transfer / cod), status, shipments, returns, refunds. **Storefront checkout is server-action-only** (see Cart & checkout) |
| Customers | ✅ `/api/customers`, `/api/customers/[id]` (keyed, PII) | ⚠️ ERP only (keyed): `POST`/`PUT`/`PATCH /api/customers` (profiles + externalRef link; no auth-account creation) |
| Cart & checkout | ❌ RSC | ❌ server actions only — **no `/api/cart`** |
| Promotions | ❌ RSC + cookies | ❌ server actions only |
| Content (blog/CMS/reviews) | ✅ `/api/content`, `/api/blog`, `/api/reviews` | ❌ server actions only |
| Search | ✅ `/api/store/search` (same-origin) | n/a |
| Auth & accounts | Better Auth `/api/auth/get-session` | ⚠️ Better Auth HTTP keeps only sign-out, social sign-in / OAuth callback, the emailed links and the 2FA card; email/password sign-in, sign-up, reset and profile changes are server actions only (disabled over HTTP) |

**Known gaps for a 100% non-Next headless storefront:** cart/checkout,
promotions and email/password authentication have no HTTP write contract
(server-action-only). A **Next.js**
frontend has no gap — it reuses the server actions directly. To go fully headless
for those domains, add `/api/cart` + `/api/checkout` + a public `/api/promotions`
(read) following the [Adding a new endpoint](#adding-a-new-endpoint) recipe; the
domain logic already lives in workflows (`src/workflows/{cart,order,promotion}`)
so the routes are thin wrappers.

## Internal write API (server actions)

All 394 actions are catalogued (file, kind, RBAC permission — derived from each
action's own `requirePermission` / `requirePermissionAny` / `permissionSetAllows`
guards, never hand-written — and summary) in
[internal-api-catalog.ts](src/lib/api-auth/internal-api-catalog.ts) and browsable
in the **API interne** admin tab. They group into: **Catalogue**, **Commandes**,
**Panier**, **Promotions**, **Clients**, **Accès**, **Contenu**, **Marketing**,
**IA**, **Système**. Calling convention: a client component binds the action to a
`<form>` or calls it via `useActionState`; it runs on the server with
`cookies()`/`headers()` and re-checks RBAC. They are **not** an external API — do
not expose them cross-origin.

## Events (internal pub/sub)

226 bus events across 52 domains ([event-catalog.ts](src/lib/api-auth/event-catalog.ts),
**Évènements** tab). Every mutation emits one; subscribers persist the audit log,
invalidate caches, send transactional email, and update search. Severity
([severity.ts](src/events/severity.ts)) drives audit persistence. The bus is
**internal**, but every event is ALSO available as a real-time **outbound
webhook**: an ERP registers a signed endpoint (subscribed to specific events or
`*`) and each matching event is queued + delivered by the `webhook_dispatch`
cron (`POST /api/cron/webhooks`). A `*` subscription excludes the security / PII
domains (`auth.*`, `rbac.*`, `api_key.*`, `user.*`, `data.*`) — subscribe to
those by exact name. See [WEBHOOKS.md → Outbound webhooks (ERP push)](WEBHOOKS.md) for the
signature scheme, headers, retry/back-off, and the admin UI. (Inbound webhooks
remain the two payment callbacks — Flouci and ClicToPay.) An integration can also
poll the relevant read API for change notifications.

## Entity-linkage map (for ERP integrators)

Soft text links (no cross-module FKs, by design — see modules.md) connect:

```
customer (users / customer_profiles)
   └─ order — payment INLINE on the order row (payment_method / payment_reference /
        │       paid_at; no separate payments table) ── webhook_events (idempotency)
        ├─ order_items ── product / product_variant
        ├─ promotion_redemptions ── promotion
        ├─ invoice / credit-note / delivery-note numbers (gapless; columns on orders/shipments)
        └─ order_returns (SAV)

promotion
   ├─ promotion_targets ── customer | segment   (bidirectional targeting)
   ├─ window: starts_at / ends_at   (date-gated eligibility — evaluateCouponEligibility)
   ├─ caps: max_uses (global) / max_uses_per_user (account-required)
   └─ promotion_redemptions ── order   (atomic with the order write)
```

Keys: `orders.user_id` (null = guest) — exposed as `userId` on the order DTO,
`ApiCustomer.userId`, the common join key across the two feeds; `orders.contact_email/phone` (guest claim post-verification),
`promotions.scope` + `scope_id`, `promotion_targets.target_type`.

## External reference (`external_ref` — « Référence externe (ERP) »)

The **cross-system linking key**. `external_ref` is a stable, opaque code *your*
ERP / PIM / WMS owns, stored on the store's own row so **neither side needs the
other's internal UUID**. It exists on **products, categories, brands, orders and
customers**. Products / categories / brands expose it as the « Référence externe
(ERP) » editor field *and* accept it on the keyed HTTP write API; an order's
`external_ref` is set by the ERP order push (`POST /api/orders`) or stamped over
the API (`PATCH /api/orders/[id]/status`), a customer's by `POST`/`PUT`/`PATCH
/api/customers` — not via an editor field. A product's stock pool inherits its
ref. Each is **partial-unique** — one live row per value, NULL never collides,
and it is kept **distinct from `sku`** so the integration key can diverge from
the SKU. Columns added by migrations 0011 (product) / 0016 (category) / 0018
(brand) / 0055 (order) / 0118 (customer).

**Why it matters for decoupling/ERP:** address your store entities *by your own
reference*. Set it once, then every read/sync uses it — no UUID bookkeeping on the
ERP side, and re-imports are idempotent.

**How the API uses it:**

- **Resolve by reference** — products / categories / brands / orders / customers /
  stock accept `?externalRef=`, and the order and customer `[id]` path segments
  accept the uuid **or** the externalRef (a uuid-shaped value that is not a local
  id falls back to the externalRef lookup). O(1) via the unique index. Examples:
  ```
  GET /api/orders?externalRef=ERP-SO-1042
  GET /api/orders/ERP-SO-1042
  GET /api/customers/ERP-C-501
  GET /api/stock?externalRef=ERP-SKU-77
  GET /api/products?externalRef=ERP-SKU-77   (resolve one product)
  ```
- **Round-trip mapping** — every keyed DTO returns `externalRef`, so one list pull
  gives the ERP the full `uuid ↔ your-ref` map (`GET /api/products`,
  `/api/orders`, `/api/customers`, …). Public (keyless) product reads strip it.
- **Stamp on orders (two-way sync)** — `PATCH /api/orders/[id]/status` accepts
  `{ externalRef }` to bind a Tokyo order to your ERP order, through the audited
  `order.set_external_ref` workflow (emits `order.edited` with `changedFields:
  ["external_ref"]`). Idempotent + guarded: re-stamping the same value is a no-op;
  a *different* value on an already-linked order → 409 `already_linked`; a value
  already used by another order → 409 `external_ref_conflict` (both with
  `fieldErrors.externalRef`). A blank `externalRef` is a 400 — clear the link with
  `{ unlink: true }`. The link is pre-checked before any status transition in the
  same request and written after it, so a refused transition never leaves a
  stamped link (and a refused link never leaves a committed transition).
- **Link customers** — `PUT /api/customers { id, externalRef }` stamps your ref
  on an existing storefront customer (idempotent; a different ref on a linked
  profile → 409 with `fieldErrors.externalRef = "already_linked"`; a ref owned by
  another customer → 409).
- **Set on catalogue (over HTTP)** — products / categories / brands accept
  `external_ref` on the keyed write API: `POST` / `PATCH /api/{products,categories,brands}`,
  or the idempotent `PUT` upsert that *keys* on it (`matchBy: externalRef` →
  create-or-update by your own reference, so re-imports are stable). The admin
  editors (« Référence externe (ERP) » field) and the bulk import pipeline set it
  too.

Uniqueness indexes: `products_external_ref_unique`, `categories_external_ref_unique`,
`brands_external_ref_unique`, `orders_external_ref_uniq`,
`customer_profiles_external_ref_uniq` — all partial on `external_ref IS NOT NULL`;
the catalogue and customer indexes additionally exclude soft-deleted rows
(`deleted_at IS NULL`, so an archived profile frees its ref), while orders are
never soft-deleted.

## Recipe — connect an ERP

1. **Issue a key** with least-privilege scopes in **API & Webhooks → Réglages &
   Clés** (e.g. `orders:read`, `orders:write`, `products:read`, `stock:write`).
   A key can never exceed its creator's own admin permissions (`write` / `full`
   need a super-admin; `customers:read` needs Clients → voir; `orders:write`
   needs Commandes → gérer), and it stops working for a scope its creator later
   loses — mint it under a stable service account.
2. **Pull catalogue**: `GET /api/products` (`?limit=&offset=`, follow
   `pagination.nextOffset` until `null`), `/api/brands` + `/api/attributes`
   (`?limit=&offset=`), `/api/categories` (tree or `?flat=1`). Compare prices on
   `basePriceCents`, not the promo-lowered `priceCents`. **Push catalogue** with
   the keyed write verbs: `POST` (create), `PATCH` (update), `DELETE` (archive),
   or `PUT` = idempotent upsert keyed on your reference (`matchBy: externalRef`) —
   the canonical way to create-or-update a row and stamp `external_ref` in one
   call.
3. **Sync stock**: `GET /api/stock` (read), `PATCH /api/stock` (adjust), and the
   `GET /api/stock/movements` ledger. No POST.
4. **Sync orders**: incremental `GET /api/orders?since=&sinceId=` (µs keyset),
   `GET /api/orders/[id]` + sub-streams; push POS/ERP sales with
   `POST /api/orders` and fulfilment with `PATCH /api/orders/[id]/status`,
   shipments, returns and refunds. Order reads are **key-only** (carry customer
   PII) — never public-toggleable. Storefront checkout itself stays
   server-action-only.
5. **Sync customers**: incremental `GET /api/customers?since=&sinceId=`, match
   existing ones by `?email=` / `?phone=` then link them with `PUT { id,
   externalRef }`; join orders and customers on `userId`.
6. **Subscribe to events** instead of polling: register an outbound webhook
   endpoint (API & Webhooks → Webhooks sortants), verify the HMAC signature, then
   hydrate through the read API — see [WEBHOOKS.md](WEBHOOKS.md).
7. **Bulk load**: the import pipeline (admin → Import) accepts CSV/XML; template
   at `GET /api/admin/import/template`. Bulk import / demo seed / clean emit no
   per-entity events — only `import.products_*` / `demo.*` summaries; resync
   through the read API after one.
8. **Payments**: settlement arrives via the gateway webhooks (Flouci +
   ClicToPay, both re-verified server-side) — the ERP reads order
   `paid_at`/status (or listens to `order.paid`) rather than the gateway
   callback.

## Recipe — build / swap the frontend

- **Re-skin (same Next app):** the UI is already componentised; restyle without
  touching the contract. Server actions + RSC loaders stay.
- **New Next.js frontend:** import the same server actions + service reads. No
  HTTP needed; reuse [internal-api-catalog.ts](src/lib/api-auth/internal-api-catalog.ts)
  as the index.
- **Non-Next frontend (fully headless):** consume the external HTTP API for
  catalogue/content/orders/search reads; for cart/checkout/promotion **writes**,
  add the HTTP routes noted in the gaps table (logic already in workflows). Auth:
  Better Auth `/api/auth/*` serves sessions, social sign-in and the emailed links,
  but its email/password credential endpoints are disabled over HTTP — expose
  them through new routes wrapping `workflows.auth.*` (keeping the throttles and
  audit events). Watch the [Rate limiting](#rate-limiting) + scope model.

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](CREDITS.md).

