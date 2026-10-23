/**
 * Drizzle schema entry point.
 *
 * Re-exports every module's tables so `drizzle-kit` sees the whole graph
 * for migrations, and so `db` is typed against the union of all schemas.
 *
 * Adding a new module:
 *   1. Define tables in `src/modules/<name>/schema.ts`
 *   2. Add a re-export line here (for type inference + an accurate schema graph)
 *   3. Hand-author `src/lib/db/migrations/NNNN_name.sql` + a matching
 *      `meta/_journal.json` entry, then `pnpm db:migrate`.
 *
 * NOTE: `db:generate` is intentionally DISABLED (see scripts/guard-generate.ts):
 * the drizzle meta snapshots are frozen at 0007, so a generate would diff against
 * the stale snapshot and emit a destructive migration. Migrations are written by
 * hand — never run `db:generate` / `db:generate:force`. See docs/database.md.
 */

// --- Identity & people
export * from "@/modules/auth/schema";
export * from "@/modules/customer/schema";
// RBAC: roles + permission grants + user↔role assignments (permission KEYS
// live in code at src/lib/rbac/registry.ts, not in a DB table).
export * from "@/modules/rbac/schema";

// --- Catalog
export * from "@/modules/catalog/brand/schema";
export * from "@/modules/catalog/category/schema";
export * from "@/modules/catalog/product/schema";
export * from "@/modules/catalog/attribute/schema";
export * from "@/modules/catalog/review/schema";
export * from "@/modules/catalog/care/schema";

// --- CMS
export * from "@/modules/cms/setting/schema";
export * from "@/modules/cms/faq/schema";
export * from "@/modules/cms/banner/schema";
export * from "@/modules/cms/navigation/schema";
export * from "@/modules/cms/page/schema";
export * from "@/modules/cms/trust_badge/schema";

// --- Commerce
export * from "@/modules/cart/schema";
export * from "@/modules/order/schema";
export * from "@/modules/order/returns.schema";
export * from "@/modules/warranty-claim/schema";
export * from "@/modules/webhook/schema";
// --- Outbound webhooks (ERP push) — endpoints + the durable delivery queue
export * from "@/modules/webhook-endpoints/schema";

// --- Fiscal/logistics document numbering (factures, avoirs, bons de livraison)
export * from "@/modules/document/schema";

// --- Add-to-cart event log (most-added-to-cart analytics, client vs visitor)
export * from "@/modules/cart-event/schema";

// --- Tax engine (per-attribute-value tax rules; global/category/product cascade)
export * from "@/modules/tax/schema";

// --- Delivery (home-delivery agents + drive-by / in-store pickup locations)
export * from "@/modules/delivery/schema";

// --- Mailing (transactional email template overrides)
export * from "@/modules/mailing/schema";

// --- Editorial
export * from "@/modules/blog/schema";
export * from "@/modules/authors/schema";

// --- Media & audit
export * from "@/modules/media/schema";
export * from "@/modules/media/settings.schema";
export * from "@/modules/audit/schema";

// --- Newsletter
export * from "@/modules/newsletter/schema";

// --- Promotions (per-product / per-category / per-brand / coupon / URL)
export * from "@/modules/promotion/schema";

// --- Payment (admin-configurable provider credentials; env force-overrides)
export * from "@/modules/payment/schema";

// --- OAuth / social login (admin-configurable Google/Facebook credentials,
// encrypted at rest; env force-overrides — see src/lib/auth/social-config.ts)
export * from "@/modules/oauth/schema";

// --- AI & Automation (admin-configurable provider API keys, encrypted at rest;
// env force-overrides — see src/lib/ai/config.ts)
export * from "@/modules/ai/schema";

// --- API access keys (external HTTP API auth; SHA-256 hashed, scoped)
export * from "@/modules/api-key/schema";

// --- Stock movement ledger (append-only; every stock change, for reconciliation)
export * from "@/modules/stock-movement/schema";

// --- Stock locations + per-location levels (multi-location inventory, opt-in)
export * from "@/modules/stock-location/schema";

// --- Stock transfers (inter-location moves: stores ↔ central depot)
export * from "@/modules/stock-transfer/schema";

// --- Stock reservations (open holds; backs the précommande/preorder flow)
export * from "@/modules/stock-reservation/schema";

// --- Showcase (manual product pins for the controllable collection pages)
export * from "@/modules/showcase/schema";

// --- Wishlist / favorites (guest token or user_id)
export * from "@/modules/wishlist/schema";

// --- Search (FTS + telemetry; search_vector columns live on indexed tables,
// only search_log is owned by this module).
export * from "@/modules/search/schema";

// --- Import (background catalog-import jobs: XML/CSV feeds → products)
export * from "@/modules/import/schema";

// --- Scheduled/cron job execution history (admin "Tâches planifiées" dashboard)
export * from "@/modules/jobs/schema";

// --- Admin-managed URL redirects (Système → Redirections & 404)
export * from "@/modules/redirects/schema";

// --- Currency registry (Commandes → Devises) — global active currency
export * from "@/modules/currency/schema";

// --- App instance heartbeats (Infrastructure → Performance uptime/downtime)
export * from "@/modules/instance/schema";


// --- Associations (cross-module joins)
export * from "@/associations/customer-user";
export * from "@/associations/product-category";
export * from "@/associations/product-brand";
export * from "@/associations/product-media";
export * from "@/associations/product-related";
export * from "@/associations/product-complementary";
export * from "@/associations/product-care";
