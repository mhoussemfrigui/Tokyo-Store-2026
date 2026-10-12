# Database Architecture & Scaling Guide

> **Target scale:** 1M products · 100k orders/month · 10k registered users ·
> 50 RPS sustained · sub-100 ms p95 storefront response time.
>
> **Stack:** PostgreSQL 16 · Drizzle ORM 0.45 · `pg` 8 · PgBouncer (prod) ·
> Coolify-managed deployment.

This document is the single source of truth for everything Postgres-related in
Tokyo Store. It covers the current architecture, every index decision, the
operational playbook, and the scaling roadmap that takes us from MVP to 1M
products without rewriting the foundation.

---

## Table of contents

1. [Design principles](#1-design-principles)
2. [Topology](#2-topology)
3. [Schema overview](#3-schema-overview)
4. [Index strategy](#4-index-strategy)
5. [Connection management](#5-connection-management)
6. [Query patterns](#6-query-patterns)
7. [Observability](#7-observability)
8. [Maintenance](#8-maintenance)
9. [Migration workflow](#9-migration-workflow)
10. [Backup & restore](#10-backup--restore)
11. [Scaling roadmap](#11-scaling-roadmap)
12. [Benchmark results](#12-benchmark-results)
13. [Anti-patterns](#13-anti-patterns)
14. [Appendix A — Hot query catalogue](#appendix-a--hot-query-catalogue)
15. [Appendix B — Environment variables](#appendix-b--environment-variables)

---

## 1. Design principles

These are the rules every schema change is checked against. They are
non-negotiable; they exist because each one has been broken before and the cost
of unwinding it later is brutal.

### 1.1 No JSON for content
Everything the CMS edits — pages, sections, products, blog posts —
lives in proper relational columns. JSON (`jsonb`) is used **only** for opaque
event payloads and machine job config/scope — never for editable content:

- `audit_log.metadata` — opaque event payload (not indexed; the `jsonb_path_ops` GIN was dropped in `0079` — see §4.5)
- `webhook_deliveries.payload` — the outbound event body, replayed as-is
- `email_logs.variables` / `.metadata` — template variables + send metadata of a queued mail
- `ai_assign_jobs.summary` — rolled-up per-run counters report
- `ai_assign_proposals.proposed` — the AI's proposed category/brand/attribute payload
- `review_generation_jobs` / `product_generation_jobs` / `catalog_content_gen_jobs` `.scope` / `.settings` — generation run target + tuning
- `product_generation_drafts.generated` / `catalog_content_gen_drafts.generated` — AI draft awaiting review (copied into real columns on apply)
- `review_schedule.scope` / `.settings` — scheduler config snapshot
- `import_jobs.result` — data-job outcome report

These are job/audit bookkeeping, not editable content. The one deliberate
exception is `value_props` on `categories` / `brands`: a short
ordered list of `{ icon, title, body }` cards edited as a unit and never
searched or joined. Other editorial content is _never_ JSON. We tried that with Lovable and it broke
content-control, full-text search, and referential integrity in one stroke.
Even the page builder is fully relational: `page_sections` plus one subtype
table per section kind (hero / text / cta / stats / timeline), all chained
with `ON DELETE CASCADE` foreign keys.

### 1.2 Modular monolith (Medusa-inspired)
Each domain lives under `src/modules/<domain>/`:

```
src/modules/catalog/product/
├── schema.ts          # Drizzle table + types
├── service.ts         # Pure business logic
├── queries.ts         # Read-side queries (cacheable)
├── types.ts           # Public DTOs
└── index.ts           # Barrel export
```

Modules **never** declare a foreign key in `schema.ts` — not even inside their
own module. Every `FOREIGN KEY` (and `CHECK`) lives in migration SQL, never in
`.references()` calls, so the Drizzle schema graph stays decoupled from the
physical constraint layout. **One exception:** the Better Auth tables in
[`src/modules/auth/schema.ts`](../src/modules/auth/schema.ts) (`sessions`,
`accounts`, `two_factors`) keep `.references(() => users.id, { onDelete:
"cascade" })`, mirroring Better Auth's generated schema — don't "fix" them.
Cross-module relationships live in `src/associations/<a>-<b>.ts` as plain
`uuid` columns; the real FK constraints (with their `CASCADE` / `SET NULL`
actions) are declared in migration SQL — the squashed baseline plus later
migrations (see §9).

The code rule is "no FK in `schema.ts`", **not** "no cross-module FK in the
database". The live schema carries a small, deliberate set of cross-module
constraints (all in migration SQL) where an orphan would be a correctness bug:

| Child column(s)                                                    | → Parent                                  | ON DELETE |
| ------------------------------------------------------------------ | ----------------------------------------- | --------- |
| `promotion_redemptions.order_id`                                   | `orders`                                  | CASCADE   |
| `promotion_redemptions.user_id`                                    | `users`                                   | SET NULL  |
| `orders.delivery_agent_id` / `.pickup_location_id`                 | `delivery_agents` / `pickup_locations`    | SET NULL  |
| `product_reviews` / `wishlist_items` / `showcase_pins` `.product_id` | `products`                              | CASCADE   |
| `stock_levels.product_id` / `.variant_id`                          | `products` / `product_variants`           | CASCADE   |
| `tax_rules.attribute_value_id`, `product_variant_values.attribute_value_id` | `product_attribute_values`       | CASCADE   |
| `product_attribute_assignments` / `product_attribute_scalars` `.product_id`, `category_attribute_filters.category_id` | `products` / `categories` | CASCADE |
| the product association tables (§3.2)                              | `products` / `categories` / `brands` / `media` | CASCADE |

They only fire on a **hard** delete. Content tables soft-delete (§1.4), so a
delete workflow must release dependants itself (e.g. `deleteProductWorkflow`
retires the variants — §3.14). Adding a new cross-module FK needs the same
justification.

This is the same architectural rule Medusa Commerce enforces, and it pays for
itself the first time you need to swap an implementation.

### 1.3 UUIDv7 over UUIDv4
Every table's primary key defaults to `uuid_generate_v7()` (a plpgsql function
defined in the baseline migration's preamble) via the shared `id()` column
builder in [`src/lib/db/columns.ts`](../src/lib/db/columns.ts). UUIDv7 is
time-ordered, which means:

- **Inserts** land at the end of the B-tree → no random-write penalty.
- **Indexes** stay ~25% smaller because consecutive keys compress better.
- **Range scans by creation time** become _free_ (the PK already orders by time).

Before the migration squash, older tables still defaulted to
`gen_random_uuid()` (re-defaulting populated tables mid-flight wasn't worth
it). The squashed clean baseline removed that concern — **all** tables now use
v7. Never bypass the `id()` helper when adding a table.

### 1.4 Soft delete, never hard delete
Every content table has a `deleted_at TIMESTAMPTZ NULL` column. All indexes
that touch user-visible reads have `WHERE deleted_at IS NULL` as a partial
predicate. Hard deletes only happen in GDPR erasure flows and in the
super-admin destructive tools (data-job « clean » segments, the demo
`?op=clear`, the all-orders purge), which rely on the `ON DELETE CASCADE` FKs
(§1.2) and clean the soft-linked rows themselves.

### 1.5 Audit everything that mutates money or auth
`audit_log` captures: auth events, role changes, order state transitions,
admin CMS writes, payment webhooks. It is append-only and indexed for time-
range scans via BRIN (see §4.4).

---

## 2. Topology

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              Coolify VPS                                 │
│                                                                          │
│   ┌──────────────┐    ┌────────────┐    ┌─────────────────────────┐      │
│   │  Next.js 16  │    │ PgBouncer  │    │  Postgres 16            │      │
│   │  (4 vCPU)    │──▶ │ tx-mode    │──▶ │  shared_buffers=1GB     │      │
│   │  pool=12×N   │    │ pool=25    │    │  max_connections=100    │      │
│   └──────────────┘    └────────────┘    └─────────────────────────┘      │
│         │                                          ▲                     │
│         │                                          │                     │
│         ▼                                          │                     │
│   ┌──────────────┐                          ┌──────────────┐             │
│   │  SeaweedFS   │                          │   pg_dump    │             │
│   │  (media)     │                          │   (backup)   │             │
│   └──────────────┘                          └──────────────┘             │
└──────────────────────────────────────────────────────────────────────────┘
```

- **One pool per app instance.** Each Next.js process opens up to
  `DB_POOL_MAX` (default 12 in prod) physical connections.
- **PgBouncer in front.** Transaction-mode pooling means we can horizontally
  scale Next.js to ~4 instances on the same Postgres without exhausting
  `max_connections`. Math: 4 instances × 12 client conns = 48 PgBouncer
  client conns → multiplexed onto 25 server conns = headroom for migrations,
  psql, pgwatch.
- **One DB. No read replicas yet.** We have measured headroom for the first
  ~100k products without splitting reads. The roadmap (§11) covers what to
  do when that changes.
- **Caches are process-local.** The `'use cache'` store (Next's default
  in-memory handler, no custom `cacheHandlers`), the `ttlCached` maps
  (`src/lib/cache/ttl.ts`) and the event bus that busts their tags are all
  per-Node-process. A write handled by one instance only busts that instance's
  cache; the others serve their copy until its `cacheLife` lapses (hours for the
  PDP). Going past one app instance needs a shared cache handler + cross-instance
  invalidation first, or the storefront shows stale catalog data.

### 2.1 Why PgBouncer?

Without a pooler, every cold Next.js function (and there are many in App
Router) would open a TCP+TLS+auth handshake against Postgres — ~30ms of
overhead per request. PgBouncer caps the server-side conn count and
multiplexes thousands of client conns over them.

- **Mode:** `transaction` (releases the server conn between transactions).
- **Implication:** no `LISTEN/NOTIFY`, no session-level `SET`, no client-side
  prepared statements. We confirmed our app code uses none of these; the boot
  migrator, which does, connects directly (`MIGRATION_DATABASE_URL`, §5.4). The
  in-process event bus (`src/events/bus.ts`) is the LISTEN/NOTIFY replacement.

### 2.2 Why not Postgres native pooling (PG 16's `pgbouncer-like` feature)?
PG 16 added internal connection pooling experimental in some builds, but it
is not yet feature-complete with PgBouncer (no admin console, no separate
`auth_query`, weaker stats). When PgBouncer-equivalent functionality ships
natively in PG 18 we revisit.

---

## 3. Schema overview

### 3.1 Modules and their tables

| Module           | Tables                                              | Notes                                        |
| ---------------- | --------------------------------------------------- | -------------------------------------------- |
| `auth`           | `users`, `sessions`, `accounts`, `verifications`, `two_factors` | Better Auth schema (camelCase JS fields); the one module with `.references()` FKs (§1.2); `two_factors` = TOTP enrolment, secrets encrypted by the plugin (`0070`) |
| `customer`       | `customer_profiles`, `addresses`, `customer_segments`, `customer_segment_members` | Linked to `users` via `customer_user_links` (§3.2); segments (manual + dynamic-rule) are reusable promo-targeting audiences; `promo_opt_out` excludes a customer from public promos (`0042`); optional `birthday` date (`0044`) drives the `birthday_month` segment rule |
| `catalog/product`| `products`, `product_variants`, `product_variant_values` | `search_vector` generated tsvector (§4.2); extra columns (§3.4); variants (§3.14) |
| `catalog/attribute`| `product_attributes`, `product_attribute_values`, `product_attribute_assignments`, `product_attribute_scalars`, `category_attribute_filters` | `attribute_kind` enum; filter dimensions + per-product scalars (§3.6) |
| `catalog/review` | `product_reviews`, `review_generation_jobs`, `review_generation_drafts`, `review_schedule` | `source` = customer/manual/ai; AI generation + scheduler (§3.7) |
| `catalog/product-gen` | `product_generation_jobs`, `product_generation_drafts` | Bulk product CONTENT generation (AI): scoped dry-run → review → apply; one-active gate (`0064`, §3.2) |
| `catalog/content-gen` | `catalog_content_gen_jobs`, `catalog_content_gen_drafts` | Bulk CATEGORY/BRAND content generation (AI), generalized via an `entity_type` discriminator: same dry-run → review → apply; PER-entity-type one-active gate (`0106`) |
| `catalog/category`| `categories`                                        | Self-referencing parent/child; `icon` + `icon_media_id` = listing chip icon (curated key OR médiathèque image, `0105`) |
| `catalog/brand`  | `brands`                                            | Brand metadata (logo); `icon` + `icon_media_id` = listing chip icon (`0105`) |
| `cart`           | `carts`, `cart_items`                               | Anonymous + user-linked. `carts.updated_at` = last activity: bumped after every line write and on a guest-cart merge (readers take `GREATEST(carts.updated_at, MAX(cart_items.updated_at))`). Guest carts are purged after 60 d without activity, quick-buy `qb-` carts after 2 d (§3.12) |
| `wishlist`       | `wishlists`, `wishlist_items`                       | Favorites; dual identity (user_id XOR guest token); opt-in PUBLIC sharing (`is_public` + case-insensitive `public_slug` + `public_display_name`) at `/u/<slug>`, gated by `social.favorites_public_enabled` (off by default) (`0057`) |
| `order`          | `orders`, `order_items`, `order_status_history`, `order_refunds` | Status history append-only (BRIN-indexed); `order_refunds` = the refund ledger (positive-only amounts, validated by `refundOrderWorkflow`; its sum ≥ `total_cents` means "fully refunded"); `order_items.variant_image_url` freezes the per-variant photo (`0031`); `order_items.picked_at` = operator pick/pack stamp (`0051`); `orders.invoice_number / credit_note_number / delivery_note_number` (+ `*_at`) = issued fiscal/logistics doc numbers, each partial-unique (`0052`) — `delivery_note_number` is the WHOLE-order BL, issued (automatically on ship, or by hand from the Documents panel) only when the order has no parcels (a parcel carries its own `shipments.delivery_note_number` from the same counter); `orders.external_ref` = ERP link, partial-unique (`0055`) |
| `order` (returns)| `order_returns`, `order_return_items`               | Customer RMA / restock ledger (§3.10); `reason_code` taxonomy + operator `comment` + per-line `condition_note` back the Retours hub stats (`0050`) |
| `order` (shipments)| `shipments`, `shipment_items`                     | Partial-shipment bons de livraison: one order → many BLs (gapless `delivery_note` number), each a per-line subset qty; shipped-qty per line = `SUM(shipment_items.quantity)` (derived); FKs CASCADE; bounds over-ship + edit-removal + blocks cancel (`0056`) |
| `document`       | `document_sequences`                                | Gapless per-(kind, period) counter for factures / avoirs / bons de livraison; bumped via `INSERT … ON CONFLICT … RETURNING` (`0052`) |
| `delivery`       | `delivery_agents`, `pickup_locations`, `delivery_zones`, `delivery_agent_zone_rates` | Home-delivery couriers + drive/in-store pickup points; optional region pricing (`delivery_zones` named gouvernorat groups × per-courier `delivery_agent_zone_rates`) behind `delivery.zone_pricing_enabled` (`0048`) |
| `tax`            | `tax_rules`                                         | Per-attribute-value TVA tier of the cascade (product → filter → brand → category → global) |
| `cart-event`     | `cart_events`                                       | Add-to-cart analytics log (product, qty, `actor_kind` client\|visitor, `source`); most-added-to-cart stats; retention-purged 180 d (`0054`) |
| `ai-assign`      | `ai_assign_jobs`, `ai_assign_proposals`             | Bulk AI category/brand/attribute assignment (§3.8) |
| `ai-jobs`        | `ai_job_logs`                                        | Shared per-item AI job log feed across product-gen / content-gen / review-gen / auto-assign (§3.8) |
| `jobs`           | `job_run_log`                                       | Scheduled/cron run history (§3.11)           |
| `redirects`      | `redirects`                                          | Admin-managed URL redirects (301/302), unique `source_path` (migration 0076) |
| `instance`       | `app_instance_heartbeats`                            | One row per Node process boot, refreshed by the runtime sampler; drives the Infrastructure → Performance uptime/downtime view (migration 0080) |
| `stock-movement` | `stock_movements`                                   | Append-only on-hand ledger (§3.9)            |
| `stock-location` | `stock_locations`, `stock_levels`                   | Opt-in multi-location inventory (§3.9b, `0103`) |
| `stock-transfer` | `stock_transfers`, `stock_transfer_items`           | Inter-location stock moves (store↔depot); stock moves only on completion, TOTAL invariant (`0127`) |
| `api-key`        | `api_keys`                                          | External HTTP API keys (SHA-256 hashes) (§3.13) |
| `associations`   | `product_categories`, `product_brands`, `product_complementary`, `product_media`, `product_related`, `customer_user_links` | Cross-module join tables (§3.2); `product_related` = curated cross-sell list (§3.5) |
| `cms/page`       | `pages`, `page_sections` + `hero_sections` / `text_sections` / `cta_sections` / `stats_sections` (+ `stats_section_items`) / `timeline_sections` (+ `timeline_section_items`) | Relational page builder (§1.1). Legal + help pages are seeded `is_system` rows (`0060`/`0061`), not a separate table |
| `cms/banner`     | `banners`                                           | Slot + display window; in-grid targeting (`0062`) |
| `cms/navigation` | `nav_menus`, `nav_items`                            | Tree, soft-delete                            |
| `cms/faq`        | `faq_categories`, `faqs`                            | Help-center FAQs, or FAQs scoped to ONE product / category / brand (CHECK `faqs_scope_target_chk`) |
| `cms/setting`    | `site_settings`                                     | Typed key/value runtime settings (`group_key`), incl. the `theme.*` tokens |
| `cms/trust_badge`| `trust_badges`                                      | Buy-box notice strip (`0060`)                |
| `blog`           | `blog_posts`, `blog_categories`, `blog_tags`, `blog_post_tags`, `authors`, `blog_comments` | Rich-text body in DB (HTML, sanitized); authors (`0184`) + threaded account-only comments (`0185`/`0187`) |
| `ai`             | `ai_provider_settings`, `ai_feature_prompts`, `ai_call_logs` | Provider credentials (AES-256-GCM, env wins) (`0005`); per-feature prompt overrides (`0006`); provider transport log, 14-day retention (`0111`) |
| `oauth` / `payment` | `oauth_provider_settings`, `payment_provider_settings` | Encrypted social-login (`0003`) and gateway credentials; the on/off flags live in `site_settings` |
| `currency`       | `currencies`                                        | One active display currency (partial unique, `0078`); relabels prices, never converts stored amounts |
| `import`         | `import_jobs`                                       | Data jobs with live progress: upload import, demo seed, segment clean, white-bg reprocess (`0001`/`0002`/`0100`) |
| `search`         | `search_log`, `search_aliases`                      | Append-only query log (purged after `search.purge_months`) + synonym/alias rules (`0114`); the tsvector / embedding columns live on the indexed tables (§4.2, `0112`) |
| `showcase`       | `showcase_pins`                                     | Manual pins for the Nouveautés / Top ventes / Promotions pages |
| `webhook`        | `webhook_events`                                    | INBOUND payment-gateway idempotency ledger (unique `(provider, event_ref, target_status)`) |
| `webhook-endpoints` | `webhook_endpoints`, `webhook_deliveries`        | OUTBOUND ERP webhooks: encrypted HMAC signing secret + durable retrying delivery queue (`0118`; retention BRIN `0119`) |
| `media`          | `media`, `media_settings`                           | S3 indirection layer (SeaweedFS) + runtime image pipeline config |
| `audit`          | `audit_log`                                         | Append-only, BRIN time index                 |
| `promotion`      | `promotions`, `promotion_redemptions`, `promotion_targets` | product/category/brand/coupon/URL triggers (a code/URL coupon may also carry a product/category/brand scope → discounts only matching lines); `promotion_targets` = admin-set multi customer/segment targeting; `max_discount_cents` cap, `grants_free_shipping`; `exclude_discounted_items` + `max_cart_cents` (`0081`, CHECK `max_cart_cents > 0` + `>= min_cart_cents` via `0083`); append-only redemptions + balancing reversals (`0042`); a free-shipping-only redemption is a `discount_cents = 0` row with `free_shipping = true` that still counts against the caps (`0116`) |
| `rbac`           | `roles`, `role_permissions`, `user_roles`           | DB roles + permission grants + user↔role links; permission KEYS live in code (`src/lib/rbac/registry.ts`) (`0033`/`0034`). Removing a key or module from the registry needs a `role_permissions` DELETE migration (`0092`, `0097`, `0123`, `0206`) |
| `mailing`        | `email_template_overrides`, `email_logs`, `email_flows`, `email_campaigns`, `mailing_sends`, `email_suppressions` | Source of truth for ALL email (`dispatchEmail` chokepoint). `email_logs` = send audit log **and** durable queue (pending/queued/sent/failed + backoff); `email_flows` per-automation toggle; `email_campaigns` admin blasts; `mailing_sends` per-(flow,dedup_key) idempotency ledger; `email_suppressions` hard-bounce/opt-out backstop. Consent + queue model in modules.md §6.1 (`0045`/`0046`) |
| `newsletter`     | `newsletter_subscriptions`                          | Email-only marketing list (consent basis distinct from profile opt-in); a campaign audience; unsubscribe writes via `unsubscribeEmailFromMarketing` |
| `appointments`   | `appointment_locations`, `appointment_reasons`, `appointments` | Rendez-vous booking (`0189`): boutiques (`opening_hours` jsonb Monday-first ×7 weekday windows + `slot_length_minutes` [CHECK 5–480] + `operators` [CHECK 0–100] = concurrent capacity/slot) + admin-editable reasons (`requires_product` flags the « essayage » motif; `max_products` [CHECK 1–20, `0190`] = how many montres that motif lets the customer pick) + bookings (account `user_id` OR guest contact cols; reason label / location name / product title SNAPSHOT so history survives config edits; `products` jsonb array [`0190`] holds the full chosen montre set while `product_id`/`product_title` keep the primary; `reason_id` / `location_id` FK ON DELETE SET NULL; status CHECK pending/confirmed/declined/cancelled/completed; soft-deleted; overbooking prevented by a `pg_advisory_xact_lock` on `location|date|slot`) |

> Product **attributes** are their own module (`catalog/attribute`), not columns
> on the `products` row. See §3.6.

Two raw-SQL tables have no Drizzle schema (baseline): `app_secrets` (key/value:
boot secrets generated by `init-secrets`, bootstrap markers, and service-only
settings such as the API/webhook kill-switches and the shared-variant-stock
default) and `rate_limit_buckets` (the Postgres fixed-window limiter behind
`src/lib/rate-limit.ts`).

### 3.2 Cross-module associations

Located in `src/associations/`:

- `product-category.ts` — `product_categories`, many-to-many `products ↔ categories`
- `product-brand.ts` — `product_brands`
- `product-media.ts` — `product_media`, a product's gallery (`products ↔ media`)
- `product-complementary.ts` — `product_complementary`, the curated « Accessoires supplémentaires » list (0089)
- `product-related.ts` — `product_related`, curated cross-sell (0020, §3.5)
- `customer-user.ts` — `customer_user_links`, one-to-one bridge between Better
  Auth `users` and our richer `customer_profiles`

Every **product** association table uses real `uuid` columns backed by Postgres
FKs **ON DELETE CASCADE** to both sides (declared in migration SQL, per §1.2).
`customer_user_links` is the exception: `user_id` is a `text` soft-link (Better
Auth ids are text) and neither side has a FK — its integrity is enforced in
`customer-user.service.ts` (plus a UNIQUE index on each side).

**Other intra-catalog / job links with real `ON DELETE CASCADE` FKs** (declared
in migration SQL, per §1.2):

- `product_related.product_id` / `.related_product_id` → `products(id)` (0020)
- `product_variant_values.variant_id` → `product_variants(id)` and
  `.attribute_value_id` → `product_attribute_values(id)` (baseline)
- `product_attribute_scalars.product_id` → `products(id)` and
  `.attribute_id` → `product_attributes(id)` (0021)
- `ai_assign_proposals.job_id` → `ai_assign_jobs(id)` (0027)
- `review_generation_drafts.job_id` → `review_generation_jobs(id)` (0023)
- `blog_comments.post_id` → `blog_posts(id)` and `.parent_id` →
  `blog_comments(id)` (threaded replies) (`0185`/`0187`)

And links that should NULL (not cascade) on parent delete — deleting a
category just detaches its content, never deletes it:

- `blog_posts.category_id` → `blog_categories(id)` **ON DELETE SET NULL** (0059)
- `blog_posts.author_id` → `authors(id)` **ON DELETE SET NULL** (0184)
- All order / order_item children are **ON DELETE CASCADE** (order_items, refunds,
  status_history, returns + return_items, shipments + shipment_items,
  promotion_redemptions), so deleting an order cleans them up automatically.

`blog_posts` also carries a `published ⇒ published_at IS NOT NULL`
CHECK (0059). The blog FKs stay within a single bounded context.

**Contenu & Design (0060).** Additive, no FKs: `pages.is_system` (protect seeded
help/legal pages from deletion); a new `trust_badges`
table (admin-managed buy-box notice strip; CHECK on `visibility`
`always|in_stock|preorder`; seeded with the 4 current badges) and a new
`announcements` table (site-wide schedulable notification bar — later **dropped
in 0097**, redundant with the `header_strip` banner placement). The DB-driven
theme tokens are plain `theme.*` rows in `site_settings` (no new table).

**In-grid banner targeting (0062).** Additive on `banners` (in-grid
`category_grid` placement only): `target_kind` (CHECK `none|category|brand|
filter`) + `target_ref` (target slug or filter attribute-value id) +
`after_load_more_count` (cadence — appear every N "Charger plus" blocks); index
`banners_target_idx (target_kind, target_ref)`. The storefront listing passes
its context (category slugs / brand slug / available filter value-ids) and the
service ORs global + matching-scope banners; cadence is applied at render.

**Reviews ordering index (0063).** `product_reviews_created_idx` on
`created_at DESC` — the admin moderation list + per-user list order by it (with
an optional status/source filter), so the sort is now indexed.

**Bulk product content generation (0064).** `product_generation_jobs` +
`product_generation_drafts` mirror the review-generation tables (§3.7) for
PRODUCT content: a scoped run (catalogue / category subtree / brand) generates
the selected fields (`description courte/complète`, `FAQ`, `SEO`) into draft
rows; the admin reviews + applies (drafts written back onto
products, per-field overwrite-or-keep). `…_status_idx`, `…_created_idx`, a
`product_generation_jobs_one_active` partial UNIQUE (≤1 active job globally =
single-flight gate), and `product_generation_drafts_job_idx`. Status CHECK
`queued|running|completed|failed`. Runner: `src/workflows/catalog/product-gen/`.

**Product-gen drafts FK (0065).** `product_generation_drafts.job_id` gets a real
FK → `product_generation_jobs(id) ON DELETE CASCADE` (0064 created the table
without one), so `pruneOld` / a manual job delete can't leave orphan drafts.

**Editable chip icons (0105).** `categories` / `brands` each gain
`icon` (a curated lucide key from `src/lib/catalog/chip-icons.ts`) + `icon_media_id`
(a custom médiathèque image, soft link). The storefront listing strip resolves
them in priority: custom image > icon key > per-type default. Both nullable, no
index (read alongside the row).

**Bulk entity content generation (0106).** `catalog_content_gen_jobs` (+ an
`entity_type` discriminator) + `catalog_content_gen_drafts` GENERALIZE the product
generator (0064) to CATEGORIES / BRANDS via one job/draft model:
same dry-run → review → apply (fields `Description / Bloc éditorial / FAQ / SEO`).
The `catalog_content_gen_jobs_one_active` partial UNIQUE is PER `entity_type`
(`ON (entity_type) WHERE status IN ('queued','running')`) so a category run and a
brand run can coexist; `entity_type` CHECK `category|brand`; status
CHECK as product-gen; drafts FK `ON DELETE CASCADE`. Runner:
`src/workflows/catalog/content-gen/`; the apply writes `description` /
`editorial_body` / `meta_*` via the entity service + FAQs via `faqService.replaceFor*`.

**Perf partial indexes (0066).** Two index-only additions, no data change:
`orders_guest_groupby_idx (lower(contact_email), contact_phone) WHERE user_id
IS NULL` backs the guest-identity GROUP BY of the filterable « Invités » tab
(`listFilteredGuests` / `guestFilterStats` in `src/lib/customers/guest-filter.ts`
— list + stats + keyset pagination + account enrichment; was a seq-scan over all
guest orders); and
`customer_profiles_live_created_idx (created_at) WHERE deleted_at IS NULL` backs
both `getCustomerStats` COUNTs (every admin dashboard load).

### 3.3 Storage estimate at 1M products

| Object                          | Approx size | Notes                                   |
| ------------------------------- | ----------- | --------------------------------------- |
| `products` heap                 | 1.8 GB      | Avg row ~1.8 KB inc. text descriptions  |
| `products_search_gin`           | 480 MB      | GIN on tsvector, partial                |
| `products_name_trgm`            | 320 MB      | GIN on trigrams, partial                |
| `products_published_recent_idx` | 28 MB       | Partial B-tree                          |
| `product_categories` heap+idx   | 240 MB      | ~3 cats per product                     |
| `product_media` heap+idx        | 350 MB      | ~3 images per product                   |
| `audit_log` heap                | 4–6 GB/year | ~500k rows/day at 50 RPS                |
| `audit_created_at_brin`         | < 1 MB      | The whole point of BRIN                 |
| **Total DB (1y, 1M products)**  | ~12 GB      | Comfortable on 40-GB managed Postgres   |

### 3.4 `products` columns added since the baseline

The squashed baseline (`0000`) shipped the core product row. These columns were
layered on across `0011`–`0024` (all additive, idempotent, default-null or
default-safe so untouched rows keep their behaviour):

| Column                  | Migration | Purpose                                                              |
| ----------------------- | --------- | -------------------------------------------------------------------- |
| `external_ref`          | `0011`    | Stable opaque ERP/PIM code for sync-by-reference; partial-unique among live rows (`products_external_ref_unique`), kept distinct from `sku` |
| `shared_variant_stock`  | `0012`    | Variable-product stock mode — `NULL` inherit / `true` shared pool / `false` per-variant |
| `related_mode`          | `0020`    | How the "Vous aimerez aussi" rail is populated — `auto` / `same_subcategory` / `same_brand` / `mixed` / `ai` / `manual` (CHECK `products_related_mode_chk`) |
| `warranty_months`, `warranty_label` | `0011`–`0024`* | Most-specific level of the global → category → product warranty cascade |
| `tax_rate_bps`          | `0011`–`0024`* | TVA override in basis points; `NULL` = inherit the filter → brand → category → global cascade |
| `meta_title`, `meta_description`, `canonical_url`, `noindex`, `og_image_media_id` | `0011`–`0024`* | Per-product SEO/social overrides (mirrored onto categories `0016` + brands `0018`), all with render-time fallbacks |
| `same_as`               | `0075`         | Official external URLs (schema.org `Product.sameAs`), newline-separated text. Emitted in the Product JSON-LD only when the global `seo.product_sameas_enabled` switch is on; parsed/validated by `lib/seo/same-as.ts`. No index (read with the row) |
| `min_purchase_qty`, `max_purchase_qty` | `0082` | Per-order purchase-quantity limits (PrestaShop `minimal_quantity` / Woo sold-individually). `NULL` = no limit; `max = 1` = sold individually. CHECKs: each `≥ 1`, `max ≥ min`. Enforced PER ORDER PER PRODUCT (place-order aggregates qty across variant lines) + pre-checked at add-to-cart; pure logic in `lib/cart/purchase-limits.ts` |
| `video_url`, `video_poster_media_id`, `video_title`, `video_description` | `0011`–`0024`* | PDP video block |
| `rating`, `reviews_count` | baseline + `0023` | Denormalised review aggregate; recomputed on every review write |

\* Several of the SEO / preorder / warranty / video columns also exist in
schema regen history bracketed by `0011`–`0024`; consult
[`src/modules/catalog/product/schema.ts`](../src/modules/catalog/product/schema.ts)
for the authoritative current shape. Variant shape (`product_type`,
`product_variants`, `product_variant_values`) is part of the product module and
described in §3.1.

### 3.5 `product_related` — curated cross-sell (0020)

A product↔product list used only when a product's `related_mode` is `manual`
or `ai`; the derived modes ignore these rows. Defined in
[`src/associations/product-related.ts`](../src/associations/product-related.ts).

| Index / FK                    | Definition                                          |
| ----------------------------- | --------------------------------------------------- |
| `pr_pair_unique`              | UNIQUE `(product_id, related_product_id)`            |
| `pr_product_idx`              | `(product_id)` — load a product's rail               |
| `pr_related_idx`              | `(related_product_id)` — reverse lookup              |
| `product_related_product_id_fkey` | `product_id` → `products(id)` **ON DELETE CASCADE** |
| `product_related_related_product_id_fkey` | `related_product_id` → `products(id)` **ON DELETE CASCADE** |

### 3.6 Attribute tables (0021 / 0022)

PrestaShop/WooCommerce-style filters. The `product_attributes` /
`product_attribute_values` / `product_attribute_assignments` /
`category_attribute_filters` tables ship in the baseline; `0021` added the
`number`/`text`/`color`/`boolean` values to the `attribute_kind` enum, the
per-value `color_hex`, and the `product_attribute_scalars` table for the
scalar (number/text) kinds. See
[`src/modules/catalog/attribute/schema.ts`](../src/modules/catalog/attribute/schema.ts).

| Table                            | Key indexes / FKs                                                       |
| -------------------------------- | ----------------------------------------------------------------------- |
| `product_attributes`             | `product_attributes_slug_unique` (partial, live), `…_active_idx`, `…_display_order_idx` |
| `product_attribute_values`       | `…_attribute_slug_unique`, `…_attribute_order_idx`; `color_hex` for `kind='color'` |
| `product_attribute_assignments`  | composite PK `(product_id, attribute_value_id)` + per-side indexes (value-list M2M) |
| `category_attribute_filters`     | composite PK `(category_id, attribute_id)` + per-side indexes           |
| `product_attribute_scalars`      | `…_product_attr_unique`, `…_attribute_idx`; FKs `product_id` → `products(id)` and `attribute_id` → `product_attributes(id)`, both **ON DELETE CASCADE** (0021) |

`attribute_kind` enum (`select`, `multiselect`, `color`, `boolean`, `number`,
`text`): select/multiselect/color/boolean use the value-list M2M; number/text
store a per-(product, attribute) row in `product_attribute_scalars`.

**Faceting is CLIENT-SIDE** (SEO-by-design). `getCategoryAttributeFilters` ships
each product's value-ids + numeric scalars to the browser; `category-client.tsx`
filters the (capped) product set in-memory via the pure
[`productMatchesAttributeFilters`](../src/lib/catalog/attribute-filter.ts) predicate
(AND-across-attributes, OR-within; number ranges). So there are **no indexable
`?attr=` filter URLs** — no faceted-nav crawl-budget bloat (the 2026 pattern). The
PDP also exposes the same specs as schema.org `Product.additionalProperty`.

**A `product_attribute_values` row is reused by THREE consumers**, which is why the
delete guards are three-part (§ modules.md): the filter M2M
(`product_attribute_assignments`), the variant axes
(`product_variant_values.attribute_value_id`, **ON DELETE CASCADE**), and the tax
cascade (`tax_rules.attribute_value_id`, **ON DELETE CASCADE**). A hard value delete
cascades all three — `deleteValueWorkflow` (+ the kind→boolean normalisation) block
when any is in use; `deleteAttributeWorkflow` SOFT-deletes the attribute so the
value rows survive.

### 3.7 Review generation (0023 / 0024)

`product_reviews` gained a `source` column (`customer` | `manual` | `ai`,
CHECK `product_reviews_source_chk`, index `product_reviews_source_idx`) in
`0023`, plus three new tables for AI review generation. See
[`src/modules/catalog/review/schema.ts`](../src/modules/catalog/review/schema.ts).

| Table                       | Key indexes / FKs / constraints                                            |
| --------------------------- | -------------------------------------------------------------------------- |
| `review_generation_jobs`    | `…_status_idx`, `…_created_idx`; `jsonb` `scope`/`settings`; `review_generation_jobs_one_active` UNIQUE partial (≤1 active job globally, `0024`) |
| `review_generation_drafts`  | `…_job_idx`; rating CHECK 1–5; `job_id` → `review_generation_jobs(id)` **ON DELETE CASCADE** (0023) |
| `review_schedule`           | singleton UNIQUE (`review_schedule_singleton`, `0024`), cadence CHECK `> 0` (`0024`); `jsonb` `scope`/`settings` |

### 3.8 AI auto-assign (0019 / 0022 / 0027) + shared job log (0071)

Background classification of products into categories, brands, or attributes,
with a dry-run → review → apply flow. See
[`src/modules/ai-assign/schema.ts`](../src/modules/ai-assign/schema.ts).

All four AI generators (auto-assign, review-gen §3.7, product-gen and
content-gen §3.2) write a shared per-item log to `ai_job_logs` (module `ai-jobs`,
migration `0071`) keyed by `(job_kind, job_id)` — one append-only row per
meaningful per-item outcome (`generated` / `skipped` / `provider_error` /
`parse_error` / `fatal`). Writes are best-effort + buffered + capped (`LOG_CAP`
= 600 per-item rows, then the terminal truncation / summary lines) so a 1000×N
run can't flood the table; rows are pruned by age alongside the job tables. The
admin panels read it via `getAiJobLogsAction` beside the `<AiJobProgress>` bar:
a TAIL read of the newest 650 lines (a whole capped job), flagged « Journal
tronqué » when older lines are left out. There is no FK (four possible parent
tables); the soft link + age prune keep it bounded.

| Table                  | Key indexes / FKs / constraints                                                  |
| ---------------------- | -------------------------------------------------------------------------------- |
| `ai_assign_jobs`       | `…_kind_status_idx`, `…_created_idx`; `ai_assign_jobs_one_active_per_kind` UNIQUE partial (single-flight per kind); `kind` CHECK widened to `categorize`/`brands`/`attributes` (`0022`); `jsonb` `summary` |
| `ai_assign_proposals`  | `…_job_idx`; `jsonb` `proposed`; `job_id` → `ai_assign_jobs(id)` **ON DELETE CASCADE** (added in `0027` — was a bare `uuid` in `0019`, which orphaned proposals on job delete) |
| `ai_job_logs`          | `ai_job_logs_job_idx` (`job_kind`, `job_id`, `created_at`, `id`); shared per-item log for all four AI generators (`0071`). FK-less soft link (four possible parents — product_gen / review_gen / auto_assign / content_gen job tables) keyed by `(job_kind, job_id)`; bounded by a per-job runner cap + age prune (`aiJobLogService.pruneOlderThan`, called from the scheduler tick) |

### 3.9 `stock_movements` — append-only ledger (0013)

One row per stock change — `reason` ∈ `order` (sale) / `cancellation` /
`refund` (full refund of goods that never left) / `return` / `api_delta` /
`api_set` / `admin` / `transfer` (inter-location leg, `0127`) — written in the
same transaction as the mutation so on-hand is reconstructable + ERP-reconcilable.
The `/api/stock/movements` feed accepts all of these as its `?reason=` filter.
Never updated or deleted. See
[`src/modules/stock-movement/schema.ts`](../src/modules/stock-movement/schema.ts).

| Index                               | Definition                                         |
| ----------------------------------- | -------------------------------------------------- |
| `stock_movements_product_idx`       | `(product_id, created_at)`                         |
| `stock_movements_order_idx`         | `(order_id)`                                       |
| `stock_movements_created_at_id_idx` | `(created_at, id)` — ERP movement-feed keyset (`0120`) |

(`product_id` / `order_id` are real `uuid` columns; `variant_id` is a `text`
soft-link so it survives variant deletion.) `location_id` (nullable `uuid`,
`0103`) records which stock location a per-location edit happened at; NULL for
legacy + single-pool movements.

**Ledger completeness.** Σ(`delta`) must explain every quantity change an ERP
reads from `/api/stock/movements`, so writers that move stock without a sale
still write a row:

- A removed TRACKED variant (variant editor, or the main-form variable → simple
  demotion) is ledgered `admin`, `delta −old → 0`, note « variante supprimée ».
- A tracking switch is a `delta 0` marker whose `resulting_qty` re-baselines the
  line (`null` = untracked) — the same shape `api_set` writes. The variant
  editor notes it « suivi désactivé » / « suivi activé »; the main product form
  writes the same marker without a note. The demotion's parent reset NULL → 0 is
  also a `delta 0` marker (note « rétrogradation » from the variant editor, no
  note from the main-form demotion).
- A `return` of a SHARED-pool variant restocks the parent pool, so its row is
  product-level (`variant_id` NULL, variant id in `note`).
- Location (de)activation writes `admin` rows with `location_id` set (§3.9b).
- A `transfer` writes two legs (source `−qty`, destination `+qty`, both
  `location_id`-tagged) that net to zero — units relocate, the sellable TOTAL is
  invariant.
- In `per_location` mode a sale also writes a per-location `order` leg (negative
  `delta`, `location_id` set) at fulfilment, ON TOP of the total-scoped decrement
  taken at placement. So a naive product-wide Σ(`delta`) over `order` rows would
  double-count that unit: an ERP reconstructing on-hand must scope by
  `location_id` and lean on `resulting_qty` (the authoritative post-change level),
  not sum `order` deltas blindly.

**`in_stock` re-derivation.** A quantity write that doesn't set the
availability flag explicitly re-derives it by the one shared rule
([`src/lib/inventory/in-stock-rule.ts`](../src/lib/inventory/in-stock-rule.ts)):
a SOLD-OUT line (tracked, qty ≤ 0) or an untracked line that starts being
tracked is listed iff the new qty > 0; a line an operator deliberately delisted
(`in_stock = false` with units) stays delisted, and reaching 0 delists. The SQL
writers inline the same `CASE`.

### 3.9b Multi-location inventory — `stock_locations` + `stock_levels` (0103)

OPT-IN. Default is a single pool: `products.stock_qty` /
`product_variants.stock_qty` stay the **authoritative sellable TOTAL** that every
reader (storefront, cart, checkout, `/api/stock`, low-stock) uses, and a single
seeded "Magasin principal" holds everything. When the operator sets
`inventory.location_mode = per_location`, `stock_levels` becomes the editable
per-store detail and the totals are maintained as the cached **SUM across active
locations** (delta-based in `stockLocationService.setLocationLevel`, so a
concurrent order decrement is never clobbered). See
[`src/modules/stock-location/schema.ts`](../src/modules/stock-location/schema.ts).

Deactivating / reactivating a location (`stockLocationService.setLocationActive`)
moves the totals by DELTA in the same transaction as the flag: −level on
deactivate (floored at 0), +level on reactivate, with `admin` ledger rows (note
« Emplacement désactivé » / « Emplacement réactivé », `location_id` set). It is
idempotent (a no-op flip touches no total), never recomputes Σ(levels) (order
decrements move only the totals, so the level sum is stale by every sale), and
symmetric: a level larger than the total is clamped on deactivation to what was
actually removed, so reactivation never brings sold units back. Level writers
take `FOR SHARE` on the location row (lock order location → total → level).
Deleting a location evacuates it first: `transfer` adds each level to the
destination, `writeoff` drops the totals — except for an INACTIVE location,
whose levels are just zeroed (its units already left the totals). Only an
active location can be the default (checked atomically by `setDefault`), and
the default can't be deactivated.

| Table             | Key indexes / constraints                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `stock_locations` | `stock_locations_one_default` (partial unique: one default); `stock_locations_code_unique` (partial); `display_order_idx`; soft-delete |
| `stock_levels`    | `stock_levels_product_pool_unique` (loc+product WHERE variant_id NULL) + `stock_levels_variant_unique` (loc+variant) split partial uniques; `product_idx` / `variant_idx` / `location_idx`; CHECK `qty >= 0` |
| `stock_transfers` | `stock_transfers_created_at_id_idx` (`(created_at, id) WHERE deleted_at IS NULL` — default list keyset, `0128`); `status_idx (status, created_at)`; `from_idx` / `to_idx` / `order_idx`; `ref_idx` UNIQUE (`0128`); soft-delete; CHECK `from ≠ to` |
| `stock_transfer_items` | `transfer_idx` (`transfer_id`); FK `transfer_id` → `stock_transfers` CASCADE; CHECK `qty > 0` (the `product_idx` was dropped in `0128` — dead) |

`stock_locations.carrier_ref` is an OPTIONAL text soft-link to a delivery
agent / pickup point (gated by `inventory.carrier_link_enabled`). It is
display-only for now — no order or pickup flow reads it — and editing a location
while the link feature is off keeps it. `code` is the location's optional ERP
id. The order pipeline (place / edit / restock) + `/api/stock` write the sellable
TOTAL; in `per_location` mode a sale's per-location detail is also maintained —
the depot leg is moved at FULFILMENT by the `ship-depot-decrement` subscriber
(an `order`-reason `stock_movements` row tagged with `location_id`, total already
decremented at placement — see §3.9). `setLocationLevel` rejects edits to an
inactive/deleted location (so the active-location SUM invariant holds) and emits
`product.updated` + `product.restocked` via `setLocationLevelsAction` (cache bust
+ back-in-stock).

A product delete drops its product-pool `stock_levels` (`productService.softDelete`)
and its variants' levels (`replaceVariants`, §3.14), so a tombstone never keeps
counting in the Emplacements totals (backfilled for older tombstones by `0125`).

Locations are managed at **Catalogue → Stock → « Emplacements »** (a sub-tab).
`/admin/catalog/locations` redirects to `/admin/catalog/stock?tab=emplacements`,
and the legacy `#emplacements` hash also opens the tab. In per-location mode the
matrix shows the authoritative `stock_qty` as « Total » (« Non suivi » when
untracked) and flags « Écart » when Σ(active levels) ≠ the total.

### 3.10 Order returns (0014)

Customer RMA. `order_returns` lists the returns raised against an order;
`order_return_items` are the lines coming back. On RECEIVE, resellable lines
restock idempotently per line (`restocked_at` anchor). Money stays in
`order_refunds`. See
[`src/modules/order/returns.schema.ts`](../src/modules/order/returns.schema.ts).

| Table                | Key indexes                                                       |
| -------------------- | ----------------------------------------------------------------- |
| `order_returns`      | `order_returns_order_idx` `(order_id)`; `order_return_status` enum (`pending`/`received`/`rejected`) |
| `order_return_items` | `…_return_idx` `(return_id)`, `…_order_item_idx` `(order_item_id)` |

### 3.11 `job_run_log` — scheduled-run history (0025)

One row per run of a registered job (`src/lib/jobs/registry.ts`, 8 jobs:
`review_generation`, `retention_purge`, `mailing_queue`, `birthday_email`,
`review_request`, `payment_reconcile`, `abandoned_orders`, `webhook_dispatch`).
Powers the admin "Tâches planifiées" dashboard. Bounded per `job_key` by an
app-side prune-on-record that keeps the latest 100 real (`ok` / `failed`) runs +
the latest 20 `skipped` (no-op) runs + always the latest failure, so frequent
no-op drains can't evict the history; the retention purge also caps it by age
(90 d). Distinct from `audit_log` (operator actions vs. machine job runs). See
[`src/modules/jobs/schema.ts`](../src/modules/jobs/schema.ts).

| Index                       | Definition                                       |
| --------------------------- | ------------------------------------------------ |
| `job_run_log_job_created_idx` | `(job_key, created_at DESC)`                   |

`status` CHECK (`ok`/`failed`/`skipped`), `trigger` CHECK
(`schedule`/`manual`/`cron`).

### 3.12 `carts_ephemeral_purge_idx` — quick-buy retention sweep (0026)

A partial index backing the retention purge of ephemeral quick-buy carts
(`cartService.purgeEphemeralOlderThan` / the `/api/cron/retention` sweep).
Without it, `DELETE FROM carts WHERE token LIKE 'qb-%' AND created_at < cutoff`
seq-scans the whole `carts` table and trips the 10s statement timeout.

```sql
CREATE INDEX carts_ephemeral_purge_idx
  ON carts (created_at)
  WHERE token LIKE 'qb-%';
```

The `token LIKE 'qb-%'` predicate is IMMUTABLE (valid in a partial-index
`WHERE`) and keeps the index tiny by excluding all non-ephemeral carts. Window:
2 days (`RETENTION_WINDOWS.ephemeral_carts`).

A second sweep, `cartService.purgeStaleGuestCarts` (60 days,
`guest_carts`), deletes guest carts (`user_id` NULL, not `qb-`) whose LAST
ACTIVITY — `carts.updated_at` and every line's `updated_at` — is older than the
window. Both sweeps delete in 5000-row batches; lines go with the
`cart_items → carts` CASCADE.

### 3.13 `api_keys` — external HTTP API (0010)

Keys for the external HTTP API (`/api/products`, `/api/categories`, write
endpoints). The plaintext key is shown once and never stored — only its
SHA-256 hash. `prefix` is a non-secret identifier for the admin list — the
`gz_live_` label plus a short non-reversible SHA-256 fingerprint of the key (NOT
a slice of the live secret). See
[`src/modules/api-key/schema.ts`](../src/modules/api-key/schema.ts).

| Index                     | Definition                          |
| ------------------------- | ----------------------------------- |
| `api_keys_key_hash_unique` | UNIQUE `(key_hash)`                 |
| `api_keys_active_idx`     | `(revoked_at)` — filter live keys    |

### 3.14 `product_variants` + `product_variant_values` — variable-product variants (baseline / 0008 / 0030)

Each row in `product_variants` is an independently-sellable unit of a `variable`
product carrying its OWN absolute `price_cents` / `stock_qty` / child `sku` /
`gtin`, plus an optional per-variant `image_media_id` (a soft-FK to `media`; the
PDP gallery falls back to the product gallery when it is NULL). `product_id` is a
real `uuid` FK → `products(id)` **ON DELETE CASCADE** (baseline). The attribute
combination that defines a variant lives in `product_variant_values`. See
[`src/modules/catalog/product/schema.ts`](../src/modules/catalog/product/schema.ts).

> **Attribute-derived vs. manual variants.** A variant may be either
> attribute-derived (one `product_variant_values` row per defining value, with
> `label` denormalised from that combination) **or** manual/free-form — a custom
> `label` / `sku` / `price_cents` / `stock_qty` typed directly in the editor with
> **no** `product_variant_values` rows. No schema change was needed: the absence
> of value links is what marks a row manual, and `product_variants.label` is the
> source of truth for its display name. Both kinds coexist on the same product.

| Index / constraint                          | Definition                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `product_variants_product_idx`              | `(product_id)`                                                              |
| `product_variants_order_idx`                | `(product_id, display_order)`                                              |
| `product_variants_live_order_idx`           | `(product_id, display_order)` WHERE `deleted_at IS NULL` — partial, backs PDP/admin ordering over the live set |
| `product_variants_image_media_id_idx`       | `(image_media_id)` WHERE `image_media_id IS NOT NULL` — partial; per-variant image lookup + media orphan-GC |
| `product_variants_one_default_per_product`  | UNIQUE `(product_id)` WHERE `is_default AND deleted_at IS NULL` — at-most-one default variant per product |
| `product_variants_sku_unique`               | UNIQUE `(sku)` WHERE `sku IS NOT NULL AND deleted_at IS NULL` — child-SKU uniqueness over live rows (`0008`) |
| `product_variants_gtin_unique`              | UNIQUE `(gtin)` WHERE `gtin IS NOT NULL AND deleted_at IS NULL` — child-GTIN uniqueness over live rows (`0008`) |

> The plain `product_variants_sku_idx` was **dropped** in `0030` — redundant
> write-amplification on the hottest variant path (delete + reinsert per save),
> superseded by the partial-unique `product_variants_sku_unique` that
> `findVariantBySku` already uses. The four load-bearing partial indexes
> (`sku_unique`, `gtin_unique`, `image_media_id_idx`, `live_order_idx`) are now
> also declared in `schema.ts` so a drizzle regen can't emit a `DROP` for them.

**Variant retirement.** `productService.replaceVariants` updates kept rows IN
PLACE (ids stay stable for carts / order lines) and SOFT-deletes the rest. A
retired variant ends with `sku` / `gtin` NULL (freed on the partial uniques),
`is_default` false, `stock_qty` 0 / `in_stock` false and its `stock_levels`
dropped; tracked units leaving are ledgered by the caller (§3.9). Deleting a
product (`deleteProductWorkflow`) runs, in ONE transaction, the product
soft-delete (+ its product-pool levels), `replaceVariants(id, [])`, the removal
of its attribute assignments — so a
tombstone no longer holds variant SKU/GTINs, per-location units or attribute
values "in use". Order history is unaffected (`order_items` snapshot sku / label
/ image). Migration `0125` backfilled the same release
for products deleted before this.

`product_variant_values` links a variant to each attribute value that defines it
(one row per `(variant, value)`):

| Index / FK                              | Definition                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `product_variant_values_unique`         | UNIQUE `(variant_id, attribute_value_id)`                                  |
| `product_variant_values_variant_idx`    | `(variant_id)`                                                             |
| `product_variant_values_value_idx`      | `(attribute_value_id)`                                                     |
| `product_variant_values_variant_id_fkey` | `variant_id` → `product_variants(id)` **ON DELETE CASCADE** (baseline)    |
| `product_variant_values_attribute_value_id_fkey` | `attribute_value_id` → `product_attribute_values(id)` **ON DELETE CASCADE** (baseline) |

### 3.15 Extensions

| Extension            | Created by | Used for |
| -------------------- | ---------- | -------- |
| `pgcrypto`, `btree_gin` | `0000` | `pgcrypto`: `gen_random_bytes` for `uuid_generate_v7()`; `btree_gin`: search indexes |
| `pg_trgm`            | `0000` (re-asserted `0047`) | Trigram GIN indexes (typo-tolerant search, admin ILIKE search) |
| `unaccent`           | `0000`     | The `fr_unaccent` text-search configuration (§4.2) |
| `vector` (pgvector)  | `0112`     | `products.embedding` + HNSW index (semantic search). Needs the pgvector Postgres image (`docker/pgvector/Dockerfile`) BEFORE the deploy that runs `0112` |
| `pg_stat_statements` | `0124`     | Slow-query stats (§7.1). Created only where the server preloads it |

---

## 4. Index strategy

The full list is the `0000_squash_baseline.sql` baseline
(`src/lib/db/migrations/0000_squash_baseline.sql`) plus the later migrations
(footer log). Below is the rationale for each family.

### 4.1 Partial B-tree on hot listings
**Rule of thumb:** every read query the storefront hits has a partial index
matching its `WHERE` clause exactly. Partial indexes are 2–10× smaller than
full-table B-trees and the planner picks them automatically.

```sql
-- The single hottest query: latest published products.
CREATE INDEX products_published_recent_idx
  ON products (is_published, published_at DESC NULLS LAST)
  WHERE deleted_at IS NULL;
```

Why this composition: leading `is_published` lets the planner narrow to the
visible slice immediately, and trailing `published_at DESC` removes the sort
step from the plan (visible in EXPLAIN as no `Sort` node above the index).

### 4.2 Hybrid full-text search (tsvector + pg_trgm)

`products.search_vector` is a `STORED GENERATED tsvector` column:

```sql
ALTER TABLE products ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('fr_unaccent', coalesce(name, '')), 'A') ||
  setweight(to_tsvector('fr_unaccent', coalesce(sku, '')), 'A') ||
  setweight(to_tsvector('fr_unaccent', coalesce(short_desc, '')), 'B') ||
  setweight(to_tsvector('fr_unaccent', coalesce(description, '')), 'C') ||
  setweight(to_tsvector('fr_unaccent', coalesce(platform, '')), 'D')
) STORED;

CREATE INDEX products_search_gin
  ON products USING GIN (search_vector)
  WHERE deleted_at IS NULL AND is_published = true;
```

- **Weights** (`A` > `B` > `C` > `D`): name **and** SKU score highest (`A`),
  then `short_desc` (`B`), `description` (`C`), and `platform` (`D`). `ts_rank`
  uses these weights automatically.
- **Dictionary** is the custom `fr_unaccent` text-search configuration (defined
  in the baseline migration's preamble), **not** `simple`. It pipes words
  through `unaccent` + `french_stem` so an accent-insensitive French search
  ("manette" matches "manettes", "élite" matches "elite") works, while
  numbers/urls/emails fall back to `simple` mapping. The same `fr_unaccent`
  config drives the `search_vector` on `categories`, `brands`, `pages`,
  and `blog_posts` (each with its own column weighting).
- **Partial predicate** keeps the index at ~480 MB instead of ~1.2 GB at 1M
  rows — only storefront-visible products need the index.

Trigram (`pg_trgm`) sits next to it for typo tolerance:

```sql
CREATE INDEX products_name_trgm
  ON products USING GIN (name gin_trgm_ops)
  WHERE deleted_at IS NULL;
```

`searchProducts(query, limit, cfg, …)` issues both queries in a single CTE and
unions them, with FTS hits ranking above trigram fallback (and, when semantic
search is enabled, a pgvector branch). See
[`src/modules/search/queries.ts`](../src/modules/search/queries.ts).

### 4.3 In-stock and price partials
Storefront defaults to "in stock only" — every category listing hits these:

```sql
CREATE INDEX products_in_stock_active_idx
  ON products (in_stock, published_at DESC NULLS LAST)
  WHERE deleted_at IS NULL AND is_published = true;

CREATE INDEX products_active_price_idx
  ON products (price_cents)
  WHERE deleted_at IS NULL AND is_published = true;
```

### 4.4 BRIN for append-only time-series

`audit_log` and `order_status_history` are write-once + read-by-time-range.
A BRIN index on `created_at` stores one summary tuple per 32 pages — orders
of magnitude smaller than a B-tree, with negligible read overhead because
the data is naturally clustered by insert time.

```sql
CREATE INDEX audit_created_at_brin
  ON audit_log USING BRIN (created_at) WITH (pages_per_range = 32);
```

At 1M audit rows the B-tree would be ~22 MB; the BRIN is **8 KB**.

### 4.5 Audit-log index reconciliation (0079)

`audit_log` is the **hottest-insert** table — the wildcard subscriber writes a
row on nearly every stateful action — so its index set is tuned for cheap
writes, not speculative reads. Migration `0079` **dropped four indexes** that
were pure write-amplification on every insert with no query path to justify
them:

- `audit_metadata_gin` — a GIN on `metadata jsonb_path_ops`. It was provisioned
  for `@>` containment queries, but **no code path actually queries `metadata`
  as a predicate** (the Journal filters on `event_name` / `actor_user_id` /
  `severity` / `target_*`, never the JSON payload), so the GIN only added
  insert cost. Dropped.
- `audit_event_idx` (`event_name`) and `audit_actor_idx` (`actor_user_id`) —
  single-column btrees shadowed by the new `(col, id DESC)` composites below.
- `audit_created_at_idx` — an **ASC** `created_at` btree; the BRIN (§4.4, purge
  range) + the `(created_at DESC, id DESC)` composite below cover every real
  query (purge ORDER BY + date-range filter), so the ASC copy was redundant.

`0079` also **added** a per-row `severity` column (drives the Sévérité filter +
KPI counts) and four composites keyed to the admin Journal's keyset — three
filter composites `(event_name, id DESC)` (recreated; the baseline was
`created_at DESC`), `(actor_user_id, id DESC)`, `(severity, id DESC)`, plus a
`(created_at DESC, id DESC)` composite (`audit_created_id_idx`) that **replaced**
the baseline single-column `audit_created_at_desc_idx` and serves both the purge
ORDER BY and the date-range Journal filter:

```sql
CREATE INDEX audit_event_recent_idx    ON audit_log (event_name,    id DESC);
CREATE INDEX audit_actor_recent_idx    ON audit_log (actor_user_id, id DESC);
CREATE INDEX audit_severity_recent_idx ON audit_log (severity,      id DESC);
CREATE INDEX audit_created_id_idx      ON audit_log (created_at DESC, id DESC);
```

The Journal keysets on `id` (uuid v7 = newest-first, and an **exact** boundary
— `created_at` is microsecond-precision but a JS/ISO cursor is millisecond, so
it can't be an exact cursor). Leading each composite with the filter column +
`id DESC` makes a severity/actor/event-filtered page an index range-scan in
keyset order rather than a Sort.

### 4.6 Soft-aware unique slugs
Every "slug" column has a single **partial unique** index scoped to live rows,
which both enforces uniqueness among non-tombstoned rows and serves every
slug-equality lookup:

```sql
CREATE UNIQUE INDEX products_slug_unique
  ON products (slug) WHERE deleted_at IS NULL;
```

Soft-deleted rows keep their slug (so audit trails remain readable) and that
slug is freed for reuse, while the storefront's slug-lookup never has to scan
them. Earlier there was also a redundant non-unique `products_active_slug_idx`
on the same `(slug) WHERE deleted_at IS NULL` — functionally identical to the
unique index, so it was **dropped in migration `0009`** (it only added write
overhead; the planner falls back to `products_slug_unique` transparently).

### 4.7 Prefix-duplicate indexes (0125)

A single-column btree that is the leading column of another index on the same
table (composite or UNIQUE) serves no read the wider index can't, including the
FK-cascade lookup, and only costs writes. Migration `0125` dropped two such indexes; the one still on a live table:

- `promotion_redemptions_promo_idx (promotion_id)` — covered by
  `promotion_redemptions_user_idx (promotion_id, user_id)` and
  `promotion_redemptions_promo_created_idx (promotion_id, created_at DESC)`;

Same reasoning as the earlier drops (`0009` duplicate slug index, `0043`
`coin_tx_order_idx` covered by `(order_id, kind)`). Check a new index against
the table's existing ones before adding it.

The schema is **not** clean of this pattern yet: `0125` only removed those two.
Older baseline-era single-column indexes of the same shape remain, e.g.
`pc_product_idx` (under `pc_pair_unique`), `cart_items_cart_idx` (under
`cart_items_cart_product_unique`), `sessions_user_idx` (under
`sessions_user_expires_idx`), `role_permissions_role_idx` (under
`role_permissions_role_perm_unique`), and `cul_user_idx` / `cul_profile_idx`,
exact copies of the UNIQUE `cul_user_unique` / `cul_profile_unique`. Several are
also declared in the Drizzle `schema.ts` files, so dropping one means editing
the schema too.

---

## 5. Connection management

### 5.1 Pool sizing
Defined in [`src/lib/db/client.ts`](../src/lib/db/client.ts):

| Env                       | Prod | Dev | Rationale                              |
| ------------------------- | ---- | --- | -------------------------------------- |
| `DB_POOL_MAX`             | 12   | 5   | Per-process client cap (`src/lib/db/client.ts`: `isProd ? posIntEnv(DB_POOL_MAX, 12) : 5`) |
| `DB_STATEMENT_TIMEOUT_MS` | 10000| 10000 | Kill long queries before they block  |
| `DB_IDLE_TIMEOUT_MS`      | 15000| 15000 | Drop idle pooled clients fast (frees slots for other instances) |
| `DB_CONNECTION_TIMEOUT_MS`| 3000 | 3000 | Fail fast on acquire instead of queueing |
| `DB_KEEPALIVE`            | on   | on   | TCP keepalive through proxy/NAT idle cutoffs (`false` disables) |
| `DB_APPLICATION_NAME`     | tokyostore-app | same | Shows in `pg_stat_activity`     |

Blank / non-numeric values fall back to the defaults (`posIntEnv`,
`src/lib/db/env-num.ts`), so an empty Coolify variable can't disable a limit.

The prod default is **12** (matching the §2 topology math: 4 instances × 12 =
48 connections, leaving headroom under `max_connections = 100`). In dev the cap
is a hard-coded **5** (the `DB_POOL_MAX` env override only applies in prod).

### 5.2 Per-connection safety net

The pool sets four per-connection timeouts through the libpq **startup packet**
(the `options` string + `statement_timeout`/`query_timeout` fields on the pg
`Pool` config in [`src/lib/db/client.ts`](../src/lib/db/client.ts), driven by
`DB_STATEMENT_TIMEOUT_MS`, default 10s) — NOT a `pool.on('connect')` `SET`
handler (a post-connect `SET` races the first pooled query; pg9 will throw):

```
statement_timeout = 10s   (also client-side via node-postgres query_timeout)
lock_timeout = 3s
idle_in_transaction_session_timeout = 30s
```

⚠️ On the DIRECT connection Postgres honours these startup params. Under the
opt-in **PgBouncer transaction** pooling (see §5.4) the startup params are
dropped (`IGNORE_STARTUP_PARAMETERS`). `statement_timeout` still bites because
node-postgres enforces `query_timeout` **client-side** regardless of pooling,
but `lock_timeout` / `idle_in_transaction_session_timeout` have no client-side
equivalent — so **migration `0117_role_connection_timeouts.sql` sets those two
at the ROLE level** (`ALTER ROLE CURRENT_USER SET …`), which Postgres applies
server-side when it opens a backend, surviving the pooler. Migrations override
these per-connection (generous lock wait, no statement cap) via their own
startup `options` in `migrate.ts` — which only works on a DIRECT connection, so
the migrator runs on `MIGRATION_DATABASE_URL` (§5.4).

**Long jobs.** `SET LOCAL statement_timeout` alone can't lengthen a query: the
pool-wide client-side `query_timeout` still aborts it at 10 s ("Query read
timeout") while the server keeps running it. A legitimately long job (bulk
import, backfill, heavy report) uses `withLongStatement(ms, fn)` from
[`src/lib/db/client.ts`](../src/lib/db/client.ts): `fn` runs in a transaction on
a dedicated short-lived connection whose `query_timeout` + `statement_timeout`
are `ms`, plus a `SET LOCAL` so it also holds behind PgBouncer. `lock_timeout` /
the 30 s idle-in-transaction reaper still apply, so keep HTTP / AI calls out of
`fn`. One extra connection per call: reserve it for rare operator-triggered
jobs.

**Never call the pool inside a transaction.** Inside `db.transaction(async (tx)
=> …)`, thread `tx` through (and pass it to every service method that defaults
to `txOrDb = db`). Resolve read-only config (e.g. `getSharedStockDefault()`,
`getTaxConfig()`) BEFORE opening the transaction. A `db.*` call inside the
callback takes a second connection while the tx holds one plus its row locks;
at pool-max concurrency that deadlocks the pool until the acquire timeout.
`src/lib/db/tests/tx-pool-reentrancy.test.ts` guards the cancel and full-refund
paths.

### 5.3 Graceful shutdown

```typescript
export async function closePool(): Promise<void> { await pool.end(); }
```

Wired into Next.js's `process.on('SIGTERM')` so Coolify rolling deploys hand
off cleanly without leaving connections in `idle_in_transaction`.

### 5.4 PgBouncer mode caveats (recap)

- ✅ Simple queries, parameterised — _what we do_
- ✅ `BEGIN`/`COMMIT` wrapped in same client request — _what we do_
- ❌ `LISTEN`/`NOTIFY` — _we don't use_
- ❌ Server-side prepared statements (`PREPARE … AS …`) — _we don't use_
- ❌ Session-level `SET` (must use `SET LOCAL`) — _app code uses only `SET LOCAL` / `set_config(…, true)`_
- ❌ Session advisory locks — _app code uses only transaction-scoped ones (`pg_advisory_xact_lock` / `pg_try_advisory_xact_lock`: import single-flight, mail-drain, system-page bootstrap)_
- ❌ Cursors held across requests — _we don't use_

The one exception is the **migrator** (`src/lib/db/migrate.ts`, run by the
container entrypoint on every boot): its session advisory lock, session `SET`s
and startup `options` need a direct connection, so it connects via
`MIGRATION_DATABASE_URL` when set (else `DATABASE_URL`).
`docker-compose.coolify.yml` pins that to `postgres:5432`. When enabling the
pooler, repoint ONLY `DATABASE_URL` at `pgbouncer:5432`. The PgBouncer service
must list every startup key the app sends in `IGNORE_STARTUP_PARAMETERS`
(Appendix B), or it rejects every app connection. Anything else that needs one
of the ❌ features should likewise use a dedicated direct connection.

---

## 6. Query patterns

### 6.1 Listing the storefront (the hottest query)

```typescript
// src/modules/catalog/product/queries.ts
db.select(...)
  .from(products)
  .where(and(isNull(products.deleted_at), eq(products.is_published, true)))
  .orderBy(desc(products.published_at))
  .limit(24);
```

Planner picks `products_published_recent_idx` → Index Scan → no sort →
~0.1 ms at 10k rows; estimated ~0.5 ms at 1M.

### 6.2 Slug lookup

```typescript
db.select(...).from(products)
  .where(and(eq(products.slug, slug), isNull(products.deleted_at)))
  .limit(1);
```

Planner picks `products_slug_unique` → Index Scan → ~0.04 ms at any
size (B-tree depth `log₂(N)` doesn't move the needle).

### 6.3 Hybrid search

```typescript
// src/modules/search/queries.ts
await searchProducts("chronogrph automatik", 20 /* limit */, cfg);
```

Single SQL with a `WITH fts AS (...) , fuzzy AS (... NOT IN fts)` CTE.
Planner uses `products_search_gin` then `products_name_trgm`. Typical
latency at 1M rows: 12–18 ms for the FTS branch, +60–90 ms when the fuzzy
branch fires (rare — only triggers when FTS returns zero hits).

### 6.4 Category page

```sql
SELECT p.id, p.slug, p.name FROM products p
JOIN product_categories pc ON pc.product_id = p.id
WHERE pc.category_id = $1
  AND p.deleted_at IS NULL AND p.is_published = true
ORDER BY p.published_at DESC NULLS LAST LIMIT 24;
```

`product_categories.product_id` / `category_id` are real `uuid` columns
(see [`src/associations/product-category.ts`](../src/associations/product-category.ts)),
so the join is a plain `uuid = uuid` and `pc_category_idx` is used directly.

### 6.5 Use `'use cache'` directives for storefront reads

Next.js 16 introduces `'use cache'` (enabled via `experimental.useCache`;
`cacheComponents` stays off). Cached readers declare their dependencies with
`cacheTag(…)` from the single vocabulary in
[`src/lib/cache/tags.ts`](../src/lib/cache/tags.ts) — e.g. the PDP loader
(`src/lib/api/products.ts`: `products:list`, `products`, `brands`,
`categories`, `product:slug:<slug>`, `product:<id>`) and the taxonomy loaders
(`src/lib/api/categories.ts`, brand / blog `queries.ts`). Writes
mostly don't bust tags themselves: they emit events and the
`src/events/subscribers/invalidate-*-cache.ts` subscribers (one per domain,
e.g. catalog, attribute, blog) expire the matching tags. A few paths bust directly via
`bustCacheTag` (`src/lib/cache/revalidate.ts`), and bulk data jobs bust the
whole storefront set (`src/lib/cache/bust-storefront.ts`).
`src/lib/db/tests/cache-tag-readers.test.ts` keeps tags and readers in sync.
Layout-reachable cached DB reads must guard `isBuildPhase()` (the Docker build
has no DB). The cache is per-process (§2).

---

## 7. Observability

### 7.1 `pg_stat_statements`

`docker-compose.coolify.yml` starts Postgres with (as `-c` flags):

```conf
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.max = 10000
pg_stat_statements.track = all
track_io_timing = on
```

Migration `0124_pg_stat_statements` then runs `CREATE EXTENSION IF NOT EXISTS
pg_stat_statements` — guarded: only when the library is actually preloaded (the
view errors otherwise), and a non-superuser role or a server without the contrib
module just logs a NOTICE instead of failing the deploy. The compose runs
Postgres as the superuser `POSTGRES_USER`, so production gets the view on the
next boot; dev/test databases don't preload it and stay without. The admin
« Requêtes lentes » card (Système → Base de données) reads it.

Top-N slow queries:

```sql
SELECT mean_exec_time::int AS avg_ms,
       calls,
       (total_exec_time / 1000)::int AS total_seconds,
       substring(query, 1, 80) AS preview
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

### 7.2 Slow query log

`docker-compose.coolify.yml` sets `log_min_duration_statement = 500ms` and
`log_lock_waits = on` on the Postgres server, so any query slower than half a
second (and any lock wait past `deadlock_timeout`) hits the Postgres container
log, which Coolify collects. No migration sets it, so a database outside that
compose (the dev DB, a managed Postgres) needs the same setting via
`postgresql.conf` / `ALTER SYSTEM` / `ALTER ROLE`.

### 7.3 Index usage audit

```sql
SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_stat_user_indexes
WHERE schemaname = 'public' AND idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;
```

Any index with `idx_scan = 0` after a week of prod traffic is a candidate
for removal. Drop them — unused indexes still cost write throughput.

### 7.4 Live connection / lock view

```sql
-- Active queries holding locks for > 1s
SELECT pid, now() - pg_stat_activity.query_start AS duration,
       state, wait_event_type, wait_event, query
FROM pg_stat_activity
WHERE state != 'idle' AND now() - query_start > interval '1 second'
ORDER BY duration DESC;
```

### 7.5 PgBouncer admin console

Connect as `tokyo` to db `pgbouncer` (mode admin):

```sql
SHOW STATS;     -- per-database query rate, avg time
SHOW POOLS;     -- client+server conn breakdown
SHOW CLIENTS;   -- who's connected
```

### 7.6 Disk space watch

```sql
SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS total
FROM pg_class
WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
ORDER BY pg_total_relation_size(oid) DESC LIMIT 20;
```

---

## 8. Maintenance

### 8.1 Autovacuum tuning

**Recommended (not currently applied in the repo).** No migration or compose
file sets per-table autovacuum today — the pre-squash `0004` that once carried
these `ALTER TABLE … SET (autovacuum_*)` statements is gone and they were NOT
folded into the baseline, so hot tables (`audit_log`, `search_log`,
`webhook_events`, `stock_movements`) currently run on
the global thresholds (the Coolify compose only raises the server-wide
`autovacuum_max_workers = 4` / `autovacuum_naptime = 30s`). To restore
aggressive autovacuum on the high-churn tables, add a migration with the
statements below:

```sql
ALTER TABLE audit_log SET (
  autovacuum_vacuum_scale_factor = 0.02,    -- vacuum at 2% dead rows (default 20%)
  autovacuum_analyze_scale_factor = 0.01,   -- analyze at 1% changed
  autovacuum_vacuum_cost_limit = 2000,      -- more I/O budget
  fillfactor = 90                           -- room for HOT updates
);
```

Rationale: `audit_log` is write-heavy and we want index visibility maps
refreshed often so index-only scans stay efficient.

### 8.2 Quarterly reindex schedule (when needed)

Postgres B-trees don't usually need rebuilding, but GIN indexes can bloat
after many updates. Cron-style task:

```sql
-- Run during low-traffic window. CONCURRENTLY = no blocking.
REINDEX INDEX CONCURRENTLY products_search_gin;
REINDEX INDEX CONCURRENTLY products_name_trgm;
```

Check bloat first with `pgstattuple` extension or `pg_repack`'s reporter.

### 8.3 pg_repack for online table rewrites

When a hot table grows bloated past 30% (rare with our autovacuum settings),
use `pg_repack` to rewrite it online (no exclusive lock):

```bash
pg_repack -d tokyo -t products
```

Coolify-managed Postgres ships pg_repack as an installable extension.

---

## 9. Migration workflow

### 9.1 Authoring migrations

Migrations are **hand-authored**. `pnpm db:generate` is guarded/disabled (the
drizzle meta-snapshot chain is frozen at `0007`, so a diff would target stale
state and emit a destructive migration — escape hatch `pnpm db:generate:force`).
Write the SQL yourself, then apply it:

```bash
# 1. create src/lib/db/migrations/NNNN_name.sql  (next number: 0140; --> statement-breakpoint
#    between statements; prefer idempotent IF [NOT] EXISTS / guarded DO $$ … $$)
# 2. add a matching entry to src/lib/db/migrations/meta/_journal.json
# 3. update the Drizzle schema so the barrel stays the source of truth
pnpm db:migrate     # applies pending migrations (advisory-locked, idempotent)
```

**The journal `when` must be STRICTLY greater than the previous entry's.** The
drizzle migrator only compares each entry's `when` with the newest applied one,
so an equal or smaller value is silently SKIPPED on every already-migrated
database (prod, dev) while a fresh DB applies it. The recent entries use
hand-picked round values that run ahead of the wall clock (`0130` =
`1790800000000`), so a bare `Date.now()` can currently be too small: take the
previous `when` + `100000000`. `src/lib/db/tests/migration-journal.test.ts`
(in `test:pure`) fails on a non-increasing `when`, a gap in `idx`, or a `.sql`
file without a journal entry.

You write by hand everything drizzle wouldn't generate anyway:

- `CREATE INDEX CONCURRENTLY` (you have to write it by hand)
- Partial indexes with predicates not in the schema
- `GENERATED ALWAYS AS` columns
- Extensions, functions, autovacuum knobs

Number the file after the latest migration (see the `0000_squash_baseline.sql`
baseline for the pattern). Each statement must be idempotent (`IF NOT EXISTS`,
`CREATE OR REPLACE`). A migration that needs a privilege or extension the target
may not have (e.g. `0124`) wraps it in a `DO $$ … EXCEPTION WHEN … $$` guard so it
can't fail a boot.

### 9.2 Applying migrations

```bash
pnpm db:migrate
```

In production (Coolify) the app container's entrypoint runs the bundled
migrator on every boot, before `init-secrets` and `server.js`. To run it by hand,
exec into the app container:

```bash
docker exec <app-container> node /app/db-runner/migrate.cjs
```

It connects via `MIGRATION_DATABASE_URL` when set (a DIRECT Postgres URL, never
the pooler), else `DATABASE_URL`.

### 9.3 Zero-downtime schema changes

The 3-deploy rule for any breaking column rename / drop:

1. **Deploy 1:** add the new column nullable, double-write from app code.
2. **Backfill:** script reads old column, writes new column for old rows.
3. **Deploy 2:** flip reads to the new column. Old column still present.
4. **Deploy 3:** drop the old column. Migration `0009_drop_*.sql`.

For index additions on huge tables:

```sql
CREATE INDEX CONCURRENTLY ...   -- never blocks writes, but slow
```

Note: `CREATE INDEX CONCURRENTLY` can't run inside a transaction. The
Drizzle migrator wraps every file in `BEGIN/COMMIT`; if you need concurrent
index creation, drop the breakpoints and run the file directly via `psql`.

### 9.4 Rollback

Every migration must be safely re-runnable AND have a documented inverse.
For the hand-rolled `0000_squash_baseline.sql` baseline, the inverse is straightforward `DROP INDEX
IF EXISTS ...` + `ALTER TABLE ... DROP COLUMN search_vector;`. We don't
auto-generate inverses because the irreversible ones (data backfill, type
change) need human review.

---

## 10. Backup & restore

### 10.1 Coolify scheduled dumps

Coolify Postgres exposes a daily `pg_dump` schedule in the Database tab:

- **Schedule:** `0 3 * * *` (3am UTC)
- **Retention:** 14 daily + 8 weekly + 12 monthly
- **Destination:** off-host (S3 / R2). _Backups on the same VPS aren't
  backups._

### 10.2 Manual full-cluster dump

```bash
docker exec tokyo-postgres \
  pg_dump -U tokyo -d tokyo -Fc --no-owner --no-privileges \
  > backups/tokyo-$(date +%Y%m%d-%H%M).dump
```

### 10.3 Restore drill

Once a month, restore the latest backup into a scratch container and run
a row-count assertion. _Untested backups are not backups._

```bash
docker run --rm -d --name scratch-pg -e POSTGRES_PASSWORD=x postgres:16-alpine
docker exec -i scratch-pg pg_restore -U postgres -d postgres < backups/latest.dump
docker exec scratch-pg psql -U postgres -c "SELECT count(*) FROM products;"
docker rm -f scratch-pg
```

---

## 11. Scaling roadmap

We have headroom at every stage. The order below is the order to take them:

### Stage 1 — Now (1M products, 50 RPS)
- ✅ Single Postgres; PgBouncer available as the opt-in `pooler` compose profile.
- ⚠️ One Next.js instance until the `'use cache'` store and its tag busts are
  shared across instances (§2). The pool math already allows 4.
- ✅ All indexes in place (the `0000_squash_baseline.sql` baseline + later migrations).
- ✅ Statement timeouts + role-level safety.

### Stage 2 — Read scaling (200+ RPS)
- Add a streaming-replica reader.
- Route `src/modules/**/queries.ts` to the reader via a second pool.
  ```ts
  export const readDb = drizzle({ client: readerPool, schema });
  ```
- Writes stay on the primary. Eventual consistency is acceptable for
  storefront reads because we already cache via `'use cache'` (once that cache
  is shared across instances, §2).

### Stage 3 — Audit log partitioning (5M+ rows)
- Convert `audit_log` to native range-partitioning by `created_at`
  (monthly buckets) using `pg_partman`. The BRIN index remains useful per
  partition; pruning makes time-range queries linear in the number of
  matching partitions, not in N.
- To be authored when this stage is reached: range-partition by `created_at`
  (monthly), attach the current table as the legacy partition, and recreate per
  partition the BRIN + the `(event_name|actor_user_id|severity, id DESC)` +
  `(created_at DESC, id DESC)` composites (see §4.5 / migration 0079). (The
  earlier `partition-audit-log.sql` draft was removed — it had drifted to a
  wrong column set + indexes dropped in 0079, so it was unsafe to run.)

### Stage 4 — Product partitioning (~5M products)
- Range-partition `products` by `created_at` only if benchmark shows a
  measurable benefit. At 1–2M rows it isn't worth the operational tax.
- More likely we shard at the catalog level (one catalog per locale / per
  market) before resorting to product-table partitioning.

### Stage 5 — Sharding / multi-region (eight-digit catalog)
- This is product-team territory, not database-team. Catalogs by region
  become independent databases with a thin metadata service in front. By
  then the architecture (modular, a short documented list of cross-module
  FKs — §1.2) makes this cheap-ish.

---

## 12. Benchmark results

Run with `pnpm db:bench:catalog 10000` (10k synthetic products + an
extracted EXPLAIN ANALYZE on each hot path). Last run:

```
─── EXPLAIN ANALYZE on hot paths ──────────────────────
  listing (latest published)          cost=10.3   exec=  0.09ms
  slug lookup                         cost= 8.3   exec=  0.04ms
  category listing (via join)         cost=20.9   exec=  0.23ms
  price filter (cat + range)          cost=65.0   exec=  0.23ms
  FTS search (tsvector @@)            cost=53.7   exec=  1.80ms
  fuzzy search (pg_trgm)              cost=1156.7 exec=  6.71ms
  in-stock filter                     cost=12.0   exec=  0.10ms
```

Projecting to 1M rows (B-tree depth log₂, GIN scales sub-linearly):

| Query                    | 10k      | 1M (projected) |
| ------------------------ | -------- | -------------- |
| listing                  | 0.09 ms  | ~0.6 ms        |
| slug lookup              | 0.04 ms  | ~0.05 ms       |
| category listing         | 0.23 ms  | ~1 ms          |
| price + cat filter       | 0.23 ms  | ~2 ms          |
| FTS                      | 1.8 ms   | ~12 ms         |
| fuzzy fallback           | 6.7 ms   | ~80 ms         |
| in-stock                 | 0.1 ms   | ~0.7 ms        |

P95 storefront page (1 listing + 1 navigation + 1 banner): comfortably
under the 100ms target even with no application-level cache.

To rerun: `pnpm db:bench:catalog 100000` (uses synthetic rows tagged
`bench-*` — top up safely on the dev DB).

---

## 13. Anti-patterns

Things we explicitly **don't** do and the reason why:

| Anti-pattern                                | Why we avoid it                                    |
| ------------------------------------------- | -------------------------------------------------- |
| Storing rich content as JSON                | Breaks FTS, RI, content control (see §1.1)         |
| New cross-module foreign keys (beyond §1.2) | Couples modules; blocks future service extraction  |
| Pool calls (`db.*`) inside `db.transaction` | Second connection while holding locks → pool deadlock (§5.2) |
| `SELECT *` in hot paths                     | Wastes pool I/O on unused columns                  |
| Application-level joins (N+1)               | Drizzle's `with: { ... }` is fine; ORM-level N+1 isn't |
| `LISTEN`/`NOTIFY`                           | Incompatible with PgBouncer transaction mode       |
| Session-level `SET` from app code           | Same — leaks across pooled connections             |
| Cursors held across HTTP requests           | Same                                               |
| Adding an index "just in case"              | Each index slows writes; only add when EXPLAIN proves the need |
| Hard deletes on content tables              | Loses audit trail and breaks denormalised caches   |
| Long-running transactions from web requests | Blocks the pool; move to background jobs          |

---

## Appendix A — Hot query catalogue

Every query that appears in production with frequency > 10/sec. If you add a
new hot path, document it here.

### A.1 Storefront listing

```sql
-- Trigger: every / page render
SELECT id, slug, name, price_cents, currency
FROM products
WHERE deleted_at IS NULL AND is_published = true
ORDER BY published_at DESC NULLS LAST
LIMIT 24 OFFSET $1;
```
**Index:** `products_published_recent_idx`. **Cache:** none — the home page is
`force-dynamic` (runs per request).

### A.2 Product detail by slug

```sql
SELECT * FROM products
WHERE slug = $1 AND deleted_at IS NULL;
```
**Index:** `products_slug_unique`. **Cache:** `'use cache'` (`cacheLife("hours")`)
in `getProductWithRowBySlug`, tags `product:slug:<slug>` + `product:<id>` +
`products:list` / `products` / `brands` / `categories`.

### A.3 Category page

```sql
SELECT p.* FROM products p
JOIN product_categories pc ON pc.product_id = p.id
WHERE pc.category_id = $1
  AND p.deleted_at IS NULL AND p.is_published = true
ORDER BY p.published_at DESC NULLS LAST LIMIT 24 OFFSET $2;
```
**Indexes used:** `pc_category_idx` then `products_published_recent_idx`.
**Cache:** the category row + tree are `'use cache'` (`getCategoryBySlug` /
`listCategories`, tags `categories` + `products:list`); the product listing
itself runs per request.

### A.4 Search (FTS + fuzzy union)

See [`src/modules/search/queries.ts`](../src/modules/search/queries.ts).
**Indexes:** `products_search_gin`, `products_name_trgm` (+ the HNSW
embedding index when semantic search is on).
**Cache:** `/api/store/search` answers anonymous callers with
`public, max-age=10, s-maxage=30, stale-while-revalidate=60` and signed-in ones
with `private, no-store`.

### A.5 Better Auth session lookup

```sql
SELECT * FROM sessions WHERE token = $1 AND expires_at > now();
```
**Index:** the lookup is served by the unique `sessions_token_unique` (expiry is
checked in app code, not the WHERE clause). Separate `sessions_user_idx` +
`sessions_expires_idx` exist; there is NO composite `sessions_user_expires_idx`.
Better Auth runs NO scheduled cleanup — it evicts an expired session only lazily
when its token is re-presented — so the daily `/api/cron/retention` job
hard-deletes expired `sessions` + `verifications`
(`authService.purgeExpiredSessions/Verifications`, riding
`sessions_expires_idx`/`verifications_expires_idx`).

### A.6 Audit insert (background)

```sql
INSERT INTO audit_log (id, event, actor_id, metadata, created_at)
VALUES (uuid_generate_v7(), $1, $2, $3, now());
```
No reads on the hot path — the BRIN index is for the admin's incident
timeline.

---

## Appendix B — Environment variables

Database-related env reference:

| Variable                      | Default        | Purpose                                          |
| ----------------------------- | -------------- | ------------------------------------------------ |
| `DATABASE_URL`                | _required_     | Postgres conn string. `?sslmode=require` only when the server actually serves TLS (not on the internal `postgres` / `tokyo-postgres-<id>` hostname unless Coolify SSL is enabled on that DB) |
| `MIGRATION_DATABASE_URL`      | _(unset ⇒ `DATABASE_URL`)_ | DIRECT URL for the boot migrator + `init-secrets` (session advisory lock / startup options don't survive a pooler); the Coolify compose pins it to `postgres:5432` |
| `DB_SSL_CA`                   | _(empty)_      | PEM literal or file path. `sslmode=require` + CA = verified TLS; without a CA = encrypted but NOT verified (warned); `verify-ca` / `verify-full` refuse to start without a readable CA (`src/lib/db/ssl.ts`) |
| `DB_POOL_MAX`                 | 12 (prod) / 5 (dev) | Per-process pool ceiling (dev cap is fixed at 5; the env override applies only in prod) |
| `DB_STATEMENT_TIMEOUT_MS`     | 10000          | Per-query timeout, server + client side (lengthen only via `withLongStatement`, §5.2) |
| `DB_IDLE_TIMEOUT_MS`          | 15000          | Idle pooled client eviction                       |
| `DB_CONNECTION_TIMEOUT_MS`    | 3000           | Acquire / connect timeout                         |
| `DB_KEEPALIVE`                | on             | TCP keepalive; `false` disables                   |
| `DB_APPLICATION_NAME`         | tokyostore-app | Tag in `pg_stat_activity` (the Coolify compose passes `tokyo-app`) |

PgBouncer (set on the pooler container, not the app — the opt-in `pooler`
profile of `docker-compose.coolify.yml`, image `edoburu/pgbouncer:v1.23.1-p3`):

| Variable                      | Recommended | Purpose                              |
| ----------------------------- | ----------- | ------------------------------------ |
| `POOL_MODE`                   | transaction | Multiplex server conns               |
| `MAX_CLIENT_CONN`             | 200         | App-facing limit                     |
| `DEFAULT_POOL_SIZE`           | 25          | Server-side conn count               |
| `RESERVE_POOL_SIZE`           | 5           | Burst handling                       |
| `IGNORE_STARTUP_PARAMETERS`   | extra_float_digits,application_name,statement_timeout,lock_timeout,idle_in_transaction_session_timeout,options | PgBouncer REJECTS a connection carrying any unlisted startup param, and the app sends `statement_timeout` plus `-c` keys inside `options` (§5.2) — a shorter list fails every app connection |

---

_Last reviewed 2026-10-09, covering migrations `0000`–`0207` (next
migration `0208`).
`0207_tighten_removed_value_checks` — SUBSYSTEM REMOVAL (finalises 0204). Purges any
`promotion_targets` rows with `target_type = 'business'` and narrows
`promotion_targets_type_chk` to `('customer', 'segment')`; purges any
`catalog_content_gen_jobs` rows with `entity_type = 'collection'` and narrows
`catalog_content_gen_jobs_entity_type_chk` to `('category', 'brand')`.
`0206_clean_removed_subsystem_grants` — SUBSYSTEM REMOVAL. DELETEs orphaned RBAC
grants for the removed modules from `role_permissions` + `user_permissions`:
`collections:%` / `loyalty:%` / `businesses:%` / `credit:%` (the registry no longer
defines those modules). The credit-note / avoir document stays gated by
`orders:manage`, NOT a `credit:*` key, so dropping every `credit:%` grant is safe.
`0205_drop_inert_promotion_columns` — SUBSYSTEM REMOVAL. Drops the two now-inert
`promotions` columns 0204 left behind: `business_id` (legacy B2B eligibility filter,
NULL since 0042) and `stack_with_member_discount` (there is no member discount now).
`0204_remove_subsystems` — SUBSYSTEM REMOVAL (the big forward DROP; IF EXISTS /
CASCADE, idempotent). Removes SIX subsystems entirely: merchandising **Collections**
(`collections` + `product_collections` + `faqs.collection_id`), **Drip & Exclusivité**
/ early-access / tier-release (`product_tier_release`, `products.drip_start_at` /
`early_access_enabled`), stored-value **gift cards** (`gift_cards`,
`products.is_gift_card`, `orders.gift_recipient_email` / `_name` / `gift_message`),
the whole **Fidélité/loyalty** programme (`loyalty_levels` / `loyalty_referrals` /
`loyalty_life_stage_claims`; `customer_profiles.loyalty_level_id` /
`cumulative_spend_cents` / `paid_order_count` / `credit_balance_cents` /
`loyalty_mode` + the self-action provenance markers; `orders.loyalty_accrued_at` /
`loyalty_spend_cents`), the whole **Entreprises/B2B** programme (`businesses` /
`business_members` / `business_levels` / `business_level_allocations` /
`business_applications` / `business_join_requests`; `orders.is_business` /
`business_tax_id` / `business_tax_cents` / `member_discount_is_business`), and
**Store credit** (`customer_credit_entries`, `customer_profiles.credit_balance_cents`,
`orders.credit_applied_cents`). Also DELETEs the features' `site_settings` rows
(`loyalty.*` / `credit.*` / `cercle.*` / `tax.business.*` / `business.*` /
`auth.business.*` / `pages.fidelite.*` / `pages.collections.*` / `drip.*` /
`giftcard.*`) and rebuilds the `faqs_scope_target_chk` CHECK without `collection_id`.
KEPT (different features, explicitly spared): the shop's own `business.legal_name` /
`business.tax_id` invoice-issuer identity, the credit-note / avoir document columns
(`credit_note_*`), the showcase collection PAGES, and the retail third-party
gift/recharge card PRODUCTS.
`0148_order_gift_recipient` — CARTES CADEAUX (Phase C.5, gifting). Adds
`orders.gift_recipient_email` / `gift_recipient_name` / `gift_message` (all
nullable, no index): ONE recipient per order for the gift card(s) it mints —
the code email is addressed to them; NULL email = the buyer keeps the card(s).
Inert on a non-gift order. Additive columns only.
`0147_gift_cards` — CARTES CADEAUX (Phase C.1, digital-first). Adds
`products.is_gift_card` (bool, partial index `products_gift_card_idx`) + the
`gift_cards` bearer-card ledger: `code_hash` (UNIQUE — the only thing that
redeems, a keyed HMAC), `code_last4` (support search, NON-unique by design),
staff `reference` (UNIQUE), `denomination_cents` (frozen), `status`
active|redeemed|void (CHECK; no `printed`), `origin` digital|physical (CHECK;
v1 always digital), `denomination_cents > 0` CHECK, gifting cols
(recipient_*/gift_message/sent_at), void/reissue cols, `expires_at` (NULL =
never). FKs: `order_id`→orders SET NULL, `redeemed_by_profile_id`→
customer_profiles SET NULL; product/variant/order_item/replaced_by are soft
links. `gift_cards_line_seq_uniq` (order_item_id, line_seq) = the double-mint
backstop. Ported from GZ 0210/0211/0213/0232 as the digital subset — the
physical pool (batches/`printed`/pool idx) + scheduled-send (code_enc) + GZ's
0310 exclusivity CHECK are DROPPED (0310 references products.is_digital /
requires_serial, which Tokyo never had).
`0146_cercle_state_index` — supporting index for the admin « Cercle de Famille »
monitor: composite `loyalty_referrals_state_accepted_idx` on `(consent_state,
accepted_at DESC)`. Serves the state-filtered `accepted_at`-sorted binding list AND
the state grouping/filter of the two monitor aggregates (`countsByState`,
`acceptedCountsByReferrer`), which previously seq-scanned. Low-volume table,
write-cheap. Index-only, no rewrite.
`0145_life_stage_one_pending` — « Événements de vie » anti-double-submit: partial
UNIQUE `loyalty_life_stage_pending_uq` on `loyalty_life_stage_claims (user_id)`
WHERE `status='pending'`, so a member has at most ONE open declaration at a time
(verified/rejected rows are unconstrained and accumulate). The DB backstop behind
`submitLifeStageAction`'s read-then-insert pre-check (which catches the 23505 and
surfaces the same "already pending" refusal). Index-only, no rewrite.
`0144_cercle_invitee_uniqueness` — « Cercle de Famille » referral anti-farming: two
partial UNIQUE indexes on `loyalty_referrals` — `loyalty_referrals_invitee_uq`
(`referred_user_id` WHERE NOT NULL: one ACCEPTED referrer per invitee, ever) and
`loyalty_referrals_pending_email_uq` (`referrer_user_id, referred_email` WHERE
`consent_state='invited'`: one pending invite per (referrer, email)). Complements
the 0140 self-referral CHECK + per-pair edge unique. Index-only, no rewrite.
`0143_loyalty_level_description` — optional operator-authored `description` (text,
nullable) on `loyalty_levels`: the public "reach"/accroche shown on the /fidelite
niveau cards + /account « Tous les niveaux » tiles, overriding the generated
default (`lib/loyalty/level-benefits` reachSentence). Metadata-only ADD COLUMN.
`0142_credit_entries_erp_feed_idx` — global ERP-feed keyset index
`credit_entries_created_id_idx` on `customer_credit_entries (created_at, id)` (ASC),
matching `creditService.listForApi`'s unscoped sort (the 0141 per-wallet index only
covered the scoped read); same shape as the 0120 order/webhook ERP feeds.
`0141_customer_credit_wallet` — store-credit **wallet** ("Crédit"), replacing the
never-wired `loyalty_bons` (DROP … CASCADE — no grant/consume path, no rows worth
keeping). ADD `customer_profiles.credit_balance_cents` (int, DEFAULT 0, `>= 0`
CHECK). NEW append-only `customer_credit_entries` ledger (`amount_cents <> 0` CHECK;
`balance_after_cents` snapshot; FKs `customer_profile_id` → customer_profiles CASCADE,
`order_id` → orders SET NULL; partial-unique guards: one `spend` + one `spend_reverse`
per order, one `newsletter_subscribe` + one `complete_profile` per wallet, one per
`(wallet, source_ref)`). ADD `orders.credit_applied_cents` (int, DEFAULT 0, CHECKs
`>= 0` and `<= total_cents` NOT VALID) — credit SETTLES the order, never discounts it.
DELETE the dropped `loyalty.bon.*` settings.
`0140_loyalty_cercle_famille` — loyalty rebuilt to TIERS-ONLY "Le Cercle de
Famille" (spendable points/coins removed). RENAMEs `coin_levels` → `loyalty_levels`
(`threshold_coins` → `threshold_spend_cents`; ADD `min_purchases` + `first_purchase_discount_pct`;
DROP `earn_multiplier_bps` / `max_redeem_pct` / `free_shipping_threshold_cents`),
DROPs `coin_transactions` (the spendable-points ledger). `customer_profiles`:
DROP `loyalty_points`, RENAME `lifetime_coins_earned` → `cumulative_spend_cents`,
ADD `paid_order_count` + `loyalty_level_id` (FK → loyalty_levels SET NULL). `orders`:
DROP `coins_points_spent` / `coins_discount_cents`, ADD `loyalty_accrued_at`
(at-most-once accrual stamp) + `loyalty_spend_cents`. NEW `loyalty_bons`
(engagement-voucher ledger — **superseded by the store-credit wallet and DROPPED in
`0141`**), `loyalty_referrals` (family/friends invite graph),
`loyalty_life_stage_claims` (staff-verified life events). Data migration: `coins.enabled`
→ `loyalty.enabled` + group relabel, drop the spendable-points settings, RBAC
`coins:` → `loyalty:`, reset `min_lifetime_coins:` dynamic segment rules, and
backfill cumulative spend + order count + level from paid orders (stamping them
so accrual never re-counts).
`0139_collection_parity` — collections.external_ref (stable ERP/PIM code for
sync-by-reference, partial-unique among live rows `collections_external_ref_unique`,
mirrors brands/categories) + DROP the non-selective standalone
`collections_display_order_idx` (collections are flat — every reader orders the
whole set, so a pure sort index is not selective; mirrors brands 0138). NO
is_discountable on collections (M:N OR-semantics footgun — owner call).
`0138_brand_parity` — brands.display_order (backfilled from the alphabetical order)
+ brands.is_discountable (the brand tier of the discount opt-out) + the
brands_tax_rate_bps_range CHECK (brands was the only tax tier without it). Brands
are flat, so no ordering index at brand-table scale.
`0137_category_parent_display_order_idx` — adds a composite
`categories (parent_id, display_order)` index (serves listChildren's filter+sort,
reorderSiblings' locked SELECT, and the subtree CTE's parent_id join in index
order) and DROPs the non-selective standalone `categories_display_order_idx` plus
the now-redundant parent-only `categories_parent_idx` (the composite's prefix
covers it).
`0136_review_listing_index` — replaces the `product_reviews (product_id, status)`
index with a covering `(product_id, status, created_at DESC)` so the PDP approved-
review listing is index-ordered (no sort).
`0135_status_kind_checks` — CHECKs `webhook_deliveries.status`,
`document_sequences.kind`, `pickup_locations.kind`; drops the dead
`two_factors_secret_idx` (index on the AES-encrypted TOTP secret).
`0134_index_and_check_hygiene` — `categories.boutique_image_media_id` reverse-
lookup partial index, `stock_transfers_order_idx` made partial, drops redundant
`cul_user_idx`/`cul_profile_idx`, adds CHECKs to the stable ai_job_logs/
ai_call_logs/search_aliases/currencies enum columns.
`0133_redemption_shipping_waived` — adds `promotion_redemptions.shipping_waived_cents`
(the free-shipping cost of a redemption; nets to 0 on reversal).
`0132_credit_note_amount` — adds `orders.credit_note_amount_cents` (the refund
total SNAPSHOT taken when the avoir number is drawn, so a later refund can't
change an issued credit note).
`0131_category_boutique_image` — adds `categories.boutique_image_media_id` (a
separate `/boutique` chooser image, distinct from the category-page hero).
`0130_media_white_bg_main_only` — adds the `media_settings.product_white_bg_main_only`
boolean (opt-in: détoure only a product's MAIN image, at save, instead of every
product upload). NOT NULL DEFAULT false backfills the singleton in place;
`0129_drop_stock_manage_permission` — deletes any `role_permissions` row for the
reserved-but-unwired `stock:manage` key (transfers gate on `stock:update`); same
rationale + shape as `0123`, idempotent;
`0128_transfer_index_hygiene` — adds `stock_transfers_created_at_id_idx`
(`(created_at, id) WHERE deleted_at IS NULL`, the default Transferts-tab keyset),
drops the dead `stock_transfer_items_product_idx`, and promotes
`stock_transfers_ref_idx` to UNIQUE (the `TR-<ref>` display sequence);
`0127_stock_transfers` — the inter-location transfers subsystem:
`stock_transfers` (lifecycle requested→accepted→in_transit→completed/cancelled,
soft `from`/`to`/`order` links, `ref` from `stock_transfer_ref_seq`) +
`stock_transfer_items` (lines, FK CASCADE, `qty > 0` CHECK). Stock moves only on
completion (per `stockLocationService.moveStockTx`); the product/variant
`stock_qty` TOTAL is invariant across a transfer;
`0126_fix_low_stock_index_and_prune` — repairs the `products_low_stock_idx`
predicate (0122) to match the actual low-stock query + prunes redundant
leading-column indexes;
`0125_drop_redundant_indexes` — drops `promotion_redemptions_promo_idx` (prefix
of `promotion_redemptions_user_idx` / `_promo_created_idx`) and
`business_members_business_idx` (prefix of the UNIQUE
`business_members_business_user_unique`), pure write cost with no read benefit
(§4.7); plus an idempotent backfill releasing legacy product tombstones, mirroring
`deleteProductWorkflow` (§3.14): live variants of soft-deleted products get
`sku` / `gtin` NULL, `is_default` false, stock 0 / out of stock and the product's
`deleted_at`; their `stock_levels` and attribute assignments are deleted. No
ledger rows (the product is no longer sellable); order history untouched.
Covered by the `migration-0125-backfill.test.ts` DB test;
`0124_pg_stat_statements` — `CREATE EXTENSION IF NOT EXISTS pg_stat_statements`,
only when `shared_preload_libraries` includes it; insufficient privilege / a
missing contrib module is a NOTICE, never a failed deploy (§7.1);
`0123_purge_stale_permission_keys` — deletes `role_permissions` rows whose key
no longer exists in the code registry (the whole `preorders:*` module plus
`cart:manage`, `invites:manage`, `system_database:manage`, `users:update`,
`users:delete`, `customers:create`, `system_mail:delete`, `system_tax:create`,
`system_tax:delete`, `showcase:create`, `showcase:delete`, `warranty:update`).
A stale key granted nothing, but the strict role editor rejected every save of a
role holding one and the escalation guards counted it; idempotent;
`0122_products_low_stock_index` — a partial btree on `products(stock_qty)` over
the tracked-stock published subset, serving the admin low-stock dashboard's
`WHERE stock_qty IS NOT NULL AND stock_qty <= N ORDER BY stock_qty ASC` filter +
sort (index range scan + heap fetch for the ≤20 survivors), tiny because it
excludes the untracked/unpublished majority;
`0121_drop_serials` — removed the serial-number subsystem: `DROP TABLE
order_item_serials` + `ALTER TABLE products DROP COLUMN requires_serial`;
`0120_erp_feed_sort_indexes` — composite `(created_at, id)` btrees on
`stock_movements` and `coin_transactions` so the keyset-paginated ERP movement
feeds (`/api/stock/movements`, `/api/loyalty/movements`) get an index-ordered,
early-terminating `LIMIT` walk on the empty-`WHERE` first page and the
incremental pages, instead of a full seq-scan + top-N sort of the append-only
ledgers;
`0119_webhook_deliveries_retention_brin` — a BRIN index on
`webhook_deliveries(created_at)` so the daily retention purge prunes the durable
outbound-webhook queue by an index range scan instead of a seq scan;
`0118_erp_customer_ref_and_outbound_webhooks` — the two-way ERP link
(`customer_profiles.external_ref` + partial-unique + `updated_at` index) and the
OUTBOUND-webhook subsystem tables (`webhook_endpoints` with an encrypted signing
secret + `webhook_deliveries`, a durable retrying delivery queue);
`0117_role_connection_timeouts` — `ALTER ROLE … SET` server-side
`lock_timeout` + `idle_in_transaction_session_timeout` defaults so they survive
PgBouncer transaction mode (which drops the client's libpq startup options);
`0116_promotion_redemptions_free_shipping` — a `free_shipping` marker on
`promotion_redemptions` so a free-shipping-only coupon (discount_cents = 0) still
counts against its per-user / max-uses caps instead of going unbounded;
`0115_products_embedding_backfill_idx` — partial btree on
`products(updated_at DESC) WHERE embedding IS NULL AND deleted_at IS NULL AND
is_published` so the semantic-backfill candidate scan is an index range scan, not
a full seq scan (self-shrinking — empties as products get embedded);
`0114_search_aliases` — runtime-editable synonym/alias rules (`search_aliases`:
term→expansion query expansion; unique(term,expansion) + partial active index).
Additive, no extension prerequisite;
`0113_embedding_index_predicate` — folds `deleted_at IS NULL AND is_published`
into the HNSW partial predicate so the KNN pre-filters inside the graph (recall);
`0112_product_embedding` — semantic search: `CREATE EXTENSION vector` +
`products.embedding vector(1536)` + `embedding_input_hash` + a partial HNSW cosine
index. NULLABLE column = zero behaviour change until backfilled. REQUIRES the
pgvector Postgres image (`docker/pgvector/Dockerfile`); the Coolify DB must run an
equivalent pg16+pgvector build BEFORE this deploys or `CREATE EXTENSION` fails;
`0111_ai_call_logs` — additive: the `ai_call_logs` transport-log table (provider
calls incl. embeddings), best-effort, 14-day retention;
`0110_catalog_icon_media_id_idx` — additive: partial (NON-NULL) reverse-lookup
indexes on `brands`/`categories`/`collections`.`icon_media_id` so the média
orphan check + reference count (which now OR that chip-icon soft-link) stay
index-only (parity with the image/hero/og_image soft-link indexes);
`0109_orders_new_grant` — back-fills the `orders_new:*` grants onto existing
`orders:manage` roles (dedicated « Nouvelle commande » tab split off caisse);
`0108_collections_image_media_id_idx` — additive: the one média soft-link
reverse-lookup index the convention had skipped (`collections.image_media_id`,
partial NON-NULL);
`0107_scale_indexes` — scale-readiness, additive: `products_created_id_desc_idx`
`(created_at DESC, id DESC) WHERE deleted_at IS NULL` (admin product/stock lists
sort by that pair — the baseline only had a single-column ASC index); trigram GIN
`products_sku_trgm` on `products.sku` (admin search ILIKEd sku with no trigram →
seq scan; name already had `products_name_trgm`); trigram GIN `collections_name_trgm`
on `collections.name` (parity with `brands_name_trgm` / `categories_name_trgm`);
`0106_catalog_content_gen` — `catalog_content_gen_jobs` + `_drafts` (bulk AI
content generation for categories/brands/collections, one model keyed by
`entity_type` with a per-type one-active partial-unique index);
`0105_catalog_chip_icons` — `icon` + `icon_media_id` on categories/brands/collections
(editable storefront listing chip icons);
`0104_collections_editorial_faq` — collections editorial block + `value_props` +
`faqs.collection_id` (parity with categories/brands);
`0103_stock_locations` — opt-in multi-location inventory (`stock_locations` /
`stock_levels`, `inventory.location_mode`); totals stay authoritative;
`0102_drop_product_highlights` — DROP TABLE `product_highlights` + DROP COLUMN
`products.highlights_title`; removes the product "Caractéristiques clés"
(highlights bullet list) feature store-wide (backend, admin form, storefront,
and the `highlights` AI task + bulk-gen field). Irreversible; non-breaking (no
code path read/wrote them by then);
`0101_orders_confirmed_at` — `orders.confirmed_at` flag + confirm action
(online orders auto-confirm);
`0100_import_jobs_reprocess_operation` — import-jobs reprocess operation;
`0097_drop_announcements` — DROP TABLE announcements + prunes leftover
`announcements:%` role_permissions rows (the "Bandeau d'annonce" feature,
redundant with the `header_strip` banner placement);
`0087_drop_redundant_products_published_idx` — drops the redundant non-partial
`products_published_idx` (superseded by the partial `products_published_recent_idx`).
`0086_media_product_white_bg` — `media_settings.product_white_bg` toggle for
auto white-background removal (détourage) on product-scope uploads;
`0085_nav_featured_banner_placements` — featured-banner placements for the
navigation menu;
`0084_returns_fk_validate_and_drop_dead_product_indexes` — VALIDATE the
deferred returns FKs + drop dead product indexes;
`0083_promotion_cart_band_check` — DB CHECK `max_cart_cents >= min_cart_cents`
(closes the coupon spend-band cross-field gap left by `0081`);
`0082_product_purchase_limits` — `products.{min,max}_purchase_qty` per-order
limits (CHECK each `>= 1`, `max >= min`);
`0081_promotion_coupon_controls` — `promotions.exclude_discounted_items`
+ `max_cart_cents` (CHECK `> 0`);
`0067_order_search_trgm` — GIN trigram indexes on `orders.order_number` /
`contact_email` / `contact_phone` so the admin order search (substring ILIKE)
is index-backed instead of a seq scan (mirrors the customer `0037` fix);
`0066_perf_partial_indexes` — `orders_guest_groupby_idx` (guest GROUP BY) +
`customer_profiles_live_created_idx` (dashboard COUNTs);
`0065_product_gen_draft_fk` — drafts.job_id FK CASCADE;
`0064_product_generation` — bulk product-content gen tables (§3.2);
`0063_review_created_index` — review moderation sort index;
`0062_banner_targeting_cadence` — in-grid (`category_grid`) promo banner
targeting + cadence: `banners.target_kind` (CHECK `banners_target_kind_chk`
in `none|category|brand|filter`, default `none`) + `target_ref` (category/brand
slug or filter attribute-value id) + `after_load_more_count` (default 2);
index `banners_target_idx (target_kind, target_ref)`;
`0061_seed_system_pages` — seed help + 5 legal pages as protected `is_system`
CMS pages (idempotent, unpublished; deletion + slug-change refused);
`0060_content_design_foundation` — Contenu & Design (pages.is_system,
trust_badges, announcements — see §3.2);
(`0057_wishlist_public_profiles` — public shareable favorites (opt-in, off by
default): `wishlists.is_public` / `public_slug` (case-insensitive functional
partial-unique on `lower(public_slug)`) / `public_display_name`; gated by the
`social.favorites_public_enabled` site-setting; public page `/u/<slug>`;
`0056_order_line_edits_and_shipments` — partial-shipment bons de livraison:
`shipments` (one order → many BLs, each a gapless `delivery_note` number,
partial-unique) + `shipment_items` (per-line subset qty, unique (shipment,line),
qty>0 CHECK; FKs CASCADE to orders/shipments/order_items). Shipped-qty per line
is DERIVED via `SUM(shipment_items.quantity)` — no denormalized counter. Backs
operator line-editing (`editOrderItemsWorkflow` reconciles stock/tax/totals on
add/remove/qty-change; refused once the refund ledger covers the total, and a
partial refund keeps the new total above the refunded sum; a multi-op edit is
atomic) + the cancel-blocked-when-shipped guard;
`0055_order_external_ref` — `orders.external_ref` (nullable, partial-unique) for
two-way ERP linking over the keyed order API + `orders_updated_at_idx` for the
`?since=` incremental-sync watermark;
`0054_cart_events` — add-to-cart analytics log (`cart_events`: product, qty,
`actor_kind` client|visitor, `source` cart|quick_add, `occurred_at`); indexes on
`occurred_at` and `(product_id, occurred_at)`; retention-purged (180 d);
`0053_offline_payment_methods` — `cash` + `bank_transfer` added to the
`payment_method` enum (both UPFRONT-paid) for operator-created orders;
`0052_fiscal_documents` — gapless `document_sequences` counter (kind, period,
current_value bigint; unique (kind,period)) + `orders.invoice_number /
credit_note_number / delivery_note_number` (+ `*_at`), each partial-unique;
`0051_order_item_picked` — `order_items.picked_at` (operator pick/pack stamp,
advisory);
`0050_returns_taxonomy` — `order_returns.reason_code` + `comment`,
`order_return_items.condition_note`, + `order_returns_created_idx` /
`order_returns_reason_idx` for the Retours dashboard;
`0049_brand_tax_rate` — `brands.tax_rate_bps` (nullable): the BRAND tier of the
TVA cascade, between filter and category (product → filter → brand → category →
global); resolved set-wise via `brandTaxBpsForProducts`;
`0048_delivery_zones` — optional region pricing: `delivery_zones` (named
gouvernorat groups) + `delivery_agent_zone_rates` (per-courier × zone fee, unique
(agent,zone), FK CASCADE); consulted by `resolveDelivery` only when
`delivery.zone_pricing_enabled` is on, else couriers keep their flat fee;
`0047_mailing_cleanup_indexes` — rescan-driven, idempotent: trigram GIN on
`lower(email_logs.to_email)` (replaces the unusable btree), `lower(users.email)`
index for the consent join, two partial `customer_profiles` indexes (opt-in blast
scans + the birthday cron's `extract(month/day)`), `mailing_sends(created_at)` for
the retention sweep, a `lower(email)` UNIQUE on `email_suppressions` (replaces the
case-sensitive one), and drops three dead columns — `email_campaigns.sent_count`/
`failed_count` (progress is derived from `email_logs`) and
`mailing_sends.customer_profile_id` (write-only);
`0046_mailing_indexes` — audit follow-up, idempotent: VALIDATEs the
`email_logs.campaign_id → email_campaigns` FK that 0045 added NOT VALID, and adds
`orders (status, updated_at)` so the daily review-request cron's delivered-window
scan is index-served instead of a full table scan;
`0045_mailing_system` — the comprehensive mailing upgrade: `email_logs` (send
audit log AND durable queue: status pending/queued/sent/failed + backoff +
redaction-ready body/variables + pin/soft-delete), `email_flows` (per-automation
enable override), `email_campaigns` (admin bulk blasts), `mailing_sends`
(per-(flow,dedup_key) idempotency ledger), `email_suppressions` (hard bounces);
all idempotent;
`0044_customer_birthday` — optional nullable `customer_profiles.birthday` date
column (no index); powers the `birthday_month` dynamic-segment rule for
birthday-month promotion targeting; editable from the storefront account page +
the admin customer detail page;
`0043_validate_0042_and_cleanup` — VALIDATEs 0042's three NOT-VALID constraints +
drops the redundant `coin_tx_order_idx` + the dead always-NULL `business_levels.slug`
column/index;
`0042_promotions_targeting_and_params` — `promotion_targets` (multi
customer/segment/business targeting; backfills the legacy `promotions.business_id`),
`customer_segments` + `customer_segment_members`, `customer_profiles.promo_opt_out`,
`businesses.exclude_public_promos`, `promotions.{stack_with_member_discount,
max_discount_cents,grants_free_shipping}` + a relaxed discount CHECK for
free-shipping-only promos; `0041_validate_loyalty_fks_and_redemption_index` —
VALIDATEs the four constraints 0040 added NOT VALID + a `promotion_redemptions
(promotion_id, created_at DESC)` index). Notable since 0031: `0032`
customer phone normalization, `0033`/`0034` RBAC roles + `super_admin` backfill,
`0036` business (B2B) accounts + `promotions.business_id`, `0037` customer-search
trigram indexes, `0038` deferred column drops + redundant orders-index cleanup,
`0039` order_returns / order_return_items foreign keys + drop dead
`import_jobs.kind`, `0040` loyalty dual-mode + B2B employee levels:
`coin_levels.stack_product_promos`/`stack_code_promos` + `customer_profiles.loyalty_mode`,
new `business_levels` (separate employee ladder: discount_pct, seat_cap, stacking
flags) + `business_level_allocations` (per-business quota + invite_token, FKs
`NOT VALID`) + `business_members.level_id`. See [media.md](media.md) for the
runtime knobs._
_Bump this footer whenever a new migration changes the index or schema layout._

---

Built by **[Kawn Digital Studio](https://kawn.me)** for Tokyo Store. See [CREDITS.md](CREDITS.md).
