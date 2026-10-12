# Payment gateways

Tokyo Store integrates two Tunisian gateways — **ClicToPay**
(Monétique Tunisie / SMT) and **Flouci** — plus cash-on-delivery (COD).
This document describes the live flow and the per-provider details.

> **Konnect** was removed as a supported gateway. The `payment_method` pg enum
> keeps the legacy `konnect` value so historical orders still render, but there
> is no Konnect provider client, config, webhook, or storefront toggle.

> Implementation: provider clients in
> [`src/lib/payments/providers/`](src/lib/payments/providers), dispatched by
> [`src/lib/payments/gateway.ts`](src/lib/payments/gateway.ts); the lifecycle
> lives in [`src/workflows/order/gateway-payment.ts`](src/workflows/order/gateway-payment.ts).

## Flow (init → redirect → verify)

None of these gateways are trusted via a signed push webhook. The model is
**redirect + server-side verification**:

1. Checkout creates an `orders` row with `status = pending` and a unique
   `order_number` (`placeOrderWorkflow`).
2. For an online method, the action calls `workflows.order.initiatePayment`,
   which asks the provider to create a hosted checkout session, stores the
   returned **reference** on `orders.payment_reference`, and returns a
   `redirectUrl`. An online order whose total is 0 (100 % coupon, loyalty bons, free
   shipping) never reaches a gateway: `initiatePayment` refuses it
   (`zero_amount`) and `settleZeroTotalOrderWorkflow` moves it straight to `paid`.
3. The browser is redirected to the gateway's hosted page; the customer pays.
4. The gateway redirects the customer back to `/order/[id]?pay=return`.
5. That page calls `workflows.order.confirmPayment`, which **re-verifies the
   payment against the provider's API** (never trusting the redirect), checks
   the amount, and transitions the order to `paid` exactly once.
6. **Both gateways** also ping a silent server-to-server callback which runs the
   same `confirmPayment` — real-time settlement + a backup if the customer closes
   the tab before returning. **Flouci** posts to `/api/webhooks/flouci`;
   **ClicToPay** posts/redirects to `/api/webhooks/clictopay` (the
   `dynamicCallbackUrl` passed to `register.do`), where the order is re-verified
   via `getOrderStatusExtended.do`. Both routes go through the SAME shared handler
   ([`src/lib/payments/webhook-handler.ts`](src/lib/payments/webhook-handler.ts)),
   so the payload is never trusted (order resolved by stored reference, re-verified
   against the provider API) and settlement is idempotent via `webhook_events`.
7. **Async-settlement rescue:** `POST /api/cron/payments`
   (`workflows.order.reconcilePendingPayments`) re-verifies online orders stuck
   `pending` past `PAYMENT_RECONCILE_STALE_MINUTES` (default 20) and settles the
   genuinely-paid ones — covering a closed return tab on ClicToPay/Flouci AND an
   order stranded by a crash between the webhook claim and the transition (it
   releases the orphaned claim first). Wire it as a Coolify cron — see
   [deployment-coolify.md §12d](docs/deployment-coolify.md).

COD never touches any of this — it is settled on delivery.

## Money units (do not get this wrong)

Tokyo Store stores TND as integer **millimes** (×1000, the real ISO-4217 minor
unit — SSOT [`src/lib/price.ts`](src/lib/price.ts)) — the same unit both
TND-only gateways expect, so the gateway boundary is **identity**.
`toGatewayMinor` / `fromGatewayMinor` in
[`src/lib/payments/shared.ts`](src/lib/payments/shared.ts) are kept as the
single conversion seam (today just `Math.round`) — never bypass them, and never
reintroduce the old centimes-era ×10. Columns named `*_cents`
(`orders.total_cents`, …) are legacy names that **hold millimes**.
`confirmPayment` compares the gateway's reported amount against
`toGatewayMinor(order.total_cents)` and refuses to settle a mismatch — a
missing/non-numeric gateway amount also fails closed (no settle).

## Idempotency

`confirmPayment` is safe to run repeatedly (return page + webhook can both
fire). It claims `(provider, reference, "paid")` in `webhook_events` via a
unique index (`webhook_events_provider_ref_status_uniq`) — only the first
claim performs the status transition; the rest return a no-op. An order
already out of `pending` short-circuits immediately. If the status transition
itself fails, the claim is released so a gateway retry / page refresh can
re-process. Settled `webhook_events` rows are purged after 90 days by the
retention cron (`POST /api/cron/retention`, see [API.md](API.md)).

