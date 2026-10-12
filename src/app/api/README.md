# API routes

Server-side endpoints under `/api/*`. These are **Next.js Route Handlers**
(`app/api/<path>/route.ts`) and run on the **Node.js runtime** (node-postgres,
`node:crypto`, the S3 client, and `sharp` are not available on the edge runtime).

Most server-side logic lives in Server Components / Server Actions calling the
modules directly; this HTTP surface exists for the cases that genuinely need a
URL: webhooks, cron, external/ERP consumers, file uploads, `curl`-able ops,
and Better Auth's emailed links.

The **authoritative route inventory** — every route's tier, domain, and (for
the external API) required scope — is
[`src/lib/api-auth/route-catalog.ts`](../../lib/api-auth/route-catalog.ts). It
drives the admin inventory tab, the per-route public toggle, and request
enforcement, so it can't drift from the handlers. The tables below are a
prose digest of it.

## External data API (key-gated) — `/api/products`, `/api/categories`, `/api/brands`, `/api/attributes`, `/api/stock`, `/api/orders`, plus the read-only headless content routes (`/api/content`, `/api/blog`, `/api/aide`, `/api/reviews`)

A **CRUD API for ERP / external integrations**, *not* a public read-only
surface. Every handler runs `enforceExternalApi(request, "<routeId>")`
([`src/lib/api-auth/enforce.ts`](../../lib/api-auth/enforce.ts)) which fails
**closed**:

- **Kill-switch:** when `apiSettings.apiEnabled` is false, everything → **503**
  (not even a valid key passes).
- **Reads** need a scoped API key **by default**; an admin can opt an individual
  read route public via `apiSettings.publicRoutes` (default empty). **Writes
  always need a key** — never public.
- Credential: `Authorization: Bearer <key>` or `X-API-Key: <key>`. Errors:
  **401** missing/blank key (with `WWW-Authenticate: Bearer`) or invalid/expired
  key; **403** wrong scope, or a write by a key with no associated user; **429**
  rate limit (120/min per key, 60/min per IP on a public read). Write workflows
  map validation→400, not-found→404, conflict→409.
- Every key-auth denial (missing/invalid/expired/scope/rate-limited) emits a
  best-effort `api_key.auth_failed` bus event (reason + scope + IP, **never the
  key value**), surfaced on **Système → Sécurité**. Fire-and-forget; the two
  attacker-floodable reasons (invalid/rate_limited) are sampled so a probe storm
  can't amplify into audit writes.

