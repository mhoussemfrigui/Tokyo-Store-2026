# Module pattern

The Tokyo Store architecture is a **modular monolith inspired by Medusa.js**.
This document is the canonical specification — every module merged into
`main` must conform.

The reference corpus we curated from lives at
`C:\Users\moham\OneDrive\Desktop\Work\.SKILLS\Medusa` (Medusa Agent Skills
+ learn-medusa + medusa-dev). Where Medusa's primitives don't have a clean
Next.js equivalent we adapt — those adaptations are called out explicitly
in §3 below.

---

## Table of contents

1. [The five rules](#1-the-five-rules)
2. [Per-module file layout](#2-per-module-file-layout)
3. [Medusa ↔ Tokyo Store mapping](#3-medusa--tokyo-watch-store-mapping)
4. [Cross-module associations](#4-cross-module-associations)
5. [Workflows](#5-workflows)
6. [Events & subscribers](#6-events--subscribers)
   - [6.1 Mailing — the single email send path](#61-mailing--the-single-email-send-path)
7. [API routes & admin UI](#7-api-routes--admin-ui)
   - [7.1 External keyed API (ERP)](#71-external-keyed-api-erp)
   - [7.2 SEO — metadata, structured data & crawl files](#72-seo--metadata-structured-data--crawl-files)
   - [7.3 Redirects & the 404 page](#73-redirects--the-404-page)
   - [7.4 Tracking & Analytics](#74-tracking--analytics-gtm--ga4--meta-pixel--consent-mode-v2)
   - [7.5 Currency, product condition & delivery time](#75-currency-commandes--devises-product-condition--delivery-time)
   - [7.6 Recherche](#76-recherche-search-engine--control-center)
   - [7.7 Infrastructure → Performance & Database](#77-infrastructure--performance--database-runtime-monitoring)
   - [7.8 Infrastructure → Sécurité](#78-infrastructure--sécurité-owasp-control-center)
8. [Adding a new module — walked example](#8-adding-a-new-module--walked-example)
9. [Conformance checklist](#9-conformance-checklist)
10. [Common pitfalls](#10-common-pitfalls)
11. [Cheat sheet](#11-cheat-sheet)

---

## 1. The five rules

These are non-negotiable. They mirror Medusa's "isolation, orchestration,
rollback, separation" axes — every audit checks against them.

1. **One folder per domain.** Every module lives in `src/modules/<name>/`
   and owns its tables, services, queries, and types.

2. **No cross-module foreign keys in code.** No module's `schema.ts` declares a
   `.references()` to another module's table. When two modules need to know
   about each other, the join lives in `src/associations/` as a soft-linked
   table (uuid/text columns, not `references()`). This is the equivalent of
   Medusa's Module Link layer. The database itself does carry a fixed set of
   cross-module `FOREIGN KEY`s, written in migration SQL; they are listed in
   [Cross-cutting invariant 2](#cross-cutting-invariants). Don't add one without
   adding it to that list.

3. **Services do CRUD. Workflows orchestrate.** A service exposes
   `findById`, `insert`, `update`, `softDelete`, `list`. A workflow composes
   multiple services, runs inside `db.transaction()`, handles rollback,
   and emits domain events. **Pages and Server Actions call workflows for
   any mutation** — they never reach for `service.insert(...)` directly.

4. **Events decouple side effects.** Workflows emit typed events
   (`product.created`, `order.paid`, …). Subscribers in
   `src/events/subscribers/` listen and react: email, audit log,
   `revalidateTag()`. Workflows must not know subscribers exist.

5. **Validation at the boundary.** Zod schemas live next to the Server
   Action / API route / workflow they protect. Once parsed, downstream
   code trusts the data — no defensive re-validation deeper in.

## 2. Per-module file layout

### Module inventory

Every business domain with its own tables lives under `src/modules/`. The
current set (Glob `src/modules/*/`):

| Module        | Owns (tables, abbreviated)                                              | Notes |
| ------------- | ---------------------------------------------------------------------- | ----- |
| `auth`        | `users`, `sessions`, `accounts`, `verifications`, `two_factors`        | better-auth core; the one place intra-module `.references()` FKs are kept (mirrors better-auth's generated schema). `two_factors` (migration 0070) + `users.two_factor_enabled` back the optional opt-in TOTP 2FA (twoFactor plugin); session lifetime + cookie-cache are admin-tunable via `site_settings` `auth.session.*` (read in `buildAuth`). Expired sessions/verifications are purged by the daily retention cron. |
| `customer`    | `customer_profiles`, addresses, `customer_segments`, `customer_segment_members` | profile + `promo_opt_out` + optional `birthday` (drives the `birthday_month` segment rule, 0044); segments = reusable manual+dynamic promo-targeting audiences (0042); dynamic-rule vocabulary (`marketing_opted_in` · `has_orders`/`no_orders` · `birthday_month` · `birthday_today` · `min_lifetime_spend:<millimes>` · `min_purchases:<n>`) lives in `lib/promotions/segment-rules.ts`; soft-linked to `users`. « Supprimer le client » (`workflows/customer/delete-customer.ts`) runs in a fail-safe order (login offboarded first, profile archived last), is idempotent over an already-archived profile and refuses self-deletion (`self_action`) |
| `rbac`        | `roles`, `role_permissions`, `user_roles`                              | RBAC engine — DB roles + permission grants + user↔role links; permission KEYS live in code (`src/lib/rbac/registry.ts`). Migrations 0033/0034 |
| `catalog`     | sub-modules: `brand` · `category` · `product` · `attribute` · `review` · `product-gen` · `content-gen` | flat sub-module layout (see below) |
| `cms`         | sub-modules: `setting` · `faq` · `banner` · `navigation` · `page` · `trust_badge` | settings KV + relational page builder + menus + reassurance strip (product/cart/checkout). The `banner` placement enum carries the **mega-menu featured-image** placements médiathèque-driven, resolved by `getNavFeaturedBanner` in `(shop)/layout.tsx`: the live `nav_boutique`/`nav_marques`/`nav_maison` (one per top-level nav dropdown — Boutique/Marques/Maison); the legacy `nav_collection`/`nav_fidelite` labels remain in the enum (DB-mirror only) now that the Collections/Fidélité dropdowns are gone (migrations 0085, 0096) |
| `cart`        | `carts`, `cart_items`                                                  | |
| `order`       | `orders`, `order_items`, `order_status_history`, `order_refunds`, `shipments`/`shipment_items`, `order_returns`/`order_return_items` | `*_cents` columns hold millimes; `delivery_*` snapshots. Beyond place/transition/refund/returns/shipments: `workflows.order.setExternalRef` (`set-external-ref.ts`: ERP link, idempotent, `already_linked` / `external_ref_conflict`, clearing needs `unlink: true`, emits `order.edited`) and `workflows.order.setInvoiceTax` (`set-invoice-tax.ts`: locked, refused once a facture is issued, emits `order.edited`). `settleZeroTotalOrderWorkflow` (`gateway-payment.ts`, imported directly by `lib/actions/order.ts`) moves a pending online order whose total is 0 straight to `paid` (reference `zero-total`) instead of sending it to a gateway |
| `warranty-claim` | `warranty_claims` (single row per claimed order line) | Warranty CLAIMS (SAV / RMA), migration 0166 — layered on the (pure) warranty coverage engine (`src/lib/warranty`). A claim is raised against ONE `order_item_id` a customer brings in for service; status `open → in_repair/awaiting_parts → resolved/rejected` (pgEnum `warranty_claim_status`); the coverage is SNAPSHOTTED at claim time (`warranty_months`/`_label`/`covered_until`/`was_covered` from `computeOrderLineWarranty`) so the record shows entitlement even after the product's warranty config changes. Workflows `order.warranty.{createClaim,updateClaim,resolveClaim}` (FOR UPDATE lock, one active claim per unit, terminal-status idempotency) emit `warranty.claim.created/updated/resolved` (outbound-webhooked; the ERP `erp.push_warranty` axis records the posture). Two-way ERP sync: `GET/POST /api/warranty-claims` + `GET/PATCH /api/warranty-claims/[id]` (`warranty:read`/`write`; PATCH resolves by uuid OR `external_ref`). Admin: `/admin/orders/warranty` = « Recherche » (coverage lookup) + « Réclamations » console (`warranty:manage`; the module is now VIEW_MANAGE). `product_id`/`variant_id` are SOFT links (no FK) |
| `webhook`     | `webhook_events`                                                       | INBOUND payment-provider idempotency ledger |
| `webhook-endpoints` | `webhook_endpoints`, `webhook_deliveries`                        | OUTBOUND webhooks (ERP push, migration 0118): admin-registered endpoints (HMAC secret encrypted at rest) + a durable delivery queue drained by `/api/cron/webhooks` (`webhook_dispatch` job). Fed by the wildcard `dispatch-webhooks` subscriber; a `*` subscription never receives the `SECURITY_DOMAINS` (`auth`, `rbac`, `api_key`, `user`, `data`). `webhooks.outbound_enabled` off also pauses the drain (queued rows are kept) |
| `tax`         | `tax_rules` (per-attribute-value rate filters)                        | pure engine lives in `src/lib/tax` |
| `delivery`    | `delivery_agents`, `pickup_locations`, `delivery_zones`, `delivery_agent_zone_rates` (0048) | resolver in `src/lib/checkout/delivery.ts`. Zone workflows live in `src/workflows/delivery/zone.ts` (`delivery.zone.*` events; a zone and its courier rates are saved in one transaction); they are imported directly by `lib/actions/delivery.ts`, not registered under `workflows.delivery` |
| `currency`    | `currencies` (code/name/symbol/position/decimals/`is_active`)         | ONE global active currency (partial unique idx `WHERE is_active`); **relabels** display/JSON-LD/new-order snapshot only — NO conversion; `getActiveCurrency` (TND fallback, `src/lib/currency/active.ts`); pure helpers in `currency/normalize.ts`; admin Commandes → Devises, RBAC `system_currency` (0078) |
| `mailing`     | `email_template_overrides`, `email_logs`, `email_flows`, `email_campaigns`, `mailing_sends`, `email_suppressions` | source of truth for ALL email: `dispatchEmail` chokepoint (logs every send + redacts sensitive bodies + gates marketing on consent + injects an unsubscribe footer); flow registry/toggle (`isFlowEnabled`); durable queue drained by `/api/cron/mailing`; campaigns + automations (birthday, promo blast, price-drop, shipped/delivered, back-in-stock, review). Admin hub at `/admin/marketing/mailing`, nav group Système (0045). See [§6.1](#61-mailing--the-single-email-send-path) |
| `blog`        | `blog_posts`, `blog_categories`, `blog_tags`, `blog_post_tags` (N-N) | HTML body (sanitized at render); posts soft-delete + restore; `category_id` FK → `blog_categories` ON DELETE SET NULL + a `published⇒published_at` CHECK (0059); slug-unique. Storefront `/blog` (index/[slug]/category/tag); tag archives are noindex,follow (thin) |
| `aid_center`  | `aid_articles`, `aid_categories`, `aid_article_steps` (1-N) | step-by-step how-tos; articles soft-delete + restore; `category_id` FK → `aid_categories` ON DELETE SET NULL; `aid_article_steps.article_id` uuid FK → `aid_articles` ON DELETE CASCADE + `published⇒published_at` CHECK (0059); `view_count`. Storefront `/aide` (guides) — distinct from `/help` (FAQ + contact, CMS) |
| `media`       | `media`, `media_settings`                                             | SeaweedFS + sharp pipeline; multi-surface layout (below) |
| `audit`       | `audit_log`                                                           | written by the wildcard subscriber |
| `newsletter`  | `newsletter_subscriptions`                                            | staff opt-out `unsubscribeSubscriberWorkflow` (`workflows/newsletter/unsubscribe.ts`, imported directly by `lib/actions/newsletter.ts`); the row is kept as the suppression record, never hard-deleted |
| `promotion`   | `promotions`, `promotion_redemptions`, `promotion_targets` (product/category/brand/coupon/URL) | `promotion_targets` = admin-set multi customer/segment targeting; max-cap / free-ship params. Targeting fails closed: a create/update whose submitted targets ALL fail to resolve is refused (`fieldErrors.targets`), and existing targets are never re-validated away on edit. `workflows.promotion.duplicate` clones as an INACTIVE draft with a placeholder code/slug (`<CODE>-COPIE-XXXX`) and emits `promotion.created`. A **category-scoped** auto-promotion CASCADES to sub-categories — a product filed only on a leaf receives a promo targeting any ancestor category (`expandCategoryIdsWithAncestors` in `promotion/queries.ts`, applied at the 3 category match points); the per-category **non-discountable opt-out** does NOT cascade (it stays keyed on the product's direct category links) |
| `payment`     | `payment_provider_settings` (encrypted creds)                        | env vars force-override; admin `/admin/system/payments` |
| `oauth`       | `oauth_provider_settings` (encrypted Google/Facebook creds)          | env vars force-override; admin `/admin/system/auth` (social login). Save / « Supprimer les identifiants » go through `workflows/auth/upsert-oauth-settings.ts` (emits `auth.oauth_settings_updated`, never a value; imported directly by `lib/actions/auth-settings.ts`) |
| `cart-event`  | `cart_events`                                                        | append-only add-to-cart event log (GA4-style); powers "produits les plus ajoutés au panier" segmented client vs. visitor; retention-purged |
| `document`    | `document_sequences`                                                 | gapless per-(kind, period) counters for fiscal/logistics docs (factures/avoirs/bons de livraison); number bumped atomically via INSERT … ON CONFLICT … RETURNING |
| `ai`          | `ai_provider_settings`, `ai_feature_prompts`, `ai_call_logs`         | encrypted provider creds (AES-256-GCM) + per-feature/task generation prompts + a transport-level call log (0111); env vars force-override; admin `/admin/system/ai`. A prompt equal to the code default is stored NULL; `ai.feature_prompts_updated` fires only on a real change. TWO chokepoints share the credential/base-url resolution + never log the key: TEXT generation via `generateText` (`src/lib/ai/client.ts`), and EMBEDDINGS via `generateEmbedding`/`generateEmbeddings` (`src/lib/ai/embed.ts`, powers semantic search) — a cost/SSRF audit must cover BOTH. `ai_call_logs` is bounded by the daily retention cron (14 d) |
| `ai-assign`   | `ai_assign_jobs`, `ai_assign_proposals`                             | background AI categorize/brands/attributes with a dry-run → apply flow (proposals are admin-toggleable before commit) |
| `ai-jobs`     | `ai_job_logs`                                                       | shared append-only per-item log feed across the AI generators (product-gen / content-gen / review-gen / auto-assign), keyed by `(job_kind, job_id)`; written best-effort + capped per job by the runners, read beside the progress bar via `getAiJobLogsAction` (the newest 650 lines; the viewer says « Journal tronqué » when older ones are hidden); pruned by age (0071) |
| `api-key`     | `api_keys`                                                          | SHA-256-hashed, scoped keys for the EXTERNAL HTTP API; plaintext shown once, only the hash stored |
| `api-settings`| (none — KV rows in `app_secrets`)                                  | service-only coordination module: external-API + incoming-webhook kill-switches + public-route allowlist (no public route by default) |
| `import`      | `import_jobs`                                                       | background data jobs: file-upload product imports + bundled demo seed/clean (one table backs all three flows); single-flight through `importJobService.createIfIdle()` (see §5) |
| `jobs`        | `job_run_log`                                                       | execution history for scheduled/cron job runs; powers the `/admin/system/jobs` "Tâches planifiées" dashboard. EVERY scheduled task is centralized: the registry is `src/lib/jobs/registry.ts` (`SCHEDULED_JOBS`, 9 jobs); the 8 external Coolify crons (retention, mailing, birthday, review-request, payment_reconcile, abandoned-orders, product_detourage → `/api/cron/detourage`, webhook_dispatch → `/api/cron/webhooks`) all run through the shared `runScheduledJob` (`src/lib/jobs/run-job.ts`) — per-job kill-switch (`jobs.<key>.enabled` in site_settings, cron-only) → `runAndLog` (a THROW is recorded `failed`, never lost) → one `ok\|skipped\|failed` row. The dashboard "run now" (`runJobNowAction`) and the cron route take the IDENTICAL path; the internal review scheduler uses its own `runAndLog` + `review_schedule.enabled`, and arming it / "run now" on it from the dashboard needs `reviews:manage`. History is pruned on record: per job the latest 100 real runs + 20 no-op (« Ignoré ») runs + always the latest failure. |
| `stock-movement` | `stock_movements`                                               | append-only ledger; one signed-delta row per stock change (sale/return/admin/API/sync), never updated or deleted; `location_id` (0103) tags per-location edits. Removing a tracked variant (variant editor, or the variable→simple demotion in the product form) writes an `admin` row −old → 0 (« variante supprimée »); tracking switches are delta-0 markers whose `resulting_qty` re-baselines the line (null = untracked; « suivi désactivé » / « suivi activé »). Returns on a SHARED-pool variant are ledgered at product level (`variant_id` null) |
| `stock-location` | `stock_locations`, `stock_levels`                               | OPT-IN multi-location inventory (0103). Default single pool: `products`/`product_variants.stock_qty` stay the authoritative sellable TOTAL; when `inventory.location_mode = per_location`, `stock_levels` is the per-store detail and the totals are the cached SUM across active locations (maintained delta-based in `stockLocationService.setLocationLevel`, which rejects inactive/deleted-location edits + reports the back-in-stock flip). (De)activating a location moves the totals by DELTA via `setLocationActive` (ledgered, symmetric, never a Σ(levels) recompute, so sold units are never resurrected); `stock_location.*` events. `carrier_ref` optionally soft-links a location to a delivery agent/pickup point (display-only today); `code` is its ERP id. Managed at Catalogue → Stock → « Emplacements » sub-tab; the old `/admin/catalog/locations` route redirects to `/admin/catalog/stock?tab=emplacements` |
| `stock-transfer` | `stock_transfers`, `stock_transfer_items`                    | Inter-location stock MOVES (store↔the selling depot), opt-in with multi-location (0127). A transfer is a request that walks requested→accepted→in_transit→completed (or →cancelled); physical stock moves ONLY on completion via `stockLocationService.moveStockTx` (source level −qty, dest +qty, two `transfer` ledger legs), so the sellable `stock_qty` TOTAL is invariant (units relocate). `order_id` links an order-driven auto-request (source `auto`, created on `order.created` when the depot can't fill — `lib/inventory/auto-transfer.ts`); a shared-stock line is redirected to the product POOL. Emits `stock.transfer.requested/completed/cancelled` (payloads carry location codes + line sku/external_ref for ERP webhooks). Cancelling an order cancels its non-terminal transfers. Gated on `stock:update` + `inventory.transfers_enabled`. UI: Catalogue → Stock → « Transferts » (server-paginated) + a printable `Bon de transfert`. The ERP posture tab is recorded-not-yet-enforced (Phase 2) |
| `showcase`    | `showcase_pins` (manual product pins for the controllable collection pages) | |
| `wishlist`    | `wishlists`, `wishlist_items`                                         | guest token XOR `user_id`; opt-in PUBLIC sharing (`is_public`/`public_slug`/`public_display_name`) at `/u/<slug>`, gated by `social.favorites_public_enabled` (off by default); admin Favoris tab (`favorites` RBAC) for stats + moderation (`0057`/`0058`) |
| `search`      | `search_log` (FTS telemetry), `search_aliases` (synonyms, 0114)      | the `search_vector` tsvector columns live ON the indexed tables; `products.embedding vector(1536)` (0112, semantic search) is a raw-SQL column, also not a Drizzle field. Engine is admin-tunable (`search.*` settings) + aliases + semantic — see [§7.6](#76-recherche-search-engine--control-center). Alias CRUD goes through `workflows/search/aliases.ts` (`search_alias.created/updated/deleted/seeded`), imported directly by `lib/actions/search-aliases.ts` |
| `redirects`   | `redirects` (`source_path` unique · `destination` · `status_code` 301/302/307/308 · `is_active` · `hits`/`last_hit_at`) | admin-managed URL redirect map (Système → Redirections & 404); per-request point lookup on the unique `source_path` (`src/lib/redirects/resolve.ts`), master toggle `redirects.enabled` (site_settings). The same surface also backs the editable 404-page copy (`notfound.*` in `src/lib/redirects/config.ts`). Migration `0076` |
| `instance`    | `app_instance_heartbeats`                                            | one row per Node process boot, refreshed by the runtime sampler; drives the Infrastructure → Performance uptime/downtime view (restarts + outage windows across redeploys). Migration `0080`. See [§7.7](#77-infrastructure--performance--database-runtime-monitoring) |

Cross-module joins live in `src/associations/` (§4), never as a module:
`customer-user`, `product-category`, `product-brand`, `product-media`,
`product-related`, `product-complementary` (tables) +
`catalog.service.ts`, `customer-user.service.ts` (helpers).
`product-complementary` is a SECOND, manual-only product↔product cross-sell (the
PDP "Accessoires supplémentaires" row), parallel to `product-related` but with no
derived/AI mode.

A handful of "engine" concerns are pure libraries under `src/lib/`, not
modules, because they own no tables of their own: `src/lib/tax` (TVA
cascade + compute), `src/lib/checkout/delivery.ts` (delivery resolution),
`src/lib/price.ts` (money SSOT), `src/lib/links` (link-target shared
module consumed by `cms/navigation`).

### The canonical shape

```
src/modules/<name>/
├── schema.ts        # Drizzle pgTable definitions — no cross-module FKs
├── service.ts       # CRUD class with methods on this module's tables only
├── queries.ts       # Read-side helpers — aggregates, joins within module
├── types.ts         # Optional — derived types / DTOs that diverge from schema
└── index.ts         # Public surface — re-exports queries, types, helpers
                     # Services are NOT re-exported (workflows import them directly)
```

This is the *typical* shape, not a rigid one. Two deviations are normal:
a **table-less coordination module** may be service-only — e.g. `api-settings`
owns no schema and is just a `service.ts` over KV rows in `app_secrets`; and a
**smaller module** often folds its reads into `service.ts` rather than carrying
a separate `queries.ts`. Add files only when a module genuinely needs them.

Some modules expose more than one logical surface and may add files. The
Media module is the canonical example:

```
src/modules/media/
├── schema.ts                  # `media` table
├── settings.schema.ts         # `media_settings` singleton table
├── service.ts                 # CRUD on `media` (incl. paginated `list()`)
├── settings.service.ts        # Singleton get/update on `media_settings`
├── queries.ts                 # Read-side: findMediaByIds, resolveUrlById,
│                              # resolveUrlMap, resolveSocialUrlMap,
│                              # listOrphans / countOrphans,
│                              # listReferencedMediaIds (batched in-use check),
│                              # listOrderReferencedStorageKeys, countMediaReferences
├── url-resolver.ts            # Sync URL resolvers over a MediaRow:
│                              # resolveMediaUrl (AVIF-first display),
│                              # resolveMediaThumbUrl + resolveMediaSocialUrl
│                              # (webp-first, AVIF-avoiding)
├── cdn-base.ts                # Effective CDN base resolver (DB cdn_base_url →
│                              # MEDIA_CDN_URL env → "" same-origin /cdn proxy);
│                              # getCdnBaseSync / primeCdnBase / invalidateCdnBase
├── cdn-allowlist.ts           # Build-time media host allow-list (a CDN base
│                              # outside it is ignored at runtime)
├── limits.ts                  # Framework-free upload-limit constants
│                              # (DEFAULT_MAX_UPLOAD_MB, MAX_UPLOAD_MB_CEILING,
│                              # BULK_MEDIA_MAX)
├── validation.ts              # Framework-free upload-scope + url_override rules
├── image-safety.ts            # Pure: sharp decode limits + EXIF-stripped originals
├── processor.ts               # Pure helper: sharp pipeline (upload-time)
├── white-bg.ts                # Pure helper: uniform-backdrop détourage
│                              # (removeUniformBackground — edge flood-fill)
├── reprocess-detourage.ts     # Pure helper: shared per-row détourage transform
│                              # for the in-app job + offline back-fill script
├── reprocess-source.ts        # Pure: source selection for that re-process
├── storage.ts                 # Pure helper: S3 client + variant key derivation
└── index.ts                   # Barrel — re-exports mediaQueries + DTOs +
                               # the resolveMedia* URL resolvers +
                               # mediaSettingsService (singleton needs to
                               # be reachable from storefront resolvers)
```

The rule: **every additional file must do one thing**, name it after that
thing, and put it next to the rest of the module. Don't create sub-folders
inside a module — flat is fine at this scale (~50 files max per module).

### Sub-domains (catalog, cms)

Domains with multiple distinct concepts use a flat **sub-module** layout.
Two domains do this today:

```
src/modules/catalog/
├── _shared/types.ts          # Cross-sub-module types (e.g. CategoryValueProp)
│                             # so siblings never cross-import each other's schema
├── brand/{schema,service,queries,index}.ts
├── category/{schema,service,queries,index}.ts
├── product/{schema,service,queries,index}.ts
├── attribute/{schema,service,queries,index}.ts
├── review/{schema,service,queries,index}.ts
│         + config.ts          # Generation defaults / scope + tuning shapes
│         + status.ts          # Review-status (pending/approved/rejected) helpers
│         + generation-service.ts  # AI review generation (jobs + drafts)
│         + schedule-service.ts     # Internal scheduler (cadence; no external cron)
├── product-gen/{schema,service,index}.ts   # bulk AI product-content jobs + drafts
├── content-gen/{schema,service,index}.ts   # bulk AI category/brand content
└── index.ts                  # Parent barrel — re-exports brand/category/product

src/modules/cms/
├── setting/{schema,service,queries,index}.ts      # key/value site settings
├── faq/{schema,service,queries,index}.ts
├── banner/{schema,service,queries,index}.ts       # scheduled banners
├── navigation/{schema,service,queries,index}.ts   # menus + menu items
├── page/{schema,service,queries,index}.ts         # relational page builder
└── trust_badge/{schema,service,index}.ts          # reassurance strip (product/cart/checkout via shared TrustStrip)
```

Both reach paths are valid:

```ts
// Targeted — best when only one sub-module is needed:
import { brandQueries } from "@/modules/catalog/brand";

// Aggregated — best in pages that span the whole domain:
import { brandQueries, categoryQueries } from "@/modules/catalog";
```

The catalog parent barrel re-exports only `brand` / `category` / `product`;
`attribute`, `review`, `product-gen` and `content-gen` are
reachable **only** by their direct sub-module path. Sub-module services (`brandService`, `productService`,
`categoryService`, …) are deliberately **not** re-exported by the parent —
services stay internal per Rule 3. Workflows reach into each sub-module
directly via its own `./service` path.

The **`review`** sub-module owns `product_reviews` — note its `source`
column (`customer` | `manual` | `ai`: real shopper submission vs. admin-authored
seed vs. bulk/scheduled AI generation, so moderation can filter and bulk-clean
fakes) — plus the AI-generation tables `review_generation_jobs`,
`review_generation_drafts` (a dry-run → apply flow like ai-assign) and the
single-row `review_schedule` that drives the internal cadence scheduler.

The **`product-gen`** sub-module owns `product_generation_jobs` +
`product_generation_drafts` — the SAME dry-run → review → apply pattern for bulk
PRODUCT CONTENT generation (AI). From `/admin/catalog/products` an operator
scopes a run (catalogue / category subtree / brand, optional N-cap), picks which
fields (`description courte/complète`, `FAQ`, `SEO`) + an
overwrite policy, reviews the per-product drafts, then applies (drafts written
back onto products, per-field overwrite-or-keep; emits `product.updated`). The
detached runner (`src/workflows/catalog/product-gen/`) reuses the auto-assign AI
runner + bounded concurrency; a `product_generation_jobs_one_active` partial
unique index is the single-flight gate. Per-field + per-product ("Tout générer")
in-editor generation lives in the product form via `src/lib/ai/tasks.ts`
(`produits` feature) → `generateAiContentAction`.

The **`content-gen`** sub-module GENERALIZES that exact pattern to the catalog
ENTITIES — categories, brands — via ONE job/draft model keyed by an
`entity_type` discriminator (`catalog_content_gen_jobs` / `_drafts`, not three
copies). Each entity's admin list page (`/admin/catalog/{categories,brands}`)
carries the same bulk control: scope = the whole entity type (optional N-cap),
fields `Description / Bloc éditorial / FAQ / SEO`, overwrite policy, review drafts,
apply. The runner (`src/workflows/catalog/content-gen/`) reads a per-entity ADAPTER
(`CONTENT_GEN_ADAPTERS`: feature id `categories|marques`, the grounding
context, `service.update` + `faqService.replaceFor*` on apply, the `*.updated`
event) so the runner carries zero per-entity branching, and reuses the same AI
runner + concurrency + log feed. The one-active gate is PER `entity_type` (so one
category run and one brand run coexist). Prompts are the existing
`categories`/`marques` features in `src/lib/ai/tasks.ts`
(overridable in Système → IA). Pure parse covered by
`content-gen-parse.test.ts`; the apply contract (keep/overwrite/idempotency/FAQ ×
the 3 entities) by the DB-backed `content-generation.test.ts`.

**AI run UX + reliability (shared by all four generators).** Every long-running
AI job (product-gen, content-gen, review-gen, auto-assign) renders a shared
`<AiJobProgress>` bar (indeterminate while `queued`, determinate once `total>0`)
and a collapsible `<AiJobLog>` viewer (polls `getAiJobLogsAction` while live;
per-item generated/skipped/provider_error/parse_error lines from `ai_job_logs`).
Runs are fire-and-forget and survive a closed tab; liveness is `updated_at`-based,
and a job stranded `running` by a crash/redeploy is reaped by a self-heal on the
owning page load AND by the review scheduler tick (`failStaleRunning` + `pruneOld`
for all four job tables + `aiJobLogService.pruneOlderThan`). Per-actor rate limits guard
the chokepoint: single-field gen `ai:gen:<user>` (90/min) and bulk start
`ai:bulk:<user>` (10/h). An admin-set provider `baseUrl` is SSRF-validated
(`validateAiBaseUrl`: http/https only, link-local + cloud-metadata hosts blocked).
The brittle parse/normalize layer is extracted into pure, unit-tested modules —
`src/lib/ai/parse.ts` (`extractJson` balanced-bracket recovery, `htmlToText`,
`mapWithConcurrency`, `buildUserMessage` — the single source of truth, also used
by the client `product-ai-context.ts`),
`src/workflows/catalog/product-gen/parse.ts` (`applyFieldToContent`) and
`normalize.ts` (`normalizeScope`/`normalizeSettings`) — covered by
`src/lib/db/tests/ai-parse.test.ts` (60 assertions, DB-free).

The **`product`** sub-module's `product_type` is `simple` | `variable`. A
`variable` product sells through `product_variants`: each variant carries its
own absolute price / stock / child SKU / GTIN and an optional per-variant image
(`image_media_id`, settable in the admin variant editor via a `<MediaPicker>`,
surfaced on the PDP gallery when a variant is selected and falling back to the
product gallery otherwise). A one-default-per-product invariant
(`product_variants_one_default_per_product`) keeps exactly one variant
pre-selected on the PDP. `shared_variant_stock` controls the stock model:
`NULL` inherits the global default, `true` makes all variants draw from the
parent `products.stock_qty` pool (per-variant counts ignored), `false` tracks
stock per variant. The PDP picker axes derive from **every LIVE attribute a
variant actually carries** (independent of `is_active`): a deactivated attribute
still renders its axis for existing variants — deactivation only governs the
category-filter UI, not whether an existing variant stays resolvable/buyable.
Likewise, deactivating an attribute never blocks saving a product that carries
its values: every product write path (admin form, PATCH/PUT `/api/products`,
PUT `/api/products/[slug]/attributes`, via `validateAttributeRefs` in
`src/lib/api/attribute-validation.ts`) accepts value ids of any NON-DELETED
attribute, active or not, like the scalar and variant paths. Unknown or
soft-deleted ids are still rejected.

Variants can be **attribute-derived** (built from attribute-value combinations,
each link stored in `product_variant_values`) **or manual/free-form** — a custom
`label` / `sku` / `price` / `stock` typed straight into the editor with **no**
attribute links. No migration was needed: a manual variant simply has zero
`product_variant_values` rows, and `product_variants.label` is the source of
truth for its display name. The two kinds mix freely on one product.

The **`attribute`** sub-module's `product_attributes.kind` enum is
`select` | `multiselect` | `color` | `boolean` | `number` | `text`. The
value-list kinds (select/multiselect/color/boolean) store data in
`product_attribute_values` + `product_attribute_assignments`; the scalar kinds
(number/text) store a per-(product, attribute) value in
`product_attribute_scalars`. `category_attribute_filters` opts an attribute
into a given category's filter UI.

#### Variant / attribute policies (enforced)

These are the now-enforced behaviour rules across the variant editor, deletion
workflows, and checkout. Sources cited inline.

- **Attribute / value deletion is blocked while in use** (THREE guards, since a
  `product_attribute_values` row is reused by variant axes, filter facets, AND tax
  rules). `deleteValueWorkflow` and `deleteAttributeWorkflow` refuse (error code
  `in_use`) when the value(s) are still referenced by: live variants
  (`productQueries.countLiveVariantsUsingValues`), product filter-facet assignments
  (`attributeService.countAssignmentsUsingValues`), or a per-value TVA rule
  (`taxService.countRulesUsingValues` — guarded only on the HARD-delete paths:
  `deleteValueWorkflow` + the kind→boolean normalisation; `deleteAttributeWorkflow`
  SOFT-deletes so the value rows + tax rules survive). The admin must remove the
  variants / assignments / tax rules first. Deleting (archiving) a product
  releases its variants (SKU/GTIN freed, stock 0), its per-location levels, its
  filter assignments in the same transaction
  (`deleteProductWorkflow`), so a value used only by deleted products is no
  longer "in use". The DB `ON DELETE CASCADE`s only fire on a hard delete, which
  is why the soft-delete workflow does this fan-out itself.
  (`src/workflows/catalog/manage-attributes.ts`,
  `src/workflows/catalog/create-product.ts`,
  `src/modules/catalog/product/queries.ts`, `src/modules/tax/service.ts`.)
- **Category / brand deletion.** Refused while a live promotion (enabled, not
  deleted, not ended; a scheduled one counts) targets the category or brand.
  Deleting a non-root category moves its product links to the parent in the
  same transaction (`product.updated` `["categories"]` per moved product);
  link readers skip a deleted root category's tombstone links.
  (`catalog-deletion-fanout.test.ts`.)
- **Variant editor validation.** A variant `priceCents` must be `> 0` and a GTIN
  (when set) must be 8–14 digits — both enforced server-side in the
  `upsert-product-variants` Zod schema (`gtin` regex `^\d{8,14}$`, `priceCents`
  positive). The editor's **pre-submit Save guard checks the price only**
  (`hasInvalidPrice`), so a malformed GTIN isn't blocked before submit — it comes
  back as a save error from the workflow rather than a pre-submit block. (The
  editor also drops AI-suggested combos that don't cover every axis.) The
  product-level GTIN follows the same 8–14-digit rule, checked in the product
  workflows only when the value is new or changed (a legacy value stays
  saveable). A `variable` product can't be published without at least one live
  variant.
  (`src/workflows/catalog/upsert-product-variants.ts`,
  `src/workflows/catalog/create-product.ts`,
  `src/components/admin/product-variants-editor.tsx`.)
- **Stock writes.** Every writer that changes a quantity without setting the
  availability flag re-derives `in_stock` through ONE rule
  (`nextInStockForQty`, `src/lib/inventory/in-stock-rule.ts`, the same as the
  order-restock CASE): a sold-out or untracked line is re-listed when the new
  qty > 0, a line reaching 0 is de-listed, and a line the operator delisted with
  units left stays delisted. The product and variant editors write stock only
  when the operator changed it, with a compare-and-set against the page-load
  value (`expectedStockQty` → `conflict` on a mismatch), so a sale that landed
  meanwhile is never overwritten.
- **Cart / order graceful per-line.** A cart line whose variant was soft-deleted
  shows "Variante indisponible" (and reads not-in-stock, not the product's
  stock); checkout rejects a simple line on a product since promoted to
  `variable` ("Choisissez une option…"). (`src/app/(shop)/panier/page.tsx`,
  `src/workflows/order/place-order.ts`.)
- **Order variant-image snapshot.** Order lines freeze the variant's image into
  `order_items.variant_image_url`, shown on the order/invoice with a
  product-image fallback. (`src/workflows/order/place-order.ts`.)
- **Perf.** The storefront variant build resolves only the attribute values
  variants actually reference (not the whole attribute catalogue), and
  `replaceVariants` diffs the value links (add/remove only) instead of
  delete+reinsert. (`src/lib/api/products.ts`,
  `src/modules/catalog/product/service.ts`.) These are perf optimizations with no
  standing test (`pnpm test` runs the `tsx` test files under
  `src/lib/db/tests/`, but none covers these perf paths), so a future refactor
  should re-verify them by hand.
- **Computed product-card tags (replaces the old manual badge).** The card no
  longer carries a hand-set NEW/HOT/PROMO badge (column + `product_badge` enum
  **dropped in migration 0095**). Instead `mapProductRows` (`src/lib/api/products.ts`,
  `computeProductTags`) resolves `Product.tags` server-side, batched per render —
  the card appends the live **−X% discount** chip.
- **Scannable product code (QR / Code-barres) + scan-to-select.** A store-global
  config decides what scannable code each product shows: `catalog.product_code_type`
  (`qr` | `barcode`) and `catalog.product_code_payload` (`sku` | `gtin` |
  `external_ref` | `id` — the identifiers our products carry AND the scanner
  resolves), edited at **Produits → Réglages catalogue** (a sub-tab of
  `/admin/catalog/products`; the old `/admin/system/catalog` redirects there;
  `saveCatalogSettingsAction`, gated on `products:update`). Settings are
  only ever upserted (there is no generic per-key deleter), so this config is not
  at risk of an incidental wipe. The
  pure config module `src/lib/catalog/product-code.ts` holds the keys/defaults
  (`PRODUCT_CODE_DEFAULTS` = Code-barres encoding the SKU), the shared allow-lists
  + `coerceProductCodeType`/`coerceProductCodePayloadField` (one source of truth
  for the panel options, the save-action validation and the server reader), and
  `productCodePayload()` (returns null when the chosen field is empty on a product
  → no code rendered); the
  server reader `product-code.server.ts` (`getProductCodeConfig`) resolves it from
  settings. The admin product page renders the code via `product-scan-code.tsx`:
  a **QR** (the `qrcode` lib) or a **Code 128** barcode drawn as a dependency-free
  SVG from `src/lib/catalog/code128.ts` (a pure, unit-tested Code-Set-B encoder).
  In **manual order** (« Nouvelle commande »), a POS wand types the decoded value + Enter
  and `resolveProductByCodeAction` (`src/lib/actions/manual-order.ts`) maps it
  back to the exact product, most-specific key first: child variant SKU (→ that
  variant pre-selected) → product SKU → GTIN → `external_ref` → product id (UUID
  payload). All lookups ride the partial-unique indexes.

### Cross-cutting invariants

These hold for **every** module's `schema.ts`. They're enforced again in
the §9 checklist — this is the rationale.

1. **Re-export the schema from the barrel, or it does not exist.**
   `drizzle-kit` only sees [`src/lib/db/schema.ts`](../src/lib/db/schema.ts).
   It re-exports every module's `schema.ts` (and `media/settings.schema.ts`).
   A table whose schema is *not* re-exported is invisible to migration
   generation and to the typed `db` — it silently goes unmanaged. (This is
   exactly how the `tax` table was once missed.) Adding a
   module = define the table **and** add one `export * from "@/modules/<x>/schema"`
   line to the barrel.

2. **Foreign keys live in the migration SQL, not in `schema.ts`.** Module
   schemas declare columns as plain `uuid`/`text` with **no
   `.references()`**; the actual `FOREIGN KEY … REFERENCES …` (and `CHECK`)
   constraints are written by hand in the migration SQL. This keeps the
   Drizzle snapshot diff clean and lets us add constraints `VALID` with the
   exact `ON DELETE` behaviour we want. **One exception:** the better-auth
   tables in [`src/modules/auth/schema.ts`](../src/modules/auth/schema.ts)
   keep `.references(() => users.id, { onDelete: "cascade" })` on
   `session`/`account`/`two_factors` because they mirror better-auth's own
   generated schema — don't "fix" them.

   **Sanctioned cross-module FKs.** Rule 2 keeps `.references()` out of the
   code, but these database-level FKs cross a module boundary today (all in
   migration SQL; the baseline unless noted):

   | FK | ON DELETE |
   | --- | --- |
   | associations `product_categories`, `product_brands`, `product_media` (→ `media` too), `product_related` (0020), `product_complementary` (0089) → both ends | CASCADE |
   | `orders.delivery_agent_id` → `delivery_agents`, `orders.pickup_location_id` → `pickup_locations` | SET NULL |
   | `promotion_redemptions.order_id` → `orders` | CASCADE |
   | `promotion_redemptions.user_id` → `users` | SET NULL |
   | `tax_rules.attribute_value_id` → `product_attribute_values` | CASCADE |
   | `showcase_pins.product_id`, `wishlist_items.product_id` → `products` | CASCADE |
   | `stock_levels.product_id` / `variant_id` → `products` / `product_variants` (0103) | CASCADE |
   | legacy `digital_assets.product_id` → `products` (a leftover baseline table with no owning module or Drizzle schema) | CASCADE |

   `customer_user_links` has no FK (text soft link to better-auth's
   `users.id`). FKs between catalog sub-modules (attribute ↔ product ↔
   category ↔ review) stay inside the catalog domain. Catalog rows are
   soft-deleted, so a CASCADE only fires on a hard delete; the soft-delete
   workflows do their own fan-out (e.g. `deleteProductWorkflow`).

3. **Every PK is a time-ordered UUID v7.** Use `id()` from
   [`src/lib/db/columns.ts`](../src/lib/db/columns.ts) — it defaults to
   `uuid_generate_v7()` (a function defined in the baseline preamble), which
   gives ~25 % smaller indexes and far better B-tree locality than random
   v4. The column type is still plain `uuid`; service code is identical.

4. **Soft deletes + timestamps via the column builders.** Content tables
   spread `...timestamps()` (`created_at` / `updated_at`, both `now()`
   default) and `...softDelete()` (`deleted_at`, NULL = live). Queries must
   filter `deleted_at IS NULL`; services set it instead of issuing `DELETE`.

5. **Money is integer millimes — never "centimes", never ×100.** TND = 1000
   millimes. The single scale lives in
   [`src/lib/price.ts`](../src/lib/price.ts) (`MINOR_PER_DINAR = 1000`); all
   formatting and dinar↔minor parsing route through it. Columns are
   historically named `*_cents` but **hold millimes** — read the name as
   "integer minor units". Never multiply by 100 anywhere. Tax rates are
   **basis points** (`*_rate_bps`, 1900 = 19 %), with their own SSOT in
   `src/lib/tax/shared.ts`.

6. **Squashed baseline + a live numbered chain.** The pre-`0000` history
   was squashed into one baseline
   [`src/lib/db/migrations/0000_squash_baseline.sql`](../src/lib/db/migrations/0000_squash_baseline.sql),
   but the numbered chain **continues** `0001`…`0139` on top of it (140 `.sql`
   files total incl. the baseline, and 140 entries in `meta/_journal.json`). The
   baseline carries the extensions, `uuid_generate_v7()`, the `fr_unaccent` FTS
   config, all tables/enums, every FK + CHECK as `VALID`, and the generated
   `search_vector` columns; everything since lives in the numbered chain
   (e.g. `0121_drop_serials.sql`, `0122_products_low_stock_index.sql`,
   `0123_purge_stale_permission_keys.sql`, `0124_pg_stat_statements.sql`,
   `0125_drop_redundant_indexes.sql`). **The next migration is `0140`.** A new
   journal entry's `when` MUST be strictly greater than the previous entry's
   (use `Date.now()`): the migrator only compares against the newest applied
   row, so an equal or smaller `when` is silently skipped on every
   already-migrated database. `src/lib/db/tests/migration-journal.test.ts`
   (pure) guards this plus file ↔ journal parity. Note `meta/` snapshots only
   reach `0007` because `db:generate` is frozen and migrations are
   hand-authored. Migration NUMBER→feature mappings differ from any pre-squash
   history, so don't trust an old number for what a file contains.

### Server / client boundary

A module's `service.ts`, `queries.ts`, and most of `index.ts` are
**server-only** (they import `db` and start with `import "server-only"`).
A React **client** component (`"use client"`) that imports any of them
breaks the build. When an admin client form needs a *pure* piece of a
server module — types, setting keys, a unit-conversion or formatting
helper — split the module:

- **`shared.ts`** — pure: types, constants, pure functions. **No `db`, no
  React, no `"server-only"`.** Safe to import from client components.
- **`index.ts`** — `import "server-only"`; `export * from "./shared"` and
  adds the DB-bound resolvers.

The reference implementation is the tax engine
([`src/lib/tax/shared.ts`](../src/lib/tax/shared.ts) +
[`src/lib/tax/index.ts`](../src/lib/tax/index.ts)): server code imports from
`@/lib/tax`, client forms import `TAX_SETTING_KEYS` / `percentFromBps` /
`TaxConfig` from `@/lib/tax/shared`. Apply the same split to any module
whose constants or formatters a client component needs.

## 3. Medusa ↔ Tokyo Store mapping

The Medusa skills folder uses different file names for the same concepts.
This table is the translation key.

| Medusa primitive                                  | Tokyo Store equivalent                      | Adaptation notes                                                       |
| ------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `src/modules/<name>/index.ts` (`Module()` wrapper)| `src/modules/<name>/index.ts` (barrel)            | Next.js has no DI container — `Module()` would be ceremony for nothing |
| `src/modules/<name>/service.ts` (`MedusaService`) | `src/modules/<name>/service.ts` (plain class)     | We choose explicit CRUD over auto-generated methods — easier to grep   |
| `src/modules/<name>/models/<entity>.ts` (DML)     | `src/modules/<name>/schema.ts` (Drizzle pgTable)  | Drizzle gives us hand-written SQL migrations and zero codegen overhead |
| `MEDUSA_MODULE_NAME = "blog"`                     | (none — folder name suffices)                     | No container resolution; imports are explicit                          |
| `src/workflows/` + `createStep` + `createWorkflow`| `src/workflows/<x>/<action>.ts` + `workflow()`    | We hand-roll a tiny `workflow()` helper — same shape, no SDK dependency |
| `StepResponse(result, compensation)`              | `db.transaction(async () => ...)` + manual rollback | Postgres transactions cover 95% of compensation needs                |
| Compensation function (reverse-order on failure)  | Same — manually wired inside the transaction      | If your rollback needs cross-DB-boundary state, escalate to pg-boss   |
| `src/links/` (`defineLink`)                       | `src/associations/<a>-<b>.ts` + service helpers   | Same purpose: soft links with no FK enforcement at DB level            |
| Query / Remote Query (`graph({ entity, fields })`)| `src/associations/<group>.service.ts` helpers     | Hand-written join queries — no abstraction layer over Drizzle          |
| `container.resolve("blog")`                       | Direct ES import: `import { blogService } from …` | Static imports are clearer for a single-process app                    |
| `src/subscribers/<event>.ts`                      | `src/events/subscribers/<name>.ts`                | Same concept — in-process event bus instead of Medusa's pub/sub        |
| `src/api/store/<feature>/route.ts`                | `src/app/api/store/<feature>/route.ts`            | Identical convention — Next.js App Router takes the same shape         |
| `src/api/admin/<feature>/route.ts`                | `src/app/api/admin/<feature>/route.ts`            | Same                                                                   |
| `src/admin/widgets/` & `src/admin/routes/`        | `src/app/admin/<feature>/page.tsx`                | The Next.js admin is a route group, not a plugin; no widget zones      |
| `defineRouteConfig({ middlewares })`              | `requirePermission()` / `requirePermissionAny()` / `requireAdminArea()` / `requireSession()` (+ `requireSuperAdmin()` step-up) | RBAC guard at the top of each handler (see §7.1 « RBAC gating ») |
| Zod via `validateAndTransformBody`                | Zod via `.safeParse()` inside the action          | Same library — different ergonomics                                    |

### What we kept verbatim

- **Module isolation.** Services never cross-import each other.
- **Workflow as the only mutation entry point.** Pages, Server Actions,
  API routes, jobs — all delegate to a workflow.
- **Compensation on failure.** Postgres transactions + explicit cleanup
  in the workflow body.
- **Events as the side-effect channel.** Workflows emit; subscribers
  react; emitters don't know listeners exist.
- **Thin route handlers.** Pages and route handlers are 20-line files
  that parse input, call a workflow, return the response. **No business
  logic in routes.**
- **Cross-module reads via the link/assoc layer.** Never via a service
  import.

### What we deliberately changed

- **No `MedusaService()` base class.** Auto-generated methods are
  convenient but make grep across the codebase brittle. Explicit `class
  XService` with hand-written CRUD wins on read time.
- **No `defineLink()` DSL.** Associations are plain Drizzle tables. We
  write the join SQL by hand in `src/associations/<group>.service.ts`.
- **No declarative workflow composition.** Medusa's `createWorkflow()`
  builds a DAG that the runtime executes; we use a plain async function
  with `db.transaction()`. Both work — ours is simpler at the cost of
  losing Medusa's automatic parallelisation, which we don't need yet.
- **No container.** Direct ES imports. If we ever need to swap an
  implementation (e.g. multiple email providers), we'd add a tiny
  registry like `src/lib/email/factory.ts`, not import a full DI lib.

## 4. Cross-module associations

Cross-module foreign keys are forbidden in code (no `.references()`); the fixed
set of DB-level exceptions is listed in §2 invariant 2. The pattern:

There are SEVEN join tables today (all re-exported from
[`src/lib/db/schema.ts`](../src/lib/db/schema.ts)):

```
src/associations/
├── product-category.ts          # Drizzle pgTable (soft-link columns, no .references())
├── product-brand.ts             # Drizzle pgTable
├── product-media.ts             # Drizzle pgTable
├── product-related.ts           # Drizzle pgTable (product ↔ product cross-sell, ordered)
├── product-complementary.ts     # Drizzle pgTable (product ↔ product "Accessoires supplémentaires", manual-only, ordered)
├── customer-user.ts             # Drizzle pgTable (1:1 bridge)
├── catalog.service.ts           # Helper: productCategoryLinks / productRelatedLinks / productComplementaryLinks .set/list/...
└── customer-user.service.ts     # Helper: customerUserLink.findByUserId/...
```

Two file kinds:

1. **`<a>-<b>.ts`** — declares the join table (or 1:1 bridge). Soft-link
   columns carry **no `.references()`** — that's the whole point (the product
   joins do have `ON DELETE CASCADE` FKs in the migration SQL, listed in §2
   invariant 2; `customer_user_links` has none). Their
   *type* mirrors the referenced PK: `uuid` for our v7 tables
   (`product_id`, `category_id`, `customer_profile_id`), `text` only where
   the target is better-auth's text `users.id` (`customer_user_links.user_id`).
   The table itself has its own `id` UUID v7 + timestamps. (Don't read older
   revisions that typed every link column `text`; the M2M links were
   migrated to `uuid` to match the v7 PKs they point at.)

2. **`<group>.service.ts`** — bundles the small helpers used by workflows
   to read/write the joins. These are the equivalent of Medusa's Module
   Link helpers — they're allowed to read multiple modules' tables
   because they're *the* cross-module layer; the rest of the codebase
   never does.

```ts
// src/associations/product-category.ts
import { boolean, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "@/lib/db/columns";

export const product_categories = pgTable("product_categories", {
  id: id(),
  product_id: uuid("product_id").notNull(),   // soft link → products.id (no FK here)
  category_id: uuid("category_id").notNull(), // soft link → categories.id (no FK here)
  is_primary: boolean("is_primary").notNull().default(false),
  ...timestamps(),
}, (table) => ({
  pairUnique: uniqueIndex("pc_pair_unique").on(table.product_id, table.category_id),
}));

export type ProductCategoryRow = typeof product_categories.$inferSelect;
```

```ts
// src/associations/catalog.service.ts (excerpt)
export const productCategoryLinks = {
  async set(productId: string, categoryIds: string[], primaryId?: string) { ... },
  async listForProduct(productId: string) { ... },
  async listProductIdsInCategory(categoryId: string): Promise<string[]> { ... },
  async categoryIdsForProducts(productIds: string[]): Promise<Map<string, string[]>> { ... },
};
```

A workflow calls `productCategoryLinks.set(...)` inside its transaction;
neither `productService` nor `categoryService` ever talks to the join.

## 5. Workflows

The shape every workflow file follows:

```ts
// src/workflows/<domain>/<action>.ts
import "server-only";
import { z } from "zod";

import { someService } from "@/modules/some/service";
import { otherService } from "@/modules/other/service";
import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { fail, flattenZodError, ok, workflow } from "../shared";

const inputSchema = z.object({ /* ... */ });

export const myWorkflow = workflow<
  [z.input<typeof inputSchema>, { actorUserId: string }],
  { id: string }
>("domain.action", async (input, { actorUserId }) => {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));

  // Pre-flight checks (cheap, no writes)
  const existing = await someService.findBy(...);
  if (existing) return fail("conflict", "Already exists.");

  // All writes inside ONE transaction so partial failures roll back.
  const result = await db.transaction(async () => {
    const a = await someService.insert(...);
    await otherService.update(...);
    return a;
  });

  // Side effects emitted AFTER commit — subscribers can't accidentally
  // undo a transaction that already succeeded.
  await bus.emit("domain.action", { id: result.id }, { actorUserId });
  return ok({ id: result.id });
});
```

Then register in `src/workflows/index.ts` and call from a Server Action /
API route / job. **The workflow's name (`"domain.action"`) is used by
audit logging and observability — keep them stable.**

A few workflows are imported directly by their one action instead of going
through the registry: the delivery-zone workflows (`workflows/delivery/zone.ts`),
search aliases (`workflows/search/aliases.ts`), the newsletter staff opt-out
(`workflows/newsletter/unsubscribe.ts`), the OAuth credential save/clear
(`workflows/auth/upsert-oauth-settings.ts`) and `settleZeroTotalOrderWorkflow`
(`workflows/order/gateway-payment.ts`). They follow the same shape; registering
them is optional.

**Actor context.** The second argument carries the acting user and is forwarded
as the `bus.emit` meta, so the audit row names the admin instead of « système ».
The settings/CMS workflows (`workflows.cms.*` setting, page, navigation, banner,
FAQ) take an optional `CmsActorCtx = { actorUserId?, actorIp? }`
(`src/workflows/cms/setting.ts`; the trust-badge workflows take a required
`{ actorUserId }`): only bootstrap/seed paths omit it, and every admin Server
Action passes `{ actorUserId: session.user.id }`. `settings-actor.test.ts` pins
the workflow side (the event carries the actor, a call without ctx still works,
the nav-menu workflows forward it).
`upsertSettingWorkflow` skips BOTH the write and `setting.upserted` when the
stored row is identical (value/type/group/label, and description when
provided), so re-saving a panel audits only the keys that changed. Security-relevant
keys (`SENSITIVE_SETTING_KEYS`, never a secret) carry `from`/`to` in the event
and are audited at `warn` severity (`severityFor`).

### Operational workflows (no owned module)

Some workflows orchestrate across many modules but don't own a domain
themselves — examples are the demo workflows in `src/workflows/demo/`:
`import-demo` (seed), `clear-demo` (a WHOLE-STORE clear behind the headless
`POST /api/admin/system/demo?op=clear`, super-admin only; despite its name it is
not scoped to demo rows), and the destructive super-admin **`purge-relaunch`**
(email-code-confirmed: `orderService.deleteAllOrders` + wipe all content +
soft-delete all customers, then re-seed — gated by a cluster-wide
`demo.purge_in_progress` settings marker that the data-job, product-import and
demo-import starts all respect, and that `clear-demo` also holds during its
destructive window). Store-wide destructive operations add the `*` step-up on
top of their module grant through `requireSuperAdmin` / `checkSuperAdmin`
(`src/lib/auth/super-admin.ts`): the purge, `?op=clear`, and a `clean` data-job
(CMS → Réglages danger zone). Clean segments reclaim média through
`mediaQueries.listReferencedMediaIds` (an image still referenced elsewhere is
never deleted), and `cleanSettings` only resets values still equal to the
demo's. Every background job start (the admin data-job runner, the catalogue
file import and the demo import's bundled catalogue feed) goes through
`importJobService.createIfIdle()`: a transaction-scoped
`pg_advisory_xact_lock(hashtext('import_jobs_single_flight'))`, a re-check, then
the insert (`hasActive()` is only a fast path). The headless
`?op=import` answers 409 `busy` while a job is active or a purge runs.

Future ones like CSV product export or scheduled cleanup jobs follow the same
pattern — they live under `src/workflows/<name>/` and
register in `workflows.<name>.*` — but they keep their *data* under
`src/lib/<name>/` rather than `src/modules/<name>/`, because there's no
domain table to own. The demo import's content arrays live at
`src/lib/demo/data.ts` for exactly this reason.

This split keeps the `src/modules/` folder strictly for actual business
domains with their own tables.

## 6. Events & subscribers

Every event lives in a typed registry:

```ts
// src/events/types.ts
export type EventMap = {
  "product.created": { productId: string; slug: string };
  "product.updated": { productId: string; slug: string; changedFields: string[] };
  // ...
};
```

The map holds **212** events today. `src/lib/api-auth/event-catalog.ts` is its
generated runtime list (the « Évènements » tab of Infrastructure → API & Webhooks); `pnpm gen:api-catalog`
regenerates it and `event-catalog.test.ts` fails when it drifts from
`EventMap`. Domains added by the 2026-09 audit include `delivery.zone.*`,
`stock_location.*`, `search_alias.*`, `page.updated`, `data.exported` (bulk
exports), `user.password_changed` / `user.email_changed`,
`auth.oauth_settings_updated` and `ai.feature_prompts_updated`; `order.paid` now
also fires when a COD order is settled on delivery.

`product.updated` is the catalog cache-invalidation signal. Its named
subscribers are `invalidate-catalog-cache`, which busts `products:list` +
`product:<id>` + `product:slug:<slug>` so the cached PDP refreshes, and
`reembed-product`, which re-embeds for semantic search only when
`changedFields` touch the embedded text. The wildcard listeners (audit, outbound
webhooks) see it too. `changedFields` lists only fields whose value really
changed, and a save that changes nothing emits no `product.updated`.
It is also emitted **post-commit, once per stock-touched product, on every sale,
order edit, and restock** (via `emitProductStockCacheBust` in
`@/lib/catalog/product-cache-bust`) as well as on admin product/stock writes — so
expect one `product.updated` per distinct product per order, not just on admin edits.

Subscribers live in `src/events/subscribers/<name>.ts` and register
themselves on the bus at app start:

```ts
import { bus } from "@/events/bus";

bus.on("product.published", async ({ payload }) => {
  await revalidateTag(`product:slug:${payload.slug}`);
});
```

A wildcard subscriber owns the audit log (`src/events/subscribers/audit-everything.ts`); a second, narrower subscriber (`audit-trail.ts`) attaches higher-signal summary rows for a curated allowlist of events and is *skipped* by the wildcard to avoid duplicate rows. Three more wildcard listeners observe everything: `structured-logger.ts` (one JSON line per event), `metrics-counter.ts` (in-memory counts) and `dispatch-webhooks.ts` (enqueues outbound webhook deliveries; a `*` endpoint subscription never receives the `SECURITY_DOMAINS` `auth` / `rbac` / `api_key` / `user` / `data`, which must be subscribed by exact name — pinned by `wiring-matrix.test.ts`).

```ts
bus.onAny(async (env) => {
  if (CURATED.has(env.name)) return;          // audit-trail owns these
  const cfg = await getAuditRuntimeConfig();  // 15s in-process TTL cache
  if (!cfg.enabled) return;                    // master capture kill-switch
  const severity = severityFor(env.name);      // src/events/severity.ts
  if (severity === "debug" && !cfg.persistLowSignal) return;
  await auditService.record({
    event_name: env.name, actor_user_id: env.actorUserId,
    severity, metadata: redactForStorage(env.payload), /* …target_*… */
  });
});
```

This means **any new event automatically gets audit-logged** — no extra
code per event type. The catch is the converse: a mutation that emits NO event
is invisible, so coverage = "does every mutating action emit a bus event"
(the 2026-06 sweep wired emits across returns/SAV, fiscal docs,
tax, delivery, currency, API keys, payment creds, mailing, segments,
reviews, redirects, jobs, showcase, trust badges, … so nothing is
unmonitored).

**Severity + debug settings.** Each event has an implicit severity
(`debug|info|warn|error`) from the pure map `severityFor()` (explicit override →
low-signal prefix → `.deleted` → domain default → info). It is written to the
`audit_log.severity` column once at insert and drives: the admin "Sévérité"
filter, whether the long-tail row is persisted (`audit.persist_low_signal`), and
the structured-logger console floor (`audit.log_level`, `off|error|warn|info|
debug`; `debug.enabled` forces debug). All knobs are runtime-defaulted
`audit.*`/`debug.*` settings resolved by the pure `resolveAuditConfig()`
(`src/lib/audit/parse-config.ts`) and read on the hot path through a 15s
in-process TTL cache (`runtime-config.ts`, fail-open). `redactForStorage` masks
secrets/emails AND caps array/object/depth/total-size so one fat event can't
bloat the retained table.

**Admin.** `/admin/system/audit` is a tabbed control center (Journal /
Statistiques / Réglages / Purge), RBAC `system_audit` (view vs manage). The
audit-log keyset paginates on `id` (uuid v7) — exact, no same-millisecond skips.
The Journal « Du/Au » filters are Africa/Tunis days (`from` = 00:00, `to` =
23:59:59.999 inclusive), shared by the page, load-more and the CSV export via
`normalizeAuditFilters` (`src/modules/audit/cursor.ts`); the Statistiques
overview and top-events/top-actors leaderboards are `unstable_cache`d for 5 min.
Retention is admin-configurable (`audit.retention_months`, default 12) resolved
at purge time by `runRetentionPurge` (cron + manual purge agree; a
settings-read failure SKIPS the audit purge — fail closed, recorded as
`settings_unavailable` — instead of falling back to a shorter window). Migration 0079 added the
`severity` column + `(event_name|actor_user_id|severity, id DESC)` + a
`(created_at DESC, id DESC)` composite (all aligned to the id keyset) and dropped
the redundant single-column / unused-GIN indexes on the hottest-insert table.

### 6.1 Mailing — the single email send path

The `mailing` module is the **source of truth for every outbound email**. The
guarantees below all hang off one rule: **nothing sends except through
`dispatchEmail`** (`src/modules/mailing/dispatch.ts`). Welcome, password reset,
order receipts, newsletter coupons, and every automation call it. The raw
transport `sendEmail` has exactly three callers: `dispatchEmail` itself, the
queue drain (`src/lib/mailing/drain.ts`, which sends rows `dispatchEmail` /
`enqueue` already logged), and the admin « Envoyer un test »
(`sendTestEmailAction`, `system_mail:manage`, sample data to one typed address,
so a disabled template can be tested). Every provider send is bounded: SMTP
stage timeouts 10/10/20/10 s, Resend an `AbortSignal`, and an overall 30 s race
(`src/lib/email/providers/send-timeout.ts`).

**Send paths (two, both through the chokepoint).**

- **Immediate** — `dispatchEmail({ key | composed, to, ... })` renders, gates,
  logs an `email_logs` row, and sends inline (transactional mail: account +
  commerce). One recipient per call — bulk callers loop.
- **Queued** — `enqueue()` / `enqueueCampaign()` insert `email_logs` rows with
  `status='queued'`; `/api/cron/mailing` (drain) claims due rows
  `FOR UPDATE SKIP LOCKED`, throttles (~`mail.throttle_per_min`), sends, and
  retries with backoff (1m/5m/30m, `max_attempts` 3). Used for campaigns and
  large automation fan-outs so a blast can't block a request or double-send.
  The drain is single-flight: a transaction-scoped advisory lock (key
  `72707469`) is held on a dedicated pooled client, so an overlapping cron tick
  or « run now » is skipped, not stacked. Sends are paced to a per-row deadline;
  the batch is `min(50, floor(110 × throttle / 60) + 1)` so the last send starts
  at least 10 s before the next `*/2` tick; one run has a 10-min budget. A
  settings-read failure leaves the batch queued (fail closed).
  Crash safety: a row left `status='pending'` (claimed, then worker died) older
  than `STALE_PENDING_MINUTES` (30) is re-queued by `recoverStalePending` at the
  top of every drain, under the lock — otherwise it would be stranded forever.

**Consent model (evaluated at SEND time, not enqueue time).**

| Category                       | Marketing gate?               | Unsubscribe footer? |
| ------------------------------ | ----------------------------- | ------------------- |
| `account` (reset, verify, invite) | **no** (always delivered)  | no                  |
| `commerce` (receipt, shipped, delivered) | **no** | no       |
| `marketing` (campaigns, birthday, promo blast, price-drop, back-in-stock, **review-request**) | **yes** — `canSendMarketingTo(email)` | yes (`{{unsubscribe_footer}}`) |

`canSendMarketingTo` (`src/lib/email/consent.ts`) is a **negative backstop**: it
returns `false` only for an address that is hard-suppressed (`email_suppressions`)
or explicitly opted-out (newsletter `is_active=false`); an unknown address passes.
Both checks are case-insensitive (`lower(email)`). The drain re-runs the gate at
send time, so an opt-out that lands **after** a marketing row was enqueued still
suppresses it (covered by `mailing-drain.test.ts`).

Above the per-recipient gate sits the **master kill-switch** `mail.marketing_enabled`:
when off, `dispatchEmail` short-circuits every `marketing` send (campaigns AND all
automations) before enqueue/send, and the drain cuts any marketing backlog — so the
one toggle governs everything marketing, as the admin UI promises. It fails
CLOSED: if the settings read fails, `dispatchEmail` skips marketing with reason
`settings_unavailable` and a campaign send is refused. Per-FLOW toggles
(`isFlowEnabled`, Workflows tab) gate each automation's sender individually;
per-TEMPLATE `is_enabled` (Templates tab) gates one template's content. The
account-security templates (`critical` in `templates.ts`: `password_reset`,
`email_verification`, `email_change`, `user_invitation`,
`purge_confirmation`) can never be disabled, and dispatch ignores a stored
`is_enabled=false` row for them; overriding, resetting or re-enabling one
requires the super-admin wildcard (`*`).

**Unsubscribe** is a stateless HMAC token (`src/lib/crypto/sign.ts`, keyed by
`PAYMENT_ENCRYPTION_KEY`, no table) carrying the address; the public
`/se-desabonner` POST-confirm page calls `unsubscribeEmailFromMarketing`
(`src/workflows/customer/unsubscribe.ts`), which
flips any linked profile's `marketing_opt_in=false` (emitting
`customer.profile_updated`) **and** unsubscribes the newsletter row. Marketing
sends also carry `List-Unsubscribe: <{origin}/api/unsubscribe/one-click?token=…>`
and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058,
`src/lib/email/list-unsubscribe.ts`): `dispatchEmail` sets them on inline
marketing sends and the drain on queued marketing rows (built at send time,
nothing stored); the one-click POST route calls the same
`unsubscribeEmailFromMarketing`. Staff opt-out (« Désinscrire »,
`newsletter:manage`) goes `unsubscribeNewsletterSubscriberAction` →
`unsubscribeSubscriberWorkflow` → `unsubscribeEmailFromMarketing(email,
{ actorUserId })`, so both events name the staff member; success is verified by
re-reading the row, which is kept as the suppression record.

The opposite direction is the narrow `sync-newsletter-to-profile` subscriber. A
newsletter (re)subscribe re-enables the linked account's `marketing_opt_in` ONLY
when the signed-in owner subscribes their own address, or when staff holding
`newsletter:manage` re-subscribes it from `/admin/newsletter` (« Réactiver »,
behind a « Réabonner » confirmation). An anonymous footer subscribe only
reactivates the newsletter row; a profile opt-out keeps winning in the gate.
The profile→newsletter mirror
`sync-marketing-optin` emits `newsletter.subscribed { source: "account",
reactivated }` / `newsletter.unsubscribed { source: "account" }` (with the
profile edit's actor) after each write, so account-page, signup and
admin-profile opt-ins/outs reach the audit trail and newsletter webhooks.
`source: "account"` marks a mirror: `sync-newsletter-to-profile` ignores it (no
ping-pong) and the welcome-coupon mailer skips it (account opt-ins get no
coupon).

A third `customer.profile_updated` subscriber, `sync-user-name-from-profile`,
keeps `users.name` in sync with the profile's `first_name`/`last_name` (it's a
denormalised mirror the admin **Utilisateurs** list + audit actor names read).
One-way (profile → `users.name`), gated on a name field actually changing, and
loop-safe (`authService.update` emits nothing). Frozen snapshots like order
`ship_full_name` are intentionally NOT resynced. `enqueueCampaign` renders the body once with a
`%%TK_UNSUB_FOOTER%%` sentinel and splices each recipient's own footer in, so a
large blast is O(1) renders.

**Idempotency** for automations is the `mailing_sends` ledger —
`claimOnce(flow_key, dedup_key)` inserts-first and reports whether THIS caller
won, so a flow fires exactly once per natural key across cron re-runs and
concurrent ticks (birthday key = `<profileId>:<year>`, price-drop =
`<productId>:<userId>:<newCents>`, promo blast (`promo_announce`) =
`<promoId>:<email>`). `mailingSendsService.release(flow, key)` gives a claim
back when the dispatch was not enqueued. The fan-out automations (birthday,
review-request, promo blast) check `marketingSendBlocked(templateKey)`
(kill-switch + template toggle, `src/lib/mailing/automation-gate.ts`) BEFORE
claiming, so a run while marketing is off burns no natural key; their job
summaries count only queued mails. Kept
**separate** from `email_logs` (which is retention-pruned) so a correctness key is
never mis-pruned.

The promotion announcement (`promotion.announce_requested`, emitted only by the
promo create form's « Annoncer par email » checkbox, which is disabled unless
the promo is live at creation) runs DETACHED from the admin request
(best-effort; a batched enqueue is a TODO).

**Retention.** `email_logs` is purged at 180d (pinned rows excluded);
`mailing_sends` at 540d (well past any dedup window) — both via the shared
`runRetentionPurge` sweep (`src/lib/retention/`).

**RBAC.** The hub (`/admin/marketing/mailing`, nav group **Système**) is keyed to
the `system_mail` permission module (actions `view` · `create` · `update` ·
`manage`; there is no `delete`). Mapping: `view` (read logs/flows/campaigns) ·
`create` (compose + send a campaign, preview audience) · `update` (edit
non-security templates, toggle templates/flows, From/Reply-To, global toggles) ·
`manage` (reset a template, send a test, pin / delete / resend a log row). The
mail TRANSPORT (provider, SMTP relay, sendmail path, provider secrets) and the
account-security templates additionally require the `*` wildcard: a delegate
could otherwise redirect password-reset / invitation links. `newsletter` is a
separate module.

## 7. API routes & admin UI

| Surface       | Location                                       | Pattern                                                  |
| ------------- | ---------------------------------------------- | -------------------------------------------------------- |
| Storefront    | `src/app/(shop)/<path>/page.tsx`               | Server Component → reads via `mod.queries.*`              |
| Storefront    | `src/app/api/store/<path>/route.ts`            | Thin handler → calls workflow OR query                   |
| Admin UI      | `src/app/admin/<feature>/page.tsx`             | `await requirePermission(module, "view")` (or `requirePermissionAny`) first (RBAC); `/new` pages need `<module>:create` |
| Admin UI      | `src/app/admin/<feature>/<entity>-panel.tsx`   | Client component using Server Actions                    |
| Admin API     | `src/app/api/admin/<path>/route.ts`            | `await requirePermission(module, action)`; 404 (not 403) |
| Server Action | `src/lib/actions/<domain>.ts`                  | Server-side mutation entry — delegates to a workflow     |

Routes and Server Actions are **always thin** — parse input, call a
workflow, return the response. If a handler grows past ~30 lines, the
logic belongs in a workflow, not the handler.

**Admin page conventions** (enforced by `page-guards.test.ts`,
`route-invariants.test.ts` and `settings-fail-closed.test.ts`):

- An admin page never calls another module's permission-gated Server Action
  during render unconditionally: each such call site sits behind a soft-check
  (`permissionSetAllows(perms, module, action)`) and the widget is hidden when
  the grant is missing. An RBAC denial inside `/admin` renders
  `src/app/admin/not-found.tsx` inside the admin shell (HTTP 404).
- A page whose settings read pre-fills a SAVE form reads settings strictly (no
  `getSettingsMap().catch(() => ({}))`): on a failed read it hits the admin
  error boundary instead of rendering defaults a save would then write over live
  config. Display-only pages show a « Réglages indisponibles » banner. Pages pass
  a client panel only their own key prefixes via `pickSettings(map, prefixes)`
  (`src/lib/settings/pick-settings.ts`), never the whole `site_settings` map
  (which holds ciphertext, SMTP identity and unpublished promo codes).
- `useActionState` forms pass `onSubmit={useNoResetSubmit(formAction, state)}`
  (`src/components/admin/_components/form-tabs.tsx`) alongside
  `action={formAction}`. React 19 otherwise resets every `<form action={fn}>`
  after its action, even on `{ ok: false }`, wiping uncontrolled input; the
  helper keeps the input on failure and resets on success. A blank numeric
  settings field means "default" (`parseFormNumber`, `src/lib/settings/form-number.ts`).

### 7.1 External keyed API (ERP)

`/api/<resource>` routes are the **integration surface** for an external ERP /
PIM / WMS. They authenticate via an **API key** (`Authorization: Bearer …` or
`X-API-Key`) carrying a SET of scopes (`<resource>:read|write`, or coarse
`read`/`write`/`full`) — see `src/lib/api-auth/` (`enforce.ts`, `scopes.ts`,
`route-catalog.ts`). Every route is registered in `EXTERNAL_API_ROUTES` and
auto-rendered in the **API & Webhooks** admin panel's route inventory; read
routes can be toggled public. Writes are attributed to the key's owner
(`requireApiActor`).

**Orders** (scope `orders:read` / `orders:write`; key-only, never public). The
full contract (bodies, error codes) lives in [API.md](../API.md); the shape:

| Method | Path | Scope | Notes |
| ------ | ---- | ----- | ----- |
| GET | `/api/orders` | `orders:read` | Incremental sync: `?status=`, `?since=` + `?sinceId=` (composite `updated_at, id` keyset, microsecond-precise), `?limit` (≤200). Pass `pagination.nextSince` + `nextId` back verbatim; the boundary row is never re-sent. Feeds only return rows older than `KEYSET_SETTLE_SECONDS` (5 s, `src/lib/api/keyset.ts`) so a late-committing transaction is never skipped. Or a single lookup by `?externalRef=` / `?orderNumber=`. |
| POST | `/api/orders` | `orders:write` | ERP/POS order push (live pricing, atomic stock decrement). Attaches the customer by ONE of `userId` \| `customerId` \| `customerExternalRef` (unknown → 400, never a silent guest order). |
| GET | `/api/orders/[id]` | `orders:read` | One order WITH its lines; `[id]` is the uuid id OR the ERP `externalRef`. Each line carries the `warrantyMonths`/`warrantyLabel` snapshot + an order-aware `warranty` verdict (state/expiresAt/display). Sub-reads: `…/shipments`, `…/refunds`, `…/returns`, `…/history`. |
| GET · POST | `/api/warranty-claims` | `warranty:read` · `write` | Warranty claims (SAV/RMA): list (`?status=`, `?limit`) or one by `?externalRef=`; POST opens a claim `{ orderId, orderItemId, reasonCode?, reason?, comment?, externalRef? }` (coverage snapshotted at open). |
| GET · PATCH | `/api/warranty-claims/[id]` | `warranty:read` · `write` | One claim by uuid OR `external_ref`; PATCH is the ERP write-back — a body with `resolution` (`repaired`/`replaced`/`refunded`/`rejected`) CLOSES it, otherwise `{ status?, comment?, reasonCode?, externalRef? }` advances it. |
| POST | `/api/orders/[id]/shipments` · `…/refunds` · `…/returns`, PATCH `…/returns` | `orders:write` | Fulfilment writes through the same workflows as the dashboard (order lock, over-ship / over-return guards). |
| PATCH | `/api/orders/[id]/status` | `orders:write` | `{ status?, paymentReference?, notes?, externalRef?, unlink? }`. Runs the SAME payment-method-aware state machine as the dashboard; `paymentReference` / `notes` require `status`. |

Bons de livraison: each parcel (shipment) carries its own BL number
(`shipments.delivery_note_number`). The `issue-bl-on-ship` subscriber stamps a
whole-order BL only for orders shipped without parcels (status dropdown);
parcel-fulfilled orders get none, so the same goods are never numbered twice.

ERP linking: `orders.external_ref` (unique when set) is the two-way key. The
status PATCH links it through `workflows.order.setExternalRef` (idempotent;
audited as `order.edited`; `already_linked` / `external_ref_conflict` → 409;
clearing needs `unlink: true`). Customers link the same way (`PUT
/api/customers {id, externalRef}`). Beyond the pull API, the store PUSHES events
to ERP endpoints as signed outbound webhooks (the `webhook-endpoints` module,
see [WEBHOOKS.md](../WEBHOOKS.md)); the `webhook_events` table is the separate
INBOUND payment-idempotency ledger.

**Headless content reads** (read-only; same key/scope/public-toggle model). A
head can render full pages without the storefront: scopes `content:read`,
`blog:read`, `aide:read`, `reviews:read` (all granted by coarse `read`/`full`).
Serializers live in `src/lib/api/{content,blog,aide,reviews}.ts`.

| Method | Path | Scope | Notes |
| ------ | ---- | ----- | ----- |
| GET | `/api/content` | `content:read` | One-call site chrome bundle: hero/header/footer banners, header + footer nav, **active trust badges**, logo, and the PUBLIC subset of `site_settings`. **Secrets never leak** — `getContentBundle` allow-lists `site./social./nav./theme./seo./checkout./shipping./reviews./consent./tracking.` and drops any `payment.`/`mail.` key, `tracking.custom_head`/`custom_body` (raw snippets), + any `_enc`/secret/token-looking key. Header and footer nav drop links whose category / brand target is deactivated or deleted, unless an active redirect still serves the stored URL. |
| GET | `/api/blog` | `blog:read` | Published posts (`?limit≤50`, `?cursor`, `?category=slug`); `?categories=1` → category list. `body` is serialised through `sanitizeRichHtml`; a post whose category is deactivated returns `category: null`. |
| GET | `/api/blog/[slug]` | `blog:read` | One published post (image, category, tags). |
| GET | `/api/aide` | `aide:read` | Published help articles (`?limit≤50`, `?cursor`, `?category=slug`, `?platform`); `?categories=1` → category list. `intro` / `outro` / `steps[].body` are sanitised the same way. |
| GET | `/api/aide/[slug]` | `aide:read` | One published help article, steps included. |
| GET | `/api/reviews` | `reviews:read` | Approved reviews + stored aggregate (count/average/distribution) for one product by any ref (`?product=slug` / `?sku=` / `?gtin=` / `?externalRef=` / `?id=`), `?rating=1-5`, `?limit≤100`. Internal fields (user id, `source`, status) are never exposed. A public (toggled) caller gets an empty result while `reviews.enabled` is off. |

> **Boundary — `/api/store/search` is NOT part of this keyed API.** The
> storefront autocomplete endpoint (`OTHER_ROUTES`, `store.search`) is a
> **first-party, same-origin** route gated by origin + per-IP rate limit, not an
> API key/scope. It is deliberately not externally consumable and cannot be
> toggled public from the API & Webhooks panel — a head should read the catalog
> through its own indexing, not this endpoint. The keyed integration surface is
> only the `/api/<resource>` routes registered in `EXTERNAL_API_ROUTES` above.

> **RBAC gating.** Admin access is governed by the permission registry
> (`src/lib/rbac/registry.ts`, `<module>:<action>` keyed 1:1 to the admin-nav
> ids) and the engine in `src/lib/rbac/authorize.ts`. The gates live in
> `src/lib/auth/session.ts`:
>
> - `requirePermission(module, action)` — per-page / per-action gate (the default
>   for admin pages and actions). `'*'` and `'<module>:*'` both satisfy it.
>   `requirePermissionAny(grants)` is the OR form (e.g. « Nouvelle commande »).
> - `requireAdminArea()` — shell / index pages (passes on ANY grant). A page
>   behind it that shows module data MUST gate each block by that module's
>   `view` grant. The dashboard does this through `resolveDashboardAccess`
>   (`src/lib/rbac/dashboard-access.ts`): `dashboard:view` is the master switch,
>   plus analytics / orders / customers / stock|products `view` per block, and a
>   hidden block's queries are skipped.
> - `requireSuperAdmin(module, action)` / `checkSuperAdmin(userId)`
>   (`src/lib/auth/super-admin.ts`) — the `*` step-up for store-wide destructive
>   operations, on top of the module grant. Other owner-only fields check `*`
>   in their own action: mail transport + security templates,
>   `seo.site_url`, off-site redirects, tracking custom code / GTM id, payment
>   gateway credentials. (`requireAdmin()` no longer exists.)
>
> The `/admin` layout uses `resolveAdminShellAccess` (`src/lib/rbac/authorize.ts`)
> for the area check plus nav scoping: it returns `{ ok, grantedKeys }` (concrete
> `<module>:<action>` keys, `null` = wildcard) and the shell shows an item when
> `<id>:view` is granted, or, for an item whose page guard differs, any grant in
> its `visibleWhen` list. Such a page guards with `requirePermissionAny` on the
> SAME constant from `src/lib/rbac/nav-access.ts` (`CAISSE_VIEW_GRANTS`,
> `ORDER_NEW_VIEW_GRANTS`), so nav and guard can't drift
> (`admin-nav-access.test.ts`).
>
> The legacy `users.role === 'admin'` enum bridges to `'*'`, so existing admins
> keep full access with zero seeded rows. The enum role and RBAC roles are
> independent sources of access: `changeRole` refuses → Client while the account
> holds any RBAC role, and Admin → Staff while an RBAC role grants `'*'`.
> User/role administration additionally
> enforces "no privilege above your own" via `src/lib/rbac/guards.ts`
> (a delegate cannot grant a role or touch an account more privileged than
> itself; only a wildcard admin mints enum admins).

### 7.2 SEO — metadata, structured data & crawl files

SEO is **not a module** (no owned tables); it's a settings-driven cross-cutting
layer in `src/lib/seo/` + a handful of route handlers. Everything an operator can
tune lives behind ONE admin tab — **Système → SEO & schéma**
(`/admin/system/seo`, `seo-settings-panel.tsx` → `saveSeoSettingsAction`),
writing `seo.*` (and reusing a few `site.*`) keys in `site_settings`. The panel is
split into **sub-tabs** (one `<form>`, all panels stay mounted via `FormTabs` so a
single save persists everything): **Général** (URL, default meta incl.
`seo.description_home` / `seo.keywords`, live preview) ·
**Indexation & robots.txt** · **Sitemap** · **Données structurées** (schema) ·
**Flux produits** (Google Merchant + OpenAI ACP feeds) · **Markdown agents**
(Markdown-for-Agents toggle) · **llms.txt**.

**The single config source.** `getSeoConfig()` (`src/lib/seo/config.ts`) reads
the settings map ONCE per request (wrapped in React `cache()`) and returns the
canonical `SeoConfig`: `siteUrl` (admin `seo.site_url` overrides the build-baked
`NEXT_PUBLIC_SITE_URL` — changeable without a redeploy, but owner-only (`*`) and
a bare https origin (http only for localhost), since it also drives payment
return/callback URLs, email links, Pro invite links and order QR codes), `siteName`,
`titleTemplate`, default title/description, the OG image resolved to an absolute
URL through the médiathèque (`seo.og_image_media_id` → theme default → site
logo), `sameAs` (seo.social_* with footer `social.*` fallback), `knowsAbout`,
contact (from `site.*`), `robotsIndex` (the master kill-switch), `productSameAsEnabled`
(per-product sameAs gate), `orgType` (admin-chosen schema.org Organization
`@type`: Organization | OnlineStore | Store), `robotsExtraDisallow` (extra
robots.txt Disallow paths), `sitemapExtraUrls` (extra sitemap URLs), and the
optional custom `llmsTxt`. The three free-text/enum admin inputs (`seo.org_type`,
`seo.robots_extra_disallow`, `seo.sitemap_extra_urls`) are sanitized by the pure
`src/lib/seo/settings-normalize.ts` (allowlist the org type; keep only site-root
paths / absolute http(s) URLs; dedupe + cap) so the consumers can never emit a
malformed rule/URL.

**Per-page `<metadata>`.** Pages call `buildPageMetadata()`
(`src/lib/seo/page-metadata.ts`), which layers per-page title/description/OG/
canonical/noindex over the global config. Titles flow through `composeTitle()`
(`src/lib/seo/title.ts`): it strips any baked-in brand suffix/prefix
(separator-aware, preserves "Spider-Man"), applies the template ONCE, and the
result is returned as `title.absolute` so the **root layout's** `title.template`
can't re-apply and double the suffix (`… · Tokyo Store · Tokyo Store`). The global
`seo.robots_index` kill-switch and a per-page `index` flag both feed `robots`.

**JSON-LD entity graph** (`src/lib/seo/jsonld.ts`, 2026 master-guide shape):
- ONE `@graph` per page; merge composed graphs with `mergeGraphs(...)`.
- `Organization` + `WebSite` are defined ONCE (home, `buildGlobalGraph`) with
  stable `@id`s (`orgId`/`websiteId` = `${siteUrl}/#organization|#website`);
  every other page **references** them by `@id` instead of redefining them.
- Listing pages (category, brand, blog/aide index + category) use
  `buildCollectionGraph` → `CollectionPage` + `BreadcrumbList` + `ItemList`,
  `isPartOf` the WebSite. Brand pages add `buildBrandGraph` (`#brand`).
- The PDP emits an inline merchant `Product` (`@id` `…#product`, `isPartOf` →
  WebSite, offers with price/currency/availability/priceValidUntil/seller/
  shipping, `brand` → the Brand entity `@id` when the product has a brand,
  `gtin`/`mpn`/`sku`). `aggregateRating` + a top-5 `review[]` are emitted **only**
  when there are ≥5 real reviews.
- **Per-product `sameAs`** (official external URLs — manufacturer / official
  store) is opt-in: the admin turns on the master switch `seo.product_sameas_enabled`
  (SEO tab), which reveals a "liens officiels" field on each product's SEO tab.
  Stored as free text on `products.same_as`; `lib/seo/same-as.ts` (`parseSameAs`,
  pure + tested) validates it to a deduped list of absolute http(s) URLs at DTO-map
  time. The PDP emits `Product.sameAs` ONLY when the switch is on AND the product
  has ≥1 valid URL — the switch is the single gate **for the storefront JSON-LD**.
  (The keyed product data API returns the parsed `sameAs[]` regardless of the
  switch — it's an ERP/headless data field, not a crawler-facing emission.)
- Blog `Article` / Aide `TechArticle` carry `@id` (`…#article`), `url`,
  `isPartOf` → WebSite, `publisher`/`author` → Organization `@id`; Aide adds a
  `HowTo` when the guide has numbered steps. The noindexed blog **tag** archive
  deliberately ships NO structured data.
- Optional admin-authored Q/A renders `buildFaqGraph` (returns `null` when
  empty — never an empty `FAQPage`).
- Every JSON-LD string is `<`-escaped (`replace(/</g, "\\u003c")`) before going
  into a `<script type="application/ld+json">` so admin-edited copy can't break
  out of the tag.

**Crawl files** (route handlers, all driven by `getSeoConfig`). All three export
`dynamic = "force-dynamic"` so they render per-request — otherwise Next
statically prerenders them at build time and the admin's `robots_index` /
`robots_extra_disallow` / `sitemap_extra_urls` / `site_url` edits would only take
effect on the next redeploy:
- `src/app/sitemap.ts` (2026 structure) — key content pages (NOT auth/utility
  routes like login/register/panier), smart collections, the full catalog
  (products + ALL storefront-visible non-empty categories **AND sub-categories** —
  the row AND every live ancestor active (`isCategoryChainActive`), so
  deactivating a parent hides its subtree — via
  `categoryQueries.listSitemapCategories` + per-node `countProductsForCategoryTrees`,
  brands), and editorial (blog/aide articles + categories). `!noindex` everywhere;
  thin/duplicate archives (blog tags) excluded. `lastmod` is each row's real
  `updated_at`/`published_at` (genuine freshness, not request time). Each content
  type is toggleable from the SEO tab (`seo.sitemapInclude.*`, default ON), and
  the admin's deduped `seo.sitemap_extra_urls` are appended.
- `src/app/robots.txt/route.ts` (a RAW route handler, not the `MetadataRoute`
  convention, so the body can carry comments + the llms.txt pointer + per-feature
  Allow carve-outs) → the pure `src/lib/seo/robots-txt.ts` builder. The master
  `seo.robots_index = false` switch turns the whole site `Disallow: /`. When
  indexing is ON it emits ONE `User-agent: *` group (welcoming search + AI to
  public content — never naive per-bot Allow groups that would let a bot ignore
  `*` and crawl `/admin`), appends the admin's validated `seo.robots_extra_disallow`
  to the built-in private set (`/admin /api /account /favoris /panier /checkout /facture`), and
  REACTIVELY adds an `Allow: /feeds/<file>` per ENABLED product feed + a `/md`
  (and `/*.md$`) Disallow while Markdown-for-Agents is on — so robots.txt always
  matches what is actually served. (Replaced the former `src/app/robots.ts`.)
- `src/app/llms.txt/route.ts` → the pure `src/lib/seo/llms-txt.ts` builder.
  Serves the admin's custom `seo.llms_txt` verbatim when set, else GENERATES a
  rich 2026 AEO/GEO map from live data: a `>` summary, a topical H2 per top-level
  category with the descendant tree (`buildCategoryForest` rebuilds the tree from
  the flat list, skips noindex, promotes orphans, cycle-guarded), then smart
  collections, blog/aide categories, how-to-order, shipping/warranty (configured
  facts only — never a fabricated claim), store info, and the enabled machine
  feeds. Satisfies "control AND creation".

**Machine-readable surfaces** (`src/lib/seo/feeds/*` + `src/lib/seo/markdown/*`,
two extra route handlers). Both are `noindex`, sitemap-excluded, and unlinked —
ingestion endpoints, not search pages:
- **Product feeds** — `getFeedConfig()` (`feeds/config.ts`, React `cache()`) →
  `resolveFeedConfig` (pure `feeds/normalize.ts`) reads `seo.feed_*` keys and
  yields the two feeds' enabled-state + editable filenames + seller identity
  (`seller_name`, `store_country`, `target_countries`, return/privacy/tos URLs).
  `src/app/feeds/[file]/route.ts` (ISR `revalidate=1800`) matches the requested
  filename against the **enabled** configured paths (a disabled/unknown name →
  404, so nothing leaks before opt-in) and serves EITHER the Google Merchant RSS
  2.0 XML (`feeds/google-merchant.ts`) OR the OpenAI Agentic-Commerce-Protocol
  JSON (`feeds/acp-feed.ts`). Both default **OFF**. `feeds/products.ts`
  (server-only) maps the published catalogue ONCE per ISR window via
  `listApiProducts` (paged, capped `MAX_PRODUCTS=5000` — a larger catalogue is
  truncated newest-first with a `console.warn`, never silently); variable
  products expand to one row per variant. Pure image selection
  (`feeds/images.ts`) skips placeholder-only products (Google rejects placeholder/
  SVG) and dedupes each row's primary out of its additional-image gallery.
- **Markdown for Agents** — clean Markdown twins of content pages for AI agents.
  The edge proxy (`src/proxy.ts`) rewrites any markdown-shaped request (a `.md`
  suffix OR `Accept: text/markdown`) whose path passes the pure `markdownEligible`
  (`markdown/eligible.ts`, excludes home + `/admin /account /api /checkout /panier
  /order /recherche …` + file-extension paths) to `/md/[...path]`; a normal
  browser (`Accept: text/html`) is NEVER matched, so humans + Googlebot are
  unaffected. `src/app/md/[...path]/route.ts` (`force-dynamic`, CDN `s-maxage=900`)
  reads `isMarkdownAgentsEnabled` (`markdown/config.ts`, default **ON**; off → 404)
  and dispatches through `resolveMarkdownForPath` (`markdown/generate.ts`) — which
  MIRRORS the storefront `/[slug]` dispatch (category → product →
  brand → CMS, + blog/aide + subcategory) honouring the SAME `noindex`/`visible`
  gates, using the **paged** loaders (`listApiProductsByCategory` /
  `listApiProductsByBrand`, capped at `LISTING_CAP=100`) so an agent crawl never
  enriches a whole tree. Pure builders (`markdown/docs.ts` + `markdown/render.ts`)
  emit YAML frontmatter (title/description + product price/currency/availability/
  sku) + a clean Markdown body. Twins honour the product's visibility (the product twin 404s like the PDP;
  category, sub-category and brand listings are public-gated), quote the PDP live-promo price, validate
  `/parent/sub` like the HTML page, and use the page canonical (`canonical_url`
  override, flat `/sub`) for the frontmatter `url` and the `Link` header.
  Every response (success AND 404) carries
  `Content-Type: text/markdown`, `Vary: Accept`, `X-Robots-Tag: noindex`; success
  adds `x-markdown-tokens` + `Link: <canonical-html-url>; rel="canonical"`.
  Signed-in responses are `private, no-store`.

The SEO panel also surfaces quick links to `/robots.txt`, `/sitemap.xml` and
`/llms.txt` (in the relevant sub-tab) so an operator can verify exactly what
Google and the AIs see, and documents that per-page SEO lives on each fiche's own
"SEO" tab while Organization contact details come from **Réglages → Site**.

> Pure helpers are unit-tested DB-free: `seo-title.test.ts`
> (`stripBrandFromTitle`/`composeTitle` brand-suffix de-dup), `same-as.test.ts`
> (`parseSameAs` product official-URL validation), `seo-settings.test.ts`
> (`normalizeOrgType`/`normalizeDisallowPaths`/`normalizeSitemapUrls`),
> `feed-config.test.ts` (`resolveFeedConfig` defaults/overrides/ISO + path
> sanitisation), `feed-builders.test.ts` (Google Merchant XML + ACP JSON shape +
> the strict ACP rules), `feed-images.test.ts` (placeholder-skip + gallery dedup),
> and `markdown-render.test.ts` (frontmatter/HTML→MD/doc builders + `markdownEligible`).

### 7.3 Redirects & the 404 page

Admin → **Système → Redirections & 404** (`/admin/system/redirects`, RBAC
`system_redirects`). A tabbed page: **Redirections** (server-paginated list +
create/edit + CSV mass-import with an example-CSV download + active toggle +
delete), **Réglages des redirections** (master `redirects.enabled`), **Page 404**
(`notfound.title`/`notfound.message`/`notfound.show_search`/`notfound.show_suggestions`),
**Maintenance** (site availability — see below). The « Maintenance & lancement »
Système-hub tile deep-links to that last tab.

- **Module** `src/modules/redirects/` — `redirects` table (unique `source_path`,
  `destination`, `status_code` ∈ {301,302,307,308}, `is_active`, `hits`,
  `last_hit_at`; migration 0076). `queries` (point lookup + paginated list +
  counts) / `service` (create-upsert, update, setActive, remove, `bulkUpsert` for
  CSV, `recordHit`).
- **Resolution** (`src/lib/redirects/resolve.ts`) runs at the TOP of the
  storefront content page components (node RSC — the edge proxy is deliberately
  DB-free): `[slug]`, `[slug]/[sub]`, the 3+-segment catch-all
  `(shop)/[slug]/[sub]/[...rest]` (a lookup, then `notFound()`), and the blog /
  aide / brand / marques / promo routes. It point-looks-up the
  current path and, on an active match, issues `permanentRedirect` (308, for
  301/308) or `redirect` (307, for 302/307) — Google treats these like 301/302.
  A rule never fires on the home page, on dedicated single-segment pages
  (`/about`, `/cgu`, `/login`…) or on the exact `APP_ROUTE_SHAPES` in
  `src/lib/pages/reserved-routes.ts` (`/order/<id>`, `/account/orders/<id>`,
  `/login/2fa`, `/facture/<x>`, `/feeds/…`, `/md/…`, `/cdn/…`,
  `/admin/…`, `/api/…`, the legacy `/category/<x>(/<y>)` and `/product/<x>`…);
  other paths under those prefixes (e.g. WooCommerce `/product/<cat>/<slug>`)
  are resolved. The admin flags a rule that can never fire « Jamais appliquée »
  (`redirectSourceCoverage`). No-op + never-500 when none matches or the
  engine is off. The path is decoded+normalized identically on write (form/CSV)
  and lookup so encoded/trailing-slash sources match.
- **Write rules.** A create never overwrites an existing source, and an update
  onto a taken source is refused. Absolute destinations on the store's own hosts
  (public origin, `NEXT_PUBLIC_SITE_URL`, `BETTER_AUTH_URL`, apex or www) count
  as internal for the loop guard. Off-site destinations are owner-only (`*`),
  directly or through an active chain, on form saves, the activation toggle and
  CSV import, and they are stored as temporary (301/308 become 307).
- **Slug renames.** Renaming a published product or an active category or brand
  creates a 301 old→new after commit (`syncEntityUrlRedirects`,
  `src/lib/redirects/auto-slug-redirect.ts`; a sub-category also gets
  `/parent/old → /new`); it never overwrites an operator rule. An ACTIVE
  redirect on a URL blocks another entity from claiming that slug; publishing or
  re-activating an entity deactivates any active rule on its URL (audited as
  `redirect.updated`).
- **Validation** is centralized + pure in `src/lib/redirects/normalize.ts`
  (`normalizeSourcePath`/`normalizeDestination`/`normalizeStatusCode` +
  `parseRedirectsCsv`), tested in `redirects.test.ts`.
- **404 page** (`src/components/not-found-scene.tsx`, mounted by both
  `app/not-found.tsx` standalone + `(shop)/not-found.tsx` embedded) reads
  `getNotFoundConfig()`. An elegant watch-themed "4 ◷ 4" lockup where the middle
  "0" is a sweeping analogue clock (`src/components/animated-clock.tsx`, shared with
  the maintenance scene); olive glow + film grain; recovery CTAs; reduced-motion safe.
- **Maintenance / coming-soon mode** — the `site.mode` setting (`live` |
  `maintenance` | `coming_soon`) closes the storefront to the public. `parse.ts`
  (pure, unit-tested `site-mode-config.test.ts`) resolves it + FAILS OPEN (any
  unknown value / DB error ⇒ `live`, so a settings glitch never blanks the store);
  `config.ts` wraps `getSettingsMap` + `viewerCanBypassSiteGate` (signed-in staff).
  The GATE lives at the top of `(shop)/layout.tsx`: gated + not-staff ⇒ it returns
  `MaintenanceScene` (the same clock scene as the 404 — no logo, just the clock —
  `noindex`) BEFORE the chrome fetch; STAFF fall through to the real storefront
  unchanged. An optional live **countdown** renders in EITHER mode when a target
  date is set AND `site.show_countdown` is on (an independent activate/deactivate
  toggle; no date ⇒ nothing shows). The staff login
  (`/admin-login`, top-level) and `/admin` sit OUTSIDE `(shop)`. Inside it,
  `SITE_GATE_EXEMPT_PATHS` (`src/lib/site-mode/gate-exempt.ts`: `/login` incl.
  `/login/2fa`, `/forgot-password`, `/reset-password`, `/verify-email`,
  `/se-desabonner`; `/register` stays gated) stay reachable so TOTP staff,
  invites, resets and unsubscribes keep working. They render in a bare shell with
  a client nav guard (`SiteGateNavGuard`) that hard-reloads any navigation to a
  gated route, because layouts don't re-run on soft navigation; the proxy always
  overwrites the `x-tokyo-pathname` header the layout reads. The non-page public
  surfaces are closed too, through `isSiteGatedForViewer()`
  (`src/lib/site-mode/config.ts`; the mode lookup fails open, the staff bypass
  fails closed): `/api/store/search` returns empty results, `/feeds/*` and the
  `/md` twins 404, `sitemap.xml` is empty, and `robots.txt` serves `Disallow: /`
  with no Sitemap. Only search and `/md` let signed-in staff through; the
  cookie-free machine files (feeds, sitemap, robots) pass `allowStaff: false`.
  `llms.txt` checks the mode directly (`isSiteGated`, no staff bypass) and serves
  a minimal body. Storefront pages rely
  on the `(shop)` layout gate alone; storefront Server Actions don't check the
  mode. Admin
  copy/date/toggle in the « Maintenance » tab → `saveSiteModeSettingsAction` (`src/lib/actions/site-mode.ts`, `system_redirects`;
  busts the storefront layout so the mode flips on the next request). Keys:
  `site.mode` · `site.maintenance_title` · `site.maintenance_message` ·
  `site.launch_at` · `site.show_countdown`.

### 7.4 Tracking & Analytics (GTM / GA4 / Meta Pixel + Consent Mode v2)

Admin → **Système → Suivi & Analytics** (`/admin/system/analytics`, RBAC
`system_analytics`). Sub-tabbed (`FormTabs`): **Activation** (master
`tracking.enabled`), **Consentement** (the « Bypass » switch + Consent Mode
strategy off/basic/advanced + region scope + wait_for_update + ads_data_redaction
+ url_passthrough + the per-signal default editor + a live banner-status note),
**Identifiants** (GTM / GA4 / Meta Pixel ids), **Événements** (8 activation
toggles), **Code personnalisé** (head/body snippets). Settings-driven (no
module/table) — all `tracking.*` `site_settings` rows via
`saveAnalyticsSettingsAction`. **Harmonized with Cookies & RGPD**: the pure
`src/lib/consent/effective.ts` resolves the EFFECTIVE consent — bypass
(`tracking.bypass_consent`) OR a disabled banner ⇒ everything forced granted
(and the Consent Mode default starts granted); otherwise the visitor's decision
MASKED by the offered categories (a de-offered category is denied even with a
stale cookie grant — `setConsentOffer` mirrors this into the funnel's
`hasConsent`). The ConsentProvider takes a `bypass` prop and is the runtime
source of truth; both admin tabs cross-link + reflect each other.

> Tag ids moved OUT of Cookies & RGPD here. `consent.*` keeps only banner/category
> config; `parseTrackingConfig` reads `tracking.gtm_id`/`ga4_id`/`meta_pixel_id`
> with a **legacy `consent.ga_id`/`gtm_id`/`meta_pixel_id` fallback** (no migration,
> no data loss — existing installs keep working until the owner re-saves here).
> Tag ids are allow-listed per field (GA4 `^G-[A-Z0-9]{4,}$`, Meta Pixel
> `^\d{5,20}$`, GTM `^GTM-[A-Z0-9]+$`, `src/lib/tracking/parse-config.ts`): the
> save action refuses a non-matching id and `parseTrackingConfig` ignores one
> (legacy keys included). The keys that can run arbitrary JS —
> `tracking.custom_head` / `custom_body` and the GTM container id
> (`TRACKING_SCRIPT_KEYS`, `src/lib/tracking/script-keys.ts`) — are owner-only
> (`*`); GA4 / Pixel ids and the toggles stay delegable under
> `system_analytics:update`.

- **Config** `src/lib/tracking/config.ts` (`server-only`) — `getTrackingConfig()` /
  pure `parseTrackingConfig(map)` (mirrors `lib/consent/config.ts`). `mode` ∈
  {`advanced` (default, recommended), `basic`, `off`} (`off` = no Consent Mode
  stub at all; Google tags load + collect normally, the Meta Pixel still gated by
  the marketing category). Also parses `bypassConsent`, `waitForUpdate`,
  `adsDataRedaction`, `urlPassthrough`, and per-signal `signalDefaults`
  (`tracking.cm_default_<signal>`). `toClientTrackingConfig` (public subset for
  the loader — bypass is NOT in it; it reaches the runtime via the provider) and
  `clientTrackingFlags` (per-group map, forced all-`false` when the master switch
  is off).
- **Consent Mode v2** `src/lib/tracking/consent-mode.ts` (pure) — `signalsFromState`
  maps our 4 categories → Google's 7 signals (necessary→`security_storage` always
  granted; functional→functionality/personalization; analytics→analytics_storage;
  marketing→ad_storage/ad_user_data/ad_personalization). `buildConsentDefaultJs`
  emits the stub from the admin per-signal `defaults` (or ALL-granted when
  `forceGranted` = bypass/banner-disabled), region-scoped when `region_eea_only`
  to the enumerated **ISO 3166 EEA codes + GB + TN** (`RESTRICTED_REGIONS` — NOT
  "EU"/"EEA", which Consent Mode silently ignores), with configurable
  `wait_for_update` + `ads_data_redaction` + `url_passthrough`; JSON-serialized
  values → injection-safe. Tested in `tracking-consent-mode.test.ts`.
- **Loading** — the shop layout (`src/app/(shop)/layout.tsx`) injects the
  consent-default stub (raw inline `<script>`, before GTM/GA) + the
  `window.__GZ_TRACK_CFG__` global, then mounts: `TrackingScripts`
  (`src/components/tracking/`, dual-mode — *advanced* loads tags consent-denied
  for cookieless modeling; *basic* blocks until the category is granted; direct
  GA4 only when no GTM id, to avoid double counting), `ConsentModeSync` (pushes
  `gtag('consent','update')` + `fbq('consent',…)` on every decision change), and
  `CustomTrackingHtml` (owner snippets — ALWAYS consent-gated on analytics OR
  marketing even in advanced mode, since Consent Mode can't govern arbitrary
  third-party tags; scripts re-executed; not auto-revoked on withdrawal).
  Replaces the old `consent-gated-scripts.tsx`.
- **Funnel** `src/lib/tracking/funnel.ts` — `track(event,payload)` pushes the GA4
  `ecommerce` shape to `dataLayer` (with the `ecommerce:null` clear-before-push)
  + mirrors to `/api/track` only while `serverMirrorActive()`
  (`src/lib/tracking/server-mirror.ts`) is true — development today; production
  skips the POST until a server fan-out is wired (flip `SERVER_FANOUT_WIRED`).
  `hasConsent()` also voids a decision recorded under an older
  `consent.revision`. Each push also carries a `gz_consent`
  `{analytics,marketing}` snapshot so NON-Google GTM tags (Meta/TikTok/custom) can
  gate on it. Per-group gate (`event-groups.ts`, tested in
  `tracking-events.test.ts`) checked FIRST so a disabled group never queues; in
  *basic* mode events are held + replayed on analytics consent, in *advanced* mode
  pushed immediately (Consent Mode governs transmission). Wired events:
  `view_item_list`/`select_item` (listing + card), `view_item` (PDP),
  `add_to_cart` (card + PDP), `remove_from_cart`/`view_cart` (cart),
  `add_to_wishlist`, `begin_checkout`/`add_shipping_info`/`add_payment_info`
  (checkout), `purchase` (order success), `search`, `sign_up`. (`login` is not
  auto-fired — the sign-in action redirects server-side; wire it via GTM on the
  post-login page if needed.)
- **Public API** — `/api/content` exposes the `tracking.` prefix (ids + toggles
  are public-by-nature) but `DENY_KEYS` keeps `tracking.custom_head`/`custom_body`
  server-only.
- **`POST /api/track`** — the server mirror for client funnel events. **Same-origin
  only** (`requireFirstParty`), **60 req/min per IP** (429), **8 KB body cap** (413).
  Body `{ event, payload }`; `event` must be in the allow-list **derived from
  `event-groups.ts ALL_FUNNEL_EVENTS`** (single source — a drift-guard test pins
  it, so the route can't fall behind the `FunnelEvent` union). Honors consent
  server-side, mirroring the client: an un-consented event gets
  `{ ok:true, skipped:"no_consent" }` UNLESS the owner opted out of gating —
  « Bypass » (`tracking.bypass_consent`), a disabled banner (`consent.enabled`),
  or Consent Mode `off` (`tracking.consent_mode`) all collect freely — and the
  cookie's analytics grant counts only if the category is still OFFERED
  (`consent.analytics_enabled`, the same offer-mask as `hasConsent`) and was
  recorded under the current `consent.revision` (a bump voids earlier
  decisions). In production, with no fan-out wired, it answers
  `{ ok:true, skipped:"no_sink" }` right after the same-origin check, with zero
  DB work. When active, the six gate keys (`tracking.enabled`,
  `consent.enabled`, `consent.analytics_enabled`, `tracking.bypass_consent`,
  `tracking.consent_mode`, `consent.revision`) come from ONE `unstable_cache`d
  read (tag `site:settings`, 60 s revalidate), and the master/consent gate runs
  BEFORE the per-IP rate limit. Today it just validates + logs (dev); it's the
  single hook where a future Meta CAPI / GA4 Measurement Protocol / Plausible
  fan-out plugs in — no `audit_log` write.
- **CSP** — `src/lib/security/headers.ts` allow-lists the GTM/GA4/Meta hosts plus
  common custom-tag vendors (TikTok / Hotjar / Clarity / LinkedIn). Any OTHER host
  pasted in "Code personnalisé" must be added to **`CSP_EXTRA_HOSTS`** or the
  browser silently blocks it. It is a Docker BUILD ARGUMENT (`buildCsp()` can't
  read the DB): the compose passes it both as a build arg and as a runtime env,
  and changing it needs a rebuild, not just a restart.

### 7.5 Currency (Commandes → Devises), product condition & delivery time

Three commerce levers added 2026-06 (migrations **0077** condition, **0078** currencies):

- **Global currency** — the `currency` module (`currencies` table) holds a registry
  with ONE active row (partial unique index `WHERE is_active`; TND seeded active).
  `getActiveCurrency()` (`src/lib/currency/active.ts`, React-cached, TND fallback)
  drives the price LABEL across: `MoneyProvider` (every `useMoney()` surface),
  PDP JSON-LD `priceCurrency` + `shippingRate.currency`, the **`order.currency`
  snapshot** at place-order (read up-front, NOT inside the tx), the funnel default
  (via `__GZ_TRACK_CFG__`), and the **`/api/content` bundle** (`currency`, the
  headless analogue of MoneyProvider). It RELABELS only — money stays integer
  millimes (`MINOR_PER_DINAR`); display DECIMALS stay governed by `price.decimals`.
  Admin Commandes → Devises (list/add/edit/set-active/delete; can't delete the
  active one; duplicate ISO code is caught, not 500'd). Pure normalizers +
  row-mapper + delete-guard in `currency/normalize.ts` (tested:
  `currency-normalize.test.ts`, `money-format.test.ts`). Per-product currency was
  REMOVED — `products.currency` is a frozen legacy column (kept, defaults TND).
  **Long tail (deferred):** server-side `formatCents`/`formatMoneyExact` surfaces
  (invoices, search, emails) still print "TND" — no visible change while TND is
  active. Payment gateways are TND-locked.
- **Product condition (état)** — `products.condition` (`new｜used｜refurbished`,
  default `new`, CHECK, migration 0077). Pure mapping `src/lib/catalog/condition.ts`
  (`conditionSchemaUrl` → Offer.itemCondition, `conditionLabelFr` → PDP "Détails"
  row), tested in `condition.test.ts`. Flows through the keyed product API
  (`ApiProduct.condition` via the DTO spread). File import does NOT set it yet
  (imported products default to `new`).
- **Delivery time** — `checkout.delivery.handling_days_min/max` +
  `transit_days_min/max` (day counts, `getCheckoutCopy` + `CHECKOUT_COPY_FALLBACKS`,
  pure parsers in `checkout/parse.ts` tested by `checkout-parse.test.ts`) feed the
  PDP Offer `shippingDetails.deliveryTime`. Free-text `eta_label` kept for display.

### 7.6 Recherche (search engine + control center)

The storefront search (cross-table Postgres FTS + `pg_trgm` hybrid in
`src/modules/search`) is admin-tunable and has a single admin home at **Système →
Recherche** (`/admin/system/search`, RBAC `system_search` VIEW_MANAGE). The core
tuning is settings-only, but the module now also owns two DB-backed features:
**synonyms/aliases** (`search_aliases`, migration 0114 — runtime-editable
term→expansion rules; `expandSearchQuery` ORs the variants into the tsquery,
capped at `MAX_QUERY_EXPANSIONS`; `DEFAULT_SEARCH_ALIASES` seed) and **semantic
(pgvector) search** (`products.embedding vector(1536)` + `embedding_input_hash`,
migrations 0111/0112/0113 + the `ai_call_logs` transport log; opt-in via
`search.semantic_enabled`, OFF by default; provider/model set in Système → IA &
Automation → onglet **Embeddings**, catalogue vectorised in the Sémantique tab). Both are additive +
safe-by-default: with no aliases and no vectors, the query is byte-for-byte the
legacy FTS+trigram query.

- **Config contract** — `src/modules/search/parse-config.ts` is the PURE
  (no-DB, unit-tested) resolver: `SEARCH_DEFAULTS` + `resolveSearchConfig(map)`
  clamps every `search.*` key to a safe range, and `getSearchConfig()`
  (`config.ts`, server) does the React-cached settings read. `search.*` settings
  are only upserted (no generic per-key deleter exists to wipe them). Keys & defaults:

  | Key | Default | Range | Effect |
  | --- | ------- | ----- | ------ |
  | `search.min_query_length` | 2 | 1–4 | gate before the engine runs (page/api/service) |
  | `search.trigram_threshold` | 0.3 | 0.1–0.6 | pg_trgm fuzzy-match floor (see below) |
  | `search.weight_name` / `search.weight_desc` | 2 / 1 | 0–10 | α/β in `score = ts_rank_cd·α + similarity·β` |
  | `search.semantic_enabled` | false | bool | turns on the pgvector recall branch (Sémantique tab) |
  | `search.weight_semantic` | 1 | 0–10 | δ: `+ vec.sim·δ` in the score (semantic only) |
  | `search.semantic_min_similarity` | 0.35 | 0–0.9 | cosine floor for vector-ONLY recall (keyword hits are never floored); set in the Sémantique tab |
  | `search.kind_<kind>` | true | bool | per-kind on/off (product/category/brand/blog_post/aid_article/page) |
  | `search.result_limit` | 24 | 1–50 | per-kind cap on `/recherche` |
  | `search.autocomplete_limit` | 6 | 1–25 | per-kind cap for the header dropdown / API default |
  | `search.show_out_of_stock` | true | bool | true = show OOS: the top-N is picked by relevance (`score DESC, in_stock DESC`), then in-stock hits are listed before OOS ones within that page (stable in-page partition, so a strong OOS match is never pushed off the page); false = exclude OOS from product search |
  | `search.purge_months` | 3 | 1–24 | search_log retention window (§ below) |

- **Index-safe threshold + bounded connections** — the trigram branch uses the
  `%` operator (NOT a bare `similarity() >= x` call) so it rides the
  `gin_trgm_ops` indexes. The per-search fan-out is orchestrated by
  `runSearchReaders` (`queries.ts`): at the default 0.3 the readers run in
  PARALLEL on the pool (each a one-SELECT acquire/release; `%` uses PG's
  session-default 0.3); when the threshold is tuned off 0.3 it opens ONE shared
  transaction, sets `pg_trgm.similarity_threshold` transaction-locally once, and
  runs the readers SEQUENTIALLY on that single pinned connection (each in a
  SAVEPOINT for per-kind graceful degradation). This keeps `%` index-accelerated
  AND caps a tuned search at ONE connection instead of one-per-reader (avoids
  pool exhaustion — the pool is 12/instance). `needsTrigramTx` (pure, tested)
  decides the path.
- **Semantic recall is index-safe by construction** — `searchProducts`
  (`queries.ts`) has two shapes: with semantic OFF / no query vector it emits the
  legacy `WHERE (search_vector @@ q OR name % $q)` query byte-for-byte; with a
  resolved query vector it recalls candidates as a `UNION` of two independently
  indexable branches — the keyword branch (`search_vector @@ q OR name % $q`, which
  still BitmapOrs the FTS-GIN + trigram-GIN) `UNION` the ≤`SEMANTIC_RECALL_LIMIT`
  HNSW neighbours whose `sim >= search.semantic_min_similarity` (the floor sits
  on the UNION branch, not the CTE, so the HNSW scan is unchanged; without it
  every query, even gibberish, returned products and the zero-result → alias
  loop went empty) — then JOINs `products` to that small candidate set and LEFT JOINs
  the KNN CTE only to blend `vec.sim` into the score. When the live embedding
  model is known, the KNN CTE also keeps only vectors fingerprinted under it
  (`embedding_input_hash IS NULL OR starts_with(hash, '<model>|')`): after an
  `ai.embedding_model` switch, off-model vectors drop out until « Vectoriser le
  catalogue », and NULL-hash (text-drifted) rows stay eligible. This deliberately AVOIDS an
  `OR vec.id IS NOT NULL` on the join's nullable side, which would force a full
  `products` scan (a disjunction can only BitmapOr when every branch is an indexable
  predicate on the base table). `toVectorLiteral` (pure, unit-tested in
  `vector.ts`) rejects empty/NaN/Infinity vectors so a malformed embedding falls
  back to the keyword-only query instead of emitting an invalid `::vector` cast.
- **Abuse limits** — queries are trimmed + capped to `MAX_SEARCH_QUERY_LENGTH`
  (150) in `searchService.search` (covers `/recherche` + `/api/store/search`).
  `/recherche` is rate-limited per IP at 60/min on the keyword path
  (`search:page:<ip>`; over the cap it shows a « Trop de recherches » empty state
  and logs nothing) plus 30/min on the paid semantic path (`search:sem:<ip>`;
  over the cap it degrades to keyword-only).
- **Control center** — five tabs (client `FormTabs`, RSC loader feeds them):
  **Statistiques**, **Réglages**, **Alias** (synonym CRUD through
  `workflows/search/aliases.ts`, emitting `search_alias.*`, + zero-result «&nbsp;Créer
  alias&nbsp;» shortcut + default seed), **Sémantique** (the
  `search.semantic_enabled` toggle + weight + «&nbsp;Vectoriser le catalogue&nbsp;»
  backfill), **Purge**. Detail on the first three:
  **Statistiques** (top / zero-result queries + KPIs over `search_log`; the day
  filter offers a 24-month window only when `purge_months` retains that much, so
  the longest-retained rows stay viewable — analytics clamp is 730d),
  **Réglages** (the form → `saveSearchSettingsAction`, which re-clamps via the
  resolver before persisting; disabled for view-only operators), **Purge**
  (configured-window echo + the `retention_purge` kill-switch state/last-run with
  a deep link to Tâches planifiées + a manual purge using the configured window).
- **Results page** — `/recherche` renders product results through the SAME
  `CategoryPageClient` as category pages (grid + price/brand/availability/rating
  + cross-catalog attribute facets via `getProductsAttributeFilters`), score-
  ordered via `listProductsByIds`; non-product kinds follow as a slim card strip.
  `noindex,follow`.
- **Auto-purge** — `runRetentionPurge` (`src/lib/retention/run.ts`) resolves the
  `search_log` window from `search.purge_months × 30` at purge time, so the cron
  (`/api/cron/retention` → `runScheduledJob("retention_purge")`), the jobs
  dashboard "Run now", and the Purge tab all honour the live setting. A
  settings-read failure SKIPS this purge (fail closed, `settings_unavailable`);
  `RETENTION_WINDOWS.search_log` (90d) is only the displayed default.

### 7.7 Infrastructure → Performance & Database (runtime monitoring)

- **Runtime sampler** — `src/lib/telemetry/runtime-metrics.ts` (server-only,
  state on `globalThis`, started from `instrumentation.ts`, stopped on the
  SIGTERM/SIGINT drain). A single self-rescheduling timer (NO external cron) that
  every `perf.sample_interval_sec` reads RAM (`process.memoryUsage` vs the
  cgroup-aware `process.constrainedMemory()` limit), CPU% (`process.cpuUsage`
  delta ÷ cores), event-loop p99 (`perf_hooks.monitorEventLoopDelay`, reset per
  window) and DB latency (timed `SELECT 1`, single-flight). Samples land in an
  in-memory ring (process-local). `getRuntimeSnapshot()` (live, fresh probe) +
  `getRuntimeHistory()` feed the UI; `pingDbSamples(n)` is the shared multi-probe
  used by BOTH tabs (one probe implementation, not two).
- **Config** — pure `src/lib/telemetry/perf-config.ts` (`resolvePerformanceConfig`
  clamps the `perf.*` settings; `evaluateBreaches` + `parseRecipients` are pure +
  tested), cached by `perf-runtime-config.ts` (15s TTL, mirrors
  `audit/runtime-config.ts`). Saved from the Réglages tab via
  `savePerfSettingsAction` (re-clamps through the same resolver). RBAC
  `system_performance` is `view`+`manage`.
- **Alerts** — on a breach sustained for `alert_breaches_required` ticks (and
  outside `alert_cooldown_min`), `perf-alert.ts` emits `perf.alert.raised` (warn;
  the wildcard audit subscriber persists it for free) and — when
  `perf.alert_email_enabled` — emails the configured recipients (or active
  admins) via `dispatchEmail` (account/transactional). A recovery emits
  `perf.alert.recovered` (info). Cooldown/streak state is in-memory (per
  instance).
- **Uptime/downtime** — `module/instance` (`app_instance_heartbeats`, migration
  **0080**): the sampler upserts a heartbeat every `perf.heartbeat_interval_sec`
  and marks the row stopped on a clean drain; the row is trimmed by the retention
  sweep (`RETENTION_WINDOWS.instance_heartbeats`, 90 d). The Aperçu tab renders a
  **Disponibilité (historique)** card: the RSC reads `instanceHeartbeatService
  .recent(30)` (every boot row OVERLAPPING the window, incl. one booted before it)
  and feeds the pure `src/lib/telemetry/uptime.ts` `computeUptimeStats`
  (restarts + availability % + outage windows: downtime is the part of the
  window NOT covered by the UNION of the rows' [started_at, stopped_at /
  last_seen_at] intervals, counting only uncovered spans > ~2× the heartbeat
  interval), distinct from the live process-local
  "Disponibilité (instance)" uptime in the same tab.
- **Performance tab** — tabbed control center (`performance-control-center.tsx`):
  **Aperçu** (live gauges, client poll of `GET /api/admin/metrics`, breach
  colouring via the SAME `evaluateBreaches`), **Historique** (server-rendered
  sparklines from the ring), **Métriques & cache** (event counters + cache tag
  vocabulary + Next.js config), **Réglages**. The Next.js config row is sourced
  from `src/lib/config/next-runtime.ts`, the SINGLE source ALSO imported by
  `next.config.ts` (no drift — same pattern as `security/headers.ts`).
- **Database tab** — read-only diagnostics, every loader try/catch-guarded:
  connectivity + latency (`pingDbSamples` min/median/max + `pg_postmaster_start_time`),
  pool config/gauges (incl. env-tunable idle/connect timeouts + keepAlive),
  **per-migration** applied/pending status (journal ↔ `drizzle.__drizzle_migrations`
  joined by ordinal + applied hash), table sizes, **index health**
  (`pg_stat_user_indexes` never-scanned, constraint indexes flagged "conserver"),
  **maintenance** (`pg_stat_user_tables` dead tuples + last vacuum/analyze),
  **slow queries** (`pg_stat_statements` top-N, guarded by extension presence),
  extensions, a **Stockage** card (see below), and **Rétention** — re-linked to
  the LIVE windows (`resolveSearchConfig × 30`, `resolveAuditConfig × 30`, like
  the purge) with one row per `RETENTION_TARGETS` entry (`src/lib/retention/windows.ts`,
  the purge's own inventory — **15** targets today, incl. outbound webhook
  deliveries, guest carts/wishlists, `ai_call_logs` and expired
  sessions/verifications) with the retention_purge last-run + a deep link to
  Tâches planifiées.
- **Storage breakdown** — pure `src/lib/telemetry/storage.ts` `summarizeStorage`
  (tested): from the per-table heap/index/total sizes the Database tab already
  loads it computes the data/index/TOAST split, the **logs & télémétrie subtotal**
  broken out exactly (`LOG_TABLES` — the AUTO-PURGED telemetry tables, derived
  from the `RETENTION_TARGETS` entries flagged `log` plus `ai_job_logs`; the permanent
  `stock_movements` ledger is deliberately excluded → groups under Catalogue), and
  a coarse per-domain group breakdown (first-match-wins). **Object/media storage
  (S3)** is summed separately as the TRUE bucket footprint (primary `size_bytes` +
  webp/avif/original variant bytes, per-kind so images are itemised) on the
  Stockage card AND, in detail, on the Ressources tab.
- **Ressources tab** — infrastructure & external-services hub, now showing LIVE
  status (not just config presence): PostgreSQL via the shared `pingDbSamples`
  (median latency + en-ligne/injoignable) deep-linking to Base de données; a
  bounded `HeadBucket` object-store reachability probe; a configured-count
  rollup; and a "Diagnostics liés" strip cross-linking Performance / Base de
  données / API & Webhooks. Médiathèque cross-links to the DB Stockage card —
  so the Perf ↔ DB ↔ Ressources overlap is de-duplicated (each owns its detail,
  cross-references the others) rather than repeated. The pg pool env reads
  (`DB_POOL_MAX`/timeouts) are hardened (`posIntEnv`) so a BLANK Coolify env var
  can't silently set max=0 / statement_timeout=0; `process.constrainedMemory()`
  is only trusted as the RAM% denominator when it's a real sub-host limit (its
  no-cgroup ~2^64 sentinel falls back to host total); and `loadTables` qualifies
  its `relname` (the unqualified column was ambiguous post-oid-join → the whole
  Stockage + Tables cards read "indisponible").

### 7.8 Infrastructure → Sécurité (OWASP control center)

`/admin/system/security` (RBAC `system_security`, **view-only, secret-safe** — no
secret value is ever rendered). The server resolver `page.tsx` gathers facts and
hands a fully-serialisable bundle to the client `SecurityCenter` (`security-center.tsx`)
which renders tabs:

- **Posture** — an OWASP-aligned scorecard from the PURE `src/lib/security/posture.ts`
  `computePosture(facts)`: 11 controls (HSTS, CSP-strict, CSP-nonce, auth-secret,
  payment-encryption, DB-TLS, 2FA, brute-force, email-verif, last-admin,
  sec-logging), each tagged with its OWASP 2021 category + a status
  (`pass`/`warn`/`info`) + an overall score (`info` excluded from the denominator).
  The deferred CSP-nonce migration shows as the tracked `warn` item.
- **Signaux en direct** — server-only `src/lib/security/signals.ts` `getSecuritySignals()`:
  the 5 security-FAILURE events (24h/7d, from `audit_log` — `user.sign_in_failed`,
  `user.two_factor_failed`, `auth.rate_limited`, `rbac.permission_denied`,
  `api_key.auth_failed`), **2FA adoption among the EFFECTIVE-admin set** (enum
  `admin` ∪ RBAC `*`, mirroring `countEffectiveWildcardAdmins`; only the enforced
  `users.two_factor_enabled` flag counts, so an abandoned enrolment reads as
  "without 2FA"), active sessions +
  the expired session/verification backlog. Every query try/caught → degrades.
- **En-têtes & CSP / Authentification / Secrets / RGPD & accès** — the served
  headers + resolved CSP, auth/session/cookie policy + rate-limit rules, secret
  presence/validity badges, and consent/social/last-admin.

DB-TLS verdict comes from `resolveDbSslPosture()` (src/lib/db/ssl.ts), mirroring
the driver's CA-readability check so the scorecard can't claim "verified" for an
unreadable CA. Pure tests: `security-posture` + `security-helpers` (maskEmail /
isTwoFactorChallengeCookie / resolveDbSslPosture). See [docs/security.md](security.md)
for the underlying controls.

## 8. Adding a new module — walked example

Let's add a **wishlist** module.

### 1. Schema

```ts
// src/modules/wishlist/schema.ts
import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "@/lib/db/columns";

export const wishlists = pgTable("wishlists", {
  id: id(),
  user_id: text("user_id").notNull(),  // soft link to better-auth users.id (text) — no FK
  ...timestamps(),
}, (table) => ({
  userUnique: uniqueIndex("wishlists_user_unique").on(table.user_id),
}));

export const wishlist_items = pgTable("wishlist_items", {
  id: id(),
  wishlist_id: uuid("wishlist_id").notNull(),  // soft link → wishlists.id (uuid) — no FK
  product_id: uuid("product_id").notNull(),    // soft link → products.id (uuid) — no FK
  ...timestamps(),
}, (table) => ({
  pairUnique: uniqueIndex("wishlist_items_pair_unique").on(table.wishlist_id, table.product_id),
  wishlistIdx: index("wishlist_items_wl_idx").on(table.wishlist_id),
}));

export type WishlistRow = typeof wishlists.$inferSelect;
export type WishlistItemRow = typeof wishlist_items.$inferSelect;
```

### 2. Service

```ts
// src/modules/wishlist/service.ts
import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { wishlists, wishlist_items, type WishlistRow } from "./schema";

class WishlistService {
  async findByUserId(userId: string): Promise<WishlistRow | null> { /* ... */ }
  async create(userId: string): Promise<WishlistRow> { /* ... */ }
  async addItem(wishlistId: string, productId: string) { /* ... */ }
  async removeItem(wishlistId: string, productId: string) { /* ... */ }
}

export const wishlistService = new WishlistService();
```

### 3. Queries

```ts
// src/modules/wishlist/queries.ts
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { wishlist_items } from "./schema";

export async function listProductIdsForWishlist(wishlistId: string): Promise<string[]> {
  const rows = await db.select({ pid: wishlist_items.product_id })
    .from(wishlist_items)
    .where(eq(wishlist_items.wishlist_id, wishlistId));
  return rows.map(r => r.pid);
}
```

### 4. Public surface

```ts
// src/modules/wishlist/index.ts
export * as wishlistQueries from "./queries";
export type { WishlistRow, WishlistItemRow } from "./schema";
// Convention for NEW modules: keep the service off the public barrel — reach
// it via "@/modules/wishlist/service" or a workflow. That discourages
// cross-module service calls. (Some existing modules still re-export their
// service; prefer this leaner shape going forward.)
```

### 5. Wire schema into the global re-exports

```ts
// src/lib/db/schema.ts (add a line)
export * from "@/modules/wishlist/schema";
```

### 6. Workflow

```ts
// src/workflows/wishlist/add-to-wishlist.ts
import "server-only";
import { z } from "zod";
import { wishlistService } from "@/modules/wishlist/service";
import { productService } from "@/modules/catalog/product/service";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

const schema = z.object({ productId: z.string().uuid() });

export const addToWishlistWorkflow = workflow<
  [z.input<typeof schema>, { actorUserId: string }],
  { wishlistId: string }
>("wishlist.add", async (input, { actorUserId }) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const product = await productService.findById(parsed.data.productId);
  if (!product) return fail("not_found", "Produit introuvable.");

  let wishlist = await wishlistService.findByUserId(actorUserId);
  if (!wishlist) wishlist = await wishlistService.create(actorUserId);
  await wishlistService.addItem(wishlist.id, product.id);

  await bus.emit("wishlist.item_added", {
    wishlistId: wishlist.id, productId: product.id,
  }, { actorUserId });
  return ok({ wishlistId: wishlist.id });
});
```

### 7. Event type

```ts
// src/events/types.ts (add to EventMap)
"wishlist.item_added": { wishlistId: string; productId: string };
```

### 8. Workflow registry + migration

```ts
// src/workflows/index.ts — add the new workflow to the registry
import { addToWishlistWorkflow } from "./wishlist/add-to-wishlist";

export const workflows = {
  // ...
  wishlist: { add: addToWishlistWorkflow },
} as const;
```

```bash
# migrations are hand-authored — db:generate is guarded (see docs/database.md §9.1):
# write src/lib/db/migrations/NNNN_name.sql (next: 0140) + a meta/_journal.json
# entry whose `when` is strictly greater than the previous one (Date.now()), then:
pnpm db:migrate
```

A new event also needs `pnpm gen:api-catalog` (regenerates the event catalog and
the internal action catalog; `event-catalog.test.ts` /
`internal-api-catalog.test.ts` fail on drift). A new test file under
`src/lib/db/tests/` must be appended to the LAST `test:pure:N` (no DB) or
`test:db:N` (DB) sub-script in `package.json`: the chains are split because
Windows `cmd.exe` rejects a command line over ~8191 chars, and
`test-chain-integrity.test.ts` fails on an orphaned file, a duplicate, a
sub-script its parent chain doesn't invoke, or a script over 7500 chars (start
a new sub-script once the last one nears ~6000 chars).

### 9. Server Action + UI

```ts
// src/lib/actions/wishlist.ts
"use server";
import { workflows } from "@/workflows";
import { requireSession } from "@/lib/auth/session";

export async function addToWishlistAction(productId: string) {
  const session = await requireSession();
  return workflows.wishlist.add({ productId }, { actorUserId: session.user.id });
}
```

Then `<form action={addToWishlistAction}>` or `useTransition` from a
client component — the workflow rolls back on failure, subscribers fire
audit / email / revalidation, and **you touched one feature in one place**.

## 9. Conformance checklist

A new module is mergeable only if every box ticks.

### Module file layout
- [ ] Folder name is lowercase, kebab-case or snake_case like its neighbours
      (both exist: `stock-location`, `aid_center`), never camelCase.
- [ ] `schema.ts` declares Drizzle tables only — no business logic.
- [ ] `service.ts` exposes CRUD on tables this module owns. No cross-module imports.
- [ ] `queries.ts` exposes read helpers. May join only this module's tables.
- [ ] `index.ts` re-exports `queries`, `types` — **not** `service`.
- [ ] `schema.ts` is re-exported from `src/lib/db/schema.ts`.

### Database
- [ ] `schema.ts` declares **no `.references()`** (FKs go in the migration
      SQL); the lone exception is the better-auth tables in `auth/schema.ts`.
      A new cross-module FK is added to the sanctioned list (§2 invariant 2).
- [ ] The migration is the next free number with a strictly increasing
      journal `when` (`migration-journal.test.ts`).
- [ ] All ID columns use `id()` from `src/lib/db/columns.ts` (UUID **v7**).
- [ ] Content tables include `...timestamps()` and `...softDelete()`; reads
      filter `deleted_at IS NULL`.
- [ ] Money columns are integer **millimes** (never ×100); rates are **bps**.
- [ ] Hot read paths have partial indexes matching their `WHERE`.
- [ ] If the table will hold > 100k rows, add it to the bench script.

### Cross-module work
- [ ] Cross-module relationships are in `src/associations/`, not as FKs.
- [ ] Cross-module *reads* use either the module's `queries.ts` (for one
      module) or the assoc service (for joining two modules).
- [ ] Cross-module *writes* live in a workflow, not a service.

### Workflow
- [ ] Workflow file is in `src/workflows/<domain>/<action>.ts`.
- [ ] Input validated via Zod at the top.
- [ ] All DB writes inside `db.transaction(async () => ...)`.
- [ ] Returns `ok({...})` or `fail(error, message)` — no thrown errors.
- [ ] Emits a typed event after the transaction commits, with the actor in the
      emit meta (`{ actorUserId }`); a no-op save emits nothing.
- [ ] Registered in `src/workflows/index.ts`.

### Events
- [ ] Every new event has a typed entry in `EventMap` (`src/events/types.ts`),
      and `pnpm gen:api-catalog` has refreshed the event catalog.
- [ ] Payload contains IDs only — never secrets, never raw HTML.

### Routes / actions / pages
- [ ] Admin pages/routes/actions call `await requirePermission(module, action)`
      (or `requirePermissionAny`) as the first line, or `requireAdminArea()`
      for shell/index pages. An index page behind `requireAdminArea()` that
      renders module data gates each block with
      `permissionSetAllows(perms, <module>, 'view')`. Store-wide destructive
      operations add `requireSuperAdmin(module, action)` / `checkSuperAdmin`
      for the `'*'` step-up. A nav item whose page guard isn't `<id>:view`
      carries `visibleWhen` from `src/lib/rbac/nav-access.ts`.
- [ ] Admin API routes return 404 (not 403) on unauthorised — don't leak.
- [ ] Server Actions wrap the workflow result into a serialisable
      `ActionState` and call `revalidatePath()` on success; settings writes go
      through `workflows.cms.upsertSetting(input, { actorUserId })`.
- [ ] Admin `useActionState` forms use `useNoResetSubmit`; settings pages read
      settings strictly and pass panels only `pickSettings(...)` output.
- [ ] A new first-level route directory is listed in
      `src/lib/pages/reserved-routes.ts` (`reserved-routes.test.ts`).
- [ ] Storefront pages read via `mod.queries.*`, not via `mod.service.*`.
- [ ] New test files are wired into a `test:pure:N` / `test:db:N` sub-script.

### Docs
- [ ] If the module exposes new editable surfaces, the corresponding
      panel in `/admin` has an edit page wired with the new
      `update<Entity>Action`.
- [ ] If the module owns media, edits use the central `<MediaPicker>`.
- [ ] If a workflow has interesting business rules, jot them in a
      header comment so future readers don't have to grep events.

## 10. Common pitfalls

- **Importing a service from another module.** Don't. Use a workflow that
  orchestrates both modules' services through `db.transaction()`.
- **Forgetting to re-export the schema.** Drizzle migrations won't
  include your new tables. Add the line to `src/lib/db/schema.ts`.
- **Adding cross-module FKs to "save a join table".** Each FK saved is a
  module coupling you'll regret in 6 months when extracting the module
  to its own service.
- **Mutating from a Server Component / page.** Always go through a
  workflow via a Server Action. Pages don't write.
- **Catching `redirect()` inside a try/catch in a Server Action.**
  `redirect()` throws — let it propagate. Wrap *business* errors in
  `fail()`, not framework signals.
- **Emitting events from inside `db.transaction()`.** Emit AFTER the
  commit — otherwise a subscriber failure could trick a caller into
  thinking the transaction was rolled back when it wasn't.
- **Putting business logic in route handlers.** Routes are 20-line
  glue. Anything longer belongs in a workflow.
- **Swallowing a settings read into defaults on an admin form page.**
  `getSettingsMap().catch(() => ({}))` renders defaults that the next save
  writes over live config. Read strictly (see §7 « Admin page conventions »).
- **Formatting a server-rendered date with a bare `toLocaleDateString`.** The
  server's zone is not the store's. Use `formatStoreDate` / `formatStoreDateTime`
  (`src/lib/time/store-tz.ts`, Africa/Tunis) for printed documents (facture,
  avoir, BL, reçu) and SAV dates.

## 11. Cheat sheet

| I want to…                                  | I edit…                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| Add a new database table                    | `src/modules/<x>/schema.ts` → re-export in `src/lib/db/schema.ts`      |
| Read data                                   | `src/modules/<x>/queries.ts`                                           |
| CRUD operation                              | `src/modules/<x>/service.ts`                                           |
| Multi-step mutation with rollback           | `src/workflows/<x>/<action>.ts`                                        |
| React to an event without coupling          | `src/events/subscribers/<name>.ts`                                     |
| Expose a Server Action to a form            | `src/lib/actions/<domain>.ts`                                          |
| Cross-module relationship (data)            | `src/associations/<a>-<b>.ts`                                          |
| Cross-module relationship (helpers)         | `src/associations/<group>.service.ts`                                  |
| New HTTP API endpoint                       | `src/app/api/<path>/route.ts`                                          |
| New admin page                              | `src/app/admin/<feature>/page.tsx` + `*-panel.tsx`                     |
| Validate user input                         | Zod schema co-located with the action / route                          |
| Gate a store-wide destructive op            | `requireSuperAdmin(module, action)` from `@/lib/auth/super-admin`      |
| Keep an admin form's input on a failed save | `onSubmit={useNoResetSubmit(formAction, state)}` from `@/components/admin/_components/form-tabs` |
| Invalidate cache after a write              | Add/extend an `invalidate-*` subscriber that calls `bustCacheTag(tag)` from `@/lib/cache/revalidate` |
| Add an image picker to a form               | `<MediaPicker name="…" value={…} scope="…" />` from `@/components/admin/media-picker` |

---

_Last reviewed 2026-10-09: migrations `0204`–`0207` removed six subsystems entirely
(merchandising Collections, Drip & Exclusivité / early-access, stored-value gift
cards, Fidélité/loyalty, Entreprises/B2B, Store credit) — their module entries,
dangling file pointers and cross-module FKs are struck from this spec; the shop's
own fiscal identity (`business.legal_name` / `business.tax_id`), the credit-note /
avoir document, the showcase collection PAGES and the retail third-party gift-card
PRODUCTS are unaffected. Prior 2026-09-23 (after the A–Z audit fix program, commits
`77b7163`…`866522c`): module inventory re-checked against `src/modules/*` (39
modules — `webhook-endpoints` added; catalog sub-modules incl. `collection`,
`product-gen`, `content-gen`; order/delivery/showcase tables filled in); FK rule
now lists the sanctioned DB-level cross-module FKs; migrations `0000`–`0139`
(next `0140`) + the journal `when` guard; §5 actor ctx / no-op settings saves /
direct-import workflows / super-admin step-up / data-job single-flight; §6 212
events, `product.updated` subscribers, audit fail-closed retention; §6.1 mailing
rewritten (send paths, drain lock, critical templates, RBAC, newsletter ⇄
profile consent, List-Unsubscribe); §7 admin page conventions, ERP orders API,
RBAC gates (`requireSuperAdmin`, `resolveAdminShellAccess`, `visibleWhen`,
`resolveDashboardAccess`), SEO/redirects/maintenance/tracking/search updates;
§7.8 moved out of §8; test chains split into `test:pure:N` / `test:db:N`.
Prior 2026-06-22: §6 rewritten for the Journal d'audit upgrade
(per-event severity + `audit.*`/`debug.*` capture settings, full-coverage
emits, configurable retention, the tabbed control center, migration 0079).
Prior 2026-06-15: re-audited against `src/modules/*` (now 35
modules — `cart-event` + `document` join the prior set, which already added `rbac` + `business`) + `src/associations/*` (now 5 join tables —
added `product-related`). Added the AI/automation, data-job, stock-ledger, and
external-API modules (`ai`, `ai-assign`, `import`, `jobs`, `stock-movement`,
`api-key`, `api-settings`); documented the catalog `review` AI-generation
+ scheduling subsystem (`product_reviews.source`, generation jobs/drafts,
internal `review_schedule`) and the attribute-`kind` value-list/scalar split;
softened the canonical-shape claim (table-less service-only modules; reads
folded into `service.ts`); added `_shared/types.ts` to the catalog tree and
dropped the stale product `search.ts` entry. Prior (2026-06-10): module
inventory + cross-cutting invariants (barrel registration, FK-in-migration,
UUID v7, soft deletes, millimes, single squashed baseline) + server/client
boundary rule; association soft-link columns corrected text→uuid. The Medusa
framing (modular monolith; services / workflows / associations / events) still
matches the code. When the structure or the Medusa Agent Skills corpus shifts
meaningfully, re-audit here and bump this footer._

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](CREDITS.md).