## Recovery (declines + stuck-pending)

A customer returning to `/order/[id]?pay=return` now sees the REAL outcome: a
paid order is confirmed; a declined/cancelled return shows a "Paiement non
abouti" banner with **Reprendre le paiement** (re-initiates a fresh gateway
session — it first re-verifies the order's PREVIOUS session: if that one is
already paid the order is settled instead (no new session, reference kept); a
payment signal such as an amount mismatch, or an unreachable gateway, refuses the
retry fail-closed) and **Annuler la commande** (both customer actions enforce
ownership + the pending guard server-side). For the customer who never comes
back, the `/api/cron/payments` reconcile sweep re-verifies stale pending online
orders and **auto-cancels a definitive terminal decline** (`failed`/`cancelled`)
— it never touches a still-pending or transient-error order, so a slow payer
isn't cancelled out from under them. `pending → cancelled` restocks + reverses
loyalty/promos via the shared transition workflow.

**Cancel guard (every pending-online cancel).** The customer « Annuler », the
admin status change (single; bulk status changes refuse `cancelled`), the
external order API (`PATCH /api/orders/[id]/status`) and the abandoned-order
sweep all run the same fail-closed pre-flight
(`assertPendingOnlineOrderNotCaptured`, [`gateway-payment.ts`](src/workflows/order/gateway-payment.ts)):
the cancel proceeds only when the gateway DEFINITIVELY reports the payment
uncaptured. A capture (settled on the spot as a side effect) or an amount
mismatch refuses it; so does `payment_in_progress` while the gateway still
reports `pending` and the session was (re)initiated less than 30 min ago
(`updated_at`, `GATEWAY_SESSION_WINDOW_MS`) — the customer may still be on the
payment page / in 3DS; after 30 min a `pending` verdict counts as abandoned. An
unreachable gateway refuses with `payment_unverified` (retry later).

**Late capture on a cancelled order.** A gateway callback or customer return that
lands on a CANCELLED, never-paid online order re-verifies the gateway (max 5/h per
order) and, when it reports PAID, logs `[payment] LATE CAPTURE on a CANCELLED
order` (console.error) for a manual refund — the cancelled order is never
mutated, and the order page tells the customer to contact the shop.