Writes are thin wrappers over the **same admin workflows** the dashboard uses
(actor = the key's owner), so the audit log + cache invalidation fire. Keyed
callers may read drafts/inactive rows; public callers see published/active only.

A product read (`GET /api/products` by-ref or list, and `GET /api/products/[slug]`)
returns the storefront `Product` DTO plus the uuid `id`, `externalRef` and
`stockQty` (`ApiProduct`). For a **variable** product it also returns `variants[]`
(each with `id`, `label`, `sku`, `priceCents`, `oldPriceCents`, `inStock`,
`stockQty`, `isDefault`, `optionValueIds`, `image`, `imageAlt`) and
`variantOptions[]` (the picker axes) — intended ERP exposure so a headless client
can sync each child variant's SKU + stock. See
[`src/lib/api/products.ts`](../../lib/api/products.ts).

| Method                 | Path                                | Scope               | Purpose                                                       |
| ---------------------- | ----------------------------------- | ------------------- | ------------------------------------------------------------- |
| `GET`                  | `/api/products`                     | `products:read`     | List, or by ref `?sku=`/`?gtin=`/`?externalRef=` (`?category=`, `?limit=1–100`, `?offset`) |
| `GET`                  | `/api/products/[slug]`              | `products:read`     | Single product by slug                                        |
| `POST/PUT/PATCH/DELETE`| `/api/products`                     | `products:write`    | Create / upsert-by-ref / update / archive                     |
| `GET/PUT`              | `/api/products/[slug]/attributes`   | `products:read/write` | Read or replace a product's attribute values + scalars      |
| `GET`                  | `/api/categories`                   | `categories:read`   | Tree, `?flat=1`, or by ref `?externalRef=`/`?slug=`/`?id=` (unpaginated — the category set is small & bounded, unlike keyset products/orders). FAQs are CMS-only, not in `ApiCategory` |
| `POST/PUT/PATCH/DELETE`| `/api/categories`                   | `categories:write`  | Create / upsert-by-ref / update / archive                     |
| `GET/PUT`              | `/api/categories/[slug]/attributes` | `categories:read/write` | Read or replace a category's filter-attribute set         |
| `GET`                  | `/api/brands`                       | `brands:read`       | List (`?search=`, `?limit=1–500`, `?offset`; ordered by display_order) or by ref. `ApiBrand` round-trips every writable field (logo/hero/og/icon, editorial, valueProps, tax/isDiscountable/displayOrder, meta/canonical/noindex). FAQs are CMS-only |
| `POST/PUT/PATCH/DELETE`| `/api/brands`                       | `brands:write`      | Create / upsert-by-ref / update / archive                     |
| `GET`                  | `/api/attributes`                   | `attributes:read`   | Active attributes + nested values                             |
| `POST/PATCH/DELETE`    | `/api/attributes`                   | `attributes:write`  | Create / update / archive an attribute                        |
| `POST/PATCH/DELETE`    | `/api/attributes/values`            | `attributes:write`  | Create / update / delete an attribute value                   |
| `GET`                  | `/api/stock`                        | `stock:read`        | View product/variant stock by any ref                         |
| `PATCH`                | `/api/stock`                        | `stock:write`       | `{ stockDelta: ±N }` atomic, or `{ stockQty?, inStock? }` set  |
| `GET`                  | `/api/stock/movements`              | `stock:read`        | Stock-movement LEDGER (ERP reconciliation): keyset `?since=&sinceId=`, filters `productId`/`externalRef`/`sku`/`gtin`/`variantId`/`orderId`/`reason` |
| `GET`                  | `/api/orders`                       | `orders:read`       | ERP sync: `?status=`/`?since=`/`?limit`, or one by `?externalRef=`/`?orderNumber=`. **Key-ONLY** (PII — never public) |
| `GET`                  | `/api/orders/[id]`                  | `orders:read`       | One order + lines (`[id]` = uuid or `externalRef`). **Key-ONLY** |
| `PATCH`                | `/api/orders/[id]/status`           | `orders:write`      | Push status + tracking; runs the dashboard state machine + ship gate |
| `GET`                  | `/api/customers`                    | `customers:read`    | ERP sync: `?since=&sinceId=` (updated_at,id), or by ref `?externalRef=`/`?email=`/`?phone=`. **Key-ONLY (PII)** |
| `GET`                  | `/api/customers/[id]`               | `customers:read`    | One customer + addresses (`[id]` = uuid or externalRef). **Key-ONLY** |
| `POST/PUT/PATCH`       | `/api/customers`                    | `customers:write`   | Create / upsert-by-ref / update a customer                     |
| `GET`                  | `/api/content`                      | `content:read`      | Headless render bundle (banners/nav/logo + public settings subset; secrets filtered) |
| `GET`                  | `/api/blog`, `/api/blog/[slug]`     | `blog:read`         | Published posts (list `?limit`/`?cursor`/`?category`, `?categories=1`) + one by slug |
| `GET`                  | `/api/aide`, `/api/aide/[slug]`     | `aide:read`         | Published help articles (`?platform` too) + one by slug (steps) |
| `GET`                  | `/api/reviews`                      | `reviews:read`      | Approved reviews + summary for one product by any ref; internal fields never exposed |

Scope grammar lives in [`src/lib/api-auth/scopes.ts`](../../lib/api-auth/scopes.ts):
per-resource `<resource>:<action>`, plus coarse `read` / `write` / `full`
(`write` implies `read`).

## Public / first-party

| Method     | Path                    | Purpose                                                              |
| ---------- | ----------------------- | ------------------------------------------------------------------- |
| `GET`      | `/api/health`           | Liveness probe (point Coolify / monitoring here) — truly public     |
| `GET`      | `/api/store/search`     | **First-party** FTS+trigram search (`?q=`, `?kinds=`); same-origin (403 cross-origin), edge-cached, rate-limited |
| `POST`     | `/api/track`            | **First-party** server-side mirror of funnel events (same-origin, consent-gated, rate-limited; no key) |
| `GET/POST` | `/api/auth/[...all]`    | Better Auth catch-all (sign-in/up/out, get-session, verify-email, reset-password, …) |
| `GET/POST` | `/api/webhooks/flouci`  | Flouci silent payment callback — **API-verified, not HMAC-signed** (see below) |
| `GET/POST` | `/api/webhooks/clictopay` | ClicToPay silent payment callback (`dynamicCallbackUrl`) — **API-verified, not HMAC-signed** (see below) |

`/api/store/search` and `/api/track` are **not** public API — they call
`requireFirstParty()` ([`src/lib/api-auth/same-origin.ts`](../../lib/api-auth/same-origin.ts))
and return **403** to a cross-origin browser or a bare server-to-server call.
External consumers use the key-gated data API above, not these.

## Operational (token / cron gated)

| Method | Path                       | Purpose                                                                 |
| ------ | -------------------------- | ----------------------------------------------------------------------- |
| `POST` | `/api/cron/retention`      | Data-retention purge (`Authorization: Bearer <CRON_SECRET>`)            |
| `POST` | `/api/cron/mailing`        | Drain the email send queue (campaigns + automations) — `guardCron`      |
| `POST` | `/api/cron/birthday`       | Daily birthday gift-code emails — `guardCron`                           |
| `POST` | `/api/cron/review-request` | Daily post-delivery review-request emails — `guardCron`                 |
| `POST` | `/api/cron/payments`       | Reconcile online orders stuck `pending` (re-verify + settle) — `guardCron` |
| `POST` | `/api/cron/abandoned-orders` | Cancel orders stuck `pending` past the abandon window + restore reserved stock — `guardCron` |
| `POST` | `/api/admin/bootstrap`     | Promote a registered user to `admin` (gated by `ADMIN_BOOTSTRAP_TOKEN`) |

- **`/api/cron/retention`** batch-deletes PII-bearing log tables past their
  window: `search_log` (`search.purge_months`×30, default ~90d),
  `webhook_events` (90d), `audit_log` (`audit.retention_months`×30, default
  ~360d). Both configurable windows are resolved at purge time; the static
  `RETENTION_WINDOWS` values are settings-read-failure fallbacks.
  Constant-time Bearer compare against `CRON_SECRET`; returns **503** when the
  secret is unset (never purges unguarded) and **401** on mismatch. Wire it to a
  daily Coolify scheduled task — see [docs/deployment-coolify.md](../../../docs/deployment-coolify.md).
- **`/api/admin/bootstrap`** takes `{ token, email }`, marks the user verified
  and `role=admin`. Constant-time token compare, per-IP rate-limited; returns
  **404** when `ADMIN_BOOTSTRAP_TOKEN` is unset or the token/user is wrong, so a
  closed endpoint leaks no signal it exists. (First-boot admin creation is
  separate — `instrumentation.ts` → `src/lib/bootstrap/default-admin.ts`.)

## Admin (session-gated — `requireAdmin`)

All return **404, not 403**, to anonymous/non-admin callers so the endpoints
stay invisible. Most gate on `requireAdmin`; a few gate on a finer RBAC
permission instead (e.g. `/api/admin/metrics` uses
`requirePermission("system_performance", "view")`) — see the per-row notes.

| Method | Path                                  | Purpose                                              |
| ------ | ------------------------------------- | ---------------------------------------------------- |
| `GET`  | `/api/admin/metrics`                  | Live Performance snapshot: `{ events, runtime }` (event counters + RAM/CPU/event-loop/DB-latency/pool); `system_performance:view`, process-local |
| `GET`  | `/api/admin/media`                    | `<MediaPicker>` library slice (`?q=`, `?cursor=`, `?limit=1–100`, default 24) → `{ items, nextCursor }`; or `?ids=<csv>` batch-hydration (≤50 ids, bad UUIDs dropped) → `{ items, nextCursor: null }` |
| `POST` | `/api/admin/media/upload`             | Upload an image to the object store (sharp pipeline)            |
| `POST` | `/api/admin/media/import-url`         | Ingest an image from a URL (SSRF-safe)               |
| `GET`  | `/api/admin/customers/export`         | Registered-customer CSV download                     |
| `GET`  | `/api/admin/customers/guests/export`  | Guest-customer CSV download                          |
| `GET`  | `/api/admin/import/template`          | Example import feed (`?format=csv\|xml`); 400 on unknown format |
| `POST` | `/api/admin/system/demo`              | Run demo import / clear (`?op=clear`); same-origin guarded |

## Webhooks

Neither gateway signs its callback — each just pings us with the
payment reference. **Flouci** posts to `/api/webhooks/flouci`; **ClicToPay**
posts/redirects to `/api/webhooks/clictopay` (the `dynamicCallbackUrl` passed to
`register.do`). Both routes use the SAME shared handler
([`src/lib/payments/webhook-handler.ts`](../../lib/payments/webhook-handler.ts))
that trusts nothing: it looks the order up by the reference stored at init time
and **re-verifies against the provider's API** inside `confirmPayment` (Flouci
via `verify_payment`, ClicToPay via `getOrderStatusExtended.do`), which also does
the amount check and the idempotent status transition (settlement is deduped via
`webhook_events`). Each is the real-time backup to the customer-return
verification on `/order/[id]` and the `/api/cron/payments` reconcile sweep;
whichever path settles first makes the others a no-op.