> ⚠️ `NEXT_PUBLIC_SITE_URL` (or the admin `seo.site_url`) MUST be the public
> https origin. The gateway `returnUrl` + Flouci `webhookUrl` derive from it; a
> localhost value hands the gateway a dead return target so a real payment never
> settles. `initiatePayment` now refuses to start (`config` error) on a
> localhost origin, and the production boot guard rejects a localhost
> `NEXT_PUBLIC_SITE_URL` (it's a Docker build arg — a rebuild is required).

## Observability

Two ops events fire on the settlement path (both land in the audit log via the
audit-everything subscriber, filterable per order in **Admin → Système →
Audit**):

- **`webhook.payment.amount_mismatch`** — the gateway reported a payment whose
  amount is null/non-numeric or ≠ the order total. The money guard FAILS CLOSED:
  the order is NOT settled. This is the alarm to watch — a genuinely-paid order
  with a bad amount stays `pending` until an operator reconciles it. Emitted at
  [`gateway-payment.ts`](src/workflows/order/gateway-payment.ts) `confirmPayment`.
- **`webhook.payment.unmatched`** — a callback/return arrived for a payment
  reference no order owns (e.g. a callback that beat the init write). 200-acked
  so the gateway stops retrying, and logged. Emitted by the shared
  [`webhook-handler.ts`](src/lib/payments/webhook-handler.ts).

Every gateway HTTP call has a 10 s timeout (`GATEWAY_HTTP_TIMEOUT_MS`,
[`gateway-rules.ts`](src/lib/payments/gateway-rules.ts)); a timeout is a
`gateway_error` — fail-closed in the cancel guards, **503** from the webhook
routes (so the gateway redelivers). The webhook routes also answer 503 while the
admin webhooks switch (`webhooks.enabled`) is off, 429 above 300 callbacks/min
per IP, and 200 for a terminal outcome (amount mismatch, unknown reference,
already-terminal order). A late capture on a cancelled order is logged as
`[payment] LATE CAPTURE …` (see Recovery).

## Credentials (env force-overrides admin)

Provider credentials resolve through `resolvePaymentConfig` in
[`src/lib/payments/config.ts`](src/lib/payments/config.ts):

    value = (env var, when actually set) ?? (decrypted DB value) ?? ""

Admins can paste credentials in **Admin → Système → Paiement**
(`/admin/system/payments`); they're stored encrypted in the
`payment_provider_settings` table. A set env var force-overrides the DB value
(blank/whitespace env counts as unset, so an empty Coolify field doesn't blank
a working credential). `test_mode` follows the same rule and **defaults to
sandbox**. The resolver is cached ~30s; the admin save action invalidates it.

## Per-provider

### ClicToPay (SMT) — `src/lib/payments/providers/clictopay.ts`
Implemented against the official **ClicToPay Basic 1.0** integration manual
(`Manuel_Integration_ClicToPay_v1.0`) and validated with the merchant recette
(test creds `userName` / `password` set in env or admin — default sandbox
`test.clictopay.com`, prod `ipay.clictopay.com`).
- Auth: `userName` + `password` form params. Creds: `CLICTOPAY_USERNAME`,
  `CLICTOPAY_PASSWORD`, `CLICTOPAY_TEST_MODE`.
- Init: `POST register.do` (params `userName`, `password`, `orderNumber`,
  `amount` in millimes, `currency=788`, `returnUrl` = `failUrl`,
  `dynamicCallbackUrl`, `description`, `language=fr`) → `{ orderId, formUrl }`.
  The customer is redirected to `formUrl`; `orderId` is stored as
  `orders.payment_reference`. `orderNumber` must be unique per merchant and
  AN..32: it is `<order_number>-<ms timestamp>` when that fits in 32 chars,
  otherwise compacted to `<order_number without dashes><base36 ts>` (last 32
  chars) — unique per (re)init (`clictopayOrderNumber`,
  [`gateway-rules.ts`](src/lib/payments/gateway-rules.ts)).
- Verify: `GET getOrderStatusExtended.do` (`{ orderId, language: "fr" }`) →
  `{ errorCode, errorMessage, orderStatus, amount }`. A non-zero `errorCode`
  is a hard error; otherwise `orderStatus === 2` is the ONLY paid state
  (6 = declined → failed, 3/4 = reversed/refunded → cancelled, 0/1/5 = 3DS /
  in-progress → pending). `amount` is millimes. A status read that returns an
  HTTP error or a non-JSON body (proxy outage page) is a `gateway_error`, never
  read as `pending`. Every call has the 10 s gateway timeout.
- Webhook: `GET|POST /api/webhooks/clictopay?orderId=…` (the `dynamicCallbackUrl`
  passed to `register.do`; no signature — we re-verify the `orderId` via
  `getOrderStatusExtended.do`). Real-time settlement through the SAME shared
  handler as Flouci, backed by the customer return page + the
  `/api/cron/payments` reconcile cron; idempotent via `webhook_events`.

### Flouci — `src/lib/payments/providers/flouci.ts`
Verified against the live Flouci docs (docs.flouci.com `/api-reference`) **and**
the official Flouci WooCommerce plugin v2.0.1 — the **v2** API:
- Auth (both calls): a single `Authorization: Bearer <app_token>:<app_secret>`
  header (HTTPS only). Creds: `FLOUCI_APP_TOKEN`, `FLOUCI_APP_SECRET`. Note:
  `FLOUCI_TEST_MODE` is accepted for symmetry but **inert** — Flouci v2 has no
  sandbox host, so test vs live is determined solely by the credentials entered
  (the client never reads `testMode`; the admin sandbox toggle is hidden for it).
- Init: `POST https://developers.flouci.com/api/v2/generate_payment` (JSON body:
  `amount` millimes, `success_link`, `fail_link`, `webhook`, `accept_card`,
  `session_timeout_secs`, `developer_tracking_id`) → `{ result: { link, payment_id } }`.
- Verify: `GET …/api/v2/verify_payment/{payment_id}` → PAID iff top-level
  `success === true` **and** `result.status === "SUCCESS"`; amount at
  `result.amount` (millimes). Other statuses: `PENDING`/`PREAUTH_SUCCESS` →
  pending, `FAILURE`/`EXPIRED`/`SYSTEM_FAILURE` → failed.
- Webhook: `GET|POST /api/webhooks/flouci?payment_id=…` (the `webhook` URL passed
  to generate_payment; no signature — we re-verify via the API). Real-time
  settlement, backed by the return page + the `/api/cron/payments` reconcile cron.
- Both calls have the 10 s gateway timeout (a timeout = `gateway_error`).

> ✅ **ClicToPay** is implemented against the official Basic 1.0 manual +
> recette, and **Flouci** against the official docs + WooCommerce plugin v2.0.1.
> The clients are written defensively (graceful "non configuré" errors when
> creds are missing) so the rest of the app is unaffected until real credentials
> are set.

## Admin toggles

Each gateway is shown on the storefront only when enabled in
**Admin → Système → Paiement** (`/admin/system/payments`) **and** its
credentials are present — the save action refuses to flip
`checkout.payment.{clictopay,flouci}_enabled` (the keys the storefront
reads) to on unless EVERY credential it needs resolves (ClicToPay userName AND
password, Flouci app token AND secret), and reports the refusal. Merchant
credentials and the ClicToPay sandbox toggle are super-admin (`*`) only; a
delegated `system_payments:update` role can only enable/disable the gateways and
the COD method ([`settings-plan.ts`](src/lib/payments/settings-plan.ts)). The same
page hosts the COD settings. These methods
are the single allowed-methods set for BOTH the cart and the express ("Acheter
maintenant") flow — the customer always chooses COD vs an online gateway; there
is no express-only payment routing. If a gateway is enabled but creds later
disappear, `initiatePayment` returns a clear "non configuré" error.

## Local testing

Expose `localhost:3000` with [ngrok](https://ngrok.com/) /
[cloudflared](https://github.com/cloudflare/cloudflared) so the gateway sandbox
can reach the Flouci callback and the return URLs:

```bash
ngrok http 3000
# set NEXT_PUBLIC_SITE_URL to the public URL so return/webhook URLs are correct
```

## Adding a new gateway

1. Add `src/lib/payments/providers/<name>.ts` exporting `initiatePayment` +
   `verifyPayment` (return `InitiateResult` / `VerifyResult` from `shared.ts`),
   resolving creds via `resolvePaymentConfig` in
   [`src/lib/payments/config.ts`](src/lib/payments/config.ts).
2. Register it in `gateway.ts` (`PROVIDERS` + the `GatewayMethod` union in
   `shared.ts`).
3. Extend the `payment_method` enum
   ([src/modules/order/schema.ts](src/modules/order/schema.ts)) + a migration;
   add its credential columns to `payment_provider_settings` if admin-editable.
4. Add it to the `/admin/system/payments` page (which owns the
   `checkout.payment.<name>_enabled` key) + the radio in the checkout forms.
5. Document it here. The init/redirect/verify/transition/audit/receipt flow is
   already wired through the workflows + event bus.

---

# Outbound webhooks (ERP push)

Distinct from the **inbound** payment callbacks above: the store **pushes** its
own event stream to registered ERP endpoints in real time, so an ERP mirrors
every movement without polling. Managed in **Admin → Système → API & Webhooks →
Webhooks sortants (ERP)**.

## Model

1. An admin registers an **endpoint** (name + an http(s) URL — use `https://` in
   production — + the events to subscribe to, or `*` for all; unknown event names
   are dropped). A per-endpoint **signing secret** is shown ONCE and stored
   encrypted (AES-256-GCM, needs `PAYMENT_ENCRYPTION_KEY`) — the ERP keeps it to
   verify deliveries. Creating / toggling / revoking an endpoint needs
   `system_api:create` / `:update` / `:delete`; creation is audited
   (`webhook_endpoint.created` carries the destination host, never the full URL).
2. Every emitted bus event (`order.*`, `product.*`, `stock`-related,
   `customer.*`, `loyalty.*`, …) is fanned out by the `dispatch-webhooks`
   subscriber to each active subscribed endpoint, enqueuing one durable
   `webhook_deliveries` row per (event × endpoint). The subscriber only writes
   rows (best-effort). A `*` subscription does NOT match the security / PII
   domains (see Security below) — an explicit by-name subscription always does.
3. `POST /api/cron/webhooks` (Bearer `CRON_SECRET`, job `webhook_dispatch`)
   drains the queue: it claims up to 200 due rows (`FOR UPDATE SKIP LOCKED`),
   POSTs them as signed JSON through a pool of 8 concurrent workers, marks a row
   `delivered` on a 2xx, else **retries with back-off** (`60 / 300 / 900 / 3600`
   s; 5 attempts by default — the row's `max_attempts` wins) then `failed`. Wire
   it as a Coolify cron `*/2 * * * *`; « Exécuter maintenant » in Tâches
   planifiées runs the same drain. A row claimed by a drain that died is
   re-queued after 20 min.
4. **Kill-switch.** `webhooks.outbound_enabled` (Réglages & Clés → « Webhooks
   sortants activés (ERP) ») stops BOTH the enqueue and the DRAIN: while it is
   off, no new rows are written and the `webhook_dispatch` job returns `skipped`
   (« file conservée ») — already-queued rows and their retries are kept
   untouched and resume when the switch is re-enabled. Use it during an incident
   (compromised or misbehaving endpoint).

## Delivery format

`POST <endpoint.url>` with `Content-Type: application/json` and headers:

| Header | Value |
| ------ | ----- |
| `X-Webhook-Id` | the delivery uuid (use it for idempotency) |
| `X-Webhook-Event` | the event name, e.g. `order.paid` |
| `X-Webhook-Timestamp` | unix seconds |
| `X-Webhook-Signature` | `HMAC-SHA256(secret_key, "<timestamp>.<body>")` hex |
| `User-Agent` | `TokyoStore-Webhooks/1.0` |

Body: `{ "id", "event", "occurredAt", "data": <event payload> }`. Payloads are
intentionally thin (ids + a few fields) — the receiver calls the read API
(`GET /api/orders/[id]`, `/api/customers/[id]`, …) to hydrate. Delivery is
at-least-once (a retry or an admin « Renvoyer » re-POSTs the same `X-Webhook-Id`),
so dedupe on it.

**Receiver contract.** Answer 2xx quickly. Any other status — including a 3xx
(redirects are NOT followed) — counts as a failed attempt. Each POST is
hard-capped at 30 s (DNS 5 s + request 10 s, under a 30 s per-delivery deadline);
a timeout counts as a failed attempt toward the attempt cap. The response body is
read up to 64 KiB then the connection is closed, so a large response can't stall
the queue.

**Verify** a delivery: recompute the signature over `` `${timestamp}.${rawBody}` ``
with the endpoint secret and constant-time compare against `X-Webhook-Signature`;
reject a stale `X-Webhook-Timestamp`. The signing key is
`HMAC-SHA256(secret, "webhook-v1")` (see `signWebhookBody` in
[`src/modules/webhook-endpoints/service.ts`](src/modules/webhook-endpoints/service.ts)).

## Security

- Delivery uses the **SSRF-hardened** outbound fetch
  ([`src/lib/net/ssrf-fetch.ts`](src/lib/net/ssrf-fetch.ts)): an endpoint URL that
  resolves to an internal/private host is refused (terminal, never retried), so a
  webhook can't be used to reach internal services. The resolved public IP is
  pinned for the connection (no DNS-rebinding window).
- **Data minimisation:** a `*` (all-events) subscription does NOT receive
  security / PII telemetry — `auth.*`, `rbac.*`, `api_key.*`, `user.*` and
  `data.*` (the bulk-export trail). An integration that needs one of those must
  subscribe to it by its exact event name (explicit opt-in).
- Secrets are encrypted at rest and only decrypted at delivery time; a revoked
  endpoint (or an undecryptable secret) fails its queued rows terminally.
- Deliveries are retained 90 days (`webhook_deliveries` target of the retention
  cron) then purged.

## Delivery log

**Webhooks sortants (ERP)** lists the 50 most recent deliveries (status, HTTP
code, attempts, last error) with two filters kept in the URL —
`?deliveries=failed` (« Échecs uniquement », so a failed delivery stays findable
after newer traffic) and `?endpoint=<uuid>`. « Renvoyer » re-queues a delivery
with a fresh set of attempts (a row a drain currently owns is skipped, never
double-sent).

## Event notes for integrators

The bus has **215 events** across 49 domains — the list is the **Évènements**
admin tab / [event-catalog.ts](src/lib/api-auth/event-catalog.ts) (generated from
`src/events/types.ts`, which holds the payload shapes). Semantics worth knowing:

- **`order.paid` = payment settled.** Emitted when a transition stamps `paid_at`:
  at `paid` for upfront methods (Flouci / ClicToPay, cash, virement) and at
  `delivered` for COD (cash collected on delivery). `data.settledAt` says how:
  `"gateway"`, `"manual"` (operator-recorded offline payment) or `"delivery"`
  (COD). Treat it as idempotent per `orderId`.
- **`order.edited`** also fires when the ERP link changes (`changedFields:
  ["external_ref"]`) and for invoice-TVA corrections (`["tax_cents",
  "tax_manual_cents"]`, plus `"total_cents"` when a tax-on-top order's total was
  rebuilt).
- **`product.updated`** — `changedFields` lists only the fields whose value
  actually changed; associations (categories, brand, media, attributes,
  attribute scalars, related, complementary, tier release) appear only when the
  set differs. A save that changes nothing emits nothing. API stock writes emit
  it with `["stock_qty", "in_stock"]`.
- **`category.updated`** — a SINGLE event covers every category change; there is
  no dedicated reorder/activate event. `changedFields` holds the changed DB
  **column** names (not the camelCase DTO keys, and never the new value): a form
  save lists its edited columns, a drag-reorder emits `["display_order"]`, the
  list (de)activation toggle emits `["is_active"]` (deactivating hides the whole
  subtree on the storefront), and a bulk-TVA edit emits `["tax_rate_bps"]`.
  Re-fetch `GET /api/categories?id=<uuid>` to read the new value — the
  `ApiCategory` shape now round-trips every writable field (`displayOrder`,
  `isActive`, tax/warranty, hero/og/icon media, editorial + `valueProps`).
  Category **FAQs** are intentionally NOT part of `ApiCategory` (they are CMS-only,
  authored in the admin FAQ tab); the flat category list is also unpaginated (the
  category set is small and bounded), unlike the keyset-paginated products/orders
  lists.
- **`category.filter_attributes.updated`** — a SEPARATE event fired when a
  category's attribute-filter set changes (`{ categoryId, attributeIds }`). The
  base `GET /api/categories` endpoint does NOT carry filter attributes; read the
  new set from the dedicated sub-route `GET /api/categories/<slug>/attributes`.
- **`brand.updated`** (+ `brand.created` / `brand.deleted`) — a SINGLE event covers
  every brand change (form save, inline activate toggle → `["is_active"]`, the
  `/admin/system/tax → Marques` bulk edit → `["tax_rate_bps"]`, and a drag-reorder →
  `["display_order"]`). `changedFields` holds the changed DB **column** names (not
  the camelCase DTO keys, and never the new value) — note the logo column is
  `logo_media_id`. Re-fetch `GET /api/brands?id=<uuid>` to read the new value — the
  `ApiBrand` shape round-trips every writable field (`displayOrder`, `isActive`,
  `isDiscountable`, `taxRateBps`, logo/hero/og/icon media, editorial + `valueProps`,
  meta/canonical/noindex). Brand FAQs are CMS-only, not part of `ApiBrand`. Brands
  are flat — there is no reorder-scope/parent and no attribute-filter sub-route.
- **`catalog.review.*`** — the moderation lifecycle: `created` (a customer PDP
  submission), `created_manual` (an admin-authored / seeded review), `status_changed`
  (approve ↔ reject), `deleted`, and `bulk_deleted` (the « supprimer tous les IA /
  manuels » cleanup, `{ source, deletedCount }`, no product keys — it spans many
  products). Every per-review event carries ERP keys an integration can resolve on
  without a second call: `productId` **plus** `sku` / `gtin` / `externalRef` (any may
  be `null` when the product lacks that identifier; `deleted` still resolves them
  even for a since-removed product). `created` / `created_manual` / `status_changed`
  carry the moderation `status` (`"pending"` | `"approved"` | `"rejected"`) so a
  consumer knows whether the review is publicly visible; `created` / `created_manual`
  also carry `rating` (1–5). NOTE: whether AI (`source='ai'`) and manual
  (`source='manual'`) reviews count toward the PUBLIC star rating (the PDP
  AggregateRating, the product feeds) is an operator setting (Avis → Réglages →
  « Note publique », `reviews.rating_source`); these events fire regardless of it.
- **`customer.profile_updated`** — `data.userId` is the customer's linked account
  (`null` for a standalone profile), never the admin who edited it. On an ERP
  write (`/api/customers`) `changedFields` lists the columns the request SENT,
  not a diff — only an idempotent re-link (`PUT { id, externalRef }` repeating the
  stored ref, no other field) emits nothing.
- **`customer.deleted`** — emitted once per archive; « Supprimer le client » on a
  customer-role account also emits `user.disabled`, `user.sessions_revoked` and
  one `api_key.revoked` per revoked key (security domains: by-name subscription
  only).
- **`loyalty.tier_changed`** — the customer's niveau ("Le Cercle de Famille")
  crossed a boundary. Payload carries `fromLevelId` / `toLevelId`,
  `cumulativeSpendCents`, `paidOrderCount` and `direction: "up" | "down"`: up on
  an order-spend accrual (or an admin change that raises the niveau), down on the
  reversal of a cancellation or full refund (`toLevelId` may be `null` below the
  first level). Not fired for unlinked profiles, while loyalty is disabled, or
  when the move doesn't cross a level boundary (a niveau shifts only on the
  customer's own `cumulativeSpendCents` / `paidOrderCount` change).
- **`promotion.updated`** — `scope` / `scopeId` are the promotion's target AFTER
  the update. **`promotion.redeemed`** also fires for free-shipping-only
  redemptions (`discountCents: 0`).
- **`business.allocation.changed`** — `"removed"` also carries `businessId` +
  `levelId`, and each employee whose level was revoked gets a
  `business.member.level_changed` with `levelId: null`.
- **`stock_location.*`** — emitted by the Emplacements actions; `.updated`
  carries `changedFields` ⊂ {name, code, carrier_ref, is_active, is_default} and
  `isActive` only on a real (de)activation.
- **`stock.transfer.requested` / `.completed` / `.cancelled`** — inter-location
  moves. Emitted from the service, so EVERY path announces: manual, the
  order-driven auto-request (`source: "auto"`, `orderId` set), and the
  order-cancel cascade. Only `.completed` means stock actually MOVED (the sellable
  TOTAL is unchanged — units relocated). `requested` + `completed` carry ERP keys
  an integration can resolve on: `fromCode` / `toCode` (location `code`) and
  `items[]` with `sku` / `externalRef` (not just UUIDs). NOTE: today these fire
  regardless of the ERP tab's push toggles (delivered to any subscribed endpoint);
  toggle-gating + authority enforcement are Phase 2.
- **`setting.upserted`** — only on a real change (re-saving an unchanged panel
  emits nothing); security-relevant, non-secret keys carry `from` / `to`.
- **`redirect.created` / `redirect.updated`** carry `destination`; an update also
  carries `changedFields` and `previousDestination` when the target changed.
- **`media.bulk_deleted`** — the Médiathèque bulk delete emits it (`mediaIds` =
  ids actually deleted, `storageKeys: []`) on top of the per-row `media.deleted`.
- **Security-domain events** (by-name subscription only): `user.password_changed`,
  `user.email_changed` (masked old / new), `user.email_verified` (every
  self-service verification, incl. the new address after an email change),
  `user.two_factor_enabled` / `_disabled`, `auth.oauth_settings_updated`
  (`provider`, `changedFields`, never a value) and `data.exported`
  (`{ resource, count }` for every admin CSV export).
- **Bulk paths emit no per-entity events.** Product import, demo seed and the
  clean / clear jobs do not emit `product.created`, `brand.created`,
  `category.*`, …; subscribe to `import.products_completed` and
  `demo.imported` / `demo.cleared` / `demo.purged`, then resync through the read
  API.

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](CREDITS.md).