COD needs no gateway callback.

## Conventions

- **Guard first, by tier.** External data routes run
  `enforceExternalApi(request, "<routeId>")` (and `requireApiActor(gate)` for
  writes); admin routes `await requireAdmin()`; first-party routes
  `requireFirstParty(request)`; cron a constant-time Bearer compare. Register a
  new external route in [`route-catalog.ts`](../../lib/api-auth/route-catalog.ts)
  so the inventory/toggle/enforcement stay in sync.
- Keyed external reads return `private, no-store`; only an **opted-public** read
  sets a short shareable cache (`s-maxage=…, stale-while-revalidate=…`).
  Error/`no-store` paths never get cached.
- Keep handlers thin — shared logic lives in `src/lib/api/*`, the `src/workflows/*`
  layer (writes go through the same workflows as the dashboard), and the
  `src/modules/*` service/query layers.
- Validate any incoming body with **zod** (or `readJsonObject` + the workflow's
  own `safeParse`); validate `[id]`/slug params (`isUuid()`, slug regex) before
  touching the DB.
- DB-touching handlers run on the Node.js runtime. `dynamic = "force-dynamic"`
  pins a route as never-cached, but it's **optional** for the external data
  routes: they read the `Authorization` / `X-API-Key` header inside
  `enforceExternalApi` → `requireApiKey`
  ([`src/lib/api-auth/require-api-key.ts`](../../lib/api-auth/require-api-key.ts)),
  which already forces Next to treat them as dynamic, and every response sets an
  explicit `Cache-Control` anyway — so they don't declare the directive.

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](CREDITS.md).

