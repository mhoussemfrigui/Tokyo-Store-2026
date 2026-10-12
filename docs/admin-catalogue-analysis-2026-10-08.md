# Tokyo‑Store — Admin **Catalogue** Group: Deep Analysis

> **Date:** 2026‑10‑08 · **Branch:** `main` · **Session focus:** the admin **Catalogue** sidebar group.
> **Covers:** Produits · Stock · Collections · Catégories · Marques · Drip & Exclusivité · Cartes cadeaux · Attributs · Avis · Médiathèque.
> **How it was produced:** an 11‑agent parallel full‑stack sweep (one deep reader per subsection, ~1.9M tokens, code‑cited and verified), synthesized here. Companion to [docs/az-analysis-2026-10-08.md](az-analysis-2026-10-08.md).
> **Why it exists:** you are editing and removing parts of this group, front and back, on `main`. Every subsection is traced end to end — **admin UX → components → data model → read path → write path (action → workflow → service → events) → RBAC → storefront linkage → edit/remove → risks**.

---

## How to use this document

- **§A–§E** are the synthesis — read first. The centrepiece is **§B's "does this reach the live store?" table**, which is the direct answer to "what actually happens when I edit something here."
- **§1–§11** are the per‑subsection deep dives, each with a collapsible quick‑index.
- **Appendices A–D** consolidate every source of truth, edit/remove note, risk, and the Catalogue‑specific conventions + RBAC map.

---

## §A. Executive summary

The **Catalogue** group is where the store's merchandise, taxonomy, inventory, media and social proof are managed. Ten sidebar items (`admin-shell.tsx:117‑142`) sit on top of the **`catalog` module family** (`src/modules/catalog/{product,category,brand,collection,attribute,review,product-gen,content-gen}`) plus **`gift-card`**, the three **`stock-*`** modules, and **`media`**.

**The central entity is the product.** One shared client form (`src/components/admin/product-form.tsx`, ~3,800 lines) drives both create (wizard) and edit (tabbed), writing every field in one `FormData`. All other Catalogue subsections are either **inputs to a product** (category, brand, collection, attributes, media, drip ladder, gift‑card flag) or **outputs/derivatives** of it (stock ledger, reviews, generated content).

**Every write follows the same seam:** a thin Server Action in `src/lib/actions/*` (`requirePermission` + parse `FormData` + `revalidate`) → a **workflow** in `src/workflows/catalog/*` (the real logic, in `db.transaction()`, emitting events) → module **services** (data access only). Reads come from module `queries.ts` / `src/lib/api/*`. Money is **millimes** (`*_cents` columns), ids are **uuid v7**, deletes are **soft**.

**RBAC permission ids for this group** (`rbac/registry.ts`): `products`, `stock`, `collections`, `categories`, `brands`, `attributes`, `reviews`, `media` — plus **`system_media`** for media pipeline settings and **`system_ai`** for the AI tooling. **Two items reuse `products`:** Drip & Exclusivité and Cartes cadeaux. Removing/renaming the `products` id silently changes their visibility too.

**The one thing to internalize before editing anything here:** the live customer storefront (**Tokyo**) does **not** read this admin's database at request time. It renders a **frozen JSON snapshot** (`src/storefront/data/*.json`) regenerated only by manually running `scripts/tokyo-export-catalog.ts`. So a large share of Catalogue admin work is **invisible or non‑functional on the live store** until re‑exported — and several subsections have **no Tokyo surface at all**. §B quantifies this per subsection; it is the heart of this analysis.

---

## §B. The Catalogue at a glance — *does editing it reach the live store?*

| # | Sidebar item | Route | Perm id | Core module(s) | Write path | **Reaches live Tokyo store?** |
|---|---|---|---|---|---|---|
| 1 | **Produits** | `/admin/catalog/products` | `products` | `catalog/product` | `catalog.ts` → `create/duplicate/upsert‑variants` workflows | **Partial, only after manual re‑export.** Name, slug, first image, display price, availability, condition, brand, category reach Tokyo. **Dropped:** description, variants, SEO, video, old/compare‑at price, reviews. |
| 2 | **Produits — AI suite** | (sub‑tab + form buttons) | `system_ai` (+`products` to apply) | `product-gen`, `content-gen`, `ai-assign` | detached **job rows** → `applyProductDrafts`/`applyContentDrafts`/`runAutoAssignApply` | **Mostly no.** Only AI **auto‑assign category/brand** reaches Tokyo (after re‑export). Generated descriptions/FAQ/SEO and auto‑assigned **attributes** never reach Tokyo — *you can spend AI tokens for zero storefront effect.* |
| 3 | **Stock** | `/admin/catalog/stock` | `stock` | `stock-location/movement/transfer` | `stock-*.ts` + `catalog.ts` bulk; order stock via order workflows | **Only the `in_stock`/`out_of_stock` enum, frozen at export.** No quantity, no per‑location, no low‑stock ever reaches Tokyo. |
| 4 | **Collections** | `/admin/catalog/collections` | `collections` | `catalog/collection` | `collection.ts` → `collection.ts` workflow | **No.** Not exported; no Tokyo route references collections. Admin edits show only on legacy `(shell)` `/collection(s)`. |
| 5 | **Catégories** | `/admin/catalog/categories` | `categories` | `catalog/category` | `catalog.ts` → `create/update/delete‑category` | **Structure yes** (via `taxonomy.json` re‑export) — drives the Tokyo mega‑menu & `/[slug]`. **Not reached:** `is_active`, attribute filters, editorial blocks, hero/OG/icon media, TVA. |
| 6 | **Marques** | `/admin/catalog/brands` | `brands` | `catalog/brand` | `catalog.ts` → `create‑brand` workflows | **Brand *name* on cards only** (after re‑export). **Brand landing pages 404 on Tokyo** — `(tokyo)/[slug]` has no brand branch; logo/hero/editorial/SEO/FAQ unreachable. |
| 7 | **Drip & Exclusivité** | `/admin/catalog/drip` | `products` *(reused)* | `catalog/product/tier-release` | product form → `update‑product` workflow | **No gating on Tokyo** — the snapshot has no embargo fields, so exclusives are **visible to everyone**; but cart/checkout **still block** against the live DB → *visible‑but‑not‑buyable.* |
| 8 | **Cartes cadeaux** | `/admin/catalog/gift-cards` | `products` *(reused)* | `gift-card` | `gift-card.ts` → `src/lib/gift-card/*` (not `workflows/`) | **No functional path on Tokyo.** No redeem UI mounted; buying only mints if a product is `is_gift_card` (none exist); redeem UI is orphaned. |
| 9 | **Attributs** | `/admin/catalog/attributes` | `attributes` | `catalog/attribute` | `attribute.ts` → `manage-attributes` workflow | **No storefront surface** (no attribute data in the export; Tokyo has no facet UI). **But load‑bearing backend:** variant axes + per‑value TVA depend on it. |
| 10 | **Avis** | `/admin/catalog/reviews` | `reviews` | `catalog/review` | `reviews.ts`/`review-generation.ts` → `review`/`review-gen` workflows | **No.** Tokyo **fabricates** ratings (`fakeRating`) and never reads `product_reviews`; the real review‑submission UI is orphaned. |
| 11 | **Médiathèque** | `/admin/media` | `media` (+`system_media`) | `media` | `api/admin/media/*` + `catalog.ts` → `media` workflows | **Indirect & fragile.** Image URLs are frozen in the export; a détourage reprocess/delete re‑keys or purges objects and **404s the Tokyo image** until re‑export. |

**Read this table as:** anything marked "after re‑export" silently diverges from the live store until `scripts/tokyo-export-catalog.ts` is re‑run and the JSON committed; anything marked "No / no surface" means editing it has **zero** effect on what a customer sees on Tokyo today (it may still matter for the legacy `(shell)` routes, for ERP/REST, or for backend correctness).

---

## §C. Shared write pattern, reads & conventions

- **Write path (uniform):** `admin page` (RSC, `requirePermission`) → `ProductForm`/panel (client) → **Server Action** (`src/lib/actions/*`: re‑guards permission, parses `FormData`, converts dinars→millimes at the edge, `revalidatePath`) → **Workflow** (`src/workflows/catalog/*`: validates with zod, runs in `db.transaction()`, emits `*.created/updated/deleted` events) → **Service** (`src/modules/**/service.ts`: pure data access). Services alone bypass the workflow guards — never write through them directly.
- **The `provided`‑key guard** in `updateProductWorkflow`/`updateCategoryWorkflow` is what makes partial saves safe — only submitted fields are written. Removing it turns a sparse patch into a wipe.
- **Reads:** admin lists come from each module's `service.list*Paged` / `queries.ts`; the storefront/ERP read mapper is `src/lib/api/products.ts` (`mapProductRows`, `listApiProducts`). The legacy `(shell)` storefront reads these **live**; the Tokyo storefront reads the **snapshot**.
- **Events** fan out to audit, structured logs, metrics, outbound webhooks, cache‑tag busts, loyalty/credit, gift‑card issuance, and AI re‑embed — all **in‑process, best‑effort, no retry** (see A–Z landmine #9). A `product.updated` must carry an accurate `changedFields` or those side effects misfire.
- **Soft delete** everywhere (`deleted_at`); partial‑unique indexes `WHERE deleted_at IS NULL` let a slug/SKU be reused after deletion. There is **no un‑delete UI** for products (DB‑only recovery).
- **Migrations nuance (correction):** "frozen at 0007" refers to the **drizzle snapshot/meta** (so `db:generate`/`db:push` are guard‑disabled). **Hand‑authored SQL migrations continue well past it (to ~0201)** — e.g. reviews 0023/0024/0063/0136, gift‑cards 0147, AI 0064/0065. To add schema: edit the module `schema.ts`, hand‑author `migrations/NNNN_*.sql` + a `_journal.json` entry, then `db:migrate`. Never run generate/push.

---

## §D. Catalogue landmines (session‑specific)

1. **The snapshot wall (the big one).** The live Tokyo store ignores admin catalog writes until `scripts/tokyo-export-catalog.ts` is re‑run and `src/storefront/data/*.json` committed. There is **no automation, trigger, or freshness indicator**. This affects Produits, Stock, Catégories, Marques (name), and Media across the board.

2. **Whole subsections are invisible on Tokyo:** Collections (not exported, no route), Marques landing pages (`(tokyo)/[slug]` has no brand branch → 404), Attributs (no facet UI), Avis (fabricated ratings). Editing these changes the admin and sometimes the legacy `(shell)` pages, but **not the live store**.

3. **Fabricated review aggregates shipped to Google.** The Tokyo PDP (`(tokyo)/[slug]/page.tsx:188,201‑209`) emits `Product` → `aggregateRating` using the **invented** `fakeRating(slug)` value, and renders fake stars + "(N avis)" on‑page (`product-view.tsx:118,585‑601`). Real/moderated/AI reviews in `product_reviews` never surface. This is a **structured‑data / consumer‑trust (FTC) risk**, and it means all Avis moderation work is currently invisible to shoppers.

4. **Drip = visible‑but‑not‑buyable.** Tier‑gated/early‑access products **leak into the Tokyo snapshot for everyone** (export uses `listApiProducts({public:false})`, no embargo), yet cart/checkout **still enforce** the embargo against the live DB (`add-to-cart.ts:38`, `place-order.ts:464`). A shopper sees an "exclusive", clicks buy, and is blocked. The whole per‑tier early‑access delay is equally dead on Tokyo.

5. **Gift‑card "money‑printer" guard is distributed across 5+ files** (`place-order.ts` `giftCardSubtotalCents`/`discountBaseCents`, `discountable-subtotal.ts`, `scoped-coupon.ts`, `coupon-eligibility.ts`, + `is_discountable=false`/0% TVA forced on `is_gift_card` products). Drop the gift‑card exclusion from **any** discount base and you can buy a card below face and redeem at face. Also: **no gift card is buyable or redeemable on Tokyo today** (no `is_gift_card` product seeded; redeem UI orphaned).

6. **Attributs looks safe to delete from the storefront but is load‑bearing backend:** product **variant axes** (`product_variant_values`) and **per‑value TVA** (`tax_rules.attribute_value_id`) depend on it. Removing it breaks tax calculation and variant rendering even though no customer page reads attributes. (Also: `/recherche` and `(shell)/collection/[slug]` compute attribute facets that the client then **discards** — dead integration.)

7. **AI tokens for zero effect.** Generated descriptions/FAQ/SEO never reach the Tokyo snapshot (export shape omits them); a dry‑run auto‑assign over the whole catalogue costs one paid AI call per product even for an operator who lacks `products:update` to apply it. Bulk rate‑limit **fails open** on a limiter‑store error.

8. **Silent save losses.** Folded‑in **variants/FAQ** on product and collection saves are best‑effort — the row can save `ok:true` while the folded part fails, so an edit is quietly lost until retried.

9. **Stock divergence is normal, not a bug.** `products.stock_qty` vs `Σ(stock_levels)` drift because sales move only the total; realigning a level then swings the total by the full difference. There is **no admin UI to read the `stock_movements` ledger** (ERP API only), and manual admin stock edits **don't** fire low‑stock alerts.

10. **Gift‑card/expiry & liability:** expired cards stay `status='active'` (never swept); any query keyed on `status='active'` alone over‑counts outstanding liability. No partial‑redemption/balance model — redemption is all‑or‑nothing into store credit.

---

## §E. Edit / remove quick verdicts (per subsection)

| Subsection | Safe to restyle/edit in admin? | Reaches live store without extra work? | To truly remove |
|---|---|---|---|
| Produits | Yes (tabs/fields/labels; keep `FIELD_TAB` + millime conv.) | Only via re‑export; load‑bearing backbone | Not removable — it's the core entity |
| Produits AI | Yes (prompts/caps/concurrency) | No (text/FAQ/SEO never; auto‑assign cat/brand only) | Remove per‑tool: control + action + runner + module + `AI_JOB_KINDS`; hand‑migrate tables |
| Stock | Yes (copy/labels; ledger contract load‑bearing) | Only `in_stock` enum via re‑export | Feature‑flag off (transfers/multi‑loc); full removal touches order stock paths |
| Collections | Yes (admin + `(shell)` only) | No (no Tokyo surface) | Top‑down: nav → pages/actions → shell routes → service/schema → RBAC id + route‑catalog + tests |
| Catégories | Yes (admin + `(shell)`) | Structure via re‑export; rest not reached | Hard — taxonomy drives Tokyo nav; respect tree/cycle guards |
| Marques | Yes (writes DB, live on `(shell)` `/marques`) | Name only; landing 404 on Tokyo | Soft‑delete blocked while promos target it; hard delete cascades `product_brands` |
| Drip | Yes (UI copy; Tab 1 is read‑only) | No gating on Tokyo | **Clear `product_tier_release` rows first**, then drop nav/route/form tab/guards |
| Cartes cadeaux | Yes (panel copy; 1 expiry setting) | No functional path on Tokyo | Can hide register page; **keep `lib/gift-card/*` + subscriber while any card exists** |
| Attributs | Yes (but no storefront impact) | No | **Not storefront‑safe to delete** — breaks variants + TVA; remove only with those |
| Avis | Yes (moderation + AI gen are separable) | No (fabricated ratings) | AI gen+schedule removable as a unit; keep `recompute*` + core moderation |
| Médiathèque | Yes (copy/clamps; lockstep load‑bearing) | Indirect; reprocess can 404 Tokyo until re‑export | Import‑by‑URL and détourage each removable as a unit |

---

## Subsection deep dives — table of contents

1. [Produits — core product CRUD, variants, promotions](#1-produits-core-product-crud-variants-promotions)
2. [Produits — AI generation & auto-assign suite](#2-produits-ai-generation-autoassign-suite)
3. [Stock — inventory, locations, ERP, transfers, settings](#3-stock-inventory-locations-erp-transfers-settings)
4. [Collections (Catalogue admin)](#4-collections-catalogue-admin)
5. [Catégories — taxonomy tree](#5-catgories-taxonomy-tree)
6. [Marques (brands) — admin Catalogue subsection](#6-marques-brands-admin-catalogue-subsection)
7. [Drip & Exclusivité (tiered release / early access)](#7-drip-exclusivit-tiered-release-early-access)
8. [Cartes cadeaux (gift cards)](#8-cartes-cadeaux-gift-cards)
9. [Attributs (product attributes & facets)](#9-attributs-product-attributes-facets)
10. [Avis (Reviews) — moderation, AI generation & scheduling](#10-avis-reviews-moderation-ai-generation-scheduling)
11. [Médiathèque (media library admin)](#11-mdiathque-media-library-admin)

**Appendices:** [A — Sources of Truth](#appendix-a--master-sources-of-truth) · [B — Edit & Remove](#appendix-b--edit--remove-notes) · [C — Risk Register](#appendix-c--risk-register--known-gaps)


---

## 1. Produits — core product CRUD, variants, promotions

The central catalog entity. This covers the product list, the create wizard, the edit form and all of its tabs (except the AI-generation suite, which is a separate section), the variant editor, the inline promotions panel, product duplication, and the full action → workflow → service write path. Money is handled in **millimes** at the form edge. **The live Tokyo storefront does NOT read product edits until a manual JSON re-export is run** — see Storefront linkage.

### What the operator sees & does

**List page** (`/admin/catalog/products`, `products-panel.tsx`). A sub-tab strip (`products-workspace.tsx:57-71`) switches between **Produits** (the list), **Réglages catalogue** and **Génération IA** — the latter two are other sections. A header "Nouveau produit" button links to `/new` (`products-workspace.tsx:82-89`).
- **Filter bar** (`products-panel.tsx:176-243`): free-text **Recherche** ("Nom ou SKU…"), a hierarchical **Catégorie** drill-down popover that rolls up descendants (`CategoryFilter`, `products-panel.tsx:466-633`), and a **Statut** select `Tous / Brouillon / Publié / Supprimé` (`products-panel.tsx:208-224`). Note: `status="archived"` maps to **soft-deleted** rows (`deleted_at IS NOT NULL`), a different bucket from "Dépublier" (`is_published=false`, shows under Brouillon) — labelled "Supprimé" (`products-panel.tsx:218-222`).
- **Columns** (`products-panel.tsx:303-320, 818-920`): checkbox · **Produit** (primary thumbnail + name + `/slug`) · **Prix** (`formatMoneyWithCurrency(priceCents, currency)`, millimes) · **Stock** (En stock / Indisponible pill from `isEffectivelyOutOfStock(inStock, stockQty)`) · **Statut** (Publié / Brouillon / `Supprimé le <date>`) · **Actions**.
- **Row actions** (`products-panel.tsx:879-917`): a direct storefront link — ExternalLink if published, amber Eye "Aperçu" if draft (`/${slug}`, drafts are admin-only previews) — the edit pencil (`/admin/catalog/products/<id>`), a MoreHorizontal menu (**Dupliquer**, **Publier/Dépublier**, `RowActionsMenu` `products-panel.tsx:930-1012`), and a trash → `ConfirmDeleteModal` → `deleteProductAction` (`products-panel.tsx:402-433`). Every quick-action outcome is surfaced in a notice banner (`RowNotice`, `products-panel.tsx:271-294`). Soft-deleted rows show no actions and no restore (there is no un-delete workflow — `products-panel.tsx:814-817`).
- **Bulk action**: selecting ≥2 **live** rows on the current page reveals "Assigner attributs" → `BulkAttributesDialog` → `bulkAssignAttributesAction` (additive, non-destructive; `products-panel.tsx:245-269, 679-799`). Selection is scoped to the current page only and cleared on any URL/filter/page change (`products-panel.tsx:113-119`).
- **Pagination**: 10/25/50/100 per page, windowed page buttons (`products-panel.tsx:351-400, 635-672`). Empty state: "Aucun produit ne correspond aux filtres." (`products-panel.tsx:296-299`).

**Create** (`/new`, wizard) and **Edit** (`/[id]`, flat grouped tabs) share one `ProductForm` (`src/components/admin/product-form.tsx`). Tabs in group order **Essentiel** (Général, Prix, Stock) · **Classement** (Catégorisation, Attributs, Variantes) · **Contenu** (Description, Média, Vidéo produit, FAQ) · **Marketing** (Promotions, Vous aimerez aussi, Produits supplémentaires, Drip & Exclusivité) · **Référencement** (SEO) — `TABS`/`TAB_GROUPS` `product-form.tsx:263-367`. All panels stay mounted (hidden) so one `FormData` captures every field (`product-form.tsx:637`, `PRODUCT_FORM_ID` `product-form.tsx:1332`). The full field set:
- **Général** (`product-form.tsx:640-815`): `productType` (Simple/Variable), `sharedVariantStock` (Par défaut/Par variante/Partagé), `name` (required), `slug` (blank → slugified from name), `sku`, `gtin`, `mpn`, `condition` (Neuf/Occasion/Reconditionné), `externalRef` (ERP), `displayOrder`, warranty override (`warrantyMonths` + `warrantyLabel`, with an inherited-value hint), and a `ProductScanCode` QR/barcode (edit only). Legacy `platform` is preserved via a hidden input (`product-form.tsx:777-779`).
- **Prix** (`product-form.tsx:818-867`): `priceTnd` (required), `oldPriceTnd` (compare-at / strike), `taxRateBps` entered as a **percent**. Currency is store-global (per-product selector removed).
- **Stock** (`product-form.tsx:874-937`): `inStock` checkbox, `stockQty` (blank = untracked), `minPurchaseQty`, `maxPurchaseQty`, plus hidden `stockQtyOriginal`/`inStockOriginal` page-load twins (edit only) for the compare-and-set.
- **Description** (RichText `shortDesc` + `description`, HTML), **Média** (`MediaPicker` multi `mediaIds`, first = primary), **Vidéo produit** (`videoUrl`, `videoPosterMediaId`, `videoTitle`, `videoDescription`), **FAQ** (edit-only `ProductFaqEditorBody`, folds into `faqItemsJson`).
- **Catégorisation** (`BrandPicker` `brandId` + `CategoryTreePicker` → `categoryIds`/`primaryCategoryId`), **Attributs** (`AttributesPicker` → `attributeValueIds` + per-attribute scalars `attrScalarNum.*`/`attrScalarText.*`), **Variantes** (edit-only `ProductVariantsEditor`).
- **Marketing**: `isDiscountable`, `isGiftCard`, `earlyAccessEnabled` checkboxes (`product-form.tsx:1077-1095`); the inline `ProductPromotionsPanel` (edit only); related rail mode + curated list; complementary list; Drip & Exclusivité ladder.
- **SEO** (`product-form.tsx:1266-1324`): `metaTitle`, `metaDescription`, `canonicalUrl`, `sameAs` (only when the global switch is on), `ogImageMediaId`, `noindex`.
- **Publier** checkbox + submit live in the action bar (`product-form.tsx:1443-1504`). On failed submit the form jumps to the owning tab/step via `FIELD_TAB` (`product-form.tsx:299-347, 540`). On successful **create** it routes to the new product's edit page (`product-form.tsx:595-599`).

### Routes & components
- `src/app/admin/catalog/products/page.tsx` — RSC list page. `requirePermission("products","view")` (L71), resolves `canUpdate`/`canManage` (L78-79), reads `productService.listAdminPaged` (L103) + category tree/attributes/brands, resolves primary thumbnails with no N+1 (`productMediaLink.primaryMediaIdsForProducts` L138-141), renders `ProductsWorkspace`.
- `products-workspace.tsx` — client shell/tab strip; `list`/`generation`/`settings` panels kept mounted.
- `products-panel.tsx` — client list: table, `CategoryFilter`, `BulkAttributesDialog`, `ProductRow`, `RowActionsMenu`, `PageButtons`.
- `src/app/admin/catalog/products/[id]/page.tsx` — RSC edit page. `requirePermission("products","view")` (L61), `isUuid(id)` guard 404s `/new` + typos here (L80), `productService.findById` (L81), loads brands/categories/links/attributes/scalars/FAQs/promotions/variants/related/complementary/tier ladders (L84-124), builds `initialVariants` (L213-228), renders `ProductForm mode="edit"`.
- `src/app/admin/catalog/products/new/page.tsx` — RSC create. `requirePermission("products","create")` (L52), `export const dynamic = "force-dynamic"` (L34), `ProductForm layout="wizard" mode="create"`.
- `src/components/admin/product-form.tsx` — the unified client form (3824 lines) + in-file pickers (`CategoryTreePicker`, `AttributesPicker`, `RelatedProductsPicker`, `ComplementaryProductsPicker`, `DripExclusivityPicker`, `SeoFields`, `Field`, `Section`, `CheckboxCard`).
- `src/components/admin/product-variants-editor.tsx` (679 lines), `product-promotions-panel.tsx`, `product-scan-code.tsx`, `media-picker.tsx`.

### Data model
**`products`** (`src/modules/catalog/product/schema.ts:59-266`): `id` (uuid v7), `slug`, `name`, `platform` (legacy), `sku`/`gtin`/`mpn`, `condition` (enum `new|used|refurbished`, CHECK), `external_ref`, `product_type` (enum `simple|variable`), `warranty_months`/`warranty_label`, `tax_rate_bps` (bps), `short_desc`/`description`, **`price_cents`/`old_price_cents` = MILLIMES** (the `_cents` name is legacy; L112-113), `currency` (frozen 'TND'), denormalised `rating`/`reviews_count` (written by the review module), `in_stock`/`stock_qty`, `min_purchase_qty`/`max_purchase_qty`, `shared_variant_stock` (null=inherit global / true=shared pool / false=per-variant), video_* , SEO (`meta_title`/`meta_description`/`canonical_url`/`noindex`/`og_image_media_id`/`same_as`), `display_order`, `is_published`/`published_at`, `drip_start_at`, `is_discountable`, `is_gift_card`, `early_access_enabled`, `related_mode` (enum), `timestamps`+`softDelete`.
- Invariants: partial-unique `slug` / `external_ref` WHERE `deleted_at IS NULL` (soft-deleted frees slug reuse; `schema.ts:228-235`). `sku`/`gtin` trgm/partial-unique in migration 0107/0008. App-enforced soft delete.

**`product_variants`** (`schema.ts:276-342`): `product_id` (real FK CASCADE), `sku`/`gtin`/`mpn`, `label` (denormalised combo text), **`price_cents` absolute** (not a delta), `old_price_cents`, `stock_qty` (NULL=untracked; IGNORED in shared mode), `in_stock`, `image_media_id`, `display_order`, `is_default`. Partial unique: one default per product (`product_variants_one_default_per_product`), sku/gtin unique over live rows.
**`product_variant_values`** (`schema.ts:351-367`): `(variant_id, attribute_value_id)` combo rows, unique pair.
**`product_tier_release`** (`tier-release.schema.ts:36-61`): per-product per-tier drip/exclusivity `(product_id, ladder 'coin'|'business', level_id, dwell_days)` (dwell NULL = ∞/exclusive floor).
**Associations** (soft-FK link tables, module-free; services in `src/associations/catalog.service.ts`): `product_categories` (`is_primary`; `product-category.ts`), `product_brands` (`product-brand.ts`), `product_media` (`is_primary`, display order; `product-media.ts`), `product_related` (curated "Vous aimerez aussi", `display_order`; `product-related.ts`), `product_complementary` (curated accessories; `product-complementary.ts`). Per-product attribute values + number/text scalars live in the attribute module.

### Read path
- **Admin list**: `productService.listAdminPaged({q, productIds, status, page, pageSize})` (`service.ts:251-299`) — `q` matches name+sku ILIKE (escaped), `status` flips `is_published`/`deleted_at`, category scoping is done in the page via `productCategoryLinks.listProductIdsInCategoryTree` then passed as `productIds` (page.tsx:92-94). OFFSET pagination, `ORDER BY created_at DESC, id DESC` (stable tiebreak), true `count()` total. Default pageSize 25 (clamp 5–100).
- **Admin detail**: `productService.findById` + ~16 parallel loads in `[id]/page.tsx:84-124` (variants via `productQueries.listVariantsForProduct` + `listVariantValueLinks`).
- **Storefront (legacy shell + the JSON export source)**: `src/lib/api/products.ts`. `mapProductRows` (L1259-1673) is the batched row→`Product` mapper (media/brand/category/variant/warranty enrichment, variable-product cheapest-variant display pricing via `listingDisplayPricing`, computed drip/collection card tags). `getProductWithRowBySlug`/`getProductBySlug` (PDP, `'use cache'` tagged per product) and `listApiProducts`/`listApiProductsPage` (paged, newest-first via `productQueries.listPublishedProducts`) feed the legacy storefront **live from the DB**, plus the external REST/ERP reads. These are NOT what the live Tokyo storefront renders.

### Write path
All product mutations go **action → workflow → service** in a transaction, then emit events.
- **Create**: `createProductAction` (`src/lib/actions/catalog.ts:829-943`) → required-field gate (name + price; a blank price is an explicit error, not 0; L842-869) → `workflows.catalog.createProduct` (`src/workflows/catalog/create-product.ts:288-442`). Zod `createProductSchema` (L131-286) validates; writes `products` row + category/brand/media/attribute/scalar/related/complementary/tier links in one `db.transaction` (L343-430); emits `product.created` (+ `product.published`). Variable-product-can't-publish-without-variants guard (L311-313).
- **Update**: `updateProductAction` (`catalog.ts:945-1123`) → `workflows.catalog.updateProduct` (`create-product.ts:470-1005`). `updateProductSchema = createProductSchema.partial()` but **a `provided` set of raw keys** gates every field so a sparse patch (e.g. the archive toggle `{productId, publish}`) never wipes content (L486, L623-634) — Zod keeps `.default()` through `.partial()`. `changed[]` lists only columns that actually differ (drives `product.updated` changedFields → cache bust, webhooks, audit, re-embed). Stock is diffed against a `FOR UPDATE`-locked row with compare-and-set (`expectedStockQty`, L774-796) and ledgered via `stockMovementService`. Associations rewritten only when sent-and-different (L706-744, L855-892). Guards: variable→simple demotion refused while live variants exist (L539-551); publish of variant-less variable refused (L566-571); gift-card forces `is_discountable=false`+`tax_rate_bps=0` (L636-649); re-publish drip-anchor freeze (L690-704). Emits `product.updated`/`price_changed`/`restocked`/`published`/`unpublished`, and `syncEntityUrlRedirects` keeps the old slug 301ing (L989-1002).
- **FAQ + Variants fold-in**: after `updateProduct` succeeds, the same action persists `faqItemsJson` via `workflows.cms.upsertProductFaqs` (L1065-1075) and `variantsJson` via `workflows.catalog.upsertProductVariants` (L1086-1103) — best-effort, with a partial-failure message. There is **no separate variants/FAQ save button**.
- **Variant workflow**: `upsertProductVariantsWorkflow` (`src/workflows/catalog/upsert-product-variants.ts`) → `productService.replaceVariants` (`service.ts:316-460`): id-stable (updates keep variant ids so cart/order refs survive), inserts new, soft-deletes removed at stock 0, pre-clears default flag + frees sku/gtin to allow swaps, diffs attribute-value links. Promotes product to `variable` on first variant, demotes to `simple` when emptied (resetting a NULL-stock parent to tracked/out-of-stock). Emits `product.updated`, per-variant `price_changed`, `restocked`.
- **Duplicate**: `duplicateProductAction` (`catalog.ts:1423-1443`) → `duplicateProductWorkflow` (`src/workflows/catalog/duplicate-product.ts`). New draft `"<name> (copie)"`, unique `-copie` slug, copies category/brand/media/attributes/scalars/related/complementary/tier schedule + the full variant matrix as fresh rows; **resets stock to 0, clears sku/gtin/canonical**; `stockReset` tells the operator to re-enter the count.
- **Publish toggle**: `setProductArchivedAction(productId, archived)` (`catalog.ts:1454-1474`) → `updateProduct {publish: !archived}` — flips `is_published` only, never `deleted_at`.
- **Delete**: `deleteProductAction` (`catalog.ts:1516-1525`) → `deleteProductWorkflow` (`create-product.ts:1007-1037`) — soft-deletes, releases variants/attribute links/tier schedule/stock levels in one tx; emits `product.deleted`. Order history is preserved (order_items snapshot).
- **Millime handling at the form edge**: `priceTnd`/`oldPriceTnd` are entered in dinars and converted by `priceFieldToMinor`/`priceFieldToMinorNullable` → `dinarsToMinor` (`catalog.ts:1861-1881`); `taxRateBps` entered as percent → `bpsFromPercent` (`taxBpsField`, L1905-1912). The form seeds them back with `minorToDinars`/`percentFromBps` (`product-form.tsx:830-864`). Variant editor serialises its own `variantsJson` with `dinarsToMinor` (`product-variants-editor.tsx:372-399`). A present-but-unparseable price is rejected up front (`catalog.ts:862-868, 958-966`) so an edited price never silently fails to save.
- Every successful action `revalidatePath("/admin/catalog/products")` (+ the `[id]` page and `/${slug}`).

### RBAC
Permission `products` with actions `view/create/update/delete/manage` (`src/lib/rbac/registry.ts:68`). Guards:
- List page → `requirePermission("products","view")`; edit page → `view`; create page → `create`; each mutating action re-guards: create→`products:create`, update/archive→`products:update`, duplicate→`products:create`, delete→`products:delete` (`catalog.ts:833,949,1424,1458,1517`). Bulk attribute assign uses `attributes` (via `bulkAssignAttributesAction`); the global stock bulk uses `stock:update` (`catalog.ts:1261`).
- **Reused id**: Drip & Exclusivité (`/admin/catalog/drip`) and Cartes cadeaux (`/admin/catalog/gift-cards`) both reuse the **`products`** nav/RBAC id (`admin-shell.tsx:130-137`). The standalone drip save `saveProductTierAccessAction` reuses `products:update` (`catalog.ts:1490`).
- The inline **Promotions panel** is gated **separately** on `promotions:view/create/update/delete` (resolved in `[id]/page.tsx:66-76`, passed as `promoCan*`), because the promotion actions `notFound()` on deny and would tear down the editor. A products-only operator sees no promotion rows/controls.
- UI-honesty: the Réglages/Génération tabs are hidden unless `products:update`/`products:manage` (`page.tsx:146-174`).

### Storefront linkage
This is the single most important operational fact. **Admin product edits are INVISIBLE on the live Tokyo storefront until a manual JSON export is re-run and the output committed.**
- The live customer storefront is `src/app/(shop)/(tokyo)/**` + `src/storefront/**`. Its catalog module `src/storefront/lib/catalog.ts:1-2` **statically imports `@/storefront/data/products.json`** (+ `categories.json`, `taxonomy.json`) at module load — a bundled snapshot, not a DB read. Tokyo PDPs route at `/(tokyo)/[slug]`; the legacy `/(tokyo)/p/[id]` just redirects by id.
- That snapshot is regenerated ONLY by manually running `scripts/tokyo-export-catalog.ts` (+ `tokyo-build-categories.ts`) — e.g. `pnpm tsx … scripts/tokyo-export-catalog.ts`. It calls `listApiProducts({public:false})` (DB-live, published only, no embargo) and writes `products.json` (`tokyo-export-catalog.ts:81-149`). No subscriber, workflow, or revalidate triggers it; it is not automated.
- The export is **lossy** — `RawProduct` carries only `id, slug, title, link, image (first image), price (display, cheapest variant for variable), currency, availability, condition, brand, category (deepest leaf), category_path` (`tokyo-export-catalog.ts:26-107`). It does **not** carry description, `old_price_cents`, `rating`/`reviews_count`, variants, SEO, video, gallery, or warranty months. The Tokyo PDP therefore **fabricates** ratings (`fakeRating`, seeded on slug — `src/storefront/lib/productMeta.ts:8-15`), strike/compare-at prices (`fakeStrike`, L62-71), warranty, specs and FAQ (`productMeta.ts:108-191`) — none of these come from real data. So editing a product's reviews, old price, description, variants or SEO changes nothing visible on Tokyo even after a re-export.
- By contrast the legacy **(shell)** storefront reads the DB live through `src/lib/api/products.ts`, so edits appear immediately there.

### Edit / remove notes
- **Load-bearing (don't casually change):** the millime conversion at the form edge (`priceFieldToMinor`/`dinarsToMinor`) and the `_cents`=millimes convention; the `provided`-key guard in `updateProductWorkflow` (removing it makes any partial save wipe content); the stock compare-and-set + `editedStockFields`/`variantStockFields` dirty-gate (removing it resurrects sold units); the `variantsJson`/`faqItemsJson` fold-in in `updateProductAction`; the id-stable `replaceVariants` (keeps cart/order refs); cross-namespace `checkSlugAvailability`; the `product.updated` `changedFields` contract (drives cache bust, webhooks, audit, AI re-embed). The variable-publish and demotion guards prevent a dead-end PDP.
- **Safe to change:** tab labels and order live in `TABS`/`TAB_GROUPS`/`WIZARD_STEPS` (`product-form.tsx:263-401`) — but keep `FIELD_TAB` (L299-347) in sync so error-focus still works; adding/removing a visible field means editing the form panel + the action FormData mapping + the workflow Zod schema + the `map` table (`create-product.ts:576-613`). DB columns are **frozen** (migrations stop at 0007 snapshots) — do NOT run `db:generate`/`db:push`; drop a field from the UI/workflow and leave the column.
- **If you touch a field the Tokyo export reads** (`name/slug/price/image/availability/condition/brand/category`), also update `scripts/tokyo-export-catalog.ts` and re-run it, or the storefront silently diverges.
- The AI-generation panel (`ProductGenerationControl`, the "Génération IA" tab) and bulk product-gen are a **separate section** — out of scope here.

### Gaps & risks
- **Export staleness is the #1 footgun:** nothing automatically propagates a product edit to the live Tokyo storefront; it requires remembering to run `tokyo-export-catalog.ts` and commit the JSON. An operator editing in admin will see no change on the Tokyo site.
- **Fabricated storefront data:** real `rating`/`reviews_count` and real `old_price_cents` exist in the DB and are shown correctly by the legacy shell + the real review module, but the Tokyo PDP invents ratings and strike prices from a slug hash (`productMeta.ts`), so admin review/discount data and the Tokyo "−X%" badge are unrelated.
- **Variable product stock in the admin list:** the list passes `stockQty` only for `simple` products (`page.tsx:189`), so a variable product's pill relies on the `in_stock` flag alone.
- **No restore for soft-deleted products** — "Supprimé" rows are terminal in the UI (`products-panel.tsx:814-817`); recovery is DB-only.
- **Duplicate resets stock to 0 and clears SKU/GTIN** — the operator must re-enter real quantities/identifiers before publishing (surfaced in the success message).
- **Best-effort FAQ/variant fold-in:** if the product row saves but the folded-in variants/FAQ fail, the action still reports `ok:true` with a caveat message (`catalog.ts:1114-1121`) — the product is updated but the sub-editor edit may be lost until retried.
- `platform` is a dead legacy column kept alive only by a hidden passthrough input; new characteristics belong on Attributs.


<details>
<summary><strong>1. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/products/page.tsx — RSC list page; requirePermission view (L71), listAdminPaged (L103), thumbnail resolve (L138)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/products/products-panel.tsx — client list: columns, filters, category drill-down, bulk-attr, row actions, pagination
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/products/products-workspace.tsx — client tab shell (List / Génération IA / Réglages)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/products/[id]/page.tsx — RSC edit page; isUuid 404 guard (L80), ~16 parallel loads, builds ProductForm initial
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/products/new/page.tsx — RSC create; requirePermission create (L52), force-dynamic, wizard layout
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/product-form.tsx — unified create+edit form (3824 lines), all tabs + in-file pickers; TABS L263, FIELD_TAB L299, millime seeding L830
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/product-variants-editor.tsx — variant matrix editor; serialises variantsJson (L372-399) into the main form
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/product-promotions-panel.tsx — inline promotions list + CreatePromotionModal (reads promotions module, gated on promotions:*)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/catalog.ts — product server actions (create L829, update L945, duplicate L1423, archive L1454, delete L1516) + FormData/millime helpers (L1819-end)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/create-product.ts — createProductWorkflow (L288) + updateProductWorkflow (L470) + deleteProductWorkflow (L1007); the TRUE mutation API
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/upsert-product-variants.ts — variant reconcile workflow (stock lock, ledger, promote/demote type)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/duplicate-product.ts — duplicate as draft (copies links+variants, resets stock/sku/gtin)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/product/schema.ts — products / product_variants / product_variant_values tables, enums, indexes
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/product/service.ts — productService: findById, listAdminPaged (L251), replaceVariants (L316), softDelete
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/product/queries.ts — storefront/variant reads (listPublishedProducts, listVariantsForProduct, stockStateSql)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/api/products.ts — storefront/ERP read layer: mapProductRows (L1259), getProductBySlug, listApiProducts (DB-live, feeds the export)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/scripts/tokyo-export-catalog.ts — THE data bridge: manual DB→products.json export that the live Tokyo storefront reads
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/data/products.json — bundled snapshot the Tokyo storefront renders (regenerated only by the export script)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/lib/catalog.ts — static import of products.json; builds the Tokyo product list (L73+)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/lib/productMeta.ts — FABRICATES Tokyo ratings (fakeRating L8), strike prices (fakeStrike L62), warranty/specs/FAQ
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/product/tier-release.schema.ts + tier-release.service.ts — Drip & Exclusivity per-tier schedule
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/associations/catalog.service.ts — productCategoryLinks/productBrandLink/productMediaLink/productRelatedLinks/productComplementaryLinks (set/list)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/rbac/registry.ts — products permission def (L68); Drip + Cartes cadeaux reuse it (admin-shell.tsx L134,L137)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/catalog/editor-stock-fields.ts — editedStockFields/variantStockFields dirty-gate for safe stock saves

**Models / tables**

- products (owned) — all CRUD columns incl. price_cents/old_price_cents=millimes, product_type enum, condition enum, related_mode enum, shared_variant_stock, is_discountable/is_gift_card/early_access_enabled, SEO cols, drip_start_at
- product_variants (owned) — per-variant absolute price_cents/old_price_cents, stock_qty (ignored in shared mode), is_default (partial-unique), sku/gtin (partial-unique live)
- product_variant_values (owned) — (variant_id, attribute_value_id) combo rows
- product_tier_release (owned via product/tier-release) — (product_id, ladder, level_id, dwell_days) drip/exclusivity
- product_categories (joined via associations) — is_primary; category tree rollup for list filter + PDP breadcrumb
- product_brands (joined) — single brand soft-link
- product_media (joined) — gallery, is_primary = listing thumbnail
- product_related (joined) — curated 'Vous aimerez aussi' (manual/ai modes)
- product_complementary (joined) — curated accessories
- stock_levels / stock_movements (touched on stock writes + variant/product soft-delete)
- product_attribute_values + scalars (attribute module) — M2M values + per-product number/text scalars

**Sources of truth**

- Mutation API = workflows: src/workflows/catalog/{create-product,duplicate-product,upsert-product-variants}.ts (run in db.transaction, emit events). Actions in src/lib/actions/catalog.ts only parse FormData + requirePermission + revalidate.
- Admin reads = src/modules/catalog/product/{service.ts listAdminPaged, queries.ts} + src/app/admin/catalog/products/[id]/page.tsx parallel loads.
- Storefront/ERP reads = src/lib/api/products.ts (mapProductRows). Legacy (shell) renders this live; the external REST/feeds use listApiProducts.
- LIVE Tokyo storefront render source = the bundled src/storefront/data/products.json (static import in src/storefront/lib/catalog.ts), regenerated ONLY by manually running scripts/tokyo-export-catalog.ts — NOT the DB at request time.
- RBAC = src/lib/rbac/registry.ts (products:view/create/update/delete/manage); grants in DB. Contract/tests = src/lib/db/tests/** (no OpenAPI).
- Schema = hand-authored src/modules/catalog/product/schema.ts; migrations frozen at 0007 snapshots — do NOT db:generate/db:push.

**Editable / removable**

- SAFE: tab labels/order in TABS, TAB_GROUPS, WIZARD_STEPS (product-form.tsx:263-401) — keep FIELD_TAB (L299) in sync for error-focus.
- SAFE: removing a form field = drop its panel input + its FormData mapping in catalog.ts + its key in createProductSchema and the update `map` table (create-product.ts:576-613); leave the DB column (migrations frozen).
- SAFE: the inline promotions panel can be removed from the edit page without touching the promotions module; it is a pure consumer gated on promotions:*.
- LOAD-BEARING: millime conversion (priceFieldToMinor/dinarsToMinor) + the _cents=millimes convention — changing it corrupts every price.
- LOAD-BEARING: the `provided`-key guard in updateProductWorkflow (create-product.ts:486,623) — without it a partial save wipes content/links.
- LOAD-BEARING: stock compare-and-set + editedStockFields/variantStockFields — removing it resurrects sold units and fires false back-in-stock emails.
- LOAD-BEARING: variantsJson / faqItemsJson fold-in in updateProductAction (catalog.ts:1065-1103); id-stable replaceVariants (keeps cart/order variant refs).
- LOAD-BEARING: product.updated changedFields contract (drives cache bust, webhooks, audit, AI re-embed); emit it only on real changes.
- LOAD-BEARING: variable-can't-publish-without-variants + variable→simple demotion guards (create-product.ts:311,539,566) — prevent a dead-end PDP / price divergence.
- COUPLED: if you rename/remove name/slug/price/image/availability/condition/brand/category, update scripts/tokyo-export-catalog.ts too or the Tokyo storefront diverges.
- COUPLED: the Produits nav id `products` is reused by Drip & Exclusivité and Cartes cadeaux (admin-shell.tsx:134,137) — removing/renaming it affects their visibility.

**Gaps / risks**

- Export staleness: admin product edits do NOT appear on the live Tokyo storefront until scripts/tokyo-export-catalog.ts is manually re-run and products.json committed — no automation/subscriber triggers it.
- Tokyo storefront fabricates data: ratings (fakeRating), strike/compare-at prices (fakeStrike), warranty, specs and FAQ are invented from a slug hash in productMeta.ts — real rating/reviews_count and old_price_cents never reach the Tokyo PDP.
- Export is lossy: products.json carries only name/slug/first-image/display-price/availability/condition/brand/category; description, variants, SEO, video, old price, reviews are dropped.
- Admin list Stock column passes stockQty only for simple products (page.tsx:189); variable products show a flag-only pill.
- No un-delete UI: soft-deleted ('Supprimé') products are terminal in the panel; recovery is DB-only.
- Duplicate resets stock to 0 and clears SKU/GTIN/canonical — operator must re-enter before publishing.
- Best-effort fold-in: the product row can save ok while the folded-in variants/FAQ fail (action still returns ok:true with a caveat), so a variant/FAQ edit can be silently lost until retried.
- Variable product published with zero variants is a dead end (buy button but checkout refuses) — guarded in the workflow, but any new mutation path must preserve that guard.

</details>


---

## 2. Produits — AI generation & auto-assign suite

This subsection covers the AI content tooling attached to the catalogue: (A) **bulk product content generation**, (B) **bulk catalog-entity content generation** (a generalized twin for categories/brands/collections), (C) **AI auto-assign** (categorize / brands / attributes, which mutate *products*), and the **one-click per-field "Générer (IA)"** buttons on the editor forms. All of (A)–(C) run as **detached background job rows** (fire-and-forget promises writing to dedicated job/draft tables and polled by the client) — they are NOT `WorkflowResult`s and do not flow through `src/events` the way a normal mutation does. A shared per-item log feed (`ai_job_logs`) streams progress beside each panel.

A load-bearing fact established by code read (see **Storefront linkage**): **generated product *descriptions / FAQ / SEO* never reach the Tokyo storefront even after re-export** — the snapshot shape has no such columns. Only auto-assign *categorize* and *brands* reach Tokyo (after a manual re-export).

### What the operator sees & does

**(A) Bulk product content generation** — `ProductGenerationControl`, mounted `alwaysOpen` as a dedicated sub-view inside the Produits workspace (`src/app/admin/catalog/products/page.tsx:150`). Card titled « Génération de contenu en masse (IA) » (`product-generation-control.tsx:183`). Controls:
- **Périmètre** select: `Tout le catalogue` | `Une catégorie` | `Une marque` (`:217-226`); a dependent category or brand picker appears (`:228-259`).
- **Limiter à N produits** optional number (`:264-271`) — N random products from the resolved pool.
- **Champs à générer** chips, default all four selected: Description courte, Description complète, FAQ produit, Métadonnées SEO (`FIELD_LABELS :31-36`, default set `:62-64`).
- **Remplacer le contenu existant** checkbox (overwrite vs fill-empty) (`:298-309`).
- « Lancer la génération » button, disabled when `!aiEnabled` / busy / no field (`:313-321`).
- When no provider is ready, an amber banner: « Aucun fournisseur IA configuré. Activez-en un dans Système → IA & Automation. » (`:205-209`).
- After start: a polled progress bar (`AiJobProgress`, 2 s poll `:38,:79-95`), then a **review list**: one row per product with field chips (desc. courte / desc. complète / N FAQ / SEO `generatedChips :440-447`), a per-row checkbox, Tout cocher / Tout décocher (`:345-362`). « Appliquer à N produit(s) » fires a `window.confirm` that describes overwrite-vs-fill honestly from the *job's* stored setting, not the live checkbox (`:145-158`). Amber per-row `applyError` + a « N FAQ non appliquée(s) » warning when post-commit FAQ writes fail (`:389-391,:418-422`). Collapsible per-item log (`AiJobLog jobKind="product_gen" :429`).

**(B) Bulk entity content generation** — `ContentGenerationControl` (`content-generation-control.tsx`), the same UX but scope is implicit (whole entity type + optional N), fields are Description / Bloc éditorial / FAQ / SEO (`:31-36`). It is **not on the Produits page** — it is mounted on the Categories, Brands and Collections admin panels. Included here because it is the product generator's generalized twin and shares all plumbing.

**(C) AI auto-assign** — `AutoAssignControl` (`auto-assign-control.tsx`). Also **not on Produits** — mounted inline in the Categories (`kind="categorize"`), Marques (`kind="brands"`) and Attributs (`kind="attributes"`) pages (`categories-panel.tsx:336`, `brands-panel.tsx:256`, `attributes-panel.tsx:98`), but every run **reads and mutates products**. Flow (`:50-53`): config (scope `Produits non assignés` | `Tous les produits`, and for scope=all an existing-policy `Ignorer`/`Proposer sans cocher`/`Remplacer`) → **double confirm** (`StepConfirmModal` then a `ConfirmDeleteModal` warning « …consomme des jetons chez votre fournisseur IA » `:406-439`) → background **dry-run** (progress bar, polled 2.5 s `:55`) → **review report** with selectable proposals, confidence % chips (high ≥70 green), « nouvelle marque » / « réassignation » tags, Tout / Haute confiance / Aucun bulk buttons (`:797-808`), no-match/skipped/error `<details>` sections → single confirm → background **apply** → applied read-only report with summary chips. A "Analyses récentes" history lets the operator reopen a dry-run to « Réviser & appliquer » or an apply read-only (`:659-670`).

**(D) One-click per-field** — `AiGenerateButton` (`src/components/admin/_components/ai-generate-button.tsx`) appears on the product form fields (`product-form.tsx:1877,2168,2506,2791`, `product-variants-editor.tsx:424`) and the taxonomy forms. It calls `generateAiContentAction` and writes the result **into the form field in the browser**; nothing persists until the operator saves the product the normal way. Distinct from the detached bulk jobs.

Empty states: review list hidden until a job reports drafts; « Aucune proposition applicable » when a dry-run yields none (`auto-assign-control.tsx:821-825`).

### Routes & components

Admin pages (server components, RSC):
- `src/app/admin/catalog/products/page.tsx` — Produits page; self-heals a stale bulk-gen job on load (`failStaleRunning(15) :110`), resumes the newest in-flight OR completed-unapplied job (`:122-133`), mounts `ProductGenerationControl` only when `canManage` (`:148-174`).
- `src/app/admin/catalog/products/products-workspace.tsx` — client shell that owns show/hide of the generation sub-view (hence `alwaysOpen`).
- `categories/page.tsx` + `categories-panel.tsx`, `brands/page.tsx` + `brands-panel.tsx`, `collections/page.tsx`, `attributes/page.tsx` + `attributes-panel.tsx` — host `ContentGenerationControl` and/or `AutoAssignControl`.
- `src/app/admin/catalog/content-gen-job-view.ts` — `"server-only"` mapper `toContentGenJobView(row)` shared by the three entity pages to project an in-flight content-gen job for resume (`:12-27`).

Client controls (all `"use client"`):
- `src/components/admin/catalog/product-generation-control.tsx`
- `src/components/admin/catalog/content-generation-control.tsx`
- `src/components/admin/catalog/auto-assign-control.tsx`
- `src/components/admin/_components/ai-job-progress.tsx` (progress bar) and `ai-job-log.tsx` (collapsible log, polls `getAiJobLogsAction`, tail read of 650 lines `:28-30`).
- `src/components/admin/_components/ai-generate-button.tsx` (one-click).

Server Actions (`"use server"`):
- `src/lib/actions/product-generation.ts` — start / getReport / setDraftSelected / setAllSelected / apply.
- `src/lib/actions/content-generation.ts` — same five, generalized per entity type.
- `src/lib/actions/ai-assign.ts` — startDryRun / startApply / listJobs / getReport / setProposalSelection / bulkSelect.
- `src/lib/actions/ai-generate.ts` — `generateAiContentAction` (one-click).
- `src/lib/actions/ai-job-logs.ts` — `getAiJobLogsAction`.

Workflows / runners (`"server-only"`, detached):
- `src/workflows/catalog/product-gen/{run-product-generation,scope,parse,normalize}.ts`
- `src/workflows/catalog/content-gen/{run-content-generation,entity-adapter,scope,normalize,parse}.ts`
- `src/workflows/catalog/auto-assign/{ai,run-auto-assign-dry-run,run-auto-assign-apply}.ts`

Modules: `src/modules/catalog/product-gen/*`, `src/modules/catalog/content-gen/*`, `src/modules/ai-assign/*`, `src/modules/ai-jobs/*`, `src/modules/ai/*` (feature-prompts). AI plumbing: `src/lib/ai/{client,config,tasks,parse,providers}.ts`.

### Data model

Four dedicated table sets, no cross-module FKs (soft uuid links to `products`/better-auth `users`):

**`product_generation_jobs` / `product_generation_drafts`** (`product-gen/schema.ts`): job holds `status` (queued|running|completed|failed `:15`), `scope` jsonb (`{type: catalogue|category|brand, categoryId?, brandId?, count?}` `:19-25`), `settings` jsonb (`{fields: (description_short|description_full|faq|seo)[], overwrite}` `:28-42`), `processed/total/generated/inserted`, `created_by`. Draft holds `product_id`, `product_name`, `generated` jsonb (`ProductGenContent {shortDesc?, description?, faqs?, metaTitle?, metaDescription?}` `:44-51`), `selected` (default true), `applied`, `apply_error`. DB-only CHECK + the `product_generation_jobs_one_active` partial unique index (single-flight) + draft→job FK cascade live in **migrations 0064/0065** (not in the frozen drizzle snapshot `:11-13`).

**`catalog_content_gen_jobs` / `catalog_content_gen_drafts`** (`content-gen/schema.ts`): same shape plus an `entity_type` discriminator (category|brand|collection `:21-22`); fields are `description|editorial|faq|seo`; `generated` jsonb has `{description?, editorial?, faqs?, metaTitle?, metaDescription?}`. The one-active partial unique index is **per entity_type** (`catalog_content_gen_jobs_one_active`, migration 0106 `:14`).

**`ai_assign_jobs` / `ai_assign_proposals`** (`ai-assign/schema.ts`): job holds `kind` (categorize|brands|attributes `:34`), `phase` (dry_run|apply `:35`), `status`, `scope` (all|unassigned), `existing_policy` (skip|suggest|overwrite), `processed/total/applied_count`, `summary` jsonb (`AiAssignSummary`, rolled-up counters `:44-68`), `source_job_id` (apply→dry-run link). Proposal holds `product_id/name/slug`, `action` (assign|reassign|skip|no_match|error `:42`), `skip_reason`, `current_summary`, `proposed` jsonb (discriminated union: categorize = leaf + full root→leaf `trail`; brands = brandName/slug + `existingBrandId`/`willCreate`; attributes = additive `picks[]` `:87-120`), `confidence` (0-100), `reason`, `selected`, `applied`, `apply_error`. Partial unique index `ai_assign_jobs_one_active_per_kind` + proposal→job FK cascade in **migration 0027** (`:158-160`).

**`ai_job_logs`** (`ai-jobs/schema.ts`): append-only per-item feed keyed by `(job_kind, job_id)` where `job_kind ∈ {product_gen, review_gen, auto_assign, content_gen}` (`:10`); no FK (three possible parents `:5-8`); level/step/message/item_ref; migration 0071.

**`ai_feature_prompts`** (`ai/schema.ts`): admin per-`(feature, task)` prompt/provider/model/enabled overrides; the *catalog of tasks + default prompts* lives in code at `src/lib/ai/tasks.ts` (feature ids `produits`, `categories`, `marques`, `collections`, `attributs`, `avis`; task ids `description_short/full/faq/seo/categorization/related/attributes/variants`, the taxonomy content tasks, and the `auto-categorize`/`auto-assign`/`auto-attribute` pickers).

Written-to product columns (apply path): `products.short_desc, description, meta_title, meta_description` + the per-product `faqs` table; category/brand links via `src/associations/catalog.service.ts`; attribute values via `attributeService.addProductAttributeValues`. Content-gen writes `description, editorial_body, meta_title, meta_description` on the entity + its FAQ table.

Invariants: money/uuid-v7/soft-delete conventions are untouched here. `selected` defaults true for drafts; for proposals, `selected` is set by action + policy at dry-run time (`assign`→true, `reassign`→`policy==='overwrite'`, attributes additive always `assign` `run-auto-assign-dry-run.ts:174,293,404-414`). Only `assign|reassign` proposals are applicable/selectable (`service.ts:24,275-286`).

### Read path

Not RSC `lib/api` reads — the panels **poll server actions**:
- Product-gen: `getProductGenerationReportAction(jobId)` → `productGenerationService.findJob` + `listDrafts` (ordered by product_name, uncapped) (`product-generation.ts:134-142`, `service.ts:133-139`). The Produits page pre-loads the newest job for resume via `listRecentJobs(1)` (`page.tsx:107`).
- Content-gen: `getContentGenerationReportAction` (guards non-UUID, then entity-type view perm) → `findJob` + `listDrafts` (`content-generation.ts:165-181`). Entity pages resume via `contentGenerationService.listRecentJobs(entityType, 1)` + `toContentGenJobView`.
- Auto-assign: `getAutoAssignReportAction` → `listProposals` (**capped at 2000**, applicable rows get the budget first because NULL-confidence skip/error rows sort first under `DESC` `service.ts:192-227`) **plus** `countProposals` (UNCAPPED tallies `:229-256`). The control's « x/y sélectionnés » and « Appliquer (n) » labels always read the uncapped `counts`, not the rendered page (`auto-assign-control.tsx:146,775-776`). `listAutoAssignJobsAction(kind)` → `listRecent(kind, 10)` drives polling + history.
- Logs: `getAiJobLogsAction(jobKind, jobId)` → `listTail` (newest 650, returned oldest-first; terminal summary/truncation lines are written last so a tail read always shows them `ai-jobs/service.ts:76-89`).

Pagination: none in these panels — drafts are listed whole; proposals are a single capped page with uncapped counts. The *product list itself* paginates normally (`productService.listAdminPaged`, out of scope).

### Write path

**Start (all three):** `requirePermission(...)` → per-actor rate-limit `ai:bulk:<userId>` max 10/hour (degrade-OPEN + logged on limiter error `product-generation.ts:93-105`, same bucket shared by content/auto-assign/review `content-generation.ts:120-135`, `ai-assign.ts:108-119`) → `failStaleRunning(15)` janitor → `pruneOld(30)` → single-flight `hasActive()` gate → `createJob(...)` (race closed by the one-active partial unique index; the loser catches `isUniqueViolation` → BUSY) → **fire-and-forget** `void run...DryRun(job.id).catch(failJob)` (never awaited) → returns `{jobId}`. The client then polls.

**Product dry-run** (`run-product-generation.ts:67-235`): guard `status==='queued'` → `resolveFeatureRunner("produits", field)` once per field (`auto-assign/ai.ts:34-53`; resolves merged prompt + provider from `getFeaturePrompt` ∪ first configured+enabled provider) → `resolveProductScope` (dedupe; `count` takes N random; hard ceiling `MAX_BULK_SCOPE=2000` `scope.ts:7,41-47`) → `markRunning(total)` → `mapWithConcurrency(AI_CONCURRENCY=4)` per product, per field `runFeatureTask` at temp 0.6 with per-field token caps (`FIELD_TOKENS`: desc_short 400, desc_full 1600, faq 1500, seo 700 `:45-55`) → **truncated replies are refused** (`:156-164`) → `applyFieldToContent` parses/clamps into the draft (short_desc ≤600, description ≤8000, ≤8 FAQ, meta_title ≤70, meta_desc ≤165 `parse.ts`) → buffer-flush drafts every 40, progress every 5, capped log (600) → `completeJob`. **Writes nothing onto products.**

**Product apply** (`applyProductDrafts :245-376`, called by `applyProductGenerationAction` attributing events to the *applier* `:166-171`): re-checks completed + `hasAppliedDrafts` fast-fail → `db.transaction`: `claimSelectedDrafts` (atomic `applied=true RETURNING` — the real double-apply guard `:266`, `service.ts:152-164`) → per product build a patch honoring overwrite-vs-fill (`wantText :285`) → `productService.update(id, patch, tx)` one UPDATE per row → `setInserted`. **FAQs are collected and written POST-commit** (own table/own tx), best-effort; a failure stamps the draft `apply_error` and increments `faqFailed` but never rolls back the text (`:340-362`). Post-commit `bus.emit("product.updated", …)` per touched product for cache/search refresh + audit (`:365-373`).

**Content-gen** mirrors this exactly via `CONTENT_GEN_ADAPTERS[entity_type]` (`entity-adapter.ts`) which supplies `feature`, `context`, `findByIds`, `applyText`, `replaceFaqs`, `idsWithFaqs`, `emitUpdated` per category/brand/collection (`:107-147`).

**Auto-assign dry-run** (`run-auto-assign-dry-run.ts`): branches by kind. Loads **all** candidate categories (active only) / brands / active value-list attributes, builds a text `candidateBlock` fed into the prompt, asks the model for a slug + confidence + reason, parses JSON (`extractJson`), maps to a `proposed` payload, tallies a summary, buffers proposal inserts (chunk 200), progress every 8, concurrency 5. `pickCandidates` applies scope + existing-policy (`:553-572`). **No product is mutated.** Note: this is **pure LLM classification over a prompt candidate list — NOT embeddings/pgvector** (see Gaps).

**Auto-assign apply** (`run-auto-assign-apply.ts`, via `startAutoAssignApplyAction`): re-checks `system_ai:manage` AND `products:update` (`ai-assign.ts:162-169`), source is a completed dry-run, `countSelectedApplicable>0`, `hasApplyForSource` (no duplicate apply) → new `phase:"apply"` job → runner processes selected `assign|reassign` proposals **sequentially** (so a newly-created brand is reused, and to not race the one-primary-category / one-brand constraints `:18-27`). Each target is **re-validated against the live catalog** (categories may be deleted/deactivated, values may be gone `:155-228`); brands missing on apply are created via `createBrandWorkflow`; attributes merge additively. Per-product failure is recorded (`markProposalApplied` with error) and the run continues. Post-commit `product.updated` fan-out per touched product (`:144-152`). There is **no single wrapping transaction** for the apply (unlike product/content-gen).

Revalidation: these flows don't call `revalidatePath`; freshness comes from `product.updated`/`*.updated` bus events → cache/search subscribers, and the panels re-fetch their own report after apply.

### RBAC

Every start/apply action opens with `requirePermission` (enforced by route-invariants.test.ts):
- **Product-gen**: start/apply/select gated `products:manage` (`product-generation.ts:86,149,159,166`); reads (report) `products:view` (`:137`). `manage` exists on the `products` registry row specifically for bulk AI (`registry.ts:66-68`).
- **Content-gen**: categories/brands/collections have only CRUD (no `manage`), so gated `<entity>:update` for start/select/apply, `<entity>:view` for reads (`content-generation.ts:39-53`). Job-id actions use an auth-first coarse `requirePermissionAny(ANY_UPDATE/ANY_VIEW)` then the per-entity check once the job's type is known (`:49-53,170-178`).
- **Auto-assign**: dry-run start, selection, list, report gated `system_ai:{manage|update|view}` (`ai-assign.ts:102,222,240,255,267`); **apply additionally requires `products:update`** because it rewrites the catalogue (`:162-169`). The host pages show the control to `system_ai:view` holders and pass `canManage = system_ai:manage` so a view-only operator sees disabled buttons instead of a 404 (`categories/page.tsx:32-36`, `auto-assign-control.tsx:107-114`).
- **One-click** (`ai-generate.ts`): gated on the *content* permission of the feature (`produits→products:update`, etc. `:20-27`), NOT `system_ai` — a content editor can use « Générer » without key-management rights. Provider/prompt config stays on `system_ai`.

Reused-id note: the "Catalogue" group reuses the `products` id for Drip + Cartes-cadeaux, but that does not touch this suite — bulk product-gen uses `products:manage`, content-gen uses the entity's own id, auto-assign uses `system_ai` + `products:update`.

### Storefront linkage

**This is the critical, non-obvious part.** The live Tokyo storefront reads catalog display data from the bundled JSON snapshot `src/storefront/data/{products,categories,taxonomy}.json`, regenerated only by manually re-running `scripts/tokyo-export-catalog.ts`. Code-read of that export (`scripts/tokyo-export-catalog.ts:26-104`):

- The exported `RawProduct` shape carries **only** `id, slug, title, link, image, price, currency, availability, condition, brand, category, product_type, category_path` — **no description, short_desc, FAQ, meta_title, meta_description, editorial, or attribute values**.
- `categories.json` carries only `{slug, label, count}`; `taxonomy.json` only `{slug, name, count, children}` — **no entity description/editorial/FAQ/SEO**.
- Tokyo category SEO and product meta are **hard-coded/fabricated client-side** (`src/storefront/lib/categorySeo.ts`, `productMeta.ts`), not from DB-generated content.

Therefore, per tool:
- **Bulk product content-gen (A)**: generated descriptions/FAQ/SEO land on `products.*` + the `faqs` table in the DB, but **never appear on the Tokyo storefront — not even after a re-export**, because the snapshot has no such fields. They surface only in **admin**, in the **legacy (shell) storefront** (DB-live), and in DB-live SEO/structured-data routes. Operator trap: "I bulk-generated descriptions but the Tokyo product page shows nothing."
- **Bulk entity content-gen (B)**: same — category/brand/collection descriptions/editorial/FAQ/SEO are not in the snapshot; invisible on Tokyo.
- **Auto-assign categorize (C)**: writes product→category links → snapshot carries `category/category_path/product_type` + the taxonomy tree, so after re-export this **does change Tokyo** (product filing, mega-menu counts).
- **Auto-assign brands (C)**: writes product→brand link → snapshot carries `brand`, so after re-export this **does reach Tokyo**.
- **Auto-assign attributes (C)**: writes product→attribute-value links → snapshot carries no attributes → **invisible on Tokyo**.

In all cases the change is invisible on Tokyo until `scripts/tokyo-export-catalog.ts` (+ `tokyo-build-categories.ts`) is re-run and the JSON committed.

### Edit / remove notes

- **Load-bearing (do not casually remove):** the single-flight `hasActive()` + `failStaleRunning` + the one-active partial unique indexes together prevent concurrent/orphaned bulk runs; the `claimSelectedDrafts` atomic claim is the real double-apply guard; the `truncated`-reply refusal prevents storing half-HTML/unparseable JSON; `MAX_BULK_SCOPE`/`MAX_SCOPE_COUNT` and the `ai:bulk` rate limit are the cost ceilings. Removing any weakens cost/safety.
- **Safe to tune:** `FIELD_TOKENS`, `AI_CONCURRENCY`, `PROGRESS_EVERY`, `DRAFT_FLUSH`, `LOG_CAP`, poll intervals, the parse clamps, and the default prompts in `tasks.ts` / per-task overrides in `ai_feature_prompts` (editable from Système → IA via `system_ai:update`).
- **To remove a whole tool cleanly:** unmount its control (products workspace / entity panels), delete its action + runner + module, and drop its `ai_job_logs` kind from `AI_JOB_KINDS`. Because these are **detached job rows, not WorkflowResults**, removing a tool does not touch `src/workflows/*` mutation API used elsewhere — but the tables' DB-only objects live in hand-authored migrations (0064/0065/0106/0027/0071), which must be handled manually (migrations are frozen; do NOT `db:generate/db:push`).
- The **one-click** path (D) is independent of the bulk jobs; you can remove bulk (A) while keeping one-click, and vice-versa. `AiGenerateButton` only populates the form; persistence is the normal product-update action.
- `ContentGenerationControl` and `AutoAssignControl` are physically on the *sibling* catalogue pages (categories/brands/collections/attributes), not on Produits — edits to the Produits page affect only tool (A) and the one-click buttons.

### Gaps & risks

1. **Tokyo invisibility of generated text (biggest trap):** product and entity descriptions/FAQ/SEO generated by this suite do not reach the Tokyo snapshot regardless of re-export; only categorize + brands auto-assign do. An operator spending paid AI tokens on bulk descriptions will see zero effect on the live storefront.
2. **Dry-run cost without apply rights:** auto-assign is shown to `system_ai:view` and runnable by `system_ai:manage`, but apply additionally needs `products:update`. A `system_ai:manage` holder *without* `products:update` can fire a whole-catalogue dry-run (one paid AI call per product) yet be blocked from applying — paid cost with no payoff.
3. **No AI master kill-switch:** `aiEnabled`/`hasReadyAiProvider` is only a coarse UX gate ("≥1 provider configured+enabled" `config.ts:152-155`); the runner re-validates. There is no global "AI off" flag — disabling is per-provider or per-task `enabled`.
4. **Rate-limit degrades open:** the `ai:bulk` cap (10/hour/actor, shared across product/content/auto-assign/review) is bypassed if the limiter store errors (`catch → {ok:true}`), so a limiter outage removes the only per-actor fan-out ceiling; only `MAX_BULK_SCOPE=2000` and the single-flight gate remain.
5. **Unbounded prompt candidate block:** auto-assign feeds *every* active category / *every* brand / *every* active value-list attribute into the prompt as text (`run-auto-assign-dry-run.ts:99,195,328`). It uses **no embeddings/pgvector** (that lives separately in `src/modules/search/*`). A large taxonomy can bloat the prompt/context and cost, and there is no size cap on the candidate block (unlike the one-click `MAX_CONTEXT_CHARS`).
6. **FAQ apply is post-commit, non-transactional:** a FAQ write failure leaves text applied but FAQ missing; surfaced only as an amber `apply_error` + a `faqFailed` count — easy to miss on a large run.
7. **Auto-assign apply has no wrapping transaction** (sequential per-product); a mid-run crash leaves a partially-applied job (proposals individually flagged `applied`), recoverable only by inspection — the duplicate-apply guard (`hasApplyForSource`) then blocks a clean retry of the remainder.
8. **Detached-runner orphans:** a server restart mid-run orphans a `running`/`queued` job holding the one-active index until the next start triggers `failStaleRunning(15)`; the Produits page self-heals on load (`page.tsx:110`) but the entity/auto-assign pages rely on the next action to run the janitor.
9. **Frozen migrations:** the CHECK constraints, one-active indexes and FK cascades are not in the drizzle snapshot (frozen at 0007); editing these `schema.ts` files will not regenerate them — they must be hand-authored, and dropping a table requires removing its migration-defined objects by hand.


<details>
<summary><strong>2. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/catalog/product-generation-control.tsx — client control for bulk product content gen (Produits page), alwaysOpen sub-view; poll→review→apply
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/catalog/content-generation-control.tsx — generalized twin for category/brand/collection content gen (NOT on Produits)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/catalog/auto-assign-control.tsx — categorize/brands/attributes auto-assign; double-confirm dry-run→report→apply (mounted on sibling pages, mutates products)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/content-gen-job-view.ts — server-only row→view mapper for content-gen job resume
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/product-generation.ts — product-gen actions; products:manage, ai:bulk rate limit, janitor, single-flight
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/content-generation.ts — content-gen actions; <entity>:update gating, per-entity-type single-flight
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/ai-assign.ts — auto-assign dry-run/apply/list/report; system_ai + products:update for apply
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/ai-generate.ts — one-click per-field generateAiContentAction; feature-content permission, truncation refusal
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/product-gen/run-product-generation.ts — detached dry-run runner + transactional applyProductDrafts (FIELD_TOKENS, FAQ post-commit)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/product-gen/{scope.ts,parse.ts,normalize.ts} — scope resolve (MAX_BULK_SCOPE 2000), pure field parser/clamp, input normalizers (MAX_SCOPE_COUNT 1000)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/content-gen/run-content-generation.ts + entity-adapter.ts — generalized runner + per-entity adapter map (feature/context/applyText/replaceFaqs/emitUpdated)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/auto-assign/{ai.ts,run-auto-assign-dry-run.ts,run-auto-assign-apply.ts} — AI resolver/runner (prompt candidate block, no embeddings), sequential apply with live re-validation
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/product-gen/{schema.ts,service.ts,index.ts} — job/draft tables + store (claimSelectedDrafts atomic apply guard, pruneOld/failStaleRunning)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/content-gen/{schema.ts,service.ts} — entity_type-discriminated job/draft tables + per-type single-flight
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/ai-assign/{schema.ts,service.ts} — ai_assign_jobs/proposals, proposed-union, capped listProposals + uncapped countProposals, bulkSelect
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/ai-jobs/{schema.ts,service.ts} — ai_job_logs append-only per-item feed (job_kind set), tail read
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/ai/feature-service.ts — getFeaturePrompt (DB override ∪ tasks.ts default), ai_feature_prompts CRUD
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/ai/config.ts — resolveAiProviderConfig + hasReadyAiProvider (the coarse aiEnabled gate), listAiProviderStatus
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/ai/tasks.ts — single source of truth for AI feature/task catalog + default French prompts (produits/categories/marques/collections/attributs tasks)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/products/page.tsx — mounts ProductGenerationControl (canManage), self-heal + resume job logic
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/categories/{page.tsx,categories-panel.tsx} — mounts ContentGenerationControl + AutoAssignControl(kind=categorize), system_ai:view/manage gating (pattern repeated in brands/attributes panels)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/rbac/registry.ts — products:manage (line 68), system_ai:view/update/manage (168), entity CRUD (75-79)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/scripts/tokyo-export-catalog.ts — THE storefront linkage: RawProduct/categories/taxonomy shapes omit description/FAQ/SEO/attributes; only brand+category reach Tokyo
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/_components/{ai-job-log.tsx,ai-generate-button.tsx} — log viewer (polls getAiJobLogsAction) and one-click button

**Sources of truth**

- Job/draft/proposal state: the four dedicated tables product_generation_jobs/drafts, catalog_content_gen_jobs/drafts, ai_assign_jobs/proposals, ai_job_logs — detached job rows, NOT WorkflowResults and not the src/events bus state
- The TRUE mutation API for applying generated content = applyProductDrafts / applyContentDrafts (db.transaction + claimSelectedDrafts) and runAutoAssignApply (sequential, per-product, no wrapping tx)
- RBAC source of truth = requirePermission guards in the four action files + src/lib/rbac/registry.ts (grants live in DB)
- AI task catalog + default prompts = src/lib/ai/tasks.ts; admin overrides = ai_feature_prompts via getFeaturePrompt
- AI provider availability/aiEnabled = src/lib/ai/config.ts hasReadyAiProvider (coarse gate; runner re-validates per task)
- Tokyo storefront display data = bundled JSON snapshot src/storefront/data/{products,categories,taxonomy}.json, regenerated ONLY by scripts/tokyo-export-catalog.ts; its field shape is the source of truth for what generated content can ever appear on Tokyo
- Per-item progress/log = ai_job_logs read via aiJobLogService.listTail / getAiJobLogsAction
- Contract/tests: src/lib/db/tests/** (no OpenAPI); DB-only objects (CHECKs, one-active partial unique indexes, FK cascades) in hand-authored migrations 0064/0065/0106/0027/0071, not the frozen drizzle snapshot

**Editable / removable**

- Tunable without structural risk: FIELD_TOKENS (per-field output caps), AI_CONCURRENCY/PROGRESS_EVERY/DRAFT_FLUSH/LOG_CAP, poll intervals (POLL_MS 2000 / 2500), parse clamps in product-gen/parse.ts, and the default prompts in tasks.ts or per-task overrides in ai_feature_prompts (Système → IA, system_ai:update)
- Cost ceilings are editable but load-bearing: MAX_BULK_SCOPE (2000, scope.ts), MAX_SCOPE_COUNT (1000, normalize.ts), the ai:bulk rate limit (10/hour/actor) — lowering is safe, removing weakens cost control
- Removable as a unit: any single tool (A/B/C) by unmounting its control, deleting its action+runner+module, and dropping its kind from AI_JOB_KINDS — but its tables' DB objects live in frozen hand-authored migrations and must be handled manually (no db:generate/db:push)
- The one-click AiGenerateButton path (generateAiContentAction) is independent of the bulk jobs — removable/keepable separately; it only populates the form, no job rows
- ContentGenerationControl and AutoAssignControl are mounted on the sibling catalogue pages (categories/brands/collections/attributes), not on Produits — editing the Produits page affects only ProductGenerationControl and the product-form one-click buttons
- Do NOT casually remove: single-flight hasActive()+one-active unique indexes, failStaleRunning janitor, claimSelectedDrafts atomic claim (double-apply guard), the truncated-reply refusal, and the live re-validation in runAutoAssignApply — each is a correctness/cost safety
- Changing these tables' schema.ts will NOT regenerate the CHECK/index/FK objects (migrations frozen at 0007) — hand-author migrations

**Gaps / risks**

- TOKYO INVISIBILITY: generated product descriptions/FAQ/SEO and all entity content never reach the Tokyo snapshot even after re-export (RawProduct/categories/taxonomy shapes in tokyo-export-catalog.ts omit those columns). Only auto-assign categorize + brands reach Tokyo after a manual re-export; auto-assign attributes does not. Operators can spend AI tokens for zero Tokyo effect.
- Dry-run cost without apply rights: a system_ai:manage holder lacking products:update can fire a whole-catalogue auto-assign dry-run (one paid AI call per product) but is blocked at apply (ai-assign.ts:162-169) — paid cost, no payoff.
- No AI master kill-switch: aiEnabled/hasReadyAiProvider is only a coarse UX gate; disabling AI means disabling providers or per-task enabled flags. Runner re-validates per task.
- Rate limit degrades OPEN on limiter-store error (catch→{ok:true}) in all bulk start actions, removing the only per-actor fan-out cap; only MAX_BULK_SCOPE + single-flight remain.
- Auto-assign uses NO embeddings/pgvector — it feeds every active category/brand/attribute as a text candidate block into the prompt (unbounded; no size cap unlike one-click MAX_CONTEXT_CHARS). Large taxonomies bloat prompt/context and cost. (Semantic/pgvector lives separately in src/modules/search/*.)
- FAQ apply is post-commit and non-transactional: a FAQ failure leaves text applied but FAQ missing, surfaced only as amber apply_error + a faqFailed count — easy to miss at scale.
- runAutoAssignApply has no wrapping transaction (sequential per-product); a mid-run crash leaves a partially-applied job, and hasApplyForSource then blocks a clean retry of the remainder.
- Detached runners orphan a running/queued job on server restart until failStaleRunning(15) runs on the next start; entity/auto-assign pages rely on the next action to invoke the janitor.
- Migrations frozen at 0007: CHECKs, one-active partial unique indexes and FK cascades (migrations 0064/0065/0106/0027/0071) are not in the drizzle snapshot — editing schema.ts won't regenerate them; table removal needs manual migration work.

</details>


---

## 3. Stock — inventory, locations, ERP, transfers, settings

The whole subsection is ONE admin page (`/admin/catalog/stock`) with five sub-tabs. The old `/admin/catalog/locations` route is a pure redirect into the Emplacements tab. Backend spans three NO-cross-FK modules (`stock-location`, `stock-movement`, `stock-transfer`), three Server-Action files, and stock logic embedded in the order workflow/event subscribers. All of it is gated on the single `stock` RBAC id.

### What the operator sees & does

**Shell.** `stock-tabs.tsx` renders a `FormTabStrip` with five tabs: **Inventaire** (default), **Emplacements**, **Transferts**, **ERP**, **Réglages** (`stock-tabs.tsx:18-20,69-75`). All five panels are kept MOUNTED and toggled with `hidden` so unsaved inventory edit-drafts survive a peek at another tab (`stock-tabs.tsx:89-104`). Tab badges carry at-a-glance status computed server-side: Emplacements → `"N actif(s)"`/`"partagé"`, Transferts → `"N en cours"`/`"désactivés"`, ERP → `"ERP maître"`/`"Plateforme"`/`"Mixte"`/`""` (`page.tsx:182-197,202-219`). A legacy `…/stock#emplacements` hash is synced to the tab on the client (`stock-tabs.tsx:60-68`); `?tab=emplacements` (the locations redirect) opens it server-side (`page.tsx:78-80`).

**Inventaire** (`stock-panel.tsx`) — the global inventory editor over EVERY non-deleted product, 50/page.
- Single-pool table columns: Produit (name links to `/admin/catalog/products/{id}`, slug, read-only `ERP <external_ref>` line via `ErpRef`), SKU, Prix (`formatMoneyWithCurrency`), **Disponible** (checkbox), **Quantité** (number, floored to non-neg int), **Statut** pill (`stock-panel.tsx:510-543`). Pills: Modifié / Rupture / Bas / OK / Brouillon, derived from `isEffectivelyOutOfStock`/`isLowStock` (`stock-panel.tsx:763-783`).
- A `variable` product NOT in shared mode renders as a collapsible parent row (Σ total read-only, `anyInStock` ✓) that expands to per-variant editable rows (`stock-panel.tsx:657-743`). Simple + shared-variable products edit the single product-level pool.
- Toolbar: search (name OR sku) + filter chips Tous / En stock / Bas (≤N) / Rupture / Non suivi. The "Bas" chip label carries the operator's configured threshold and is hidden when the threshold ≤ 0 unless it's the active filter (`stock-panel.tsx:105-111,172-245`).
- Dirty-state: edits are tracked GLOBALLY against a per-key `baseline` captured at first edit, so drafts made on other pages/filters are not lost and are still saved (`stock-panel.tsx:353-461`). Save posts `bulkUpdateStockAction` (shared pool) / `setLocationLevelsAction` (multi-location), fail-soft: only committed rows are cleared, failed rows stay dirty (`stock-panel.tsx:420-461,863-887`).
- Banners: ERP-authoritative warning when `erpConfig.pullStock` ("stock piloté par l'ERP… écrasées lors de la synchronisation") (`stock-panel.tsx:156-164`); read-only banner without `stock:update` (`stock-panel.tsx:305-311`).
- Multi-location mode (`inventory.location_mode = per_location`): a quantity cell per ACTIVE location with a frozen product column; each row shows **Total** (authoritative `stock_qty`) → projected-after-save, status pill, and an **Écart** badge when Σ(levels) ≠ total; variants roll up (`stock-panel.tsx:787-1265,995-1019`). Empty state: "Aucun produit pour ces critères."

**Emplacements** (`inventory-locations-card.tsx` → `locations-panel.tsx`) — locations CRUD. Each row: name, Défaut/Inactif badges, code (ERP ref), units count, carrier label. Actions: Set default (active-only), edit, delete. Create/edit form: name (req), code (opt), carrier/pickup select (only when `carrier_link_enabled`), active checkbox (default location can't be deactivated) (`locations-panel.tsx:318-431`). Delete-with-stock opens an options panel: **Transférer vers** another active location, or **Retirer le stock (writeoff)** (`locations-panel.tsx:252-313`). Empty state: "Aucun emplacement."

**Transferts** (`transfers-panel.tsx`) — inter-location moves list. Disabled empty-state when `transfers_enabled` off. Status filter chips with all-data counts; create form (from/to selects, debounced product search → variant picker for per-variant products, line qty inputs, note) (`transfers-panel.tsx:460-723`); per-row forward actions by status (Accepter/Expédier/Réceptionner/Annuler) with confirm copy on the two terminal transitions (`transfers-panel.tsx:33-73,206-233`); expand to load items; print Bon de transfert into a hidden iframe (`transfers-panel.tsx:90-124`). Needs ≥2 active locations to create (`transfers-panel.tsx:580-586`).

**ERP** (`erp-panel.tsx`) — posture radio cards off/platform/erp/mixed; mixed-only push/pull stock toggles; transfers-notify toggle; warranty push/pull toggles. A prominent amber disclaimer states the posture is RECORDED but authority enforcement is "Phase 2"; only `/api/stock` + `stock.*`/`stock.transfer.*`/`warranty.claim.*` webhooks are live today (`erp-panel.tsx:45-173`). Endpoint reference links to `/admin/system/api`.

**Réglages** (`reglages-panel.tsx`) — three self-contained settings forms, each with its own save: variant-stock default toggle (`SharedStockToggle`), `InventorySettingsCard` (location mode + carrier link + transfers + auto-request + sourcing), `StockAlertSettings` (enabled + threshold + recipients) (`reglages-panel.tsx:26-50`).

### Routes & components

- `src/app/admin/catalog/stock/page.tsx` — **Server Component**, the only data-fetching entry. Guards `stock:view`, resolves `canManageStock = stock:update`, reads filters/paging/tab from `searchParams`, issues `listStockPaged` + locations + levels + transfers + settings, and fans everything into the five panels (`page.tsx:51-297`).
- `stock-tabs.tsx` — **client** tab shell.
- `stock-panel.tsx` — **client**, `StockPanel` → `SinglePoolPanel` / `MultiLocationPanel` + `StockRow`/`MultiLocationRow`/`Toolbar`/`Pager`/`Pill`.
- `inventory-locations-card.tsx` — **client** wrapper rendering `LocationsPanel`.
- `locations-panel.tsx` — **client**, `LocationsPanel` + `LocationRow` + `LocationForm` (exports `CarrierOption`, `LocationView`).
- `transfers-panel.tsx` — **client**, `TransfersPanel` + `TransferRowView` + `CreateTransferForm` + `printTransferSlip` + `StatusPill`.
- `erp-panel.tsx`, `reglages-panel.tsx`, `inventory-settings-card.tsx`, `shared-stock-toggle.tsx`, `stock-alert-settings.tsx` — **client** settings forms.
- `src/app/admin/catalog/stock/transfers/[id]/print/page.tsx` — **Server Component**, read-only printable Bon de transfert, guards `stock:view`, never mutates; bare printable layout matched in `admin-shell.tsx:389-390`.
- `src/app/admin/catalog/locations/page.tsx` — **Server Component** that only `redirect("/admin/catalog/stock?tab=emplacements")`; `locations-panel.tsx` lives in this folder but is imported by the stock page.
- Sidebar: Catalogue group, item `{ id: "stock", href: "/admin/catalog/stock" }` (`admin-shell.tsx:124`). No separate Emplacements/Transferts nav entry.

### Data model

Modules carry NO cross-module FKs; variant/product/order/location links are soft uuid/text columns.

- **`stock_locations`** (`stock-location/schema.ts:20-46`): `id`(uuidv7), `name`, `code`(opt, partial-unique WHERE not-null & not-deleted), `carrier_ref`(soft text link to a delivery agent/pickup), `is_default`, `is_active`, `display_order`, timestamps, soft-delete. Invariant: at most ONE default store-wide (`stock_locations_one_default` partial unique).
- **`stock_levels`** (`stock-location/schema.ts:61-87`): `id`, `location_id`, `product_id`, `variant_id`(NULL = product pool; uuid = per-variant level), `qty`(non-neg, CHECK in migration). Two partial uniques split the pool row from per-variant rows. This is the SoT for per-location quantities; the product/variant `stock_qty` is the cached Σ across ACTIVE locations.
- **`stock_movements`** (`stock-movement/schema.ts:20-62`): append-only ledger, one row per change, same tx as the mutation. `delta`(signed), `resulting_qty`(on-hand after; null=untracked), `reason`, `order_id`, `location_id`(soft), `actor_user_id`(text), `note`, `created_at`. **Reasons** (`stock-movement/schema.ts:20-29`): `order` | `cancellation` | `refund` | `return` | `api_delta` | `api_set` | `admin` | `transfer`. Never updated/deleted — corrections are new rows; opening balances NOT ledgered.
- **`stock_transfers`** (`stock-transfer/schema.ts:35-80`): `id`, `ref`(int from `stock_transfer_ref_seq`, unique, displayed `TR-<ref>`), `from_location_id`/`to_location_id`(soft), `status`(free text + app-enforced transitions), `source`(`manual`|`auto`), `order_id`(soft, order-driven only), `note`, `requested_by`(text), lifecycle timestamps (`accepted_at`/`dispatched_at`/`completed_at`/`cancelled_at`), `cancel_reason`, timestamps, soft-delete. **Statuses** (`:20-26`): `requested` → `accepted` → `in_transit` → `completed` | `cancelled`. `TRANSFER_TERMINAL = [completed, cancelled]`.
- **`stock_transfer_items`** (`stock-transfer/schema.ts:90-105`): `id`, `transfer_id`, `product_id`, `variant_id`(NULL = pool), `qty`. Same (product,variant) grain as `stock_levels`.
- **Joined, owned elsewhere** (`catalog/product/schema`): `products.stock_qty` / `product_variants.stock_qty` are the AUTHORITATIVE sellable total (NULL = untracked/unlimited); `in_stock` carries two meanings — sold-out vs deliberately-delisted — re-derived by the shared `nextInStockForQty` rule (`in-stock-rule.ts:28-37`). `products.external_ref`, `products.sku`, `products.shared_variant_stock` (NULL = inherit global default), `products.product_type`.
- **Settings keys** (strings in `site_settings`, resolved by pure config modules): `inventory.location_mode`, `inventory.carrier_link_enabled`, `inventory.transfers_enabled`, `inventory.transfer_auto_request`, `inventory.transfer_sourcing_strategy` (`locations-config.ts:12-16`); `stock.alert_enabled`, `stock.low_threshold_qty`, `stock.alert_recipients` (`stock-alert-settings.tsx`); `erp.sync_mode`, `erp.push_stock`, `erp.pull_stock`, `erp.push_transfers`, `erp.push_warranty`, `erp.pull_warranty` (`erp-config.ts:21-29`). The variant-stock default is NOT a setting — it lives in `app_secrets.catalog.variant_stock_shared_default` (`variant-stock.ts:26`).
- **Key invariants**: `stock_qty` = Σ(active-location levels) is maintained delta-wise (`nextTotalForLevelWrite`, `level-total.ts:15-24`), NEVER recomputed as Σ(levels) by (de)activation (would resurrect units sold since the last matrix edit); a TRANSFER leaves `stock_qty` invariant (units just relocate); sales/returns/API move only `stock_qty` while per-location decrement happens at SHIP (ship-depot-decrement) — hence the "Écart" drift badge.

### Read path

- Inventaire list: `productService.listStockPaged({search, filter, lowThreshold, page, pageSize:50})` (`page.tsx:86-95`, impl `catalog/product/service.ts:202-240`) — filters pushed into SQL via the shared `stockStateSql` (`catalog/product/queries.ts:191-202`) with a TRUE total count; stable `created_at DESC, id DESC` order. Variable products' variants loaded via `productQueries.listVariantsForProducts` (`page.tsx:100-105`, `queries.ts:253-271`).
- Multi-location levels: `stockLocationService.listLevelsForProducts(ids)` keyed `productId` / `productId:variantId` (`service.ts:234-253`), only when per_location.
- Locations: `stockLocationService.listAll()` (default first) + `unitsByLocation()` (only when >1 location) (`page.tsx:113-127`, `service.ts:51-92`).
- Transfers: `stockTransferService.list({pageSize:TRANSFERS_PAGE_SIZE=20})` + `countsByStatus()` server-side, re-queried client-side through `listTransfersAction` on filter/page changes (`page.tsx:161-186`, `service.ts:281-325`, `stock-transfers.ts:43-80`). Item detail: `getById` (`service.ts:389-432`) / `getTransferItemsAction`. Pagination is DB-side (offset) in both list and transfers.
- Settings: `getSettingsMap()` → `resolveLowStockConfig` / `resolveInventoryConfig` / `resolveErpConfig` (`page.tsx:70-72,189`). No `.catch` on the settings read is deliberate (a swallowed read would degrade per_location to shared — `page.tsx:66-70`).
- ERP read of the ledger: `stockMovementService.listForApi` — ASC `(created_at,id)` keyset with a settle window, powering `GET /api/stock/movements` (`stock-movement/service.ts:59-94`); serialized by `serializeStockMovement` (`lib/api/movements.ts:16-29`).

### Write path (action → workflow/service → events → revalidation)

All mutating actions open with `requirePermission("stock", "update")`.

- **Inventaire single-pool save** → `bulkUpdateStockAction` (NOTE: lives in `lib/actions/catalog.ts:1229-1381`, not the stock-* files). Per-row through `applyStockSet` (`lib/inventory/adjust.ts:136-211`): locks the row FOR UPDATE, derives `in_stock` via `nextInStockForQty`, ledgers `reason:"admin"` only on a real qty change, optimistic `expectedQty` refuses a stale clobber (`StockConflictError`). Emits `product.restocked` on an unavailable→available flip; fail-soft per row; revalidates `/admin/catalog/stock` + `/admin/catalog/products`. It does NOT emit low-stock crossing events — manual admin edits never trigger alerts (`stock-alert-settings.tsx:57`).
- **Inventaire multi-location save** → `setLocationLevelsAction` (`stock-locations.ts:109-225`) → `stockLocationService.setLocationLevel` → `_applyLevelTx` (`service.ts:270-460`): locks location(share)→total(update)→level, IDOR guard (variant must belong to product), `expectedLevel` compare-and-set, maintains `stock_qty` delta-wise, ledgers `reason:"admin"`, location-stamped. Action then emits `product.updated` + `product.restocked` per changed product and revalidates both paths.
- **Variant-stock default** → `SharedStockToggle` → `setVariantStockDefaultAction` (`catalog.ts:1394+`): writes `app_secrets`, busts product cache tags, audited via `setting.upserted`.
- **Inventory settings** → `saveInventorySettingsAction` (`stock-locations.ts:51-100`): upserts each key via `workflows.cms.upsertSetting` (audited), and on a first shared→per_location switch runs `reconcileDefaultLevels()` (`service.ts:148-192`) so the matrix opens consistent.
- **Alert settings** → `saveStockAlertSettingsAction` (`stock-settings.ts:29-64`): re-clamps through the SAME `resolveLowStockConfig` the sale path uses, persists the normalized recipient list.
- **ERP settings** → `saveErpSettingsAction` (`stock-settings.ts:73-102`): upserts `erp.*`; enforcement is Phase-2 (stub posture).
- **Locations CRUD** (`stock-locations.ts`): `createLocationAction` (:228-271, emits `stock_location.created`), `updateLocationAction` (:274-378 — name/code/carrier patch, then `setLocationActive` which moves totals by DELTA and is REFUSED with pending non-terminal transfers), `setDefaultLocationAction` (:381-415 — active-only, atomic re-check + rollback), `deleteLocationAction` (:428-535 — refuses default & transfer-linked locations; with stock requires `transfer`/`writeoff` → `evacuateLocation` per-line in its own tx with `EvacuatePartialError` handling). All emit `stock_location.*` + `product.updated`/`product.restocked` as needed and revalidate.
- **Transfers** (`stock-transfers.ts`): `createTransferAction` (:131-194, gated on `transfers_enabled`, validates distinct+active locations) → `stockTransferService.create` which validates line grain via `assertLinesResolve` (`service.ts:228-278`) and emits `stock.transfer.requested`. `transitionTransferAction` (:202-228) → `service.transition` (`service.ts:441-534`): enforces `ALLOWED_TRANSITIONS`, and on `completed` moves every line via `moveStockTx` (−source/+dest `transfer` ledger legs, total invariant, dest-first to avoid a 0-crossing re-list) in one tx, emits `stock.transfer.completed`; on `cancelled` emits `stock.transfer.cancelled`. Action busts touched products' cache on completion.
- **Order lifecycle (the real stock engine)**: placement decrements `stock_qty` with a race-safe `stock_qty >= qty` guard, ledgers `reason:"order"`, and emits `product.stock_low`/`product.stock_depleted` crossings via `classifyStockCrossing` (`workflows/order/place-order.ts:1090-1360`, `low-stock.ts:80-90`). `restockOrderLines` mirrors it for cancel/refund/return with reasons `cancellation`/`refund`/`return` (`workflows/order/restock.ts:59-178`). SHIP triggers per-location `adjustLevelOnly` (level-only, total already dropped) in `ship-depot-decrement.ts`. `order.created` triggers `autoRequestTransfersForOrder` (store→depot `source:"auto"` transfers) when per_location+transfers+auto-request are on (`events/subscribers/auto-transfer.ts`, `lib/inventory/auto-transfer.ts`); order cancel cascades `cancelPendingForOrder`.
- **External API**: `GET/PATCH /api/stock` uses `applyStockDelta`(`reason:"api_delta"`)/`applyStockSet`(`reason:"api_set"`); `GET /api/stock/movements` reads the ledger. REST SoT rows: `route-catalog.ts:138-140` (domain `stock`, scopes read/write).

### RBAC

Single permission id **`stock`** with actions `["view","update"]` (`rbac/registry.ts:74`, group "Catalogue"). The stock page guards `stock:view` (`page.tsx:56`); `canManageStock = stock:update` gates every editing surface and each mutating action re-checks server-side (`page.tsx:60-64`). The print route guards `stock:view` (`print/page.tsx:35`). ALL mutations — bulk edit, per-location levels, locations CRUD, settings, AND every transfer transition — require `stock:update`; a transfer IS a stock write and deliberately shares the grant (comment at `rbac/registry.ts:69-74`; the reserved `stock:manage` was dropped in migration 0129). Grants live in DB (`role_permissions`/`user_permission_overrides`). The Catalogue sidebar group's Stock item uses the `stock` id; neighbouring Drip/Cartes-cadeaux REUSE the `products` id, not `stock` (`admin-shell.tsx:130-137`).

### Storefront linkage

Admin stock edits DO NOT reach the live Tokyo storefront until the catalog JSON snapshot is manually regenerated. `scripts/tokyo-export-catalog.ts` bakes only a frozen `availability: "in_stock" | "out_of_stock"` per product (from `p.inStock`, `:34,100`) into `src/storefront/data/products.json` — NO quantity, NO per-location, NO low-stock. Until the export is re-run and the JSON committed, the (tokyo) storefront shows stale availability. The storefront never reads real stock quantity; `src/storefront/lib/productMeta.ts` derives a 3-state `stockState` from that single enum. The LEGACY (shell) group reads the DB live, so its availability reflects edits immediately. `product.updated` → `invalidate-catalog-cache` busts the `products:list` cache tags for the DB-backed/`'use cache'` paths (what (shell) and `lib/api/products.ts` read), but it CANNOT touch the bundled JSON the (tokyo) storefront ships. In short: Stock admin → DB + ledger + events → (shell) live, ERP webhooks/API live; (tokyo) storefront only via a manual `tokyo-export-catalog` re-run.

### Edit / remove notes

- Safe to edit in isolation: labels/copy/French strings, tab icons, filter chip set, pill styling, the ERP Phase-2 disclaimer copy, status-meta labels/colours (`stock-transfer/status-meta.ts` — but it's SHARED with the order page's linked-transfers panel and the print slip, so keep it client-safe: type-only import).
- `locations/page.tsx` is a thin redirect — safe to delete only if you also drop any `?tab=emplacements` deep links; `StockTabs` still handles the tab param directly.
- The ERP tab is largely a RECORDED-posture stub: the mixed axes, push-transfers and warranty toggles persist settings but enforcement is "Phase 2" (`erp-panel.tsx:52-69`). `pullStock` is the only one with a live UI effect (the Inventaire warning banner). Removing/replacing the ERP tab does not break stock writes; the live surface is `/api/stock` + webhooks, independent of these toggles.
- Transfers, multi-location and carrier-link are feature-flag-gated (`inventory.*`); turning them off hides the UI but KEEPS existing data (levels, carrier refs, transfer history) — deactivation is reversible.
- Load-bearing, DO NOT casually change: `_applyLevelTx`/`moveStockTx`/`setLocationActive`/`evacuateLocation` lock-ordering (location→total→level) and the dest-first transfer-leg order (`service.ts:494-543`) — they prevent ABBA deadlocks and a 0-crossing re-list; `nextInStockForQty`/`nextTotalForLevelWrite`/`stockStateSql` must stay in lockstep with their SQL/JS twins or badges and the storefront diverge; the append-only `stock_movements` contract (never update/delete).
- Migrations are FROZEN at 0007-era snapshots (schema hand-authored); the schema comments reference later migration numbers (0120/0128/0129/0134) for indexes/sequence — do not run db:generate/db:push to "fix" them.

### Gaps & risks

- **Storefront staleness is the biggest operational trap**: every Inventaire/level edit is invisible on (tokyo) until someone re-runs `tokyo-export-catalog.ts` and commits the JSON. There is no admin button for it and no freshness indicator — easy to forget.
- **`backorder` dead path**: `storefront/lib/productMeta.ts` handles a third `availability: "backorder"` value, but the export only ever emits `in_stock`/`out_of_stock` (`tokyo-export-catalog.ts:34,100`). Backorder can only appear via hand-edited JSON — effectively unreachable from admin.
- **Auto-request under-counting**: two online orders landing before either ships both read the same depot level and can jointly under-request transfers (documented as deliberate, `auto-transfer.ts:17-25`) — fine for an empty depot, risky if the depot holds a few units.
- **"Écart" drift is expected, not a bug**: sales/returns/API move only `stock_qty`, so Σ(levels) legitimately diverges; an operator must re-align cells before a physical recount or a level save will swing the total by the full difference (`stock-panel.tsx:1055-1068`).
- **Partial evacuation**: `deleteLocationAction` moves stock one tx per line; a mid-way failure leaves earlier lines committed (levels zeroed) with an `EvacuatePartialError` — a retry won't double-move but the location delete didn't happen, and the operator must reconcile (`stock-locations.ts:469-494`, `service.ts:637-752`).
- **No reconciliation/audit UI for `stock_movements`**: the ledger is written everywhere and exposed via the ERP API, but there is no admin screen to read it (the reader note in `stock-movement/service.ts:15-20`).
- **ERP toggles are mostly inert** (Phase-2), yet the UI implies control over "who overwrites whom"; an operator could reasonably expect `push_stock`/`push_transfers` to gate webhooks when they currently do not (`erp-panel.tsx:52-69,147-172`).
- **ESLint**: `requirePermission` on each mutating action is enforced by `route-invariants.test.ts`; adding a new mutating stock action without the guard will fail the suite (the contract, not OpenAPI).


<details>
<summary><strong>3. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/stock/page.tsx — server entry, guards stock:view, fetches everything, fans into 5 tabs
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/stock/stock-tabs.tsx — client tab shell (mounted+hidden), hash/?tab sync
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/stock/stock-panel.tsx — Inventaire editor (single-pool + multi-location)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/stock/transfers-panel.tsx — transfers list/create/transition/print
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/stock/transfers/[id]/print/page.tsx — server Bon de transfert (read-only)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/stock/erp-panel.tsx — ERP posture (Phase-2 stub) + warranty toggles
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/stock/reglages-panel.tsx — settings hub (variant mode, inventory, alerts)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/stock/inventory-locations-card.tsx + inventory-settings-card.tsx + shared-stock-toggle.tsx + stock-alert-settings.tsx — settings/CRUD surfaces
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/locations/{page.tsx,locations-panel.tsx} — page.tsx is a redirect; locations-panel is the CRUD used by the stock page
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/stock-location/{schema.ts,service.ts,index.ts} — locations + stock_levels + total maintenance (lock-ordered)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/stock-movement/{schema.ts,service.ts,index.ts} — append-only ledger + ERP keyset read
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/stock-transfer/{schema.ts,service.ts,status-meta.ts,index.ts} — transfers lifecycle + stock move on completion
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/{stock-locations.ts,stock-settings.ts,stock-transfers.ts} — the stock Server Actions (all stock:update)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/catalog.ts — bulkUpdateStockAction (:1229) + setVariantStockDefaultAction (:1394), stock:update, used by Inventaire tab
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/inventory/{adjust.ts,in-stock-rule.ts,stock-state.ts,level-total.ts,low-stock.ts,locations-config.ts,erp-config.ts,variant-stock.ts,auto-transfer.ts} — pure/shared stock helpers
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/api/movements.ts — ERP serializer for the stock ledger
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/product/{service.ts:202 listStockPaged,queries.ts:191 stockStateSql} — admin stock read path
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/order/{place-order.ts,restock.ts} — the real stock decrement/restock + low-stock crossings
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/events/subscribers/{ship-depot-decrement.ts,auto-transfer.ts,notify-low-stock.ts,notify-transfer.ts} — stock event subscribers
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/scripts/tokyo-export-catalog.ts — bakes frozen availability enum into the (tokyo) JSON snapshot

**Models / tables**

- stock_locations (name, code[partial-unique], carrier_ref[soft], is_default[one-default partial-unique], is_active, display_order, soft-delete)
- stock_levels (location_id, product_id, variant_id[NULL=pool], qty[non-neg]; two partial uniques pool vs variant)
- stock_movements (product_id, variant_id[text soft], delta, resulting_qty, reason[order|cancellation|refund|return|api_delta|api_set|admin|transfer], order_id, location_id[soft], actor_user_id, note, created_at) — append-only
- stock_transfers (ref[seq, unique, TR-<ref>], from/to_location_id[soft], status[requested|accepted|in_transit|completed|cancelled], source[manual|auto], order_id[soft], requested_by, lifecycle timestamps, cancel_reason, soft-delete)
- stock_transfer_items (transfer_id, product_id, variant_id[NULL=pool], qty)
- JOINED (owned by catalog/product): products.stock_qty/in_stock/external_ref/sku/shared_variant_stock/product_type, product_variants.stock_qty/in_stock/label/sku
- SETTINGS (site_settings): inventory.location_mode|carrier_link_enabled|transfers_enabled|transfer_auto_request|transfer_sourcing_strategy; stock.alert_enabled|low_threshold_qty|alert_recipients; erp.sync_mode|push_stock|pull_stock|push_transfers|push_warranty|pull_warranty
- app_secrets.catalog.variant_stock_shared_default (global variant-stock mode default, not a site_setting)

**Sources of truth**

- Sellable total: products.stock_qty / product_variants.stock_qty (NULL = untracked/unlimited); in_stock re-derived by nextInStockForQty
- Per-location detail: stock_levels (qty per location,product|variant) — Σ(active) == stock_qty, maintained delta-wise not recomputed
- All stock changes: append-only stock_movements ledger (8 reasons), one row per change in the same tx; never updated/deleted
- Transfers: stock_transfers + stock_transfer_items; status graph app-enforced in service.transition; stock moves ONLY on completed
- TRUE mutation API = Server Actions in lib/actions/stock-*.ts + bulkUpdateStockAction/setVariantStockDefaultAction in lib/actions/catalog.ts; order stock moves via workflows/order/*
- Settings SoT: site_settings keys resolved by pure modules locations-config.ts / erp-config.ts / low-stock.ts; variant-stock default in app_secrets
- Stock-state predicates: stockStateSql (SQL) + stock-state.ts/in-stock-rule.ts (JS twins) must agree
- REST ERP surface SoT: route-catalog.ts:138-140 (/api/stock GET/PATCH, /api/stock/movements GET), domain stock
- RBAC: rbac/registry.ts:74 single `stock` id {view,update}; grants in role_permissions / user_permission_overrides
- Storefront display SoT: bundled JSON snapshot src/storefront/data/products.json, regenerated only by manually running scripts/tokyo-export-catalog.ts

**Editable / removable**

- Editable freely: French copy/labels, tab icons, filter chip set, pill colours, ERP disclaimer text, status-meta labels (keep status-meta client-safe: type-only import, it is shared with order page + print slip)
- Removable with care: locations/page.tsx redirect (only if ?tab=emplacements deep links are dropped); the ERP tab/toggles (stub, Phase-2 — removing does not affect live /api/stock + webhooks, except the pullStock-driven Inventaire banner)
- Feature-flag gated, reversible: Transferts, multi-location, carrier-link, auto-request — toggling off hides UI but keeps data
- Load-bearing, do NOT change casually: lock-ordering + dest-first leg order in stock-location/service.ts; nextInStockForQty/nextTotalForLevelWrite/stockStateSql twins; append-only stock_movements contract; the stock:update guard on every mutating action (route-invariants.test.ts)
- Do NOT run db:generate/db:push — migrations are frozen and schema is hand-authored

**Gaps / risks**

- Tokyo storefront availability is FROZEN at export time — admin stock edits are invisible on (tokyo) until scripts/tokyo-export-catalog.ts is manually re-run and the JSON committed; no admin trigger, no freshness indicator
- Storefront JSON carries only an in_stock/out_of_stock enum (no quantity, no per-location, no low-stock); real quantity never reaches (tokyo)
- productMeta.ts handles a `backorder` availability the export never emits (tokyo-export-catalog.ts:34,100) — dead path unless JSON is hand-edited
- ERP tab push/transfer/warranty toggles persist posture but enforcement is Phase-2 (stub); only /api/stock + stock.*/stock.transfer.*/warranty.claim.* webhooks are live, and only pullStock has a live UI effect (Inventaire banner)
- Auto-transfer can under-request when multiple orders land before either ships (same depot level read) — deliberate, documented in auto-transfer.ts
- 'Écart' drift between stock_qty and Σ(levels) is expected (sales move only the total); a level save then swings the total by the full difference if cells aren't re-aligned first
- deleteLocationAction evacuates one tx per line — a mid-way failure leaves committed lines + undeleted location (EvacuatePartialError) to reconcile manually
- No admin UI to read the stock_movements ledger (ERP API only)
- Manual admin stock edits do NOT emit low-stock/depleted alerts (only sales/order-edits/API crossings do) — by design, but can surprise operators
- Migrations frozen at 0007; schema comments cite later migration numbers (0120/0128/0129/0134) for indexes/sequence — informational only, do not regenerate

</details>


---

## 4. Collections (Catalogue admin)

Collections are first-class, SEO-friendly merchandising groupings ("Collection d'Été") with their own public page at `/collection/<slug>` and a magazine index at `/collections`. They own their table, link to products through a M2M join (no FK), and mirror the Brand/Category admin patterns almost exactly (the code comments repeatedly say "mirrors brands/categories"). RBAC id is its own `collections` (NOT a reused id). Crucially for this session: **collections are absent from the Tokyo storefront entirely** — they render only through the legacy `(shell)` routes, live from the DB.

### What the operator sees & does

**List page** (`/admin/catalog/collections`) — a sub-tab strip (`collections-panel.tsx:134-138`) with up to three sub-tabs, all rendered client-side and toggled with `hidden`:
- **"Collections"** (list) — a search box (`q`, name ILIKE, submitted via URL), a paginated list (20/page, `page.tsx:22`), and two action buttons: **"Réorganiser"** (shown only if `canUpdate` and >1 collection, `collections-panel.tsx:183`) and **"Nouvelle collection"** (`canCreate`). Each row shows thumbnail, name, `/collection/<slug>`, product count, and "· désactivée" when inactive (`collections-panel.tsx:390-396`). Row controls: an inline Eye/EyeOff **activate toggle** (`canUpdate`), an **"ExternalLink" to `/collection/<slug>`** shown ONLY for active collections (an inactive one 404s, `collections-panel.tsx:418-430`), a **Pencil** edit link (`canUpdate`), and a **Trash** delete (`canDelete`) that opens a `ConfirmDeleteModal` warning "Les produits associés ne seront plus rattachés" (`collections-panel.tsx:250-251`). Empty states differ for "no match for « q »" vs "aucune collection" (`collections-panel.tsx:213-217`).
- **"Réorganiser" mode** — replaces the list with the FULL ordered set (`reorderCollections`) and per-row up/down arrows; each move immediately fires `reorderCollectionsAction` (optimistic, `collections-panel.tsx:297-308`). "Terminé" exits and refreshes.
- **"Page Collections"** sub-tab (only when `canUpdate`) — the `CollectionsLandingSettings` block builder for the public `/collections` magazine (see Storefront linkage).
- **"Génération IA"** sub-tab (only when `canUpdate`) — the shared `ContentGenerationControl` (`entityType="collection"`) for bulk AI copy; panel auto-opens when a job is queued/running (`collections-panel.tsx:83`, `page.tsx:112-123`).

**Create/Edit form** (`collection-form.tsx`) — six tabs (`collection-form.tsx:106-113`): **Identité** (name*, slug [auto-slugified from name until edited, `:176-178`], référence externe ERP, ordre d'affichage, active checkbox, rich-text description), **Image** (hero MediaPicker + listing chip IconPicker), **Contenu** (editorial eyebrow/title/body + `ValuePropsEditor`), **Produits** (`CollectionProductsPicker` — debounced FTS search, reorderable selected list), **FAQ** (per-collection Q/A editor; create mode shows "save the collection first" placeholder, `:446-449`), **SEO** (meta title/description with live Google SERP preview + char counters, canonical URL, noindex, OG image). Every text field has AI generate buttons + a "Tout générer" bar (`GenerateAllBar`). A failed submit jumps to the tab owning the bad field (`FIELD_TAB` map `:122-142`). After a successful CREATE it redirects to the new collection's edit page (`:165-169`).

Membership is **manual only** — there is no rule-based/smart collection. The operator picks the exact product set in the Produits tab; order of the picker = `display_order` within the collection.

### Routes & components

- `src/app/admin/catalog/collections/page.tsx` — server component, list page. Resolves perms once, counts+clamps page, lists rows, batches product counts + media thumbs, primes landing config/brands for editors.
- `src/app/admin/catalog/collections/collections-panel.tsx` — client component (`"use client"`). Holds `CollectionsPanel`, `ReorderView`, `CollectionRow`, `Pager`, `EmptyState`.
- `src/app/admin/catalog/collections/new/page.tsx` — server, `force-dynamic`, gates create, renders `<CollectionForm mode="create">`.
- `src/app/admin/catalog/collections/[id]/page.tsx` — server, gates update, 404s on non-uuid/missing, hydrates assigned products (`productCollectionLinks.listForCollection` → `productPickerOptionsForIds`) + admin FAQs, renders `<CollectionForm mode="edit">`.
- `src/components/admin/collection-form.tsx` — client. `CollectionForm` + `CollectionFaqEditorBody` + `CollectionProductsPicker` + local `Section`/`Field`/`ProductThumb`. Uses `useActionState` wired to `create/updateCollectionAction`.
- `src/components/admin/collections-landing-settings.tsx` — client. The "Page Collections" block builder (wired to `saveCollectionsLandingAction`).
- `src/components/admin/catalog/content-generation-control.tsx` — shared bulk-AI panel (not collection-specific).

### Data model

Table **`collections`** (`src/modules/catalog/collection/schema.ts`), uuid v7 PK, soft-delete (`deleted_at`), timestamps. Columns: `name`, `slug`, `external_ref` (ERP linkage), `description`, `editorial_eyebrow/title/body`, `value_props` (JSONB `CategoryValueProp[]`, max 8), `image_media_id` (hero, soft media link), `icon` + `icon_media_id` (listing chip), `meta_title`, `meta_description`, `canonical_url`, `noindex` (default false), `og_image_media_id`, `display_order` (default 0), `is_active` (default true). **No money columns.** Collections are **FLAT** (no parent).

Invariants / indexes: partial-unique `collections_slug_unique WHERE deleted_at IS NULL` (slug reuse after soft-delete), partial-unique `collections_external_ref_unique WHERE external_ref IS NOT NULL AND deleted_at IS NULL`, partial media soft-link indexes on image/og/icon media ids, and a trigram GIN `collections_name_trgm` that lives ONLY in migration `0107` (Drizzle can't express gin_trgm_ops; see `schema.ts:98-101`). No standalone `display_order` index (dropped in 0139).

Join table **`product_collections`** (`src/associations/product-collection.ts`): `product_id` + `collection_id` (bare uuid soft-FKs in Drizzle; ON DELETE CASCADE FKs added in SQL migration), `display_order`. Indexes use the `pcol_` prefix deliberately — `pc_` is taken by product_categories (`product-collection.ts:24-27`). Unique `pcol_pair_unique(collection_id, product_id)`. Replace-semantics on the collection side.

Enums (string unions, not pg enums) live in the landing config: `CollectionPick` = all|featured, `HeroStyle` = gallery|banner, `SectionHeaderStyle` = text|banner, `CollectionsBlockKey` × 8 (`collections-landing-config.ts:37-66`).

### Read path

- Admin list: `collectionService.count({search})` → clamp → `collectionService.list({search,limit,offset})` ordered by `display_order, name`, **no `activeOnly`** so drafts show (`service.ts:80-91`, `page.tsx:43-52`). Product counts via one grouped query `productCollectionLinks.countProductsForCollections` (counts links to non-deleted products, `catalog.service.ts:789-802`). Thumbs via `findMediaByIds` + `resolveMediaThumbUrl`.
- Reorder view data: `collectionService.listAll()` (full ordered live set, no cap, `service.ts:97-103`).
- Edit page: `collectionService.findById` (live only) + `productCollectionLinks.listForCollection` (display order) + `faqService.listForAdminCollection` (published + draft).
- External/ERP: `src/lib/api/collections.ts` (`listApiCollections`/`getApiCollectionByRef`/`resolveCollectionRow`) → `ApiCollection` projection.
- Storefront (shell): `collectionQueries.getCollectionBySlug` + `listActiveCollections` (both `'use cache'`, tagged `CACHE_TAGS.collections`, `cacheLife("hours")`, `src/modules/catalog/collection/queries.ts`). Build-phase guard returns `[]`.

Pagination: offset-based, PAGE_SIZE=20, clamp-to-last-page in the server component (`page.tsx:43-45`); the panel also clamps client-side nav (`collections-panel.tsx:106-110`).

### Write path

All admin mutations are Server Actions in `src/lib/actions/collection.ts`, each `requirePermission` → Zod-validated workflow in `src/workflows/catalog/collection.ts` (runs in `db.transaction`, emits events) → `revalidatePath`.

- **create**: `createCollectionAction` → `workflows.catalog.createCollection`. `createCollectionSchema` (`collection.ts:45-73`). Slug uniqueness checked against collections only (NOT the flat `/[slug]` namespace, `collection.ts:84-94`) + `findShadowingRedirect` on `/collection/<slug>`. New collection lands at max(display_order)+1. Inserts row + `productCollectionLinks.setForCollection` in ONE tx (`collection.ts:115-138`). Emits `collection.created`. Action revalidates `/admin/catalog/collections`.
- **update**: `updateCollectionAction` → `updateCollectionWorkflow`. Diff-based patch (only changed fields pushed, `collection.ts:200-273`); product set replaced only when `collectionProductIds` present (the admin form always sends it — one hidden input per pick + an empty sentinel so an emptied set clears, `collection-form.tsx:859-864`, `actions/collection.ts:375-380`). Slug-change re-checks uniqueness + shadowing redirect. Field patch + product-set write share one tx (`collection.ts:275-292`). Emits `collection.updated` (changedFields) when anything changed, then `syncEntityUrlRedirects` keeps the old `/collection/<slug>` 301ing on rename. **FAQ fold-in**: if `faqItemsJson` is present (FAQ tab was edited) the action also calls `workflows.cms.upsertCollectionFaqs` best-effort (a FAQ failure doesn't fail the save but the message tells the operator, `actions/collection.ts:124-147`). Revalidates admin list, edit page, and `/collection/<slug>`.
- **delete**: `deleteCollectionAction` → `deleteCollectionWorkflow` — **soft delete** (`collectionService.softDelete`); product links stay (FK only cascades on hard delete) and simply stop resolving. Emits `collection.deleted`.
- **toggle active**: `setCollectionActiveAction` → `updateCollectionWorkflow({isActive})`. Loose UUID guard `/^[0-9a-f-]{36}$/i`.
- **reorder**: `reorderCollectionsAction` → `reorderCollectionsWorkflow` → `collectionService.reorderSiblings` (renumbers 0..n in a tx with `SELECT … FOR UPDATE`, de-dupes ids, emits `collection.updated{changedFields:["display_order"]}` per moved id, `service.ts:116-153`). Revalidates `/admin/catalog/collections` + `/collections`.
- **landing config**: `saveCollectionsLandingAction` → `workflows.cms.upsertSettingsBatch` writing ~35 `pages.collections.*` keys (strict-JSON reject, featured slugs validated against live collections/brands, `actions/collection.ts:200-344`).

Events (`src/events/types.ts:239-241`) are consumed by `src/events/subscribers/invalidate-catalog-cache.ts:61-63`, which busts `CACHE_TAGS.collections` on create/update/delete — so the shell storefront reads are read-your-writes. Audit trail + outbound webhooks ride the same events.

### RBAC

Permission module id **`collections`** with the full CRUD action set `["view","create","update","delete"]` (`src/lib/rbac/registry.ts:77`, `CRUD` at `:49`). It is its OWN id — unlike Drip/Cartes-cadeaux which reuse `products`. Guards:
- list page `requirePermission("collections","view")` (`page.tsx:30`); CRUD buttons hidden per `permissionSetAllows(perms, …)` so a control whose action would 404 never shows.
- new page `requirePermission("collections","create")`; edit page `requirePermission("collections","update")` (a view-only role should never see a form it can't submit).
- actions: create→`create`, update/setActive/reorder/saveLanding→`update`, delete→`delete`.
- The "Page Collections" + "Génération IA" sub-tabs and the landing/brand prefetch are gated on `canUpdate` (`page.tsx:61-74, 101-123`).
- The edit page loads assigned products via the server-only `productPickerOptionsForIds` under its own `collections:update` gate, deliberately NOT the `products`-gated resolve action (which would 404 the editor for a collections-only role, `[id]/page.tsx:32-34`).

### Storefront linkage

**Tokyo storefront: NONE.** The live customer storefront (`src/app/(shop)/(tokyo)/**` + `src/storefront/**`) has no collection route, no collection nav link, and no collection data. `scripts/tokyo-export-catalog.ts` emits only `products.json`/`categories.json`/`taxonomy.json` and never touches collections (zero "collection" references; the export's `RawProduct` has no collection field). `grep /collection` across `src/storefront` source returns nothing. So admin collection edits are **invisible on the Tokyo storefront** regardless of re-running the export.

**Legacy `(shell)` storefront: YES, live from DB.** Collections render through two shell routes, both `force-dynamic`, reading the DB directly (not the JSON snapshot):
- `src/app/(shop)/(shell)/collection/[slug]/page.tsx` — `collectionQueries.getCollectionBySlug` (404 on missing/inactive/deleted) + `listProductsByCollection`, reusing the shared `CategoryPageClient` grid with `navBarMode="collection"`; full SEO (meta, OG, canonical, CollectionPage + FAQ JSON-LD).
- `src/app/(shop)/(shell)/collections/page.tsx` — the block-based magazine index driven by `getCollectionsLandingConfig()` + `listActiveCollections()` + `listCollectionPreviews`; uses `src/components/storefront/collections/{collection-hero,collection-rail}.tsx`.

These shell routes are reachable (route groups add no URL segment; static `/collections` and 2-segment `/collection/<slug>` don't collide with Tokyo's `(tokyo)/[slug]`), but they render in the **legacy `.storefront` chrome**, and nothing in the Tokyo chrome links to them. The admin row's "Voir sur la boutique" link therefore opens a working, DB-live page in the old design.

The product-card **collection tag** + **"Collection" filter facet** are computed by `productCollectionLinks.listCollectionsForProducts` (active collections only) inside `mapProductRows` (`src/lib/api/products.ts`), which feeds the shell listing pages — again NOT the Tokyo snapshot. REST: `src/app/api/collections/route.ts` (GET/POST/PUT/PATCH/DELETE, `collections:read`/`write`) is ERP-only; surface declared in `route-catalog.ts:123-128`.

### Edit / remove notes

- **Safe to edit in isolation:** the admin UI shell (`collections-panel.tsx`), form fields/tabs (`collection-form.tsx`), and the magazine builder (`collections-landing-settings.tsx` + `collections-landing-config.ts` + `saveCollectionsLandingAction`). These touch only the admin surface + shell `/collections` index.
- **Removing the whole subsection:** the admin pages + actions can be deleted without touching the Tokyo storefront (no dependency). But `collections` is referenced by: the admin NAV entry (`admin-shell.tsx:127`), RBAC registry (`registry.ts:77` — removing it will trip route-invariants/registry tests), the REST route + `route-catalog.ts`, the shell storefront routes, the content-gen entity adapter, the media orphan reverse-lookup, sitemap (`listSitemapCollections`), and the product-card facet/tag. Remove top-down (nav → admin pages/actions → shell routes → service/schema → registry/route-catalog) and update the test suite (`src/lib/db/tests/**`, the contract).
- **Load-bearing:** the empty-sentinel `collectionProductIds` input (its absence would make a save never clear members); the FAQ fold-in (`faqItemsJson`); the transactional product-set write; the soft-delete + partial-unique slug/external_ref indexes (hand-authored SQL, migrations frozen at 0007-snapshot — do NOT `db:generate`).
- The hero `MediaPicker`/OG/value-props use `scope="categories"` (shared media scope), not a dedicated collections scope.
- `display_order` is editable both per-collection (form field) and via Réorganiser (bulk) — they write the same column; concurrent edits serialize via `FOR UPDATE` in `reorderSiblings`.

### Gaps & risks

- **Stale comment** in `[id]/page.tsx:34`: says the product hydrate runs "under THIS page's collections:view gate" but the page actually guards on `collections:update` (`:26`). Harmless, but misleading if someone relaxes the gate relying on the comment.
- **Loose UUID validation**: `setCollectionActiveAction` (`actions/collection.ts:167`) and `optionalUuid`/`pickAllUuid` (`:371-380`) use `/^[0-9a-f-]{36}$/i`, which accepts any 36-char hex/dash string (not a real UUID shape). The workflow Zod `.uuid()` is the real guard; the action regex is cosmetic.
- **Export drift is silent**: because collections never reach Tokyo, there is no "re-run the export" remedy — any requirement to surface collections on the live storefront needs new Tokyo routes + export fields, not just an admin edit. Operators may reasonably expect edits to appear on the live site and they won't.
- **Product soft-delete leaves `product_collections` rows**: the admin count (`countProductsForCollections`) filters deleted products, but the raw join rows persist; a product hard-delete cascades, a soft-delete does not.
- **FAQ save is best-effort** inside `updateCollectionAction` — a FAQ write failure returns `ok:true` with a warning message, so automation checking only `ok` would miss a dropped FAQ.
- `collection-form.tsx:338` placeholder text still references "montres" ("Présentez cette collection…" is fine, but `editorialTitle` helper example `:391` is "Des montres pensées pour la saison.") — legacy watch-store copy lingering in a high-tech rebrand.


<details>
<summary><strong>4. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/collections/page.tsx — server list page: perms, count+clamp, list, product-count/media batch, landing+gen prefetch
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/collections/collections-panel.tsx — client list/reorder/sub-tabs, row controls, delete modal, pager
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/collections/new/page.tsx — create page (force-dynamic), gates collections:create
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/collections/[id]/page.tsx — edit page, gates collections:update, hydrates products+FAQs; stale 'view' comment at :34
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/collection-form.tsx — 6-tab create/edit form, product picker, FAQ editor, SEO preview, AI buttons
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/collections-landing-settings.tsx — 'Page Collections' block builder (public /collections magazine)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/collection.ts — server actions: create/update/delete/setActive/reorder + saveCollectionsLandingAction
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/collection.ts — create/update/reorder/delete workflows (Zod, tx, events, redirect upkeep)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/collection/schema.ts — collections table, indexes, invariants
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/collection/service.ts — CRUD + list/listAll/count/reorderSiblings/findByExternalRef
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/collection/queries.ts — cached storefront reads (listActiveCollections, getCollectionBySlug, sitemap)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/collection/index.ts — barrel (collectionQueries + CollectionRow)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/associations/product-collection.ts — product_collections join table
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/associations/catalog.service.ts — productCollectionLinks (setForCollection, listForCollection, counts, facet join) at :694-875
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/api/collections.ts — external ERP projection (ApiCollection, resolve/list)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/pages/collections-landing-config.ts — /collections block-builder config (getCollectionsLandingConfig, parseBlockOrder)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/(shop)/(shell)/collection/[slug]/page.tsx — LIVE DB-driven storefront collection detail (legacy shell chrome)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/(shop)/(shell)/collections/page.tsx — LIVE DB-driven magazine index (legacy shell chrome)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/storefront/collections/collection-hero.tsx + collection-rail.tsx — shell /collections index components
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/api/collections/route.ts — REST ERP surface (collections:read/write)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/events/subscribers/invalidate-catalog-cache.ts:61-63 — busts CACHE_TAGS.collections on collection.* events
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/scripts/tokyo-export-catalog.ts — Tokyo snapshot exporter; does NOT export collections (decisive for storefront linkage)

**Models / tables**

- collections (OWNED) — id uuidv7 PK; name, slug, external_ref, description, editorial_eyebrow/title/body, value_props jsonb(CategoryValueProp[] max8), image_media_id, icon, icon_media_id, meta_title, meta_description, canonical_url, noindex(bool def false), og_image_media_id, display_order(int def0), is_active(bool def true), timestamps, deleted_at(soft)
- collections indexes: collections_slug_unique (partial WHERE deleted_at IS NULL), collections_external_ref_unique (partial), image/og/icon media_id partial idx, collections_name_trgm GIN (SQL-only, migration 0107)
- product_collections (OWNED join, no FK in Drizzle) — id, product_id uuid, collection_id uuid, display_order; pcol_pair_unique(collection_id,product_id), pcol_collection_idx, pcol_product_idx; ON DELETE CASCADE FKs added in SQL migration
- JOINED read-only: products (via product_collections for counts/previews/facet), media (image/og/icon soft links), faqs (faqs.collection_id, migration 0104), site_settings (pages.collections.* for /collections landing), brands (landing cross-sell + featured-slug validation)
- Enums (string unions, not pg enums) in collections-landing-config.ts: CollectionPick=all|featured, HeroStyle=gallery|banner, SectionHeaderStyle=text|banner, CollectionsBlockKey(8: hero,carousels,grid,brands,editorial,trust,blog,faq)

**Sources of truth**

- WRITE API = Server Actions in src/lib/actions/collection.ts → workflows in src/workflows/catalog/collection.ts (the real mutation API; runs in db.transaction, emits collection.created/updated/deleted)
- Schema SoT = src/modules/catalog/collection/schema.ts (hand-authored; trigram index + CASCADE FKs only in SQL migrations 0093/0104/0107/0108/0139 — migrations frozen, do NOT db:generate)
- Product membership SoT = product_collections join via productCollectionLinks.setForCollection (replace-semantics, collection owns the set)
- RBAC SoT = src/lib/rbac/registry.ts:77 (id 'collections', CRUD actions); grants in DB role_permissions/user_permission_overrides
- REST surface SoT = src/lib/api-auth/route-catalog.ts:123-128 (collections.list/create/upsert/update/delete)
- Storefront (shell) read SoT = src/modules/catalog/collection/queries.ts (cached, tagged CACHE_TAGS.collections)
- /collections magazine config SoT = pages.collections.* keys in site_settings, parsed by src/lib/pages/collections-landing-config.ts
- Contract/tests = src/lib/db/tests/** (route-invariants + registry tests enforce the RBAC guard on every page/action)

**Editable / removable**

- SAFE TO EDIT: admin UI (collections-panel.tsx), the 6-tab form (collection-form.tsx), and the magazine builder (collections-landing-settings.tsx + collections-landing-config.ts + saveCollectionsLandingAction) — these touch only admin + the shell /collections index, never Tokyo
- SAFE TO EDIT: storefront shell pages ((shell)/collection/[slug] and (shell)/collections) and their components — DB-live, isolated from Tokyo
- LOAD-BEARING (do not remove casually): the empty-sentinel collectionProductIds hidden input (clears membership on save); the FAQ fold-in via faqItemsJson; the single-tx field+product-set write; soft-delete + partial-unique slug/external_ref indexes
- REMOVING THE SUBSECTION requires top-down cleanup: admin NAV (admin-shell.tsx:127) → admin pages/actions → shell storefront routes → service/schema/join → RBAC registry (registry.ts:77) + route-catalog.ts + REST route → content-gen adapter, sitemap, media orphan lookup, product-card facet; then update src/lib/db/tests/**
- NO TOKYO IMPACT: deleting admin collection code does not affect the live Tokyo storefront (it has no collection dependency); conversely, editing collections can never surface on Tokyo without new routes + export work
- WATCH: collection id 'collections' is its OWN RBAC id (not reused like Drip/Cartes-cadeaux on 'products') — removing it will trip registry/route-invariants tests

**Gaps / risks**

- Collections are INVISIBLE on the live Tokyo storefront — not exported by tokyo-export-catalog.ts and no Tokyo route/nav references them; admin edits only ever show on the legacy (shell) /collection and /collections pages. Operators likely expect otherwise.
- Stale comment: [id]/page.tsx:34 says the product hydrate runs under 'collections:view' but the page gates on collections:update (:26).
- Loose UUID regex /^[0-9a-f-]{36}$/i in setCollectionActiveAction (actions/collection.ts:167) and optionalUuid/pickAllUuid (:371-380) accepts non-UUID shapes; the workflow Zod .uuid() is the real guard.
- FAQ persistence inside updateCollectionAction is best-effort — a failure still returns ok:true (with a warning message), so ok-only automation can miss dropped FAQs (actions/collection.ts:124-147).
- Product soft-delete leaves product_collections rows intact (FK cascades only on hard delete); admin count filters deleted products but the raw links persist.
- Legacy 'montres' copy lingers in the high-tech rebrand (e.g. collection-form.tsx:391 editorialTitle helper example).
- Per-collection display_order (form field) and bulk Réorganiser write the same column; reorderSiblings serializes via SELECT FOR UPDATE, but a form save can still clobber a just-reordered value.

</details>


---

## 5. Catégories — taxonomy tree

The admin "Catégories" screen manages a self-nesting category tree (unlimited depth via `parent_id`) that drives warranty/TVA cascades, product filing, SEO, and storefront navigation. The single biggest correctness fact for this session: **admin category edits do NOT reach the live Tokyo storefront automatically** — Tokyo reads a bundled JSON snapshot that is only regenerated by manually re-running `scripts/tokyo-export-catalog.ts`. The legacy `(shell)` storefront group reads the DB live; Tokyo does not.

### What the operator sees & does

Page title "Catégories", subtitle "Arborescence du catalogue — sous-catégories sur plusieurs niveaux" (`categories-panel.tsx:205-210`). A primary pill tab-strip (`FormTabStrip`, `categories-panel.tsx:214`) switches between up to four inline sections, each shown/hidden with `hidden` so polling state survives a switch (`categories-panel.tsx:195-200`):
- **Catégories** (always) — the tree.
- **Page Boutique** — the public `/boutique` chooser settings (only when `canUpdate`; `page.tsx:114-123`). This is a separate settings surface (writes `storefront.boutique_landing.*`), not the taxonomy itself.
- **Génération IA** — bulk AI copy generation for categories (only `canUpdate`; `page.tsx:103-113`).
- **Auto-catégoriser** — AI product→category auto-assign (only when the viewer holds `system_ai:view`; `page.tsx:32-36, 53`).

Within the Catégories section, a secondary toggle (`ListViewToggle`, `categories-panel.tsx:63-66, 380-405`) switches:
- **Navigation (drill-down)** — one level at a time with a breadcrumb (`categories-panel.tsx:263-330`). Clicking a row with children drills in (`path` state, `categories-panel.tsx:126, 304`). "Nouvelle catégorie" pre-fills the current level as parent (`categories-panel.tsx:152-153`).
- **Liste (flat)** — every category with its full ancestor path label (`a › b › c`), computed by `flattenTree` (`categories-panel.tsx:68-82, 244-262`).

Per-row controls (`CategoryRow`, `categories-panel.tsx:415-556`), each RBAC-gated: a child-count chip; up/down reorder arrows (**drill-down only**, when `canUpdate` and >1 sibling, `categories-panel.tsx:311-323`); an Eye/EyeOff **activate toggle** (`canUpdate`); a "Voir sur la boutique" external link **only for reachable nodes** (`categories-panel.tsx:513-524`); Edit (pencil → `[id]` page, `canUpdate`); "+" add-sub-category (`canCreate` → `new?parent=<id>`); and a danger Delete (`canDelete`). Deactivating a node with children pops a `window.confirm` warning that it hides the whole subtree + products (`categories-panel.tsx:155-172`). Rows show "· désactivée" or "· masquée (parent désactivé)" when a node is active but an ancestor is off (`categories-panel.tsx:558-570`). Delete opens a `ConfirmDeleteModal` explaining children are re-parented one level up and products move to the parent (`categories-panel.tsx:350-369`).

Empty state: "Aucune catégorie pour l'instant. Créez la première…" (`categories-panel.tsx:240-243`); empty sub-level: "Aucune sous-catégorie ici…" (`categories-panel.tsx:292-294`).

**Create/Edit form** (`category-form.tsx`), 6 tabs (`category-form.tsx:157-164`): a controlled tab so a failed submit jumps to the offending field via `FIELD_TAB` (`category-form.tsx:178-205, 229`):
- **Identité**: name (required), slug (auto if blank, unique site-wide helper), tagline, displayOrder, externalRef (ERP), parent `SelectField` (root option + flattened parents), isActive, isDiscountable, rich-text description; plus a **Garantie** section (warrantyMonths, warrantyLabel, taxRateBps entered as percent) (`category-form.tsx:360-472`).
- **Image hero**: hero `MediaPicker`, separate "Image Boutique" (`/boutique` tile), and `IconPicker` listing chip (lucide key + custom image) (`category-form.tsx:476-507`).
- **Contenu**: editorial eyebrow/title/body + `ValuePropsEditor` (max 8 cards) (`category-form.tsx:510-550`).
- **Filtres**: tick which attributes act as storefront filters, with an inline "Nouvel attribut" creator (hidden unless `attributes:create`) (`category-form.tsx:553-613, 579`). Selected ids ride hidden inputs + a `""` sentinel so an empty set still wipes the M2M (`category-form.tsx:567-572`).
- **FAQ**: edit mode only; a signpost in create mode ("Enregistrez d'abord…") (`category-form.tsx:619-635`). Lives in a hidden sibling `<form>` and also folds into the main save via `faqItemsJson` once touched (`category-form.tsx:281-299, 338-343, 787-793`).
- **SEO**: meta title/description (controlled, char counters, live Google SERP preview), canonicalUrl, noindex, OG image picker; AI "Générer" button fills meta fields (`category-form.tsx:638-752`). A `GenerateAllBar` fans AI across all text fields (`category-form.tsx:349`). After a successful **create**, it redirects to the new node's edit page (`category-form.tsx:237-241`).

### Routes & components

- `src/app/admin/catalog/categories/page.tsx` — server; the list page. Guards `categories:view`, resolves per-action gates, loads the tree + auxiliary panels, projects `DbTreeNode → CategoryTreeNode` with a recursive `reachable` flag (active AND every ancestor active) (`page.tsx:24-125`).
- `src/app/admin/catalog/categories/categories-panel.tsx` — **client** (`"use client"`); the whole interactive tree (sub-tabs, drill-down/flat views, inline toggle/reorder/delete). Calls server actions directly (`categories-panel.tsx:27-32`).
- `src/app/admin/catalog/categories/new/page.tsx` — server; guards `categories:create`, `force-dynamic`, flattens all categories as parents (`new/page.tsx:20-28, 39, 47-56`).
- `src/app/admin/catalog/categories/[id]/page.tsx` — server; guards `categories:update`, loads the row + filters + FAQs, flattens parents **excluding the node's own subtree** to prevent cycle selection (`[id]/page.tsx:29, 42-68`).
- `src/components/admin/category-form.tsx` — **client**; create+edit form (all tabs above), plus inner `CategoryFaqEditorBody` and `CreateFilterAttribute`.
- Shared admin components: `MediaPicker`, `IconPicker`, `FormTabs`/`FormTabStrip`, `RichTextField`, `ValuePropsEditor`, `AutoAssignControl`, `ContentGenerationControl`, `BoutiqueLandingSettings`, `ConfirmDeleteModal`.
- Nav entry: `src/app/admin/_components/admin-shell.tsx:128` ("Catégories" → `/admin/catalog/categories`, under the "Catalogue" group, `Tag` icon).

### Data model

**`categories`** table — owned (`src/modules/catalog/category/schema.ts:22-126`):
- Identity/tree: `id` (uuid v7), `slug` (notNull), `name`, `tagline`, `description`, `parent_id` (uuid, self-FK; baseline `ON DELETE SET NULL`), `external_ref` (ERP), `display_order` (int, default 0).
- SEO: `meta_title`, `meta_description`, `canonical_url`, `noindex` (bool).
- Media soft-links (text, not FKs): `og_image_media_id`, `hero_media_id`, `boutique_image_media_id`, `icon` (lucide key) + `icon_media_id`.
- Cascade defaults: `warranty_months`/`warranty_label` (NULL = inherit global), `tax_rate_bps` (NULL = inherit), `is_discountable` (bool, default true).
- `is_active` (bool, default true). Editorial: `editorial_eyebrow/title/body`, `value_props` (jsonb `CategoryValueProp[]`).
- `timestamps()` + `softDelete()` (`deleted_at`, app-enforced).

**Key invariants / indexes** (`schema.ts:92-125`):
- `categories_parent_display_order_idx` (parent_id, display_order) — serves every sibling read/reorder.
- `categories_root_slug_unique` — partial unique on `slug WHERE parent_id IS NULL AND deleted_at IS NULL` (root siblings only; a sub-category may reuse a root slug; a soft-deleted root frees its slug).
- `categories_external_ref_unique` — partial unique among live rows.
- Sibling slug uniqueness and site-wide slug uniqueness are enforced in the **workflow**, not the DB (comment `schema.ts:14-20`).
- `CategorySlimRow` (`schema.ts:138-148`) — structural projection dropping heavy text/jsonb; the tree/sitemap/mega-menu builders read this via `listAllSlim`.

**Joined (not owned here):**
- `product_categories` M2M (`src/associations/product-category.ts:11-28`): `product_id`, `category_id`, `is_primary` (one primary per product for breadcrumb/canonical/TVA chain). `pc_pair_unique`, `pc_product_idx`, `pc_category_idx`. FK `category_id` is `ON DELETE CASCADE` (comment `service.ts:174-191`).
- `category_attribute_filters` M2M (`src/modules/catalog/attribute/schema.ts:130-147`): composite PK (category_id, attribute_id) + `display_order`; which attributes appear as storefront filters.
- Category FAQs live in the CMS module (`faqService`, `[id]/page.tsx:9, 44`).

### Read path

- Admin list: `categoryQueries.getCategoryTree()` (`page.tsx:52`) → `categoryService.listAllSlim()` (one SELECT, structural columns) + in-memory grouping (`queries.ts:100-132`). **Orphan-safe** (a node under a dead/soft-deleted parent surfaces as root) and **cycle-safe** (`seen` set). Returns inactive categories too (admin sees everything). No pagination — one full SELECT, fine for ~50 nodes.
- Edit detail: `categoryService.findById(id)` (deleted_at-filtered) + `attributeService.listCategoryFilters(id)` + `faqService.listForAdminCategory(id)` (`[id]/page.tsx:31, 42-48`).
- Parent pickers: flatten `getCategoryTree()` (create: all; edit: excludes self-subtree) (`new/page.tsx:20-28`, `[id]/page.tsx:55-68`).
- Storefront visibility helpers (used by `(shell)` + sitemap, not Tokyo): `isCategoryChainActive` (`queries.ts:26-28`), `getCategoryBySlug` with `activeOnly` chain check (`queries.ts:148-153`), `getCategorySubtreeChildren` (`queries.ts:174-191`).

### Write path

All category mutations go action → workflow (`db.transaction` where needed) → service → `bus.emit` → `revalidatePath`. Server actions in `src/lib/actions/catalog.ts`; workflows in `src/workflows/catalog/create-category.ts` (name is legacy — it holds create/update/reorder/delete/tax).

- **Create**: `createCategoryAction` (`catalog.ts:228-291`) → `createCategoryWorkflow` (`create-category.ts:88-173`). Zod `createCategorySchema` (`create-category.ts:41-86`); validates parent is live (`:103-106`); `checkSlugAvailability` across all entities + nested `/parent/slug` (`:114-119`); sibling-slug belt check (`:124-127`); defaults `display_order` to end-of-siblings (`:133-137`); inserts; emits `category.created` (`:167-171`). Then the action wires filters via `setCategoryFilters` workflow (`catalog.ts:277-281`) and `revalidatePath("/admin/catalog/categories")`.
- **Update**: `updateCategoryAction` (`catalog.ts:293-404`) → `updateCategoryWorkflow` (`create-category.ts:179-332`). Uses a `provided` set from raw input so Zod `.default()` through `.partial()` can't silently re-activate/re-enable fields (`:192, 259-266`). Cross-entity slug check on rename (`:200-214`); **parent-cycle guard** walks up from the proposed parent, rejects self/descendant (`:222-254`); builds a sparse `patch`, emits `category.updated` with `changedFields` (`:294-301`); `syncEntityUrlRedirects` keeps old URLs 301-ing after rename/reparent/re-activate (`:303-330`). Action also replaces the filter M2M (`catalog.ts:352-359`) and folds in FAQ upsert (`catalog.ts:373-382`), then revalidates `/admin/catalog/categories`, `/admin/catalog/categories/[id]`, and the storefront `/[slug]` (`catalog.ts:384-390`).
- **Activate toggle**: `setCategoryActiveAction` (`catalog.ts:423-438`) → `updateCategoryWorkflow({isActive})`.
- **Reorder**: `reorderCategoriesAction(parentId, orderedIds)` (`catalog.ts:445-457`) → `reorderCategoriesWorkflow` (`create-category.ts:414-433`) → `categoryService.reorderSiblings` — locks the sibling group `FOR UPDATE`, de-dupes, applies one CASE UPDATE scoped to the parent, returns moved ids (`service.ts:245-293`); emits `category.updated{changedFields:["display_order"]}` per moved node.
- **Delete**: `deleteCategoryAction` (`catalog.ts:406-415`) → `deleteCategoryWorkflow` (`create-category.ts:435-496`). Blocks when live promotions target the category (`:445-451`). In one transaction: `softDeleteWithChildPromotion` promotes live children to the deleted node's own parent (`service.ts:141-163`), `productCategoryLinks.moveToCategory` moves product links to that parent keeping `is_primary` (`catalog.service.ts:315`), and `setCategoryFilters(id, [])` clears the attribute M2M (`:474`). Emits `category.deleted` + `product.updated` per moved product (`:477-493`).
- **Filters**: `setCategoryFiltersWorkflow` (`manage-attributes.ts:564-591`) validates every attribute id is live, wipe-and-reinsert via `attributeService.setCategoryFilters` (`service.ts:317-335`), emits `category.filter_attributes.updated`.

### RBAC

Permission id **`categories`** with full CRUD (`view`, `create`, `update`, `delete`, `manage`) — registry `src/lib/rbac/registry.ts:75` (group "Catalogue"). Grants:
- List page: `requirePermission("categories", "view")` (`page.tsx:25`); per-control gates derived from `resolveUserPermissions` → `canCreate/canUpdate/canDelete` (`page.tsx:39-41`).
- Create page: `requirePermission("categories", "create")` (`new/page.tsx:39`).
- Edit page: `requirePermission("categories", "update")` (`[id]/page.tsx:29`).
- Mutating actions each re-guard: create→`create`, update/setActive/reorder→`update`, delete→`delete` (`catalog.ts:232, 297, 427, 449, 407`).
- **Reused ids**: the "Auto-catégoriser" panel uses `system_ai:view`/`system_ai:manage` (`page.tsx:32-36`); the inline attribute creator needs `attributes:create` (`new/page.tsx:42-46`, `[id]/page.tsx:36-40`, gated in form `category-form.tsx:579`); the "Page Boutique" save reuses `categories:update` (`catalog.ts:471`). (Separately, in the sidebar group, Drip and Cartes-cadeaux reuse the `products` id — not category-related, `admin-shell.tsx`.)

### Storefront linkage

**CRITICAL — two different storefronts read two different ways.**

1. **Live Tokyo storefront (`src/app/(shop)/(tokyo)/**`) reads a BUNDLED JSON SNAPSHOT, not the DB.** The category routes resolve through `src/storefront/lib/api/categories.ts` → `catalogSource` → `staticSource` (`src/storefront/lib/data/static-source.ts:47-55`) → `src/storefront/lib/catalog.ts`, which statically imports `src/storefront/data/categories.json` and `products.json` (`catalog.ts:1-2`). Navigation (header mega-menu, breadcrumbs, drill rails) reads `src/storefront/data/taxonomy.json` via `src/storefront/lib/categoryNav.ts` (`categoryNav.ts:1, 24`), consumed by `header.tsx:244` (`megaMenu = navTaxonomy.map(buildMega)`), `category-view.tsx`, `product-view.tsx`, and the flat resolver `(tokyo)/[slug]/page.tsx:14-20, 131-135`.
   - These JSON files are regenerated ONLY by manually running `scripts/tokyo-export-catalog.ts` (`tokyo-export-catalog.ts:53-156`): it reads the live DB (`categoryService.listAll()` + `listApiProducts`), writes `categories.json` ({slug,label,count}, `:115-117`) and `taxonomy.json` (the nested tree with rolled-up counts, empty branches pruned, `:124-151`), then the files must be **committed**. There is no runtime/webhook trigger and no `revalidatePath` touches these files. **Therefore every admin category edit — rename, reparent, reorder, activate/deactivate, new/deleted category — is invisible on Tokyo until this script is re-run and the output committed.** `scripts/tokyo-build-categories.ts` is the one-time seeder that wipes the old watch demo and builds the tree from the migration feed (`tokyo-build-categories.ts:38-90`); not part of normal edits.
   - The leaf/parent model `tokyo-export-catalog.ts` relies on: `listApiProducts` exposes a 2-level view where `category` = the **parent** of the primary node and `subcategory` = the **primary node (the real leaf)** (`src/lib/api/products.ts:1479-1496`). The export files each product at its deepest category via `p.subcategory ?? p.category` and that leaf's ancestor `chainSlugs`, so a universe/section page rolls up descendants (`tokyo-export-catalog.ts:91-106`); `getProductsForSlug` then matches any product whose `category_path` contains the slug (`catalog.ts:117-132`).
   - **Not reflected in Tokyo at all**: a category's description/editorial block, hero/OG/boutique images, SEO meta, warranty/TVA, `is_discountable`, and the attribute filters — the export only carries slug/name/count. Tokyo category pages fabricate ratings/discounts client-side via `fakeRating` (`category-view.tsx:82, 388, 440`) and have **no attribute-filter UI**; the DB-backed `getCategoryAttributeFilters` is consumed only by the legacy `(shell)` search page and admin banner targets (`lib/api/categories.ts:57-148`; consumers in `(shell)/recherche/page.tsx`).

2. **Legacy `(shell)` storefront reads the DB live.** `lib/api/categories.ts:listCategories` (`:288-324`, `'use cache'` tagged `categories`+`products:list`) builds the active-only nested tree + live product counts; `nav-composer.ts:237-242` renders the shell mega-menu "categories" block; `main-nav-items.ts:21-48` composes it. These bust instantly on the `category.*` events above. `/boutique` lives here (`src/app/(shop)/(shell)/boutique`), so the "Page Boutique" tab's settings target the shell, not Tokyo.

### Edit / remove notes

- Safe to edit freely (behaviour is self-contained + revalidated): list UI in `categories-panel.tsx`, form fields/tabs in `category-form.tsx`, SEO/editorial copy. These touch only admin + shell.
- **Load-bearing, change with care**:
  - `getCategoryTree` orphan/cycle handling (`queries.ts:100-132`) — every parent picker and the whole tree UI depend on no live node ever dropping out.
  - The parent-cycle guard (`create-category.ts:222-254`) and the edit page's self-subtree exclusion (`[id]/page.tsx:55-68`) — removing either lets an operator create a `parent_id` loop that spins tree recursion/breadcrumbs.
  - `deleteCategoryWorkflow`'s single transaction (child promotion + product-link move + filter cleanup, `create-category.ts:469-476`) — dropping any step leaves orphaned children, products stuck on a tombstone (lost from parent listings/TVA chain), or a bricked attribute-side picker (comment `:466-468`).
  - The `provided`-set gate in update (`create-category.ts:192, 259-266`) — removing it makes sparse API patches silently re-activate archived categories / re-enable discounts.
  - The `""` filter sentinel (`category-form.tsx:572`) — removing it means an operator who unchecks every filter can no longer clear the M2M.
- **To actually change what Tokyo shows**, editing admin is not enough: you must also re-run `scripts/tokyo-export-catalog.ts` and commit `src/storefront/data/{categories,taxonomy}.json`. If removing/renaming a category, the stale JSON keeps linking to it (a slug that no longer resolves 404s; the export prunes empty branches so a now-empty category silently disappears from nav).
- The "name is create-category.ts but holds update/delete/reorder/tax" is intentional; don't assume one workflow per file.

### Gaps & risks

- **Snapshot drift is the headline risk**: admin and Tokyo can disagree indefinitely. There is no automation, reminder, or CI check tying a category write to a re-export; the only coupling is the comment in `tokyo-export-catalog.ts:11-13` ("Re-run after any catalogue change"). An operator deactivating/deleting a category in admin will still see it live on Tokyo until someone re-exports.
- **Dual source of truth for counts/visibility**: shell uses `is_active` chain + live rollup counts (`countProductsForCategoryTrees`, `catalog.service.ts:169-197`); Tokyo uses pruned `taxonomy.json` counts frozen at export time. The two can show different nav sets for the same DB.
- **`is_active` is not exported to Tokyo** — a category deactivated in admin still appears in `taxonomy.json`/`categories.json` until re-export, so Tokyo can link to a category the owner intended to hide (unlike shell, which drops it immediately via `mapActiveSubcategoryTree`, `lib/api/categories.ts:335-348`).
- **Attribute filters, FAQ, editorial, hero/OG/boutique images, warranty/TVA are category-form features with zero Tokyo surface** — an operator spending time on the Filtres/Contenu/SEO tabs will see no effect on the live store (only on `(shell)`), which may be surprising when "replacing the frontend".
- **Media/icon links are soft (text uuids, no FK)** — deleting a media row leaves a dangling `hero_media_id`/`icon_media_id`; render fallbacks exist but there is no referential guarantee.
- Reorder/toggle are inline optimistic calls that `router.refresh()` after; a failed server action surfaces a shared `actionError` line (`categories-panel.tsx:133, 168, 187`) but the tree does not re-sort until refresh.
- `tokyo-build-categories.ts` is destructive (wipes all categories/brands/products, `:38-40`) — it is a seed tool, must never be confused with the incremental `tokyo-export-catalog.ts`.


<details>
<summary><strong>5. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/categories/page.tsx — server list page; guards categories:view, projects tree with reachable flag (L24-125)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/categories/categories-panel.tsx — client tree UI: sub-tabs, drill-down/flat views, inline toggle/reorder/delete (L84-556)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/categories/new/page.tsx — create page, guards categories:create, flattens parents (L30-87)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/categories/[id]/page.tsx — edit page, guards categories:update, excludes self-subtree from parents (L18-130)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/category-form.tsx — client create/edit form, 6 tabs, filter linker, FAQ fold-in (whole file)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/category/schema.ts — categories table, columns, partial-unique slug/external_ref indexes, CategorySlimRow (L22-148)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/category/service.ts — CategoryService: listAllSlim, softDeleteWithChildPromotion, reorderSiblings, findBySlug (L38-331)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/category/queries.ts — getCategoryTree (orphan/cycle-safe), isCategoryChainActive, getCategoryBySlug (L26-191)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/category/index.ts — module barrel (categoryQueries, CategoryRow, CategoryTreeNode)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/create-category.ts — create/update/reorder/delete/tax workflows, Zod schemas, cycle guard, redirect upkeep (L41-497)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/catalog.ts — category server actions L227-457 + saveBoutiqueLandingAction L467, revalidation
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/associations/product-category.ts — product_categories M2M schema (is_primary) (L11-31)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/associations/catalog.service.ts — productCategoryLinks.set/moveToCategory/countProductsForCategoryTrees/primaryCategoriesForProducts (L24-233)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/api/categories.ts — shell storefront reads (listCategories, mapActiveSubcategoryTree) + ERP/attribute-filter reads (L57-550)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/api/products.ts — listApiProducts leaf/parent 2-level model (L1479-1496), DTO notes (L60-65)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/api/nav-composer.ts — shell mega-menu categories block (L237-242)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/api/main-nav-items.ts — request-cached shell nav composition (L21-60)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/scripts/tokyo-export-catalog.ts — THE Tokyo data bridge: writes categories.json/taxonomy.json/products.json from live DB (whole file)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/scripts/tokyo-build-categories.ts — one-time destructive seed of the tree from migration feed (whole file)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/lib/categoryNav.ts — Tokyo taxonomy index consumed by header mega-menu + breadcrumbs (whole file)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/lib/catalog.ts — loads categories.json/products.json; getProductsForSlug rollup (L83-132)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/lib/data/static-source.ts — static catalog source wiring (whole file)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/lib/api/categories.ts — Tokyo server category facade over the static source (whole file)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/(shop)/(tokyo)/[slug]/page.tsx — Tokyo flat-slug resolver (category vs product) using categoryNav taxonomy (L46-179)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/data/categories.json + taxonomy.json — the bundled snapshots Tokyo renders from (must be re-exported+committed after admin edits)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/attribute/schema.ts — category_attribute_filters M2M (L130-147)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/manage-attributes.ts — setCategoryFiltersWorkflow (L559-591)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/attribute/service.ts — setCategoryFilters/listCategoryFilters (L317-344)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/rbac/registry.ts — categories permission id, CRUD (L75)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/_components/admin-shell.tsx — Catalogue sidebar group, Catégories entry (L117-128)

**Sources of truth**

- categories table schema is HAND-AUTHORED in src/modules/catalog/category/schema.ts (migrations FROZEN at 0007; do NOT db:generate/db:push)
- The TRUE mutation API is the workflow layer src/workflows/catalog/create-category.ts (runs in db.transaction, emits category.* events); server actions in src/lib/actions/catalog.ts are thin wrappers that guard RBAC + revalidate
- Admin tree read SoT = categoryQueries.getCategoryTree() via categoryService.listAllSlim() (returns inactive too, orphan/cycle-safe)
- Tokyo storefront category SoT = the bundled JSON snapshots src/storefront/data/{categories,taxonomy}.json, regenerated ONLY by manually re-running scripts/tokyo-export-catalog.ts and committing — NOT the DB at request time
- Legacy (shell) storefront category SoT = the live DB via lib/api/categories.ts (listCategories), busted by category.* cache tags
- RBAC permission existence SoT = src/lib/rbac/registry.ts (id 'categories', CRUD); grants live in DB role_permissions/user_permission_overrides
- Attribute-as-filter opt-in SoT = category_attribute_filters M2M, written only through setCategoryFiltersWorkflow
- Product→category filing SoT = product_categories M2M (is_primary drives breadcrumb/canonical/TVA chain); written by productCategoryLinks.set from the product form, not the category form

**Editable / removable**

- SAFE: list/row UI and sub-tab wiring in categories-panel.tsx (self-contained client state, server actions revalidate).
- SAFE: form tabs/fields, labels, SEO/editorial/value-prop copy, AI buttons in category-form.tsx — affects admin + (shell) only.
- SAFE: the 'Page Boutique', 'Génération IA', 'Auto-catégoriser' sub-tabs can be removed independently (each is gated + rendered conditionally in page.tsx L103-123, 334-348) — they are adjacent features, not the taxonomy itself.
- LOAD-BEARING: getCategoryTree orphan+cycle handling (queries.ts:100-132) — all parent pickers + the tree depend on no live node dropping out.
- LOAD-BEARING: parent-cycle guard (create-category.ts:222-254) + edit-page self-subtree exclusion ([id]/page.tsx:55-68).
- LOAD-BEARING: deleteCategoryWorkflow single transaction (child promotion + product-link move + filter cleanup, create-category.ts:469-476).
- LOAD-BEARING: the `provided`-set gate in updateCategoryWorkflow (create-category.ts:192,259-266) guards against sparse-patch re-activation.
- LOAD-BEARING: the '' filter sentinel + hidden inputs (category-form.tsx:567-572) — needed to wipe the attribute M2M to empty.
- CANNOT be made to show on Tokyo by editing admin alone: any category change requires re-running scripts/tokyo-export-catalog.ts and committing src/storefront/data/{categories,taxonomy}.json.
- DESTRUCTIVE / do not run casually: scripts/tokyo-build-categories.ts wipes all categories/brands/products (seed only).

**Gaps / risks**

- Snapshot drift: no automation/CI/webhook ties a category write to a Tokyo re-export — admin and the live store can disagree indefinitely until scripts/tokyo-export-catalog.ts is re-run and committed.
- is_active is NOT in the Tokyo export, so a category deactivated/deleted in admin still appears (and may 404-link) on Tokyo until re-export; (shell) hides it live.
- Dual counts/visibility: (shell) uses live rollup counts + is_active chain; Tokyo uses frozen pruned taxonomy.json counts — the two can show different nav.
- Category attribute filters, FAQ, editorial block, hero/OG/boutique images, warranty/TVA, is_discountable have ZERO Tokyo surface — operators editing those tabs see no live effect (Tokyo fabricates ratings via fakeRating and has no attribute-filter UI).
- Media/icon references are soft (text uuids, no FK) — deleting a media row dangles hero_media_id/icon_media_id with no referential guarantee.
- Site-wide and sibling slug uniqueness are enforced only in the workflow (not the DB beyond the root-slug partial index); bypassing the workflow (raw insert / ERP path) could create shadowing slugs.
- scripts/tokyo-build-categories.ts is destructive (wipes categories/brands/products) and easily confused with the incremental export script.
- Reorder/toggle are inline optimistic actions relying on router.refresh(); a stale-id reorder is defended in reorderSiblings but the UI only re-sorts after refresh.

</details>


---

## 6. Marques (brands) — admin Catalogue subsection

Brands own their own flat table and a product↔brand soft link. The admin surface is a full CRUD + editorial/SEO editor plus three side panels (Page Marques landing builder, AI generation, auto-assign). The important truth for this session: the brand **landing page does not exist on the live Tokyo storefront** — only the brand *name string* reaches Tokyo (via the manual JSON export), while the real brand index `/marques` and every brand's rich page live only in the legacy `(shell)` group.

### What the operator sees & does

Page header "Marques" + subtitle "Marques affichées sur les fiches produit, la page /marques et le filtre catalogue." (`brands-panel.tsx:155-158`). A `FormTabStrip` of sub-tabs (`brands-panel.tsx:145-150`):
- **Marques** (list, always shown)
- **Page Marques** (landing builder — only when `canUpdate`)
- **Génération IA** (bulk AI copy — only when `canUpdate`)
- **Auto-affecter** (AI product→brand assignment reports — only when viewer has `system_ai:view`)

**List tab** (`brands-panel.tsx:170-251`): name search box (submits `?q=`, name-only `ILIKE`), a "Réorganiser" button (shown when `canUpdate && reorderBrands.length > 1`), a "Nouvelle marque" link (when `canCreate`), a "from–to sur total" count line, and the row list. Each row (`BrandRow`, `brands-panel.tsx:384-468`): logo thumbnail, name, `/slug` (+ "· désactivée" when inactive), then controls — inline activate toggle (Eye/EyeOff, `canUpdate`), "Voir sur la boutique" external link to `/{slug}` **only for active brands** (`brands-panel.tsx:436-447`), edit pencil (`canUpdate`), delete trash (`canDelete`). Empty state: "Aucune marque pour le moment." or the search-miss variant (`brands-panel.tsx:222-229`). Pager with first/prev/numbered/next/last (`Pager`, `brands-panel.tsx:488-562`).

**Réorganiser mode** (`ReorderView`, `brands-panel.tsx:302-382`): loads the full ordered live set, up/down arrows per row, each move fires `reorderBrandsAction` immediately; "Terminé" exits and refreshes.

**Delete** (`ConfirmDeleteModal`, `brands-panel.tsx:266-297`): shows a logo preview and warns "Les produits associés ne seront plus rattachés à cette marque."

**Create/Edit form** (`brand-form.tsx`, 5 tabs `identity|image|content|faq|seo`, `brand-form.tsx:95-103`), with a `GenerateAllBar` ("Compléter" / "Tout régénérer", `brand-form.tsx:242`):
- **Identité** (`:253-298`): `name` (required), `slug` (auto from name if blank), `externalRef` (ERP reference), `displayOrder`, `isActive` checkbox ("visible sur le storefront"), `isDiscountable` checkbox (per-brand discount opt-out), `tagline`, and a rich-text HTML `description` with AI assist.
- **Image** (`:331-359`): `logoMediaId` + `heroMediaId` `MediaPicker`s (scope `brands`) and an `IconPicker` writing `icon` (curated lucide key) + `iconMediaId` (custom chip image) for the listing nav strip.
- **Contenu** (`:362-398`): `editorialEyebrow`, `editorialTitle`, rich-text `editorialBody` (AI), `ValuePropsEditor` (max 8 cards).
- **FAQ** (`:401-417`): edit-mode only; add/edit Q/A rows with order + published flag. Create mode shows "Enregistrez d'abord la marque."
- **SEO** (`:420-521`): `metaTitle` (60-char counter), `metaDescription` (160), live Google SERP preview, `canonicalUrl`, `noindex` checkbox, `ogImageMediaId` picker, AI SEO generate button.
After a successful **create**, the client redirects to the new brand's edit page (`brand-form.tsx:164-168`). `tax_rate_bps` is **not** in this form — it is edited only on `/admin/system/tax` (see Write path).

### Routes & components

- `src/app/admin/catalog/brands/page.tsx` — **server** RSC list page; guards, pagination, loads logos, marques config, content-gen + auto-assign props (`page.tsx:24-134`).
- `src/app/admin/catalog/brands/brands-panel.tsx` — **client**; `BrandsPanel` + `ReorderView` + `BrandRow` + `Pager` + `EmptyState`.
- `src/app/admin/catalog/brands/new/page.tsx` — **server**, `export const dynamic = "force-dynamic"`, guards `brands:create`, renders `BrandForm mode="create"` (`new/page.tsx:13-40`).
- `src/app/admin/catalog/brands/[id]/page.tsx` — **server**, guards `brands:update`, `notFound()` on bad uuid / missing brand, loads FAQs, renders `BrandForm mode="edit"` with the full initial mapping (`[id]/page.tsx:15-87`).
- `src/components/admin/brand-form.tsx` — **client**; `BrandForm` + `BrandFaqEditorBody`.
- `src/components/admin/marques-landing-settings.tsx` — **client** "Page Marques" block builder (rendered into the panel from `page.tsx:108-116`).
- Shared components used: `ContentGenerationControl`, `AutoAssignControl`, `MediaPicker`, `IconPicker`, `FormTabs`/`FormTabStrip`, `RichTextField`, `ValuePropsEditor`, `AiGenerateButton`, `GenerateAllBar`, `ConfirmDeleteModal`, `IconButton`.

### Data model

- **`brands`** (owned; `src/modules/catalog/brand/schema.ts:15-104`): `id` (uuid v7), `slug`, `name`, `description`, `external_ref`, `logo_media_id`, `icon`, `icon_media_id`, `is_active` (default true), `display_order` (flat 0-based, default 0), `is_discountable` (default true), `tax_rate_bps` (bps, nullable = inherit), editorial block (`hero_media_id`, `tagline`, `editorial_eyebrow`, `editorial_title`, `editorial_body`, `value_props` jsonb `CategoryValueProp[]`), SEO (`meta_title`, `meta_description`, `canonical_url`, `noindex`, `og_image_media_id`), `...timestamps()`, `...softDelete()`. No enums (icon is a free curated lucide string). Brands are **FLAT** — no parent (`schema.ts:2-4`).
- **`product_brands`** (owned join; `src/associations/product-brand.ts:10-22`): `product_id`, `brand_id` (plain `uuid` soft links, NO cross-module FK). Modelled 1:1 — `pb_product_unique` unique index on `product_id` guarantees at most one brand per product; `pb_brand_idx` on `brand_id`.
- **Invariants**: partial-unique slug `brands_slug_unique WHERE deleted_at IS NULL` (tombstones free the slug); partial-unique `brands_external_ref_unique WHERE external_ref IS NOT NULL AND deleted_at IS NULL`; `tax_rate_bps` 0–10000 guarded by DB check `brands_tax_rate_bps_range` + zod (`create-brand.ts:43`); soft-delete is app-enforced (`deleted_at`); every brand reader joins `isNull(brands.deleted_at)` so soft-deleted brands stop resolving while their `product_brands` rows persist (`catalog.service.ts:370-381`); `product_brands.brand_id` is ON DELETE CASCADE only on **hard** delete. Brand FAQs are rows in the CMS `faq` module (not `brands`).

### Read path

- **Admin list**: `brandService.count({search})` first (to clamp the page), then `brandService.list({search,limit:20,offset})` (`page.tsx:48-57`). `PAGE_SIZE = 20` (`page.tsx:22`); offset pagination; order `display_order ASC, name ASC` (`service.ts:77-88`). `brandService.listAll()` loads the full ordered set for reorder + logos (`page.tsx:67-82`); unfiltered `count()` feeds the bulk-gen "Toutes (N)" hint.
- **Admin edit**: `brandService.findById(id)` (`[id]/page.tsx:27`); FAQs via `faqService.listForAdminBrand(id)` (`[id]/page.tsx:31`). Logos resolved with `findMediaByIds` + `resolveMediaThumbUrl` (`page.tsx:85-88`).
- **Storefront/queries** (`src/modules/catalog/brand/queries.ts`): `listActiveBrands()` (`'use cache'`, `cacheTag(CACHE_TAGS.brands)`, build-phase guard, `:38-51`), `listAllBrands()` (React `cache()` per-request for the product-editor picker, `:16-22`), `getBrandBySlug()` (`:85-95`), `listSitemapBrands()` (`:61-79`). `listNavBrands()` in `src/lib/api/brands.ts:124-141` powers the category-page "Marques" strip.
- **REST/ERP read** (`src/lib/api/brands.ts`): `listApiBrands`, `getApiBrandByRef`, `resolveBrandRow` (id → external_ref → slug, caller picks one), projecting `ApiBrand` (`brands.ts:48-114`).

### Write path

All mutations: **action → workflow (`db.transaction` via `workflow()`) → service → event**, with RBAC at the action.
- **Actions** (`src/lib/actions/catalog.ts`): `createBrandAction` (`:40-82`), `updateBrandAction` (`:84-162`, folds in FAQs via `workflows.cms.upsertBrandFaqs`, best-effort), `deleteBrandAction` (`:164-171`), `setBrandActiveAction` (`:174-186`, inline toggle), `reorderBrandsAction` (`:189-198`), `createBrandInlineAction` (`:211-225`, called from the product editor's brand picker).
- **Workflows** (`src/workflows/catalog/create-brand.ts`): `createBrandWorkflow` (zod `createBrandSchema`, slug via `checkSlugAvailability` against the shared flat `/[slug]` namespace, new brand lands at `max(display_order)+1`, `:80-134`), `updateBrandWorkflow` (per-field diff → `changedFields[]`, slug-conflict check with `excludeKind:"brand"`, `syncEntityUrlRedirects` for slug/active changes, `:164-293`), `reorderBrandsWorkflow` (`:353-364`), `deleteBrandWorkflow` (**blocks** if live promotions target the brand, then soft-delete, `:366-386`), `setBrandTaxRatesWorkflow` (the only tax-rate writer — used by `/admin/system/tax` «Marques» tab, `:316-339`).
- **Service** (`src/modules/catalog/brand/service.ts`): `insert`, `update` (sets `updated_at=now()`), `softDelete`, `reorderSiblings` (locks the live set `FOR UPDATE`, de-dupes ids, renumbers 0..n, returns moved ids, `:113-150`), `deleteAll` (hard delete, cascades `product_brands`, `:201-204`). Product link writes go through `productBrandLink.set(productId, brandId)` (delete-then-insert, `catalog.service.ts:360-368`) from the **product** workflows, not the brand form.
- **Events** (`src/events/types.ts:231-233`): `brand.created`, `brand.updated {changedFields}`, `brand.deleted`. Subscribers: `invalidate-catalog-cache` busts `CACHE_TAGS.brands` on all three (`:53-55`); `reembed-product` marks linked products needing re-embedding only on a **name** change or delete (`:74-93`); `invalidate-media-cache` also busts `brands` (`:32`).
- **Revalidation**: actions call `revalidatePath("/admin/catalog/brands")`, plus `/{id}` and `/{slug}` on update (`catalog.ts:151-154`).

### RBAC

Permission id **`brands`** with full `CRUD` actions, group "Catalogue", label "Marques" (`src/lib/rbac/registry.ts:76`). This is brands' **own** id — unlike Drip & Cartes-cadeaux which reuse `products`. Guards: list page `requirePermission("brands","view")` (`page.tsx:30`); `new` → `"brands","create"` (`new/page.tsx:17`); `[id]` → `"brands","update"` (`[id]/page.tsx:25`). Every mutating action re-guards: create→`create`, update/setActive/reorder/inline→`update`, delete→`delete` (`catalog.ts:44,88,165,175,190,215`). The panel derives `canCreate/canUpdate/canDelete` from `resolveUserPermissions` + `permissionSetAllows` to hide controls a view-only role can't use (`page.tsx:36-41`). "Page Marques" and "Génération IA" sub-tabs require `brands:update`; "Auto-affecter" requires `system_ai:view` (read) with start/apply gated on `system_ai:manage` (`page.tsx:37-41,72-82`). REST surface maps `brands.*` routes to module `brands` read/write scopes (`route-catalog.ts:117-122`).

### Storefront linkage

This is the load-bearing caveat for this session. Two distinct realities:

1. **Live Tokyo storefront `(tokyo)` — brand pages DO NOT EXIST.** The only flat `/[slug]` route under `(shop)` is `(tokyo)/[slug]` (`find` confirmed; `(shell)` has no `[slug]`). Its resolver `resolveSlug` tries nav-alias → category → product → fuzzy-category only; it has **no brand branch** (the sole "brand" reference is the product JSON-LD at `(tokyo)/[slug]/page.tsx:198`). So `/apple`, `/samsung`, etc. 404 on the live site unless the slug happens to match a category/product/alias. The Tokyo storefront lib has **no** brand-by-slug resolver (grep of `src/storefront/lib/api` empty). Therefore logo, hero, editorial, tagline, value-props, FAQ, SEO, `display_order`, and the Page-Marques builder **never render on the live Tokyo site**.

2. **Brand NAME reaches Tokyo only via the manual JSON export.** `scripts/tokyo-export-catalog.ts:92-106` writes `brand: p.brand ?? ""` into `src/storefront/data/products.json`, where `p.brand` is the resolved **active** brand's *name* (`src/lib/api/products.ts:1467-1472`; an inactive/soft-deleted brand yields `""`). That string is the only brand data Tokyo consumes: the product "Marque" spec row and warranty line (`src/storefront/lib/productMeta.ts:101,157`), accessory-carousel grouping (`accessory-carousel.tsx:70-76`), cart line (`cart-view.tsx:576`), `platform-map.ts:24`. It is a **display string with no link, logo, or page**. Admin brand-name edits are invisible on Tokyo until someone re-runs the export and commits the JSON; a rename also triggers product re-embedding (subscriber) but the JSON stays stale until re-export.

3. **`/marques` index + per-brand pages are served by the legacy `(shell)` group**, reading the DB **live**. `(shell)/marques/page.tsx` is a block builder driven by `getMarquesLandingConfig()` (`src/lib/pages/marques-landing-config.ts`, `pages.marques.*` in `site_settings`) and `brandQueries.listActiveBrands()`; brand/landing edits appear there immediately (tag-busted). But it renders in the legacy shell design, and each brand links to `/{b.slug}` (`marques/page.tsx:145`) — which lands on the Tokyo resolver and 404s as in (1). `(shell)/brand/[slug]` is a permanent redirect to `/{slug}` (`brand/[slug]/page.tsx`). The admin "Voir sur la boutique" link (`/{slug}`) has the same dangling fate.

Net: brand admin edits reach (a) `/marques` live (legacy design), (b) Tokyo product cards as a plain name string after a manual re-export — and reach the Tokyo *brand page* never, because there is no such route.

### Edit / remove notes

- **Safe to edit**: all brand form fields, the "Page Marques" builder, AI generation, and reorder — these write the DB and surface on `/marques` immediately. The form's AI buttons use `feature="marques"` (`brand-form.tsx:48`).
- **Load-bearing, do not break**:
  - `product_brands` 1:1 link + `productBrandLink.{set,findBrandId,listProductIdsForBrand,countPublishedProductsForBrands}` (`catalog.service.ts:359-423`) — used by the product editor, the tax cascade (brand tier), brand-scoped promotions/coupons, the storefront `product.brand` resolution, and the sitemap. The brand form does **not** write this link; the product workflows do.
  - `checkSlugAvailability` — brand slugs share the flat `/[slug]` namespace with products, categories and CMS pages; renaming must keep going through it (`create-brand.ts:93,181`).
  - `CACHE_TAGS.brands` bust + `listActiveBrands`'s `'use cache'`/build-phase guard — removing the tag bust makes `/marques`/nav strip stale.
- **Delete semantics**: `deleteBrandWorkflow` is a **soft** delete and is **blocked** while live promotions target the brand (`create-brand.ts:376-382`). Product links persist but stop resolving (live-brand join). The only hard delete is `brandService.deleteAll()` (segmented "clean" flow), which cascades `product_brands`.
- **tax_rate_bps** is fully supported by schema/zod/workflow but intentionally absent from the brand form — it is edited on `/admin/system/tax` «Marques» via `setBrandTaxRatesWorkflow`. Leave that path intact if touching tax.
- If the owner wants brand landing pages to actually work on Tokyo, that requires **adding a brand branch** to `(tokyo)/[slug]` `resolveSlug` plus a storefront brand resolver + view — none exist today. Until then the `/marques` brand links are dead on the live store.

### Gaps & risks

- **Dangling brand links / dead landing pages (highest impact).** `/marques` and the admin "Voir sur la boutique" link both point at `/{slug}`, which the live Tokyo `[slug]` resolver cannot resolve to a brand → 404. All brand editorial/SEO/logo/hero/FAQ/value-prop content is unreachable on the live Tokyo site.
- **Export staleness.** Only the brand *name* reaches Tokyo product cards, and only after a manual `scripts/tokyo-export-catalog.ts` re-run; `display_order`, featured, logo, icon, and the Page-Marques builder never reach Tokyo. A rename creates a DB↔JSON mismatch window (DB live on `/marques`, JSON stale on Tokyo cards).
- **Design split.** `/marques` renders in the legacy `(shell)` design, inconsistent with the rest of the live Tokyo store.
- **`setBrandActiveAction` uuid check** uses a loose `/^[0-9a-f-]{36}$/i` regex (`catalog.ts:176`) rather than `isUuid`; functionally fine but weaker than the edit page's `isUuid`.
- **`displayOrder` two writers.** The form's absolute `displayOrder` field and the Réorganiser renumber can disagree; a manual value set in the form is immediately overwritten by the next reorder. Minor, but confusing to operators.
- **Catalog filter wording.** The panel subtitle mentions "le filtre catalogue", but no brand facet exists in the Tokyo storefront catalog (grep of `src/storefront/lib` found no brand filter); any brand filtering is legacy-shell only.


<details>
<summary><strong>6. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/brands/page.tsx — server list page: RBAC gates, PAGE_SIZE=20 pagination, loads logos + marques config + content-gen + auto-assign
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/brands/brands-panel.tsx — client panel: sub-tabs, list rows, search, ReorderView, delete modal, Pager
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/brands/new/page.tsx — create page (force-dynamic, brands:create)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/brands/[id]/page.tsx — edit page (brands:update), loads brand + FAQs, maps BrandForm initial
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/brand-form.tsx — 5-tab create/edit form (Identité/Image/Contenu/FAQ/SEO) + BrandFaqEditorBody + AI
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/marques-landing-settings.tsx — 'Page Marques' block-builder client component
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/brand/schema.ts — brands table (flat), partial-unique slug/external_ref, tax_rate_bps range, editorial+SEO cols
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/brand/service.ts — brandService: list/count/listAll/findById/reorderSiblings(FOR UPDATE)/softDelete/deleteAll
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/brand/queries.ts — listActiveBrands ('use cache' tag=brands, build-phase guard), listAllBrands (per-request cache), getBrandBySlug, listSitemapBrands
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/brand/index.ts — barrel: brandQueries + BrandRow type
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/create-brand.ts — create/update/delete/reorder/setTaxRates workflows + zod schemas + events
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/catalog.ts — brand server actions (lines 39-225): create/update/delete/setActive/reorder/inline
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/api/brands.ts — REST/ERP read projection (ApiBrand, resolveBrandRow) + listNavBrands for category-page strip
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/associations/product-brand.ts — product_brands join table (pb_product_unique 1:1, pb_brand_idx)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/associations/catalog.service.ts — productBrandLink.{set,findBrandId,listProductIdsForBrand,countPublishedProductsForBrands} (lines 359-423, live-brand join)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/pages/marques-landing-config.ts — getMarquesLandingConfig (pages.marques.* settings) for the /marques block builder
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/(shop)/(shell)/marques/page.tsx — LIVE /marques brand index (legacy shell design), links each brand to /{slug}
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/(shop)/(shell)/brand/[slug]/page.tsx — legacy /brand/[slug] -> permanentRedirect(/{slug})
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/(shop)/(tokyo)/[slug]/page.tsx — LIVE Tokyo flat-slug resolver; NO brand branch (brands 404 here)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/scripts/tokyo-export-catalog.ts — manual export writing brand NAME into src/storefront/data/products.json (line 103)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/lib/productMeta.ts — Tokyo consumes product.brand as a display string (spec row 'Marque', warranty)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/rbac/registry.ts — brands permission id (line 76, group Catalogue, CRUD, own id)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/events/subscribers/invalidate-catalog-cache.ts — busts CACHE_TAGS.brands on brand.created/updated/deleted (lines 53-55)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/events/subscribers/reembed-product.ts — re-embeds linked products on brand name change/delete (lines 74-93)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/api-auth/route-catalog.ts — REST surface for brands.* (lines 117-122, module 'brands')

**Models / tables**

- brands (owned) — id, slug (partial-unique WHERE deleted_at IS NULL), name, description, external_ref (partial-unique), logo_media_id, icon, icon_media_id, is_active, display_order (flat 0-based), is_discountable, tax_rate_bps (0-10000 bps, DB check brands_tax_rate_bps_range), hero_media_id, tagline, editorial_eyebrow/title/body, value_props (jsonb CategoryValueProp[]), meta_title/description, canonical_url, noindex, og_image_media_id, timestamps, deleted_at; indexes brands_slug_unique, brands_external_ref_unique, brands_og_image_media_id_idx, brands_icon_media_id_idx
- product_brands (owned join, soft uuid links, no FK) — product_id, brand_id; pb_product_unique (enforces 1 brand/product), pb_brand_idx; brand_id ON DELETE CASCADE on hard delete only
- faq (CMS module, joined) — brand-scoped FAQ rows via faqService.listForAdminBrand / upsertBrandFaqs (not owned by brands)
- site_settings (CMS, joined) — pages.marques.* keys for the /marques landing builder
- No brand enums; icon is a free curated lucide key string (@/lib/catalog/chip-icons)

**Sources of truth**

- Schema (hand-authored, migrations frozen at 0007): src/modules/catalog/brand/schema.ts (brands) and src/associations/product-brand.ts (product_brands join)
- Mutation API: src/workflows/catalog/create-brand.ts (create/update/delete/reorder/setTaxRates workflows) invoked only through src/lib/actions/catalog.ts server actions
- RBAC permission registry: src/lib/rbac/registry.ts line 76 (id 'brands', CRUD, group Catalogue); grants in DB role_permissions/user_permission_overrides
- Storefront DISPLAY snapshot for Tokyo: src/storefront/data/products.json, regenerated ONLY by manually re-running scripts/tokyo-export-catalog.ts (brand carried as name string)
- Live /marques config: site_settings pages.marques.* via src/lib/pages/marques-landing-config.ts (saved by saveMarquesLandingAction in catalog.ts)
- REST/ERP contract: src/lib/api-auth/route-catalog.ts brands.* + the test suite src/lib/db/tests/** (no OpenAPI)

**Editable / removable**

- SAFE: all brand-form fields, Page-Marques builder, AI generation, reorder — write the DB and show on /marques immediately via the brands cache-tag bust
- SAFE to re-theme/relocate: the /marques index renders in the legacy (shell) design; moving it to Tokyo is purely additive (no DB dependency)
- LOAD-BEARING: product_brands 1:1 link + productBrandLink.* (product editor, tax cascade brand tier, brand-scoped promotions/coupons, storefront product.brand, sitemap counts) — brand form does NOT write it; product workflows do
- LOAD-BEARING: checkSlugAvailability (brand slugs share the flat /[slug] namespace with products/categories/CMS); CACHE_TAGS.brands bust + listActiveBrands 'use cache'/build-phase guard
- DELETE is soft and BLOCKED while live promotions target the brand (deleteBrandWorkflow); hard delete only via brandService.deleteAll (segmented clean, cascades product_brands)
- tax_rate_bps is supported by schema/workflow but NOT in the brand form — edited only on /admin/system/tax «Marques» (setBrandTaxRatesWorkflow); keep that path if touching tax
- To make brand landing pages live on Tokyo you must ADD a brand branch to (tokyo)/[slug] resolveSlug + a storefront brand resolver/view — none exist today

**Gaps / risks**

- Dead brand landing pages on live Tokyo: (tokyo)/[slug] resolver has no brand branch, so /marques links and the admin 'Voir sur la boutique' link (/{slug}) 404 unless the slug matches a category/product/alias; all brand editorial/SEO/logo/hero/FAQ/value-props are unreachable on the live store
- Export staleness: only brand NAME reaches Tokyo product cards, and only after a manual tokyo-export-catalog re-run; display_order/featured/logo/icon/Page-Marques never reach Tokyo; a rename leaves products.json stale until re-export
- Design inconsistency: /marques renders in the legacy (shell) shell, not the Tokyo design
- setBrandActiveAction uses a loose /^[0-9a-f-]{36}$/i uuid check (catalog.ts:176) instead of isUuid
- Two display_order writers (form absolute field vs Réorganiser renumber) can silently overwrite each other
- Panel subtitle says 'le filtre catalogue' but the Tokyo storefront has no brand facet (brand filtering is legacy-shell only)

</details>


---

## 7. Drip & Exclusivité (tiered release / early access)

"Drip & Exclusivité" is the per-product, per-tier **timed visibility** feature: a product can be released progressively down a loyalty ladder (drip) and/or locked to a tier forever (∞ exclusive), independently on two ladders — **coin** (consumer `loyalty_levels`) and **business** (B2B `business_levels`). It sits on top of a simpler **global** early-access delay (`loyalty_levels.early_access_delay_days`) that staggers every newly-published product. The admin "Catalogue → Drip & Exclusivité" page is a **dashboard + read-only overview**; the real per-product editor is a tab on the product form.

**Headline finding (storefront linkage): the entire feature is DEAD on the live Tokyo storefront.** Tokyo reads a bundled JSON snapshot that carries no tier/drip/early-access data, and the export that builds it runs un-embargoed (`public: false`). Drip only takes effect on the legacy `(shell)` surfaces, the REST/feed APIs, and the cart/order workflows. Details in the Storefront linkage sub-section — it is a real gap.

### What the operator sees & does

The page `/admin/catalog/drip` renders a two-tab wrapper (`DripTabs`, `drip-tabs.tsx:27`) under the title "Drip & Exclusivité":

- **Tab 1 "Par niveau (vague nouveautés)"** (`early-access-tiers-panel.tsx`): **read-only**. Lists every loyalty level (incl. disabled, flagged "(désactivé)") with its global early-access delay in days ("Immédiat" when 0). A top banner warns when the master early-access switch is off (`masterEnabled=false`) that "ces délais ne s'appliquent pas". The only control is a link to **Fidélité → Niveaux** (`/admin/marketing/loyalty`) — there is no editor here; these values are edited in one place only (`early-access-tiers-panel.tsx:78-88`).
- **Tab 2 "Par produit (planification)"** (`DripDashboard`, `drip-panel.tsx:33`): a table of every product that carries a schedule. Columns: **Produit** (name, `/slug`, "· brouillon" if unpublished, `drip-panel.tsx:136-140`), **Échelle points** (coin ladder floor badge + next-drop countdown), **Échelle entreprise** (business ladder floor + countdown), **Actions**. Floor badge is green "Public …" (Unlock) or primary "<Tier>" (Lock); a product that opted out shows "Public (accès anticipé désactivé)" (`page.tsx:81-84`, `drip-panel.tsx:91-113`). Rows are sorted soonest-next-drop first (`page.tsx:169-175`). Per-row actions: **"Rendre public"** (clears the schedule inline), **"Modifier"** (links to the product form), and an external-link icon to the PDP (`drip-panel.tsx:150-177`). Empty state: "Aucun produit échelonné pour le moment." with a hint to use the product form (`drip-panel.tsx:57-67`). There are no filters, search, bulk actions, or create form on this page.

The **actual create/edit controls** live in the product form's "Drip & Exclusivité" tab (`DripExclusivityPicker`, `product-form.tsx:3408`), reached via "Modifier". It offers a **Public / Échelonné** mode toggle (`tierMode` hidden input, `:3638`); in Échelonné mode: a **"Début du drip"** `datetime-local` (posted only when dirty, `:3690-3697`), and per-ladder (coin + business) rows each with a **scheduled checkbox**, a **"Délai à ce niveau" day input**, and an **"∞ Exclusif (s'arrête ici)" checkbox** — top row flagged "TOP", disabled levels shown read-only but preserved, rows below an ∞ step greyed out (`:3536-3611`). A live **"Aperçu de la diffusion"** preview computes the cumulative release schedule client-side (`buildPreview`, `:3466-3510`). An amber warning shows when the product's `early_access_enabled` is off, because the schedule then does nothing (`:3639-3645`).

### Routes & components

- `src/app/admin/catalog/drip/page.tsx` — **server** component `DripDashboardPage`. Guards, loads ladders + scheduled products, computes floor/countdown views, renders `<DripTabs>`.
- `src/app/admin/catalog/drip/drip-tabs.tsx` — **client** (`"use client"`). Tab strip + wrapper; owns the active-tab state.
- `src/app/admin/catalog/drip/early-access-tiers-panel.tsx` — **server** component (no `"use client"`), pure display.
- `src/app/admin/catalog/drip/drip-panel.tsx` — **client**. `DripDashboard` table + `DripRow` (the inline "Rendre public" `useTransition` action, `:116-130`).
- `src/components/admin/product-form.tsx` — **client**. `DripExclusivityPicker` (`:3408`) is the granular editor, rendered in the `drip` FormTab (`:1155-1165`); tab registered at `:281`, in the "Marketing" group `:365`.
- `src/app/admin/catalog/products/[id]/page.tsx` — **server**. Hydrates the drip tab: loads `productTierRelease.listForProduct` + both ladders, builds `tierDwellByLevel` / `tierCoinLevels` / `tierBusinessLevels` / `tierMode` / `dripStartAt` (`:100-147`, `:386-393`).

### Data model

- **`product_tier_release`** (`tier-release.schema.ts:36`), owned by this feature. Columns: `id` (uuid v7 PK), `product_id` (uuid, **the only enforced FK** → `products(id) ON DELETE CASCADE`, added in migration), `ladder` (`text`, `'coin'|'business'`, CHECK in migration), `level_id` (uuid, **SOFT link** to `loyalty_levels.id` OR `business_levels.id` depending on `ladder` — no FK), `dwell_days` (`integer`, nullable; **NULL = ∞/forever**, drip stops here = exclusive floor), `created_at`/`updated_at`. Unique index `ptr_product_ladder_level_unique` on `(product_id, ladder, level_id)` — one step per (product, ladder, level); its leading column also serves the FK-cascade / product lookups, so the standalone `product_id` index was dropped in migration `0150`.
- **`products`** columns joined/owned by the feature (`product/schema.ts`): `drip_start_at` (timestamptz, nullable, `:195`), `early_access_enabled` (boolean NOT NULL default true, `:217`), `published_at` (`:186`). The drip anchor = `drip_start_at ?? published_at` (`viewer-tier-access.ts:188-194`).
- **`loyalty_levels.early_access_delay_days`** — the separate global per-tier delay (read-only surfaced in Tab 1; edited in Fidélité).
- **Enums / consts**: `TIER_RELEASE_LADDERS = ["coin","business"]` (`tier-release.schema.ts:67`).
- **Invariants**: a level's **rank** = its index in the ascending enabled-level list of its ladder (0 = entry, higher = more exclusive). Steps are ordered TOP→BOTTOM; the top step is visible at `dripStart` (offset 0), each lower tier at `dripStart + Σ dwell of higher tiers`; a null dwell terminates the cascade; a finite lowest dwell → PUBLIC after it elapses (`tier-access.ts:54-91`). Visibility across the two ladders is an **OR** (`isTieredProductVisible`, `:106-140`). Ladders are ranked **including disabled** levels so a temporarily-disabled tier keeps its slot — otherwise re-ranking would collapse an exclusive floor to public (`viewer-tier-access.ts:44-54`). Migrations are FROZEN (`0090` early_access, `0094` tier_release, `0150` drop index); schema hand-authored.

### Read path

- **Admin dashboard** (`page.tsx`): `productTierRelease.productIdsWithSchedule()` → all scheduled ids, then `productTierRelease.listForProducts(ids)` (one batched query, grouped) + `productQueries.listProductsByIds(ids)` for product metadata (`page.tsx:121-126`). Per product it builds coin/business `TierStep[]` via `buildSchedulesFromRows` and the anchor via `dripStartMsFor`, then the floor label (`currentReleasedFloorRank`) and countdown (`nextDripTransition`) from `tier-access.ts`. **No pagination** — the whole scheduled set is loaded and sorted in memory.
- **Product-edit hydrate** (`[id]/page.tsx:123`): `productTierRelease.listForProduct(productId)` → `tierDwellByLevel` map (`dwell_days==null ? "inf" : n`).
- **Storefront/API gating read** (DB-live surfaces only): `filterEarlyAccessRows` (`viewer-early-access.ts:83`) → `loadProductSchedules` (batched `listForProducts`, `viewer-tier-access.ts:174`) → `getViewerTierRanks` → `isTieredProductVisible`. The global-delay path uses `getViewerEarlyAccessDelay` + `isProductVisibleForDelay`. The pure resolver (`tier-access.ts`) has no DB and is unit-tested.

### Write path

Two Server Actions in `src/lib/actions/catalog.ts`, both routed through the **one** mutation workflow `workflows.catalog.updateProduct` (`create-product.ts`):

1. **`saveProductTierAccessAction`** (`catalog.ts:1485`) — the dashboard "Rendre public" / standalone save. `requirePermission("products","update")` (`:1490`), validates `productId` as uuid, parses `dripStartAt` in the **store zone** (Africa/Tunis, `parseStoreLocalDateTime`), calls `updateProduct({ productId, tierSchedule, dripStartAt })`, then `revalidatePath("/admin/catalog/drip")` + the product page (`:1511-1512`). "Rendre public" sends `tierSchedule: []` + `dripStartAt: null` (`drip-panel.tsx:123-127`).
2. **Product form** (`updateProductAction` `:967`, `createProductAction` `:870`) — `parseTierSchedule(formData)` (`catalog.ts:1980`) reads `tierMode` + `tierCoin.<uuid>` / `tierBusiness.<uuid>` (value `""`=skip, `"inf"`=null dwell, number=dwell) + optional `dripStartAt`, returning `{ tierSchedule, dripStartAt, scope }`; `scope` = every level the editor rendered (used to preserve out-of-scope steps). Revalidates `/admin/catalog/products` + the product page (`:1105-1106`).

**Workflow** (`updateProduct`, `create-product.ts`): zod validates `tierSchedule` (`:248`), `dripStartAt: z.coerce.date().nullable().optional()` (`:265`), `tierScheduleScope` (`:465`). It (a) **scope-merges** preserved out-of-scope steps so a partial editor can't drop an exclusivity step (`:663-678`), (b) diffs via `sameTierSchedule` → `writeTier` (`:679`), (c) applies the **re-publish anchor freeze** so re-publishing a NULL-anchor scheduled product doesn't restart the drip (`:690-704`), then inside **`db.transaction`**: `productTierRelease.setForProduct(...)` (REPLACE semantics — delete-then-insert, de-dupes, drops malformed uuid/non-finite dwell, takes a **per-level `pg_advisory_xact_lock`** to serialize with level deletes, `tier-release.service.ts:35-80`) and reconciles `drip_start_at` (`:909-941`: empty→null, explicit pick, or stamp now() for a schedule newly added to a live product). On commit, emits **`product.updated`** with `changedFields` including `"tier_release"` / `"drip_start_at"` (`:954-958`); publish transitions emit `product.published`/`unpublished`. `createProduct` persists the schedule + stamps the anchor (`:420-430`, `:324-330`). `deleteProduct` clears the schedule + anchor in-tx and emits `product.deleted` (`:1030-1035`). `duplicateProduct` copies the schedule but **not** `drip_start_at` (`duplicate-product.ts:211-219`).

### RBAC

- Permission id **`products`** (`rbac/registry.ts:68`, actions `view/create/update/delete/manage`). **Drip reuses it — confirmed**: there is no `drip`/`tier` permission.
- `page.tsx:88` → `requirePermission("products","view")`. `saveProductTierAccessAction` → `requirePermission("products","update")` (`:1490`). Product `[id]` page → `requirePermission("products","view")` (`:61`); form saves → `products:update`/`create`.
- Nav: `admin-shell.tsx:134` registers "Drip & Exclusivité" under the Catalogue group with nav id `"products"` (shared id for visibility only — "anyone who can view products"); "Cartes cadeaux" `:137` reuses it the same way.
- **No REST route** — drip/tier are absent from the route-catalog SoT (`route-catalog.ts`); this is a Server-Action-only surface. The level-delete guards (`loyalty-program.ts:221`, `business.ts:771`, `segments.ts:1233/1258`) call `productTierRelease.countUsingLevel` under the same advisory lock to **block** deleting a level still pinned by a schedule (would orphan the soft link → expose an exclusive).

### Storefront linkage

The gating engine runs **only on DB-live surfaces**: `lib/api/products.ts` facades and PDP body (`filterEarlyAccessRows` at many call sites, `:236/282/312/334/417/606/627/978-979/1067/1079`; `getProductBySlug` itself applies **no** embargo and relies on the PDP body + `/md` twin to gate, `:121-131`), `/api/products`, `/api/store/search`, `/api/stock`, `/api/reviews`, SEO `/md`, the public product **feeds**, and the **cart/order workflows** (`add-to-cart.ts:38`, `place-order.ts:464`, `place-quick-order.ts:160`, `review.ts:74`). These back the legacy **`(shell)`** group + the REST/ERP surface + checkout.

**The live customer storefront is the `(tokyo)` design, and it does NOT enforce drip/early-access at all:**
- Tokyo pages read through `src/storefront/lib/api/products.ts` → `catalogSource`, which defaults to **`staticSource`** (bundled JSON `src/storefront/data/products.json`); `httpSource` is a `notImplemented()` stub whose sketch mapping omits any tier field (`storefront/lib/data/index.ts:14-18`, `http-source.ts:37-57`). No Tokyo page or `src/storefront/**` module calls `filterEarlyAccessRows` / `isTieredProductVisible` (the Tokyo PDP `(tokyo)/[slug]/page.tsx` just calls the static `getProductBySlug`).
- The snapshot's `RawProduct` shape has **no** `early_access`/`drip`/`tier` columns — only slug/title/price/availability/category (`tokyo-export-catalog.ts:25-47`).
- The export runs `listApiProducts({ public: false })` → `public:false` means `filterEarlyAccessRows` is **skipped**; the script comment says "full catalogue, **no viewer embargo**" (`tokyo-export-catalog.ts:76`, `:85`).

So a drip-scheduled or permanently-∞-exclusive product is exported and shown to **everyone** on Tokyo the moment the catalog JSON is re-exported — no release window, no tier gate. Admin drip edits are invisible on Tokyo twice over: once because Tokyo ignores the embargo, and once because the snapshot must be manually re-exported anyway. **One inconsistency to flag:** the cart/order workflows still gate against the live DB, so a Tokyo shopper who sees an embargoed product can be **blocked at add-to-cart/checkout** (visible-but-not-buyable).

### Edit / remove notes

- **Safe to edit freely**: all copy/labels/formatting in `page.tsx` (`countdown`, label strings), `drip-panel.tsx`, `early-access-tiers-panel.tsx`, `drip-tabs.tsx`, and the picker UI in `product-form.tsx` — these are display-only. Tab 1 ("Par niveau") is pure display with no editor; it can be dropped with no functional loss (editing lives in Fidélité → Niveaux).
- **Load-bearing — do not casually remove**: `productTierRelease.setForProduct` REPLACE-semantics + the per-level advisory locks; the **includeDisabled** ranking in `page.tsx:94` and `viewer-tier-access.ts:55-59` (dropping it re-ranks and exposes exclusives); the **level-delete guards** (`loyalty-program.ts`, `business.ts`, `segments.ts`) — `level_id` has no FK, so these are the only thing stopping an orphaned soft link from silently flipping an exclusive product public; the **re-publish anchor freeze** (`create-product.ts:690-704`); and every `filterEarlyAccessRows` call site (removing one un-gates that surface).
- **To remove the feature entirely**: delete the nav entry (`admin-shell.tsx:134`), the `/admin/catalog/drip` route, the product-form `drip` tab + `parseTierSchedule`, the workflow schedule/anchor handling, and the three level-delete guards. Because the cart/order gate still reads the DB, **first clear all `product_tier_release` rows** (set every product to Public) so no shopper hits a checkout block after the UI is gone. Removing drip has near-zero impact on the live Tokyo store (which already ignores it).

### Gaps & risks

- **CRITICAL — feature inert on the live store**: Tokyo renders the static snapshot with no embargo, and the export is un-embargoed (`public:false`). Drip/exclusivity/early-access configured in admin never reach customers on `(tokyo)`. The admin dashboard, picker and preview all promise behavior the live UI silently drops.
- **Visible-but-not-buyable**: `add-to-cart.ts:38` / `place-order.ts:464` / `place-quick-order.ts:160` still enforce the embargo server-side against the DB, so a Tokyo shopper can browse an embargoed product (from JSON) yet be rejected at cart/checkout — confusing and inconsistent with the visible catalogue.
- **The global per-tier delay is dead on Tokyo too** for the same snapshot reason, so Tab 1's whole premise ("vague nouveautés") doesn't apply to the live store.
- **Soft-link fragility**: correctness of exclusivity hinges entirely on the delete guards + includeDisabled ranking + advisory locks. Any new code path (or direct SQL) that deletes a loyalty/business level without `countUsingLevel` orphans the step and flips exclusives public — the comments call this out but nothing enforces it structurally (no FK).
- **No pagination** on the dashboard (`page.tsx:121-125` loads every scheduled product) — fine today, unbounded at scale.
- **Three-places config**: the schedule (product form), the per-tier delay (Fidélité → Niveaux), and the master switch (`loyaltyCfg.earlyAccessEnabled`, Fidélité → Réglages) — easy to misconfigure. A product with `early_access_enabled=false` silently exempts itself from both the global delay and its own drip (`viewer-early-access.ts:144`, `page.tsx:146`); the picker warns but the schedule can be built to do nothing.
- **`httpSource` stub** means even flipping `NEXT_PUBLIC_DATA_SOURCE=http` would not restore drip — the adapter (and its ApiProduct→Product mapping) would have to be implemented and, crucially, call the gating path per viewer.


<details>
<summary><strong>7. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/drip/page.tsx — server dashboard page; requirePermission('products','view'); builds floor/countdown views (no pagination)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/drip/drip-tabs.tsx — client 2-tab wrapper (Par niveau / Par produit)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/drip/drip-panel.tsx — client dashboard table + DripRow 'Rendre public' inline action
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/drip/early-access-tiers-panel.tsx — read-only global per-tier delay overview; links to Fidélité
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/product-form.tsx — DripExclusivityPicker (:3408) is the REAL editor; drip tab at :1155
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/products/[id]/page.tsx — hydrates the drip tab (listForProduct, ladders) :100-147
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/product/tier-release.schema.ts — product_tier_release table (soft level_id link, dwell_days null=∞)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/product/tier-release.service.ts — setForProduct REPLACE + advisory locks; countUsingLevel delete guard; batched loaders
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/loyalty/tier-access.ts — pure resolver: currentReleasedFloorRank, isTieredProductVisible, productAccessStatus, nextDripTransition, rankOf
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/loyalty/viewer-tier-access.ts — request-scoped ladder/rank resolvers, buildSchedulesFromRows, loadProductSchedules, dripStartMsFor
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/loyalty/viewer-early-access.ts — filterEarlyAccessRows (the storefront gate combining global delay + drip)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/loyalty/early-access.ts — global per-tier delay helpers isProductVisibleForDelay / maxEnabledDelay
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/catalog.ts — saveProductTierAccessAction (:1485) + parseTierSchedule (:1980)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/create-product.ts — updateProduct/createProduct: scope merge, anchor freeze, setForProduct, events (:660-704, :909-958)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/api/products.ts — getProductBySlug applies NO embargo (:121); all filterEarlyAccessRows call sites (shell + REST + feeds)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/scripts/tokyo-export-catalog.ts — builds the Tokyo JSON snapshot via listApiProducts({public:false}) = no embargo, no tier fields (:76,:85)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/lib/data/index.ts — catalogSource defaults to staticSource (JSON); http is a stub
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/lib/data/http-source.ts — notImplemented() stub; sketch mapping omits drip/tier fields
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/(shop)/(tokyo)/[slug]/page.tsx — Tokyo PDP; calls static getProductBySlug, no gating
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/rbac/registry.ts — 'products' permission (:68); no drip/tier permission
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/_components/admin-shell.tsx — nav entry 'Drip & Exclusivité' reuses id 'products' (:134)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/loyalty-program.ts:221 & src/lib/actions/business.ts:771 & src/workflows/data/segments.ts:1233 — level-delete guards via countUsingLevel
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/db/tests/tier-access.test.ts & early-access.test.ts — pure-resolver + viewer-gating contract tests

**Models / tables**

- product_tier_release (OWNED): id uuidv7 PK; product_id uuid (FK→products ON DELETE CASCADE, enforced in migration); ladder text 'coin'|'business' (CHECK in migration); level_id uuid (SOFT link to loyalty_levels.id OR business_levels.id, NO FK); dwell_days integer NULL (NULL=∞/forever exclusive floor); created_at/updated_at. Unique index ptr_product_ladder_level_unique (product_id, ladder, level_id); standalone product_id index dropped in migration 0150
- products (JOINED/owned cols): drip_start_at timestamptz NULL (schema.ts:195, anchor; falls back to published_at); early_access_enabled boolean NOT NULL default true (schema.ts:217; false = exempt from BOTH global delay and own drip); published_at timestamptz (schema.ts:186)
- loyalty_levels (JOINED): early_access_delay_days (global per-tier delay surfaced read-only in Tab 1; coin ladder ranked by threshold_spend_cents ASC); enabled flag
- business_levels (JOINED): B2B ladder ranked by display_order ASC (last = top/most-exclusive); enabled flag
- Enum/const: TIER_RELEASE_LADDERS = ['coin','business'] (tier-release.schema.ts:67)
- Events emitted: product.updated (changedFields includes 'tier_release' and/or 'drip_start_at'), product.published/unpublished, product.deleted — via in-process bus in create-product.ts

**Sources of truth**

- Table schema: src/modules/catalog/product/tier-release.schema.ts (product_tier_release) + products.drip_start_at / early_access_enabled in src/modules/catalog/product/schema.ts
- Mutation API: workflows.catalog.updateProduct/createProduct in src/workflows/catalog/create-product.ts (runs in db.transaction, emits product.updated with changedFields incl tier_release/drip_start_at)
- Service: src/modules/catalog/product/tier-release.service.ts (setForProduct REPLACE semantics, countUsingLevel)
- Visibility rules: pure resolver src/lib/loyalty/tier-access.ts; storefront gate src/lib/loyalty/viewer-early-access.ts (filterEarlyAccessRows)
- Contract tests (no OpenAPI): src/lib/db/tests/tier-access.test.ts, early-access.test.ts, business-levels.test.ts, catalog-deletion-fanout.test.ts, public-gating.test.ts
- RBAC: permission id 'products' in src/lib/rbac/registry.ts (grants live in DB role_permissions/user_permission_overrides)
- Tokyo storefront display data: bundled snapshot src/storefront/data/products.json regenerated ONLY by scripts/tokyo-export-catalog.ts

**Editable / removable**

- Safe to edit: all admin UI copy/labels/formatting — page.tsx countdown() + label strings, drip-panel.tsx, drip-tabs.tsx, early-access-tiers-panel.tsx, and the DripExclusivityPicker UI in product-form.tsx (display-only)
- Tab 1 'Par niveau' (early-access-tiers-panel.tsx) is pure read-only display with no editor — removable with no functional loss; editing stays in Fidélité → Niveaux
- The dashboard 'Rendre public' button and sort/countdown logic can be reworked freely (presentation only)
- Load-bearing — do NOT remove without care: tier-release.service.setForProduct REPLACE + per-level advisory locks; the includeDisabled ladder ranking (page.tsx:94, viewer-tier-access.ts:55); the level-delete guards (loyalty-program.ts, business.ts, segments.ts) that stop soft-link orphaning; the re-publish anchor freeze (create-product.ts:690-704); every filterEarlyAccessRows call site
- To remove the feature: drop nav entry (admin-shell.tsx:134), the /admin/catalog/drip route, the product-form drip tab + parseTierSchedule, workflow schedule/anchor handling, and the delete guards — but FIRST clear all product_tier_release rows so the DB-live cart/order gate can't block checkout after the UI is gone
- product_tier_release.level_id has no FK (soft link) — any new level-delete path must call countUsingLevel or it orphans steps and exposes exclusives

**Gaps / risks**

- CRITICAL: Drip/early-access does NOT function on the live Tokyo storefront — (tokyo)+src/storefront/** read the static JSON snapshot (staticSource default; http is a notImplemented stub), the snapshot has no tier/drip fields, and tokyo-export-catalog.ts builds it with listApiProducts({public:false}) = no embargo ('full catalogue, no viewer embargo', script:76). Exclusives/drip leak to everyone on Tokyo.
- Visible-but-not-buyable inconsistency: cart/order workflows (add-to-cart.ts:38, place-order.ts:464, place-quick-order.ts:160) still enforce the embargo against the live DB, so a Tokyo shopper who sees an embargoed product (from JSON) is blocked at add-to-cart/checkout.
- The global per-tier early-access delay (Tab 1's whole premise) is equally dead on Tokyo for the same snapshot reason.
- Soft-link fragility: level_id has no FK; correctness depends entirely on the delete guards (loyalty-program.ts:221, business.ts:771, segments.ts:1233/1258) + includeDisabled ranking + advisory locks. Any new/direct level delete orphans steps and silently flips exclusives public.
- Admin dashboard loads ALL scheduled products with no pagination (page.tsx:121-125) — unbounded at scale.
- Config is spread across 3 places: schedule (product form), per-tier delay (Fidélité→Niveaux), master switch loyaltyCfg.earlyAccessEnabled (Fidélité→Réglages). early_access_enabled=false silently nullifies a product's whole schedule (viewer-early-access.ts:144); the picker only warns.
- httpSource is a stub whose sketch mapping omits tier fields — flipping NEXT_PUBLIC_DATA_SOURCE=http would NOT restore drip without new work including a per-viewer gating call.

</details>


---

## 8. Cartes cadeaux (gift cards)

A gift card here is the **own-brand bearer instrument** (`TWS-XXXX-XXXX-XXXX-XXXX` codes), NOT the third‑party recharge products (iTunes/PSN/Xbox…) merchandised under "Gift Cards" on the storefront. A code is money: whoever holds the string can spend it, so only a keyed hash is stored, the plaintext is shown/emailed once at issuance, and a card is identified in the register by its `reference`. Redeeming a card grants **store credit** into the buyer's wallet (`giftcard_redeem`); the card itself settles nothing at checkout. The whole money-moving layer deliberately lives in `src/lib/gift-card/*` (paired with the credit wallet in one transaction), while the module (`src/modules/gift-card/*`) owns only table access — the same split `creditService` has with `lib/credit/apply.ts`.

### What the operator sees & does

Route `/admin/catalog/gift-cards` renders one page titled "Cartes cadeaux" with a header explaining that codes are never shown/stored in clear and are emailed at issuance (`page.tsx:49-55`).

- **Header stats (3 tiles):** Actives / Utilisées / Annulées, from `countsByStatus()` (`gift-cards-panel.tsx:62-66`, `page.tsx:40-44`).
- **Two management cards, shown only to `products:manage` holders** (`gift-cards-panel.tsx:68-73`):
  - **"Émettre une carte (geste commercial)"** — `IssueForm`: amount in DT (`number`, min 1) + recipient email; mints a standalone card and emails the code (`gift-cards-panel.tsx:197-222`).
  - **"Réglages"** — `SettingsForm`: one field, "Validité d'une nouvelle carte (mois)". Blank/0 = never expires; copy states the validity is frozen at issuance so changing it only affects future cards (`gift-cards-panel.tsx:224-255`).
- **"Registre des cartes"** — a list (not a table), newest-first. Each row shows: `reference` (mono), `••last4`, amount label (DT), a status pill, and a meta line "Émise le … · expire le …/n'expire pas · achat/émission manuelle" (`gift-cards-panel.tsx:154-170`, built in `page.tsx:25-39`). Empty state: a Gift icon + "Aucune carte cadeau émise pour l'instant." (`gift-cards-panel.tsx:77-81`).
- **Per-row actions (only when `canManage` AND the row is live-active):** "Remplacer" (reissue) → `window.prompt` for the delivery email, then voids the original and mints a replacement; "Annuler" (void) → `window.confirm` warning the value is destroyed (`gift-cards-panel.tsx:128-195`). A reissue that succeeds but whose email failed returns `ok:true` with a `warning`/amber notice so the operator knows the customer was stranded (`gift-cards-panel.tsx:114-152`).
- **No filters, no search, no pagination control, no bulk actions.** The list is a flat cap of 100 (service caps at 500). There is no detail page — a row is the whole UI; operators lose balance/history beyond the list fields.
- **Status display quirk:** an `active` card past `expires_at` is rendered as "Expirée" purely client-side (`gift-cards-panel.tsx:122-124`); the DB row stays `active` (nothing sweeps the table — expiry is enforced only in the redemption WHERE). No way to resend a code from the register other than "Remplacer".

A **second read-only surface** exists on the order detail page: `IssuedGiftCards` (`src/app/admin/orders/[id]/issued-gift-cards.tsx`) lists the cards an order minted (reference, masked code, amount, status) via `listForOrder`.

### Routes & components

- `src/app/admin/catalog/gift-cards/page.tsx` — **RSC**, `force-dynamic` (`:12`). Guard, parallel reads, maps rows, computes `canManage`, renders the panel.
- `src/app/admin/catalog/gift-cards/gift-cards-panel.tsx` — **client** (`"use client"`). `GiftCardsPanel`, `StatTile`, `GiftCardRow`, `IssueForm`, `SettingsForm`, and a local `useFormAction` wrapper (`:259-271`) for the object-shaped issue action. Uses `useState`/`useTransition`/`useActionState`; re-syncs its local `list` to fresh server `rows` via the adjust-state-during-render pattern (`:49-58`).
- `src/lib/actions/gift-card.ts` — **server actions** (`"use server"`): `redeemGiftCardAction` (customer), `voidGiftCardAction`, `reissueGiftCardAction`, `issueStandaloneGiftCardAction`, `saveGiftCardSettingsAction`.
- `src/modules/gift-card/{schema,service,index}.ts` — table + `giftCardService` + public re-exports.
- `src/lib/gift-card/{code,config,issue,issue-standalone,redeem,reissue,deliver-email,guards}.ts` — the orchestration/money layer.
- `src/events/subscribers/issue-gift-cards.ts` — issuance+delivery subscriber.
- `src/app/admin/orders/[id]/issued-gift-cards.tsx` — read-only per-order card list (client component rendering `GiftCardRow[]`).

### Data model

**Owned table `gift_cards`** (`src/modules/gift-card/schema.ts:35-108`; FKs/CHECKs in migration `0147_gift_cards.sql`):

- `id` (uuid v7 PK), `reference` (unique, staff-facing identity — safe to show, cannot redeem), `code_hash` (keyed HMAC-SHA256, **unique** — redemption lookup), `code_last4` (indexed, deliberately NOT unique).
- `denomination_cents` — **face value in millimes, frozen at issuance** (CHECK `> 0`).
- `origin` TS enum `GIFT_CARD_ORIGINS = ["digital","physical"]` (`:28`); v1 only ever mints `digital`. `status` TS enum `GIFT_CARD_STATUSES = ["active","redeemed","void"]` (`:32`) — no `printed` (physical pool dropped).
- Soft links (no FK): `product_id`, `variant_id`, `order_item_id`, `line_seq`, `replaced_by_gift_card_id` — so a card's frozen value outlives a later product edit.
- Real FKs (0147, both `ON DELETE SET NULL`): `order_id → orders`, `redeemed_by_profile_id → customer_profiles`.
- Lifecycle timestamps: `activated_at` (= created for a digital mint), `redeemed_at`, `expires_at` (NULL = never), `voided_at`/`voided_by`/`void_reason`, `sent_at` (stamped only on confirmed email send — NULL on an active card = "code never left").
- Gifting overlay (Phase C.5): `recipient_email`, `recipient_name`, `gift_message`.

**Key invariants / DB constraints** (migration 0147; proven by the schema-drift test):
- `gift_cards_status_chk` IN (active,redeemed,void); `gift_cards_origin_chk` IN (digital,physical); `gift_cards_denomination_pos_chk` > 0 (`0147:61-63`).
- `gift_cards_code_hash_uniq` — one code can't open two cards.
- `gift_cards_line_seq_uniq` — **partial unique on (order_item_id, line_seq) WHERE order_item_id IS NOT NULL** = the DB's own double-mint backstop (one card per unit sold) behind the per-order advisory lock (`schema.ts:98-101`).
- `gift_cards_created_idx` (created_at DESC, id DESC) — the register's landing order.

**Joined, not owned:** `products.is_gift_card` (boolean, `src/modules/catalog/product/schema.ts:210`) is the flag that makes buying a product MINT a card; `order_items.unit_price_cents` supplies the frozen face value; the credit wallet/ledger (`lib/credit/apply.ts`, `grantCredit` kind `giftcard_redeem`) receives redeemed value; `cms.setting` key `giftcard.expiry_months` holds the one setting.

### Read path

- Admin list: `giftCardService.listForRegister(100)` — `SELECT * ORDER BY created_at DESC, id DESC LIMIT min(limit,500)` (`service.ts:50-56`). **Cap-only, no offset/cursor pagination** — cards beyond the newest 100 are invisible in the register.
- Header stats: `giftCardService.countsByStatus()` — grouped `count(*)` by status (`service.ts:59-67`).
- Setting: `getGiftCardConfig()` (`lib/gift-card/config.ts:41-49`), React-`cache()`d, reads `getSettingsMap()` from the CMS module.
- Lookups used elsewhere: `findByCodeHash` (the only way redemption locates a card, `service.ts:24`), `findByReference` (staff), `findById`, `listForOrder` (order page), `lockForOrder` (`FOR UPDATE`, used by order undo).
- Customer self-check (unused on Tokyo today): `inspectGiftCard` reads state without redeeming (`lib/gift-card/redeem.ts:156-193`).

### Write path

All admin mutations: **action → lib/gift-card orchestration → giftCardService → revalidatePath("/admin/catalog/gift-cards")**. There is **no `src/workflows/*` entry and no event emission** for the admin gift-card actions — they transact directly in `lib/gift-card/*` (the deliberate credit-pairing split). Validation is hand-rolled (no zod in the actions; `create-product`'s zod only governs the `is_gift_card` product flag).

- **Issue standalone** (`issueStandaloneGiftCardAction`, `actions/gift-card.ts:110-135`): validates email + positive amount, `dinarsToMinor`, calls `issueStandaloneGiftCard` (`lib/gift-card/issue-standalone.ts:23`) which generates code → hashes → inserts an active digital card with `expiresAt = expiryFor(config, now)`; returns the plaintext code ONCE; the action emails it via `sendGiftCardDeliveryEmail` and sets `warning` if the send failed (then the code is lost → "annulez et réémettez").
- **Void** (`voidGiftCardAction` → `voidGiftCardOnly`, `lib/gift-card/reissue.ts:122-144`): conditional `voidCard` (`WHERE status='active'`), so it refuses a redeemed card (value already in a wallet) and won't re-void.
- **Reissue** (`reissueGiftCardAction` → `voidAndReissueGiftCard`, `lib/gift-card/reissue.ts:32-115`): ONE `db.transaction` — refuses redeemed/void/**expired** cards, mints the replacement first (same `denomination_cents`, same `order_id`, NOT attached to the order line, inherits gifting overlay), then conditionally voids the original with `replaced_by_gift_card_id` set. If the conditional void loses a race to a redemption it **throws** (a `return` would commit the replacement → customer holds both credit and a new card).
- **Settings** (`saveGiftCardSettingsAction`): the only action that goes through a workflow — `workflows.cms.upsertSettingsBatch` writing `giftcard.expiry_months` (`actions/gift-card.ts:138-150`).
- **Order-driven issuance** (the real "sale" path): subscriber `registerGiftCardIssueSubscriber` listens on `order.paid` and `order.status_changed→delivered` (`events/subscribers/issue-gift-cards.ts:72-79`) → `issueGiftCardsForOrder(orderId)` (`lib/gift-card/issue.ts:42`). It runs ONE `db.transaction` under `pg_advisory_xact_lock('giftcard-issue:'+orderId)` (`issue.ts:84`), re-reads `findById(..,{forUpdate:true})`, **refuses to mint onto a cancelled/refunded/fully-refunded order** (`issue.ts:93-97`), counts cards already issued per line and mints only the shortfall → **idempotent**. Face value = `order_items.unit_price_cents` (what the customer paid, drift-proof). A missing `PAYMENT_ENCRYPTION_KEY` **throws → whole batch rolls back** (never a live card with no recoverable code). Then the subscriber emails each code (respecting the `gift_card_delivery` flow toggle — when OFF, cards are still minted but sit `sent_at=NULL` for manual delivery) and stamps `sent_at` on a confirmed send.
- **Customer redeem** (`redeemGiftCardAction` → `redeemGiftCard`, `lib/gift-card/redeem.ts:47`): requires a signed-in **linked** account, rate-limited 10/hr/member; normalizes+hashes the code, looks up by hash, then the **race-safe conditional claim** `claimForRedemption` (`WHERE status='active' AND (expires_at IS NULL OR > now())`, `service.ts:144-162`) + `grantCredit(kind:"giftcard_redeem", allowWhilePaused:true)` in ONE transaction. A refusal is converted **outside** the tx (a `return {ok:false}` inside would commit the claim and burn the card).
- **Order-undo reconciliation** (`lib/gift-card/guards.ts`): `blockedByRedeemedGiftCard`/`reconcileGiftCardsForOrderUndo` lock the order's cards `FOR UPDATE`, refuse an undo if any card was redeemed, else `voidActiveForOrder` (conditional `WHERE status='active'`) so a refunded buyer can't keep a live card (double-pay). Called from `workflows/order/{place-order,returns,refund-order,transition-status}.ts`.

### RBAC

- **No dedicated gift-card permission** — the whole section **reuses `products`** (confirmed: RBAC registry `src/lib/rbac/registry.ts:68` defines only `products` with actions view/create/update/delete/manage; no `gift`/`gift-cards` id anywhere). The admin-shell nav entry carries `id: "products"` (`admin-shell.tsx:137`).
- Page guard: `requirePermission("products", "view")` (`page.tsx:15`). The management cards + row actions are additionally gated on `products:manage` (`page.tsx:22-23`; each mutating action re-guards with `requirePermission("products","manage")` — `actions/gift-card.ts:73,89,114,139`).
- `redeemGiftCardAction` is a public/session action (not permission-guarded) — whitelisted as such in `route-invariants.test.ts:610` and `internal-api-catalog.ts:486` (`session/public`).

### Storefront linkage

**Admin "Cartes cadeaux" edits do NOT reach the Tokyo JSON snapshot at all.** This section is a **live-DB admin-only register**; it is not catalog display data, so `tokyo-export-catalog.ts` doesn't touch it and there is nothing to regenerate. Precisely:

- **Buy an own-brand gift card on Tokyo today?** No dedicated product/page is wired. Minting is backend-driven by the DB product's `is_gift_card` at checkout via `workflows.order.place` — which IS the action Tokyo checkout uses (`checkout-view.tsx` → `placeOrderFromCartAction` → `workflows.order.place`, `actions/order.ts:716`). So *if* an operator flags a product `is_gift_card=true` and it's sellable through the Tokyo cart, a card would mint. But (a) no such product exists in the seed/import feed (grep found none), (b) the storefront JSON `Product` type has no `is_gift_card` field, and (c) the storefront `Gift Cards` shelf is unrelated: `GiftCardTabs` (`src/storefront/components/storefront/gift-card-tabs.tsx`) and the `/gift-cards` nav alias (`src/storefront/lib/navAliases.ts:103-106`) resolve to **third‑party recharge categories** (iTunes/PSN/Xbox/Steam/Netflix…) from the bundled JSON — regular products, not the TWS bearer instrument. Rendered on the Tokyo home via `HomeExtras` (`(tokyo)/page.tsx:44` → `home-extras.tsx:97`).
- **Redeem an own-brand gift card on Tokyo today?** **No.** The only redeem UI (`GiftCardRedeemCard` + the `GIFT_CARD_REDEEM_ENABLED=true` flag) lives in `src/app/(shop)/(shell)/account/account-client.tsx` — the **legacy shell** account — and that component is **orphaned**: `(shell)/account/page.tsx` does not exist (only `(shell)/account/orders/[id]`), nothing imports `account-client.tsx`, and the live `/account` route is `(tokyo)/account/page.tsx`, whose `AccountView` has **no gift/credit/redeem UI at all** (grep: zero matches). `redeemGiftCardAction` is still exported and wired, but it is unreachable from the live storefront.
- The delivery email's `redeem_url` points customers at `${origin}/account` (`deliver-email.ts:68`) — which on Tokyo has no redeem form, so a delivered code currently has no self-service landing.

### Edit / remove notes

- **Safe to restyle/relabel** freely: `gift-cards-panel.tsx` (all presentation), the header copy in `page.tsx`, status pill labels/colors. These have no behavioural coupling.
- **The three row/issue flows are load-bearing money paths** — keep the conditional-update + throw-not-return discipline. In particular: never change `claimForRedemption`/`voidCard`/`voidActiveForOrder` to read-then-write; never make `redeemGiftCard`/`voidAndReissueGiftCard` `return` a failure from inside the transaction (it commits).
- **Do not weaken the discount-base exclusion** (see Gaps) — it's the money-printer guard.
- The **code domain label `tokyo.giftcard.v1.` and `PAYMENT_ENCRYPTION_KEY` are frozen** (`lib/gift-card/code.ts:81-90`): changing either orphans every issued card (redemption can't find the hash). The TS enums must stay in lockstep with the 0147 CHECKs (schema-drift test fails otherwise); migrations are frozen so don't `db:generate`.
- To actually **sell** own-brand cards: it's a product with `is_gift_card=true` (the product form checkbox is in the "promotions" group, `components/admin/product-form.tsx:1084`); `create-product` then force-sets 0% TVA + non-discountable (`workflows/catalog/create-product.ts:357,386-387`, and the update guard at `:636-645`). Removing the gift-card product flag/column would break issuance (`issue.ts:54-62` reads it) and the discount/loyalty exclusions.
- To hide the section entirely you'd remove the nav entry (`admin-shell.tsx:137`) and the page; the register itself is harmless to hide (it's read-only + manual issue), but issuance/redeem/undo logic in `lib/gift-card/*` + the subscriber are independent of the admin page and must not be removed if any card exists.

### Gaps & risks

- **Money-printer guard is distributed, easy to regress.** A gift card is excluded from every discount base in `place-order.ts` (`giftCardSubtotalCents`/`discountBaseCents` `:640-644`, `discountableSub` `:648-655`) and from product promos via `is_discountable=false`. These are belt-and-suspenders; the comment at `place-order.ts:636-639` notes `is_discountable=false` only blocks product-scope promos, so the order-level member % and cart coupons rely on the `is_gift_card` subtraction. A refactor that drops `isGiftCard` from any of `discountable-subtotal.ts`/`scoped-coupon.ts`/`coupon-eligibility.ts`/the place-order base lets a buyer purchase a card below face while it redeems at face.
- **No pagination** in the register — only the newest 100 (hard cap 500) are ever visible; there is no search by `reference`/last4 in the UI although the service supports it. A busy shop silently loses older cards from view.
- **No balance/partial redemption** — redemption is all-or-nothing into credit; the model has no `balance` column, so "Balance" in the register is just the frozen denomination. There is no way to see a card's post-redeem remaining value (there isn't one).
- **Lost code is unrecoverable by design** — if the delivery email fails, the plaintext is gone; the only remedy is void+reissue (reissue) or void+re-issue-standalone. The amber `warning` path depends on the operator noticing the notice.
- **Expiry is never swept** — an expired card stays `status='active'` in the DB; only the redemption WHERE and client display treat it as expired. Any new query that keys off `status='active'` alone (e.g. a future "total outstanding liability" report) would over-count expired cards.
- **`issue-standalone.ts` casts the insert with `as never`** (`:50`) — bypasses the typed insert shape; a future column addition won't be type-checked on that path.
- **Storefront dead ends:** the redeem flow is fully built but unmounted on Tokyo, and the delivery email sends customers to a `/account` with no redeem form. Anyone enabling own-brand sales must first re-wire a redeem UI into `(tokyo)` AccountView — the backend is ready, the frontend is not.


<details>
<summary><strong>8. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/gift-cards/page.tsx — RSC admin page; guard requirePermission('products','view') (:15), reads register/counts/config (:16-21), computes canManage via products:manage (:23), maps rows (:25-39)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/gift-cards/gift-cards-panel.tsx — client UI: stats, IssueForm (:197), SettingsForm (:224), GiftCardRow with reissue/void (:103-195), empty state (:77-81)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/gift-card/schema.ts — gift_cards table, GIFT_CARD_ORIGINS (:28)/GIFT_CARD_STATUSES (:32), code_hash unique (:83), (order_item_id,line_seq) partial-unique double-mint backstop (:99)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/gift-card/service.ts — table access only; race-safe claimForRedemption (:144), voidCard (:171), voidActiveForOrder (:105), lockForOrder FOR UPDATE (:87), listForRegister cap-only (:50), countsByStatus (:59)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/gift-card/index.ts — public re-exports
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/gift-card.ts — server actions: redeemGiftCardAction (:29, public/session), voidGiftCardAction (:72), reissueGiftCardAction (:84), issueStandaloneGiftCardAction (:110), saveGiftCardSettingsAction (:138); all mutators guard products:manage
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/gift-card/code.ts — code/reference generation, keyed HMAC hash with frozen domain label 'tokyo.giftcard.v1.' + PAYMENT_ENCRYPTION_KEY (:81-90), fail-loud GiftCardKeyMissingError
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/gift-card/config.ts — single setting giftcard.expiry_months; expiryFor() stamps at issuance only (:56), getGiftCardConfig cache() (:41)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/gift-card/issue.ts — issueGiftCardsForOrder: advisory lock (:84), refuse-on-undone-order (:93-97), shortfall-only idempotent mint, face=unit_price_cents (:106), key-missing throws→rollback
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/gift-card/issue-standalone.ts — operator goodwill mint (order_id NULL); insert cast 'as never' (:50)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/gift-card/redeem.ts — redeemGiftCard: conditional claim + grantCredit in one tx, refusal converted outside tx (:131-148); inspectGiftCard read-only (:156)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/gift-card/reissue.ts — voidAndReissueGiftCard one-tx void+mint, refuses redeemed/void/expired, throw-on-race (:108); voidGiftCardOnly (:122)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/gift-card/deliver-email.ts — sendGiftCardDeliveryEmail; code is a render var only, redacted from send log; redeem_url → origin+/account (:68)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/gift-card/guards.ts — order-undo reconciliation: blockedByRedeemedGiftCard (:29), reconcileGiftCardsForOrderUndo (:50), both lock FOR UPDATE
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/events/subscribers/issue-gift-cards.ts — order.paid + →delivered triggers (:73-78); mints then emails, respects gift_card_delivery flow toggle, stamps sent_at
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/order/place-order.ts — gift-card-needs-email guard (:586-595), gift-card discount-base exclusion / money-printer guard (:634-655)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/promotions/discountable-subtotal.ts — isGiftCard lines skipped from coupon base (:30)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/create-product.ts — is_gift_card product flag forces 0% TVA (:357) + non-discountable (:386), update guard willBeGiftCard (:636-645)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/orders/[id]/issued-gift-cards.tsx — read-only per-order minted-card list via listForOrder
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/components/storefront/gift-card-tabs.tsx + src/storefront/lib/navAliases.ts:103 — storefront 'Gift Cards' = THIRD-PARTY recharge products from JSON, unrelated to own-brand instrument
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/(shop)/(shell)/account/account-client.tsx — GiftCardRedeemCard + GIFT_CARD_REDEEM_ENABLED (:526) — ORPHANED (no (shell)/account/page.tsx; not imported); the live (tokyo)/account/page.tsx has no redeem UI
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/db/migrations/0147_gift_cards.sql — status/origin/denomination CHECKs (:61-63), order_id + redeemed_by FKs ON DELETE SET NULL (:65-66)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/db/tests/gift-card-schema-drift.test.ts — TS enum ↔ DB CHECK equality, denomination>0, code_hash unique, (order_item_id,line_seq) double-mint backstop, service round-trip
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/db/tests/gift-card-{code,issue,redeem,lifecycle}.test.ts — the no-OpenAPI contract for code hashing, issuance idempotency, redeem race-safety, lifecycle
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/rbac/registry.ts:68 — only 'products' permission exists; no gift-card id (reuse confirmed)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/_components/admin-shell.tsx:137 — Catalogue nav entry 'Cartes cadeaux' carries id 'products'

**Models / tables**

- gift_cards (owned) — id uuid v7 PK; reference text UNIQUE; code_hash text UNIQUE (keyed HMAC-SHA256); code_last4 text (indexed, non-unique); denomination_cents int millimes CHECK>0 (frozen face value); origin text enum digital|physical (CHECK gift_cards_origin_chk); status text enum active|redeemed|void (CHECK gift_cards_status_chk); product_id/variant_id/order_item_id/line_seq (soft links, no FK); order_id uuid FK→orders ON DELETE SET NULL; redeemed_by_profile_id uuid FK→customer_profiles ON DELETE SET NULL; redeemed_at; activated_at; expires_at (NULL=never); voided_at/voided_by/void_reason; replaced_by_gift_card_id (soft); recipient_email/recipient_name/gift_message (gifting overlay); sent_at (NULL on active = code never emailed); timestamps
- Partial-unique index gift_cards_line_seq_uniq on (order_item_id, line_seq) WHERE order_item_id IS NOT NULL — DB double-mint backstop; gift_cards_code_hash_uniq; gift_cards_created_idx (created_at DESC, id DESC)
- products.is_gift_card boolean DEFAULT false (joined, modules/catalog/product/schema.ts:210) — flags a product whose purchase MINTS a card; forces tax_rate_bps=0 + is_discountable=false in create-product
- order_items.unit_price_cents (joined) — supplies the frozen denomination at issuance
- credit wallet/ledger (joined via lib/credit/apply.ts grantCredit kind 'giftcard_redeem', allowWhilePaused) — receives redeemed value; balance_after_cents returned as the new balance
- cms.setting (joined) — key giftcard.expiry_months (text; blank/0=never), group 'giftcard'
- Enums (TS, src/modules/gift-card/schema.ts): GIFT_CARD_STATUSES=['active','redeemed','void']; GIFT_CARD_ORIGINS=['digital','physical'] — must equal the 0147 CHECK literals

**Sources of truth**

- Mutation API: src/lib/gift-card/* orchestration (NOT src/workflows/*) — the admin gift-card actions transact directly here paired with the credit wallet; no event is emitted for admin mutations
- Order-driven issuance: src/events/subscribers/issue-gift-cards.ts (order.paid + status→delivered) → src/lib/gift-card/issue.ts
- Contract/spec: src/lib/db/tests/gift-card-*.test.ts (code, issue, redeem, lifecycle, schema-drift) — there is no OpenAPI
- Schema SoT split: Drizzle table in src/modules/gift-card/schema.ts; FKs + CHECK constraints in migration src/lib/db/migrations/0147_gift_cards.sql (schema-drift test enforces TS enums == DB CHECK literals)
- RBAC registry (permissions that EXIST): src/lib/rbac/registry.ts — gift cards reuse the 'products' id (view/manage); grants live in DB role_permissions/user_permission_overrides
- Money unit: integer millimes; *_cents columns hold millimes (src/lib/price.ts, MINOR_PER_DINAR=1000) — dinarsToMinor/minorToDinars used in the issue/redeem actions
- Setting SoT: cms.setting key 'giftcard.expiry_months' via getGiftCardConfig()/workflows.cms.upsertSettingsBatch; blank/0 = never expires
- Code secret SoT: keyed HMAC in src/lib/gift-card/code.ts with frozen domain label 'tokyo.giftcard.v1.' + PAYMENT_ENCRYPTION_KEY — only code_hash is stored, plaintext shown once

**Editable / removable**

- EDITABLE freely: all of gift-cards-panel.tsx presentation (stat tiles, status pill labels/colors in STATUS_META, row layout, empty-state copy) and page.tsx header copy — no behavioural coupling
- EDITABLE: the single Réglages field (expiry months) and its copy; the setting is additive and defaults to 'never' so changes are backward-safe
- LOAD-BEARING, do not weaken: conditional-update discipline in service.ts (claimForRedemption/voidCard/voidActiveForOrder are WHERE status='active' updates — never read-then-write) and the throw-not-return pattern in redeem.ts/reissue.ts/issue.ts (a return inside the tx commits)
- LOAD-BEARING: the gift-card discount-base exclusion spread across place-order.ts (giftCardSubtotalCents/discountBaseCents/discountableSub), discountable-subtotal.ts, scoped-coupon.ts, coupon-eligibility.ts, and is_discountable=false/0% TVA forced in create-product.ts — removing any one risks a money printer (buy below face, redeem at face)
- FROZEN: code.ts domain label 'tokyo.giftcard.v1.' and the PAYMENT_ENCRYPTION_KEY — changing either orphans every issued card; the GIFT_CARD_STATUSES/GIFT_CARD_ORIGINS TS enums must match the 0147 CHECKs (schema-drift test); migrations are frozen (no db:generate/db:push)
- REMOVABLE with care: the admin register page + nav entry (admin-shell.tsx:137) can be hidden (read-only + manual issue) WITHOUT touching issuance/redeem/undo logic in lib/gift-card/* and the subscriber, which run independently and must stay while any card exists
- ORPHANED / candidate for cleanup OR rewire: src/app/(shop)/(shell)/account/account-client.tsx GiftCardRedeemCard + GIFT_CARD_REDEEM_ENABLED flag — not mounted by any live page; redeemGiftCardAction is wired but unreachable from the live Tokyo storefront
- REMOVING products.is_gift_card column/flag would break issuance (issue.ts reads it), the discount/loyalty exclusions, and the per-order mint — not a safe standalone removal

**Gaps / risks**

- Money-printer guard is distributed across 5+ files and relies on the is_gift_card subtraction for order-level member % and cart coupons (is_discountable=false only blocks product-scope promos) — a refactor dropping isGiftCard from any discount base regresses it silently
- Admin register has no pagination (newest 100, hard cap 500) and no reference/last4 search in the UI although the service supports findByReference — older cards become invisible
- No balance / partial redemption model: redemption is all-or-nothing into store credit; there is no remaining-balance column, so the register's amount is only the frozen denomination
- Expiry is never swept — an expired card stays status='active' in the DB (enforced only in the redemption WHERE + client display), so any future query keyed on status='active' alone over-counts expired/outstanding liability
- issue-standalone.ts inserts with 'as never' (schema.ts type bypass) — a future column change won't be type-checked on the standalone-mint path
- Storefront dead ends: redeem UI is fully built but unmounted on live Tokyo ((shell)/account/account-client.tsx is orphaned; (tokyo) AccountView has no redeem/credit UI), and the delivery email's redeem_url points to /account which on Tokyo has no redeem form — a delivered code has no self-service landing today
- Can a customer buy/redeem an own-brand gift card on Tokyo today? NO redeem; buying only mints if a product is flagged is_gift_card=true and sold through the Tokyo cart — no such product exists in seeds/feed, and the storefront 'Gift Cards' shelf is unrelated third-party recharges
- Lost code is unrecoverable by design; the only amber 'email failed' warning depends on the operator noticing the inline notice — a missed warning strands the customer with an unredeemable paid card

</details>


---

## 9. Attributs (product attributes & facets)

The "Attributs" catalogue sub-page defines **reusable filter dimensions** (Matière, Couleur, État, PEGI…) in a PrestaShop/Woo-style EAV model: an attribute carries a *kind*, its *values* (or per-product scalar data), is *assigned* to products, and is *bound to categories as filter facets*. It is a fully-wired admin + ERP surface. **The headline finding: in the current code these attributes reach NO live storefront surface — the Tokyo design never reads them, the real DB-backed read paths are orphaned/dead, and the one DB-live facet path is thrown away by a compatibility shim.** Details under *Storefront linkage*.

### What the operator sees & does

**List page** (`/admin/catalog/attributes`): header "Attributs" + description, a `Nouveau` button (only if `attributes:create`), and a card list. There are two sub-tabs (`src/app/admin/catalog/attributes/attributes-panel.tsx:28-31`) — **« Attributs »** (the list) and **« Auto-attribuer »** (AI auto-assign) — but the tab strip is shown **only** when the viewer holds `system_ai:view` (`attributes-panel.tsx:55,76`); a catalogue-only operator just sees the flat list. Each card (`attributes-panel.tsx:131-184`) shows the name (link to editor), `/slug` code chip, a **kind chip** (Choix multiples / Choix unique / Couleur / Booléen / Nombre / Texte — `_kinds.ts:21-28`), an `Inactif` badge when disabled, a value line (`N valeurs` for list kinds, `Oui / Non` for boolean, `valeur par produit` for number/text — `attributes-panel.tsx:187-193`) and `ordre N`. Controls: pencil (edit) always; trash (delete) only with `attributes:delete`. Delete opens a confirm modal warning "Les valeurs associées et les assignations produit seront perdues" (`attributes-panel.tsx:107-126`). Empty state: "Aucun attribut pour le moment…" (`attributes-panel.tsx:203`). **No search, no filters, no pagination, no bulk actions** on this list — it loads every live attribute at once.

**Create page** (`/admin/catalog/attributes/new`, `attribute-create-form.tsx`): fields Nom (required), Slug (auto if empty), **Type** select (6 kinds, default `multiselect` — `attribute-create-form.tsx:20,76-82`), Ordre d'affichage, and an `Actif` checkbox. When the kind is a value-list kind (`select`/`multiselect`/`color`) a **Valeurs** editor appears with add/remove rows — each row has label, slug (auto), and a colour-picker + hex field when kind is `color` (`attribute-create-form.tsx:97-176`). Boolean shows an info note ("une seule valeur automatiquement"); number/text show "stocke une donnée par produit" (`attribute-create-form.tsx:177-186`). Seed values are serialised to a hidden `valuesJson` input. On success the action returns the new id and the form redirects straight into the editor (`attribute-create-form.tsx:31-35`).

**Edit page** (`/admin/catalog/attributes/[id]`, `attribute-detail-panel.tsx`): four stacked sections — (1) **Informations** form (name/slug/kind/order/active, Save → `updateAttributeAction`); (2) **Valeurs** — for value-list kinds, an inline per-row editor with create/update/delete + up/down reordering (`AttributeValuesEditor`, lines 257-398); for number/text/boolean a read-only **ScalarNote** (lines 218-234) explaining there is no editable list; (3) **Catégories** — a depth-indented checkbox tree of all categories; ticking opts this attribute in as a filter on those categories, saved via `setAttributeCategoriesAction` (lines 562-652); (4) **Produits utilisant cet attribut** — a capped, name-ordered list of products carrying this attribute (value or scalar) with links to each product editor, showing "N affichés sur M" when truncated (lines 97-137).

### Routes & components

- `src/app/admin/catalog/attributes/page.tsx` — **server** RSC. Guards `attributes:view`, resolves permission flags, calls `attributeQueries.listAttributesWithValues()` and (only if `system_ai:view`) `listAutoAssignJobsAction("attributes")`, maps to summaries, renders `AttributesPanel`.
- `attributes-panel.tsx` — **client** (`"use client"`). List UI, sub-tab strip, delete modal, embeds `AutoAssignControl` (AI).
- `_kinds.ts` — client-safe kind metadata (`KIND_OPTIONS`, `KIND_LABELS`, `VALUE_LIST_KINDS`, `hasEditableValues`, `isColorKind`). Type-only import of `AttributeKind`, so no Drizzle runtime leaks into the client bundle.
- `new/page.tsx` — **server**; guards `attributes:create`, `force-dynamic`, renders the form.
- `new/attribute-create-form.tsx` — **client**; `useActionState(createAttributeAction)`.
- `[id]/page.tsx` — **server**; guards `attributes:view`, `isUuid` guard → `notFound()`, four parallel reads (`getAttributeWithValues`, `categoryQueries.getCategoryTree`, `listCategoriesForAttribute`, `listProductsUsingAttribute`), flattens the category tree, renders `AttributeDetailPanel`.
- `[id]/attribute-detail-panel.tsx` — **client**; sub-components `AttributeMetaForm`, `AttributeValuesEditor`/`ValueRow`, `ScalarNote`, `AttributeCategoriesEditor`, `ProductsUsingAttribute`. Uses the isomorphic `slugify` from `@/lib/slug` for the client-side slug preview (line 19).

Backend module `src/modules/catalog/attribute/` — `index.ts` (barrel), `schema.ts`, `service.ts` (`attributeService` singleton), `queries.ts` (RSC reads).

### Data model

Five tables, all in `src/modules/catalog/attribute/schema.ts`, uuid-v7 PKs, **no cross-module FKs** (product_id/category_id are soft uuid columns):

- **`product_attributes`** (line 56) — `id, slug, name, kind, display_order, is_active`, `timestamps()` + `softDelete()`. Partial-unique slug `WHERE deleted_at IS NULL` (line 70, so a tombstoned attribute frees its slug). Indexes on display_order and a partial active index. **Soft-deleted.**
- **`product_attribute_values`** (line 82) — `id, attribute_id, slug, label, display_order, color_hex`. Unique `(attribute_id, slug)` (line 99). **Hard-deleted** (no `deleted_at`).
- **`product_attribute_assignments`** (line 110) — M2M `(product_id, attribute_value_id)` composite PK; the product↔value facet set that drives filtering.
- **`category_attribute_filters`** (line 130) — M2M `(category_id, attribute_id)` + `display_order`; which attributes appear as filters on which category.
- **`product_attribute_scalars`** (line 155) — per-`(product, attribute)` `numeric_value` / `text_value` for `number`/`text` kinds. Unique `(product_id, attribute_id)`.

**Enum `attribute_kind`** (`schema.ts:44`): `select | multiselect | color | boolean | number | text`. Note the authoritative server constant `VALUE_LIST_ATTRIBUTE_KINDS` (`schema.ts:54`) = `select,multiselect,color,**boolean**`, while the client `VALUE_LIST_KINDS` (`_kinds.ts:35`) excludes boolean (boolean auto-manages its single value, so the UI shows no editable list). Scalar kinds `number`/`text` have no value list. `color`, `boolean`, `number`, `text` were added by migration `0021_attribute_types_scalars.sql` (which also created `product_attribute_scalars`); the AI-assign kind by `0022`.

**Key invariants:** boolean = exactly one value `{slug:"oui", label:"Oui"}` (auto-seeded/normalised); scalars only exist for number/text; FK cascades (declared in SQL migrations, not Drizzle): deleting an attribute cascades values, deleting a value cascades assignments, `tax_rules.attribute_value_id` and `product_variant_values` also cascade from a value (why the delete/kind-change guards exist).

### Read path

All reads go through `queries.ts` → `attributeService` (no pagination anywhere):

- **Admin list** → `attributeQueries.listAttributesWithValues()` (`queries.ts:118`) → `attributeService.listAllAttributes()` (live, active+inactive, ordered by display_order then name) + one batched `listValuesForAttributes`. Returns the whole set.
- **Admin detail** → `getAttributeWithValues(id)` (`queries.ts:98`) + `listCategoriesForAttribute(id)` (`queries.ts:110`, inner-joins live categories so orphaned links from soft-deleted categories self-heal) + `listProductsUsingAttribute(id)` (`service.ts:498`, capped at 500, returns `{rows,total}` with the true distinct count over value-assignment OR scalar paths).
- **DB-backed PDP specs** → `getProductSpecs(productId)` (`queries.ts:32`) — cached (`"use cache"`, tags `attributes` + `product(id)`), batched. **Consumed only by `src/components/product-tabs.tsx`, which has zero importers (orphaned) — see Storefront linkage.**
- **Storefront facet builder** → `getProductsAttributeFilters` (`src/lib/api/categories.ts:158`) — builds live attribute facets (drops `text` kind, drops inactive). **Its output is discarded — see Storefront linkage.**
- **ERP read** → `GET /api/attributes` (active attributes + values, limit/offset bounded 1–500).

### Write path

Server Actions (`src/lib/actions/attribute.ts`) → workflows (`src/workflows/catalog/manage-attributes.ts`, exposed as `workflows.catalog.*` in `src/workflows/index.ts:316-325`) → `attributeService`. Every mutating workflow runs its multi-row writes in `db.transaction()` and emits an event; actions call `revalidatePath`.

- `createAttributeAction` → `createAttributeWorkflow` (`manage-attributes.ts:85`). Zod `createAttributeSchema` (name ≤120, kind enum default multiselect, ≤50 seed values). Slugifies name, rejects empty-slug, checks slug conflict. Boolean auto-seeds only `{oui}` and **ignores caller values**; value-list kinds dedupe seed slugs; number/text seed nothing. Attribute + seeds inserted in one tx. Emits `attribute.created`. Revalidates `/admin/catalog/attributes`.
- `updateAttributeAction` → `updateAttributeWorkflow` (`:186`). Only applies raw-provided keys (so `.partial()`-surviving Zod defaults can't silently flip kind/active — `:201`). **Kind-change guards (load-bearing):** →boolean, value-list→scalar, and scalar→value-list are each blocked while values are used by live variants / facet assignments / TVA rules, or scalars exist (`valuesInUseFail` `:58`, `:224-268`). →boolean normalisation (drop all values, seed `oui`) runs atomically with the kind write (`:282-297`). Emits `attribute.updated` only on real change.
- `deleteAttributeAction` → `deleteAttributeWorkflow` (`:312`). **Soft delete.** Blocks if used by live variants or facet assignments; first clears all `category_attribute_filters` links (`:348`) to avoid bricking category filter saves; emits `attribute.deleted`. (No tax guard — soft delete doesn't cascade values.)
- Values: `createValueAction`/`updateValueAction`/`deleteValueAction` → `createValueWorkflow` (`:363`) / `updateValueWorkflow` (`:413`) / `deleteValueWorkflow` (`:455`). Delete **hard**-deletes and is blocked by variant / facet-assignment / TVA-rule guards (`:464-492`).
- Reorder: `setAttributeValueOrderAction` → `setValueOrderWorkflow` (`:603`), writes `display_order = index` (attribute_id-scoped). Emits `attribute.updated {value_order}`.
- Categories (attribute side): `setAttributeCategoriesAction` → `setAttributeCategoriesWorkflow` (`:630`), diff-based (preserves each category's filter order), validates every category is live. Emits `attribute.updated {categories}`.
- `createCategoryFilterAttributeAction` (`actions/attribute.ts:24`) — inline "create filter attribute" from the category editor; reuses `createAttributeWorkflow`.
- Bulk: `bulkAssignAttributesWorkflow` (`:518`) append-only, per-item try/catch, emits `product.updated`.

**Cache/events:** `src/events/subscribers/invalidate-attribute-cache.ts` listens to all six `attribute*`/`attribute_value*` events + `category.filter_attributes.updated` and busts the `categories`, `products`, and `attributes` cache tags together.

### RBAC

Permission id **`attributes`** (`src/lib/rbac/registry.ts:78`, group Catalogue, actions `CRUD = view/create/update/delete`; **no `manage`**). Guards:
- Pages: list + detail guard `requirePermission("attributes","view")` (`page.tsx:13`, `[id]/page.tsx:29`); new page guards `attributes:create` (`new/page.tsx:14`).
- Actions: create→`attributes:create`, update/reorder/setCategories/bulk→`attributes:update`, delete→`attributes:delete` (`actions/attribute.ts`).
- UI gating is cosmetic-only (buttons hidden); the server action guards are authoritative (`route-invariants.test.ts` enforces every mutating action opens with a guard).

**Reused / cross-id surfaces (important for edit/remove):**
- The **« Auto-attribuer »** tab is **not** gated by `attributes` — it needs `system_ai:view` to appear and `system_ai:manage` to run (`page.tsx:18-21`).
- The REST attribute endpoints split across *three* permission ids: `/api/attributes` + `/api/attributes/values` use **`attributes`** read/write; `/api/categories/[slug]/attributes` uses **`categories`** read/write (`route-catalog.ts:115-116`); `/api/products/[slug]/attributes` uses **`products`** read/write (`:107-108`). So a role with `attributes` but not `products`/`categories` cannot sync facets over REST.
- Per the project note, the Catalogue group also reuses `products` for Drip and Cartes-cadeaux — not for Attributs (it owns its own id).

### Storefront linkage

**Attributes do NOT reach the live Tokyo storefront in any form.** Concretely:

1. **Tokyo JSON snapshot** — `scripts/tokyo-export-catalog.ts` builds `products.json` from a `RawProduct` shape that has **no attribute/value/scalar/facet fields** and never queries `attributeService`. Verified: `products.json` entries carry only id/slug/title/price/brand/category/condition/availability/category_path. So no admin attribute edit can ever appear in a (tokyo) product, PDP, or category filter, regardless of re-running the export.
2. **Tokyo category filters** — `src/storefront/components/storefront/category-view.tsx` (used by `(tokyo)/[slug]/page.tsx`) has filter groups **Disponibilité, État, Prix, Marque, Note client only** — no attribute facet group. It never references `category_attribute_filters` or product value ids.
3. **Tokyo PDP specs** — `product-view.tsx` renders `productSpecs(product)` from `src/storefront/lib/productMeta.ts:154`, which **fabricates** a spec table from the JSON product (Référence=id, Marque, État, Catégorie, Disponibilité, Garantie) — **not** DB `product_attributes`.
4. **The real DB spec path is dead** — `getProductSpecs` (`queries.ts:32`, the batched, cached, correct PDP spec builder) is consumed **only** by `src/components/product-tabs.tsx`, which has **zero importers** (orphaned). No shop route uses `getProductSpecs`.
5. **The pure facet predicate is dead** — `productMatchesAttributeFilters` (`src/lib/catalog/attribute-filter.ts`) claims to be "shared verbatim by the client grid" but is referenced **only by test files**; no live component imports it.
6. **The DB-live facet path is discarded** — `getProductsAttributeFilters` (`categories.ts:158`) *does* read live attributes/values/scalars and is called by the two remaining (shell) listing pages `/recherche` and `/collection/[slug]`, which pass `filterAttributes`/`productValueIds`/`productNumericValues` into `CategoryPageClient`. But `src/app/(shop)/(shell)/_components/category-client.tsx:25` is now a **compatibility shim** that destructures only `{category, baseProducts}`, accepts the rich legacy filter props via an index signature and **explicitly ignores them**, rendering the attribute-less Tokyo `CategoryView`. So even the shell listings compute attribute facets and throw them away.

Net: product attributes are an **admin + ERP-only** data model today. ERP can read/write them via `/api/attributes`, `/api/products/:slug/attributes`, `/api/categories/:slug/attributes`, and they drive TVA rules and variant axes — but they have no customer-facing render.

### Edit / remove notes

- **Safe to remove with low storefront blast radius:** because nothing customer-facing consumes attributes, deleting the whole Attributs sub-page/module would **not** change any (tokyo) page. But attributes are **not** inert in the backend — they are referenced by: product variant axes (`product_variant_values`), TVA rules (`tax_rules.attribute_value_id`), the product editor's Attributs tab, bulk-tagging, the category editor's Filtres tab, and the AI auto-assign flow. Removing the module would break all of those.
- **Dead code safe to delete independently:** `src/components/product-tabs.tsx` (orphaned) and its only reason for `getProductSpecs`; `src/lib/catalog/attribute-filter.ts` + its tests (referenced only by tests). Confirm `getProductSpecs`/`listScalarsForProducts` have no other caller before removing them.
- **If the goal is to wire attributes into Tokyo instead of removing them:** you must (a) add value/scalar/facet fields to the export `RawProduct` and write `products.json` from the attribute service, and (b) add an attribute facet group to `category-view.tsx` + feed PDP specs from real data. All three are greenfield — none exist.
- **Changing kinds in place is guarded** — `updateAttributeWorkflow` blocks conversions that would strand data; don't expect a silent kind flip to prune values.
- **Reused REST ids:** if you trim the `categories`/`products` permission grants, the category/product attribute-sync endpoints break even though the Attributs id is untouched.
- Slug changes on a published attribute are discouraged in-UI (helper text) but allowed; unique only among live rows.

### Gaps & risks

- **Stale project context:** the task brief says migrations are "frozen at 0007", but the repo has SQL migrations through `0201_order_business_tax.sql`; the scalar columns + color/boolean/number/text kinds are from `0021`, AI kind from `0022`. The schema-level "0007" reference is specifically the slug partial-unique index. Treat the migration set as live, not frozen at 0007.
- **Silent feature loss:** the `CategoryPageClient` shim (`category-client.tsx`) means `/recherche` and `/collection/[slug]` still *compute* attribute facets (DB load on every search) that are **never rendered** — wasted work and a confusing half-wired state for anyone reading the code. The comments in `attribute-filter.ts` and `getProductSpecs` still describe a storefront integration that no longer exists.
- **No list pagination/search:** the admin list loads every attribute with all values in one shot; fine at current scale but unbounded.
- **Three-way REST permission split** is easy to get wrong when editing RBAC — attribute facet sync is gated by `products`/`categories`, not `attributes`.
- **Hard vs soft delete asymmetry:** attributes soft-delete (slug freed for reuse), values hard-delete; the delete guards are the only thing preventing cascade data loss (variants/TVA). Any refactor that bypasses the workflow (e.g. calling `attributeService` directly) loses those guards.
- The AI **Auto-attribuer** tab is embedded in this page but is a `system_ai` surface — removing/editing Attributs should not assume that tab is governed by the `attributes` permission.


<details>
<summary><strong>9. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/attributes/page.tsx — server list page; guards attributes:view; loads listAttributesWithValues + (system_ai) auto-assign jobs
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/attributes/attributes-panel.tsx — client list UI, Attributs/Auto-attribuer sub-tabs (AI tab gated by system_ai:view), delete modal, no search/pagination
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/attributes/_kinds.ts — client-safe kind metadata; VALUE_LIST_KINDS excludes boolean (UI) vs schema VALUE_LIST_ATTRIBUTE_KINDS includes it
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/attributes/new/page.tsx — guards attributes:create
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/attributes/new/attribute-create-form.tsx — create form; kind picker, seed values (color hex), valuesJson, redirect to editor on success
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/attributes/[id]/page.tsx — detail page; guards attributes:view; 4 parallel reads + category tree flatten
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/attributes/[id]/attribute-detail-panel.tsx — meta form, values editor+reorder, scalar note, category picker, products-using-attribute
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/attribute/schema.ts — 5 tables, attribute_kind enum, invariants
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/attribute/service.ts — attributeService: all queries/mutations incl. listProductsUsingAttribute, setScalar, countAssignmentsUsingValues
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/attribute/queries.ts — RSC reads; getProductSpecs (DB PDP specs, cached) is consumed only by orphaned product-tabs.tsx
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/attribute/index.ts — barrel (attributeQueries, attributeService)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/manage-attributes.ts — the true mutation API; CRUD + value CRUD + reorder + setAttributeCategories + setCategoryFilters + bulkAssign; kind-change and delete guards
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/attribute.ts — Server Actions (RBAC guards + revalidatePath) incl. createCategoryFilterAttributeAction
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/api/attribute-validation.ts — validateAttributeRefs; shared value-id/scalar-kind validation for product write paths
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/catalog/attribute-filter.ts — pure facet predicate productMatchesAttributeFilters; DEAD (referenced only by tests)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/events/subscribers/invalidate-attribute-cache.ts — busts categories/products/attributes tags on attribute events
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/api/attributes/route.ts — ERP GET/POST/PATCH/DELETE (attributes read/write)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/api/attributes/values/route.ts — ERP value CRUD (attributes write)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/api/categories/[slug]/attributes/route.ts — category filter facets (categories read/write)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/api/products/[slug]/attributes/route.ts — product value/scalar sync (products read/write) via updateProduct workflow
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/scripts/tokyo-export-catalog.ts — storefront export; RawProduct has NO attribute fields (attributes never exported)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/components/storefront/category-view.tsx — Tokyo category listing; price/condition/brand/rating/stock facets only, NO attribute facets
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/lib/productMeta.ts — productSpecs() fabricates PDP spec table from JSON product, not DB attributes; fakeRating/fakeStrike fabricated
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/(shop)/(shell)/_components/category-client.tsx — CategoryPageClient shim: accepts filterAttributes/productValueIds and IGNORES them, renders attribute-less Tokyo CategoryView
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/api/categories.ts:158 — getProductsAttributeFilters (DB-live facet builder) whose output is discarded by the shim
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/product-tabs.tsx — ProductTabs consuming getProductSpecs; ORPHANED (zero importers)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/rbac/registry.ts:78 — attributes permission (CRUD, no manage)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/_components/admin-shell.tsx:138 — Catalogue nav entry id:attributes -> /admin/catalog/attributes
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/api-auth/route-catalog.ts:107-136 — REST SoT; attribute endpoints split across attributes/categories/products ids
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/db/migrations/0021_attribute_types_scalars.sql — origin of color/boolean/number/text kinds + product_attribute_scalars

**Models / tables**

- product_attributes (owned): id, slug (partial-unique WHERE deleted_at IS NULL), name, kind (attribute_kind enum), display_order, is_active, timestamps, deleted_at — SOFT delete
- product_attribute_values (owned): id, attribute_id (soft uuid), slug, label, display_order, color_hex; unique(attribute_id, slug) — HARD delete
- product_attribute_assignments (owned): PK(product_id, attribute_value_id) + valueIdx — M2M product↔value facet set
- category_attribute_filters (owned): PK(category_id, attribute_id) + display_order — M2M attribute↔category filter binding
- product_attribute_scalars (owned): id, product_id, attribute_id, numeric_value (numeric), text_value; unique(product_id, attribute_id) — per-product number/text
- enum attribute_kind: select | multiselect | color | boolean | number | text (schema.ts:44)
- Joined (soft uuid, other modules): products (product_id; listProductsUsingAttribute inner-joins products by name), categories (category_id; listCategoriesForAttribute inner-joins live categories)
- Cross-module consumers of attribute values (no FK, join services/workflows): product_variant_values (variant axes), tax_rules.attribute_value_id (per-value TVA)

**Sources of truth**

- Enum authority: attribute_kind pgEnum in src/modules/catalog/attribute/schema.ts:44 (select|multiselect|color|boolean|number|text); workflow validation derives from it (manage-attributes.ts:27) so it can't drift
- Value-list vs scalar authority: VALUE_LIST_ATTRIBUTE_KINDS (schema.ts:54, includes boolean) is the server truth; client _kinds.ts VALUE_LIST_KINDS (excludes boolean) is UI-only
- Mutation API: src/workflows/catalog/manage-attributes.ts (runs in db.transaction, emits events) — the ONLY correct write path; service methods alone bypass the guards
- RBAC existence: src/lib/rbac/registry.ts (attributes = CRUD); grants live in DB role_permissions/user_permission_overrides
- REST surface SoT: src/lib/api-auth/route-catalog.ts
- Contract/tests (no OpenAPI): src/lib/db/tests/attribute-validation.test.ts, attribute-guards.test.ts, attribute-filter.test.ts
- Storefront display data SoT: src/storefront/data/products.json (regenerated by scripts/tokyo-export-catalog.ts) — contains NO attribute data

**Editable / removable**

- DELETE-SAFE (no storefront impact): the entire Attributs admin sub-page + module can be removed without changing any (tokyo) page, because nothing customer-facing reads attributes — BUT it is load-bearing for the backend (product variant axes via product_variant_values, TVA rules via tax_rules.attribute_value_id, product editor Attributs tab, bulk-tagging, category Filtres tab, AI auto-assign). Removing it breaks those.
- DEAD CODE, independently deletable: src/components/product-tabs.tsx (zero importers) and src/lib/catalog/attribute-filter.ts + its test (referenced only by tests). Verify getProductSpecs/listScalarsForProducts have no other caller first.
- WASTED-WORK cleanup: getProductsAttributeFilters (categories.ts:158) is still invoked by /recherche and /collection/[slug] but its result is discarded by the CategoryPageClient shim — either delete the computation from those callers or re-wire CategoryView to consume facets.
- LOAD-BEARING, do not weaken: the kind-change guards (manage-attributes.ts:224-268) and delete guards (value/attribute, :312, :455) — they are the only protection against cascading loss of variant combos and TVA overrides.
- LOAD-BEARING: deleteAttributeWorkflow must keep clearing category_attribute_filters links before soft delete (:348) or category filter saves brick.
- RBAC caution: the REST attribute endpoints depend on categories and products permissions (not attributes) for facet sync — trimming those grants silently breaks ERP facet/scalar sync.
- The Auto-attribuer tab on this page is a system_ai surface, not attributes — gate/remove it via system_ai, not the attributes id.

**Gaps / risks**

- Stale brief: migrations are NOT frozen at 0007 — repo has migrations through 0201; scalar columns + color/boolean/number/text kinds came in 0021, AI kind in 0022. The '0007' in schema comments is only the slug partial-unique index.
- Half-wired storefront: /recherche and /collection/[slug] compute live attribute facets (getProductsAttributeFilters, extra DB load per request) that CategoryPageClient then silently discards — confusing dead integration.
- Misleading comments: attribute-filter.ts claims it is 'shared verbatim by the client grid' and getProductSpecs/queries.ts describe a PDP integration — neither exists anymore (both consumers orphaned).
- No admin list pagination/search: the list loads every attribute + all values at once.
- Three-way REST permission split (attributes/categories/products) makes RBAC edits error-prone for facet sync.
- Hard vs soft delete asymmetry (attributes soft, values hard) plus the guard-only protection means any direct attributeService call outside the workflow risks cascading loss of variant combos and TVA overrides.
- Attributes carry real, invisible backend weight (variants + TVA). A removal that looks safe from the storefront can break tax calculation and variant rendering.

</details>


---

## 10. Avis (Reviews) — moderation, AI generation & scheduling

The "Avis" subsection is one admin page with **three sub-tabs** backed by the `catalog/review` module (five services), six review workflows, two action files, one RSC read layer, one read-only REST route, an in-process scheduler booted from `instrumentation.ts`, and a daily mailing cron. **The live Tokyo storefront reads NONE of it** — it fabricates ratings from the product slug. Full detail below.

### What the operator sees & does

Single page at `/admin/catalog/reviews`, titled "Avis", rendered by `ReviewsModerationPanel` with a segmented tab strip (`reviews-panel.tsx:74-78`, `:198-204`): **Avis** (moderation + manual create, carries a badge = global pending backlog), **Génération** (AI on-demand + scheduler + fake cleanup), **Réglages** (policy). All three panels stay mounted and toggle via `hidden` so unsaved edits survive tab switches (`:206-208`). A section-level "Créer un avis" button sits above the tabs, gated on `perm.create` (`:186-194`).

**Tab "Avis" (moderation queue):**
- Status filter chips `En attente | Publiés | Rejetés | Tous` (`FILTERS`, `reviews-panel.tsx:56-63`); default view = `pending` (the queue) (`page.tsx:40-42`).
- Source filter chips `Toutes | Client | Manuel | IA` (`:65-72`, `:233-255`). Chip numbers are **facet-scoped**: a status chip reflects the active source and vice-versa, computed from the `statusSourceMatrix` so each chip's count equals what selecting it lists (`:131-144`).
- Product-name search box `?q=` (server-side ILIKE on `products.name`, metachar-escaped) (`:258-294`, `service.ts:19-33`).
- List rows (`ReviewRow`, `:480-603`): star rating, status badge, source badge, "Achat vérifié" badge, title, body (`dir="auto"` for RTL Derja), author, product link (suppressed with a "produit supprimé"/"non publié" pill when the product is soft-deleted/unpublished), date. Actions per row (gated): **Approuver**, **Rejeter**, **Supprimer** (confirm modal). Refused actions surface inline (`:489-503`, `:582-586`).
- **Server-side paging** `?page=N`, PAGE_SIZE=100, with a `« N affichés sur M »` counter and prev/next controls (`page.tsx:28-31,:77-85`, panel `:296-338`). Empty state: "Aucun avis dans cette sélection."
- **Create (manual) modal** (`ManualReviewModal`, `:606-748`): debounced product picker (`searchProductsForPickerAction`), 1-5 star picker, author, title, body, status (`En attente | Publié`), optional backdate (`<= today`), "Achat vérifié" checkbox.

**Tab "Génération":**
- "Génération à la demande (IA)" card → `ReviewGenerationControl` modal (`review-generation-control.tsx`): choose scope (Tout le catalogue / Catégorie+sous-catégories / Marque), N random products (blank = all), min/max reviews per product (1-5), rating distribution (`Réaliste | Très positive | Variée`), apply-status (`En attente | Publié`). Flow = **Générer (aperçu)** → background dry-run with live progress + log (`AiJobProgress`/`AiJobLog`, polled every 2.5s) → **report** where every draft is editable inline (rating stars, title, body, author, select/deselect, bulk all/none) → **Appliquer** (confirm). Lists "Aperçus à appliquer" (unapplied manual previews) and "Générations récentes" (`:417-456`).
- "Génération planifiée (IA)" card → `ReviewScheduleCard` (`review-schedule-card.tsx`): enable toggle, cadence in days, max products/run, scope, min/max, rating skew, status; shows last/next run + last error; **Enregistrer** and **Exécuter maintenant** buttons. Non-managers see an amber notice and the arm/publish/run-now controls are disabled (`:103-121,:180-194,:216-223`).
- "Avis factices" cleanup card (`FakesCard`, `reviews-panel.tsx:425-478`): counts of manual + AI reviews with bulk "Supprimer les manuels / IA" (confirm modal); never touches customer reviews.

**Tab "Réglages" (`ReviewSettingsCard`, `:367-423`):** toggles `Avis activés`, `Qui peut publier` (`Tout utilisateur connecté | Acheteurs vérifiés`), `Modération avant publication`, and `Note publique (source)` (`Avis clients uniquement (recommandé) | Tous les avis approuvés`). Changing the rating source warns it recomputes every product's stars.

### Routes & components

- `src/app/admin/catalog/reviews/page.tsx` — **server** RSC. `requirePermission("reviews","view")`, parallel reads, resolves per-action perms, clamps paging, maps rows, renders the panel (`:33-135`).
- `src/app/admin/catalog/reviews/reviews-panel.tsx` — **client** (`"use client"`). The whole UI: `ReviewsModerationPanel`, `ReviewSettingsCard`, `FakesCard`, `ReviewRow`, `ManualReviewModal`, `ProductPicker`, `Field`.
- `src/components/admin/catalog/review-generation-control.tsx` — **client** AI preview→edit→apply modal; polls jobs/report.
- `src/components/admin/catalog/review-schedule-card.tsx` — **client** scheduler config card.
- Shared UI: `FormTabStrip`, `ConfirmDeleteModal`, `SelectField`, `StarRating`, `ToggleField`, `AiJobProgress`, `AiJobLog`.
- Nav entry: `src/app/admin/_components/admin-shell.tsx:139` (`{ id:"reviews", label:"Avis", href:"/admin/catalog/reviews", icon: Star }`) under the Catalogue group.

Module (all `server-only`): `src/modules/catalog/review/{index,schema,service,generation-service,schedule-service,queries,config,config-parse,status}.ts`.
Workflows: `src/workflows/catalog/review.ts` and `src/workflows/catalog/review-gen/{generate,run-review-generation,scheduler,scope}.ts`.
Actions: `src/lib/actions/reviews.ts`, `src/lib/actions/review-generation.ts`.
Read layer: `src/lib/api/reviews.ts` + module `queries.ts`. REST: `src/app/api/reviews/route.ts`.

### Data model

**`product_reviews`** (`schema.ts:33-69`) — owned. Cols: `id` (uuidv7), `product_id uuid NOT NULL` (soft link, **no module FK**, but migration adds `product_reviews_product_id_fkey → products(id) ON DELETE CASCADE`), `user_id text` (Better-Auth id; NULL for manual/ai/guest), `author_name`, `rating int` (1-5), `title`, `body`, `status text default 'pending'`, `source` (`customer|manual|ai`, default `customer`), `verified_purchase bool`, timestamps. Invariants: CHECKs `product_reviews_rating_range` (1-5), `product_reviews_status_valid`, `product_reviews_source_chk`; **partial unique `(user_id, product_id) WHERE user_id IS NOT NULL`** (one review per signed-in user per product; NULL-user fakes unconstrained — supports many manual/ai rows). Indexes: `product_status_created`, `user`, `source`, `created`.
Enums: `REVIEW_STATUSES = [pending, approved, rejected]`, `REVIEW_SOURCES = [customer, manual, ai]` (`schema.ts:21-31`).

**`products.rating numeric(3,2)` + `products.reviews_count int`** (`product/schema.ts:122-123`, CHECK `products_rating_range` 0-5) — **the denormalized aggregate**, joined/written by the review service, never recomputed live for the headline.

**AI-gen tables** (`schema.ts:99-169`): `review_generation_jobs` (`status queued|running|completed|failed`, `scope jsonb`, `settings jsonb`, `scheduled bool`, progress counters `processed/total/generated/inserted`, `error`, `created_by`, timestamps); `review_generation_drafts` (`job_id` FK→jobs cascade, `product_id`, `product_name`, `author_name`, `rating`, `title`, `body`, `lang` derja_latin|derja_arabic|fr, `selected`, `applied`, `apply_error`); `review_schedule` (single-row config: `enabled`, `cadence_hours default 72`, `max_products_per_run default 8`, `scope`, `settings`, `last_run_at`, `next_run_at`, `last_error`).
Typed JSON: `ReviewGenScope {type: catalogue|category|brand, categoryId?, brandId?, count?}`, `ReviewGenSettings {reviewsPerProductMin, reviewsPerProductMax, ratingSkew: realistic|positive|mixed, status: pending|approved}`.
DB guards (`migrations/0024_review_gen_guards.sql`): partial-unique `review_generation_jobs_one_active` (≤1 queued/running job globally — DB single-flight), `review_schedule_singleton` (≤1 config row), `review_schedule_cadence_chk (cadence_hours > 0)`; drafts `rating_range` CHECK + FK cascade.

### Read path

- **Admin list/detail:** `page.tsx` calls, in parallel (`:53-64`): `reviewService.countForAdmin(filter)` (total for paging), `reviewService.statusSourceMatrix()` (one `GROUP BY status,source` scan → facet badges), then `reviewService.listForAdmin({...filter, limit:100, offset})` (`service.ts:269-300`) — a `leftJoin products` giving `productName/productSlug/productDeleted/productPublished`, ordered `created_at DESC`, offset-paged. Gen jobs via `listReviewGenerationJobsAction` (10 recent + unapplied previews, de-duped, `review-generation.ts:187-198`). Schedule via `reviewScheduleService.get()` (seeds defaults on first read).
- **Draft report:** `getReviewGenerationReportAction` → `findJob` + `listDrafts` (`generation-service.ts:162-168`).
- **Storefront/headless read:** `getApiProductReviews` (`lib/api/reviews.ts`) → `reviewQueries.listProductReviews` (approved only, `listApproved`, newest-first, cap 300) + `getProductReviewSummary`. Headline count/average come from the **stored** `products.rating/reviews_count` (`storedAggregate`), not a live AVG; per-star histogram is a live `distribution` query honoring the rating-source policy (`queries.ts:12-27`, `service.ts:162-202`).

### Write path (action → workflow → service → events)

All mutations go through `src/workflows/catalog/review.ts` (each wrapped in `workflow(...)`, which runs in a transaction and emits on the in-process bus). Actions revalidate `/admin/catalog/reviews` and `/` layout.

- **Customer submit:** `submitReviewAction` (`reviews.ts:19-75`, rate-limited per-user 5/min + per-IP 10/min) → `createReviewWorkflow` (`review.ts:53-134`): zod-validates (rating 1-5, title 3-120, body 10-4000); requires `cfg.enabled` + signed-in; the product must be **live + published + not early-access-embargoed** (`filterEarlyAccessRows`); dedupe via `findByUserAndProduct` (a `rejected` row is overwritten via `resubmitRejected`, re-opened for moderation — partial-unique prevents a second row); `verified_purchase` computed by `hasPurchased` (an order containing the product whose status ∉ `UNVERIFIED_ORDER_STATUSES = [pending,cancelled,refunded]`, `review.ts:21-44`); `buyers_only` policy rejects non-buyers; status = `pending` unless `requireApproval` is off; `recomputeProduct` only when approved; emits `catalog.review.created`.
- **Status change:** `setReviewStatusAction` (`requirePermission reviews:manage`) → `setReviewStatusWorkflow` → `setStatus` + `recomputeProduct` + `catalog.review.status_changed`.
- **Delete:** `deleteReviewAction` (reviews:delete) → `deleteReviewWorkflow` → hard `delete` + `recomputeProduct` + `catalog.review.deleted`.
- **Manual create:** `createManualReviewAction` (reviews:create) → `createManualReviewWorkflow` (`review.ts:208-255`): `user_id=NULL`, `source='manual'`, optional backdate clamped `≤ now`; recompute only when approved; emits `catalog.review.created_manual`.
- **Bulk fake cleanup:** `deleteReviewsBySourceAction` (reviews:delete) → `deleteReviewsBySourceWorkflow` (refuses `customer`) → `deleteBySource` + per-product recompute + `catalog.review.bulk_deleted`.
- **Policy settings:** `saveReviewSettingsAction` (reviews:update) → `workflows.cms.upsertSetting` ×4; if `rating_source` changed, runs `reviewService.recomputeAll` on a 60s long-statement connection + `bustStorefrontCache()`.
- **Denorm lockstep:** `recomputeProduct`/`recomputeAll` (`service.ts:215-259`) do a single atomic UPDATE with correlated sub-selects over `status='approved'` rows (lost-update-safe under READ COMMITTED), honoring `reviews.rating_source` (`customers` → only `source='customer'` feed the stars). This is the ONLY thing that keeps `products.rating/reviews_count` in sync with `product_reviews`; it is called after every create(approved)/status-change/delete/bulk-delete/apply(approved).

**AI generation** (`review-generation.ts` + `review-gen/*`):
- `startReviewGenerationAction` (reviews:manage): normalizes/clamps scope+settings, refuses a category/brand scope without an id, per-actor `ai:bulk` rate-limit (10/hr), `failStaleRunning(15m)`, `hasActive()` single-flight (+ DB one-active index), creates a `queued` job, fire-and-forgets `runReviewGenerationDryRun`.
- `runReviewGenerationDryRun` (`run-review-generation.ts:27-153`): resolves AI runner (`resolveFeatureRunner("avis","generate")`) + `resolveReviewScope` (`scope.ts`, only live+published products; random subset if `count`), generates drafts with concurrency 5 (`generateReviewsForProduct`, `generate.ts` — code picks rating by weighted skew + language by a fixed pool, model only writes title/body), buffers drafts, writes a capped per-item log, completes the job. **Writes NO reviews.**
- `applyReviewDrafts` (`run-review-generation.ts:173-229`): one tx — `claimSelectedDrafts` (atomic `applied=true ... RETURNING`, idempotent against double-apply) → `insertMany` reviews (`user_id=NULL`, `source='ai'`, job's status, `created_at` spread over ~90 days) → `setInserted` → `recomputeProduct` per product when approved; emits `catalog.review_gen.applied {productIds}`.
- Inline draft edits: `setReviewDraftSelectedAction`/`setAllReviewDraftsSelectedAction`/`updateReviewDraftAction` (reviews:manage).

**Scheduler** (`review-gen/scheduler.ts`): started from `instrumentation.ts:83-84` (`startReviewScheduler`, module-local once-guard, NOT HMR-safe), drained at `:117-118`. `reviewSchedulerTick` runs ~every 30min (`REVIEW_SCHEDULER_TICK_MS`): reaps/prunes stale jobs across review+product+content+ai-assign tables, single-flight `hasActive()`, then `reviewScheduleService.claimDueRun()` (atomic compare-and-set advancing `next_run_at` by cadence ±15% jitter) → `runScheduledGeneration` (creates a `scheduled` job capped at `max_products_per_run`, dry-runs, then **auto-applies all drafts** at the schedule's status) → logs a `job_run_log` row (`job_key "review_generation"`). `saveReviewScheduleAction` (reviews:update base; `scheduleSaveRequiresManage` escalates to reviews:manage to arm or newly set `approved`), emits `job.enabled_changed`. `runReviewScheduleNowAction` (reviews:manage) fires `runReviewScheduleNow`, emits `job.run_triggered`. Revalidates both `/admin/catalog/reviews` and `/admin/system/jobs` (Tâches planifiées dashboard).

**Events** (`src/events/types.ts:700-746`): `catalog.review.created|status_changed|deleted|created_manual|bulk_deleted`, `catalog.review_gen.generated|applied`. Consumed by **only** `invalidate-catalog-cache.ts:69-85` (busts `cacheTag.product(id)` / broad list tag so a cached PDP's stored rating + JSON-LD refresh) and documented in `event-catalog.ts:170` (external webhook surface). **No loyalty/credit grant subscriber exists** (see Gaps).

### RBAC

Permission id **`reviews`** with actions `view, create, update, delete, manage` (`rbac/registry.ts:79`, group "Catalogue"). The page opens with `requirePermission("reviews","view")` (`page.tsx:38`). Every mutating action re-guards server-side: `manage` for status change / AI start / apply / draft edits / run-now; `create` for manual create; `delete` for single + bulk delete; `update` for policy settings and scheduler save (with `manage` escalation to arm/publish). The panel receives a resolved perm object (`permissionSetAllows`, `page.tsx:69-75`) so view-only moderators see disabled controls instead of 403s. REST `/api/reviews` uses scope **`reviews:read`** (public-toggleable, read-only — `route-catalog.ts:180`); there is intentionally no `reviews:write` headless scope. **The "reviews" id is NOT reused** by other Catalogue entries (unlike Drip/Cartes-cadeaux which reuse "products"); reviews is its own id.

### Storefront linkage

**This is the critical gap. The live Tokyo storefront does NOT read `product_reviews` at all.** Every rating shown on Tokyo is fabricated client-side by `fakeRating(seed)` (`src/storefront/lib/productMeta.ts:8-15`) — a deterministic hash of the product slug (`~1 in 7 → "not yet rated"`, else `3.8–5.0` with a `12–491` count). Used on:
- Tokyo PDP: `(tokyo)/[slug]/page.tsx:188` (`const {rating,reviews}=fakeRating(p.slug)`), and the PDP **JSON-LD AggregateRating is built from that fake value** (`:199-206`); `product-view.tsx:118,585-610` renders the fake stars + "(N avis)" and a "soyez le premier" state — there is **no real review list and no submit form** on the Tokyo PDP.
- Product cards + category grids: `product-card.tsx:22`, `category-view.tsx:388,440`.

So **admin Avis edits (moderation, manual, AI, schedule) never surface on the live Tokyo storefront** — not even through the JSON snapshot: `tokyo-export-catalog.ts` exports catalog display data, not reviews, and the PDP rating is computed from the slug regardless. Real reviews ARE correctly maintained in the DB and reach exactly two other places: (1) the ERP/headless `GET /api/reviews` (approved reviews + stored aggregate, by any product ref, `reviews:read`), and (2) the **legacy `ProductReviews` component** (`src/components/product-reviews.tsx` — real reviews, histogram, verified badge, `submitReviewAction` form) which is imported only by `src/components/product-tabs.tsx`, and **`product-tabs.tsx` has zero importers → the legacy live-DB review UI is orphaned/unreachable in the current Tokyo app.** The `recomputeProduct`/cache-bust machinery, the rating-source policy, and the reviews-enabled switch therefore all operate on a surface no Tokyo shopper sees.

The only customer-facing review *touchpoint* that is live is the **review-request email** (cron `POST /api/cron/review-request` → `runReviewRequests`, `lib/mailing/review-request/run.ts`): daily, emails marketing-opted-in customers ~`mail.review_delay_days` (default 4) after delivery, idempotent per order, consent-gated, linking to `/order/{id}` (not a PDP review form). Registered as job `review_request` (`jobs/registry.ts:150`, `mailing/flows.registry.ts:222`). It does not itself write reviews.

### Edit / remove notes

- **Safe to retune:** moderation filters/paging/`PAGE_SIZE` (`page.tsx:28-31`), facet-badge logic, AI prompt/author pools/rating weights/language mix (`generate.ts:24-66`), schedule defaults (`schedule-service.ts:14-20`), rate-limit numbers. These are self-contained.
- **Removing AI generation/scheduling:** delete the Génération tab + `review-generation-control.tsx` + `review-schedule-card.tsx`, the `review-generation.ts` actions, `review-gen/*` workflows, `generation-service`/`schedule-service`, the `startReviewScheduler` boot in `instrumentation.ts:83-84,117-118`, and the `review_generation_*`/`review_schedule` tables. Core customer-review moderation (`review.ts` create/status/delete, `product_reviews`, `products.rating`) is independent and would keep working.
- **Load-bearing — do not break:** `recomputeProduct`/`recomputeAll` are the only writers of `products.rating`/`reviews_count`; removing a recompute call leaves stars stale. The partial-unique `(user_id, product_id)` is what makes `resubmitRejected`/duplicate logic correct. The `review_generation_jobs_one_active` index is the double-apply/concurrent-run backstop. `deleteReviewsBySourceWorkflow` must keep refusing `source='customer'`.
- **If Tokyo should show real reviews:** wire `getApiProductReviews`/`reviewQueries` (or revive `ProductReviews` via `product-tabs`) into `(tokyo)/[slug]/page.tsx`/`product-view.tsx` and replace `fakeRating` — otherwise all Avis work is invisible to shoppers. This is a product decision, not a bug to silently "fix".

### Gaps & risks

- **Fabricated ratings vs. real data (highest-impact):** `fakeRating` drives Tokyo stars AND the PDP JSON-LD AggregateRating, so Google sees invented ratings/counts unrelated to `product_reviews`. The admin "rating source (customers only, FTC/Google compliant)" setting is therefore cosmetic on Tokyo — it governs a stored aggregate nothing on Tokyo reads. FTC/structured-data risk.
- **Legacy review UI is dead code:** `product-tabs.tsx` (→ `ProductReviews` + `submitReviewAction`) has no importers; customers currently have **no way to submit a review** on Tokyo, yet `submitReviewAction` + rate limits + buyers-only policy are all maintained. The review-request email even invites reviews that can't be left on a PDP.
- **AI/manual "seed" reviews are fake content:** generation seeds invented Tunisian-dialect reviews with fake author names and backdated `created_at`; if ever surfaced + approved under rating-source "all", they inflate public ratings — a review-authenticity/FTC concern. Auto-apply by the scheduler bypasses human review entirely (mitigated only by defaulting to `pending`).
- **Scheduler cache-bust is best-effort:** background tick/"run now" applies can't `revalidate` Next tags from a detached context (`run-review-generation.ts:164-172`), so even on the legacy/headless surfaces an approved scheduled batch heals only within `cacheLife`.
- **Scheduler not HMR-safe** (`scheduler.ts:206-214`) — a dev re-eval from an HMR-reachable module could double-start the interval (duplicate generations still blocked by `hasActive()`).
- **Doc vs code:** project context says "migrations frozen at 0007," but review features live in migrations 0023/0024/0063/0136; schema is hand-authored SoT. No `db:generate/db:push` proposed.
- **No loyalty/credit on review:** the task hypothesized a "loyalty/credit grant-on-review path" — it does **not exist**. `catalog.review.created` has only two subscribers (cache invalidation + the webhook event-catalog doc); no credit/points are granted for leaving a review.


<details>
<summary><strong>10. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/reviews/page.tsx — RSC admin page; requirePermission('reviews','view'), parallel reads, paging, perm resolution (:38,:53-85,:100-115)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/catalog/reviews/reviews-panel.tsx — all client UI: tabs, moderation list/filters/paging, settings card, fakes cleanup, manual-create modal
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/catalog/review-generation-control.tsx — AI preview→edit→apply modal with job polling
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/catalog/review-schedule-card.tsx — internal-scheduler config card (save / run now)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/review/schema.ts — product_reviews + review_generation_jobs/drafts + review_schedule tables, enums, invariants
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/review/service.ts — moderation reads, statusSourceMatrix, setStatus/delete, recomputeProduct/recomputeAll (denorm), storedAggregate/distribution/listApproved/resubmitRejected
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/review/generation-service.ts — AI job/draft store, single-flight, claimSelectedDrafts, prune
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/review/schedule-service.ts — single-row schedule config, claimDueRun compare-and-set, setEnabled
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/review/config.ts + config-parse.ts — reviews.* policy (enabled/policy/require_approval/rating_source)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/catalog/review/status.ts + queries.ts + index.ts — status labels/colors; storefront read wrappers; module barrel
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/review.ts — create/setStatus/delete/createManual/deleteBySource workflows; hasPurchased + UNVERIFIED_ORDER_STATUSES
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/review-gen/generate.ts — generative core (code-fixed rating/lang distribution, model writes title/body)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/review-gen/run-review-generation.ts — dry-run runner + applyReviewDrafts (atomic claim+insert)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/review-gen/scheduler.ts — internal tick, runScheduledGeneration, run-now, start/drain (booted from instrumentation.ts)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/catalog/review-gen/scope.ts — resolveReviewScope (live+published products only)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/reviews.ts — submit/createManual/setStatus/delete/deleteBySource/saveSettings server actions + RBAC guards
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/review-generation.ts — AI start/list/report/draft-edit/apply + schedule save/run-now actions
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/api/reviews.ts — headless/storefront read (approved + stored aggregate, embargo + enabled gates)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/api/reviews/route.ts — REST GET /api/reviews (reviews:read, by any product ref)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/lib/productMeta.ts — fakeRating(): FABRICATED Tokyo ratings (NOT product_reviews) — the storefront gap
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/(shop)/(tokyo)/[slug]/page.tsx — Tokyo PDP; uses fakeRating(:188) incl. JSON-LD AggregateRating(:199-206)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/components/storefront/product-view.tsx — Tokyo PDP body; fake stars (:118,:585-610); no real reviews/submit form
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/product-reviews.tsx + product-tabs.tsx — legacy real-review UI (reads DB + submitReviewAction) but product-tabs has ZERO importers → orphaned
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/events/subscribers/invalidate-catalog-cache.ts — the only functional consumer of catalog.review.* events (cache busting), :69-85
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/api/cron/review-request/route.ts + src/lib/mailing/review-request/run.ts — daily post-delivery review-request email (no review write, no credit)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/db/migrations/0024_review_gen_guards.sql + 0023_review_source_and_generation.sql — one-active/singleton/cadence/source CHECK guards
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/rbac/registry.ts:79 + src/lib/api-auth/route-catalog.ts:180 + src/app/admin/_components/admin-shell.tsx:139 — RBAC id, REST scope, nav entry

**Models / tables**

- product_reviews (owned): id uuidv7, product_id uuid (soft link + migration FK→products ON DELETE CASCADE), user_id text NULL, author_name, rating int 1-5, title, body, status text[pending|approved|rejected] default pending, source text[customer|manual|ai] default customer, verified_purchase bool, created_at/updated_at; CHECKs rating_range/status_valid/source_chk; partial-unique (user_id,product_id) WHERE user_id IS NOT NULL
- products (joined, denorm written): rating numeric(3,2) default 0 (CHECK 0-5), reviews_count int default 0 — maintained only by reviewService.recompute*
- review_generation_jobs (owned): status[queued|running|completed|failed], scope jsonb(ReviewGenScope), settings jsonb(ReviewGenSettings), scheduled bool, processed/total/generated/inserted int, error, created_by, started_at/finished_at; partial-unique review_generation_jobs_one_active
- review_generation_drafts (owned): job_id uuid FK→jobs cascade, product_id, product_name, author_name, rating int 1-5, title, body, lang[derja_latin|derja_arabic|fr], selected bool, applied bool, apply_error
- review_schedule (owned, single row): enabled bool, cadence_hours int default 72 (CHECK >0), max_products_per_run int default 8, scope jsonb, settings jsonb, last_run_at/next_run_at, last_error; unique review_schedule_singleton
- orders + order_items + order_status_history (joined read-only): hasPurchased() verified-purchase check (status ∉ pending/cancelled/refunded); review-request cron reads delivered-at from status history
- site_settings reviews.* (joined via cms setting): enabled/policy/require_approval/rating_source + mail.review_delay_days

**Sources of truth**

- product_reviews table (status/source/verified_purchase) = the real review store; status enum gates visibility, only 'approved' feeds aggregate
- products.rating + products.reviews_count = the DENORMALIZED aggregate, sole writer is reviewService.recomputeProduct/recomputeAll; headline count/average read from here, never live AVG
- reviews.* site_settings (config-parse.ts resolveReviewConfig): enabled / policy(all|buyers_only) / require_approval / rating_source(all|customers)
- RBAC permission id 'reviews' with actions view/create/update/delete/manage (rbac/registry.ts:79); DB grants in role_permissions/user_permission_overrides
- src/workflows/catalog/review.ts = the true mutation API for customer/manual/moderation reviews (tx + events); src/lib/db/tests/** is the contract (no OpenAPI)
- review_schedule single-row config (schedule-service.get seeds defaults) = scheduler source of truth; next_run_at advanced atomically by claimDueRun
- review_generation_jobs_one_active partial-unique index = global single-flight backstop for all AI generation runs
- REST surface SoT src/lib/api-auth/route-catalog.ts:180 → reviews.list = reviews:read, read-only (no reviews:write scope offered)
- Tokyo storefront rating source of truth is NOT the DB — it is fakeRating(slug) in src/storefront/lib/productMeta.ts (fabricated)

**Editable / removable**

- Safe to retune in isolation: moderation PAGE_SIZE/MAX_QUERY (page.tsx:28-31), facet-badge math, filter chip sets, product-search behavior
- Safe to retune: AI prompt text, Tunisian name pools (generate.ts:24-30), RATING_WEIGHTS skews (:40-44), LANG_POOL mix (:59-66), per-review token budget
- Safe to retune: schedule defaults (schedule-service.ts:14-20), cadence/max clamps (review-generation.ts:303-304), ai:bulk rate limit, tick interval env REVIEW_SCHEDULER_TICK_MS
- Removable as a unit (AI generation + scheduling): Génération tab, review-generation-control.tsx, review-schedule-card.tsx, lib/actions/review-generation.ts, workflows/catalog/review-gen/*, generation-service/schedule-service, instrumentation start/drain (:83-84,:117-118), review_generation_*/review_schedule tables — core moderation is independent
- Load-bearing, do NOT break: recomputeProduct/recomputeAll (only writer of products.rating/reviews_count); call it after every approve/reject/delete/apply-approved
- Load-bearing: partial-unique (user_id,product_id) WHERE user_id IS NOT NULL + resubmitRejected rejected-only guard (dedupe + rejected resubmit correctness)
- Load-bearing: review_generation_jobs_one_active index + claimSelectedDrafts atomic claim (concurrent-run / double-apply guards)
- Load-bearing: deleteReviewsBySourceWorkflow must keep refusing source='customer'; scope.ts must keep restricting AI reviews to live+published products
- Product decision, not a safe silent edit: wiring real reviews onto Tokyo PDP (replace fakeRating in (tokyo)/[slug]/page.tsx + product-view.tsx, revive ProductReviews/product-tabs or use getApiProductReviews)

**Gaps / risks**

- Tokyo storefront fabricates ratings via fakeRating(slug) and does NOT read product_reviews — all admin Avis moderation/generation is INVISIBLE to live shoppers; the PDP JSON-LD AggregateRating uses the fake value (Google/FTC risk)
- Legacy real-review UI (product-reviews.tsx via product-tabs.tsx) is orphaned (zero importers) → customers currently have no way to submit a review on Tokyo, yet submitReviewAction + buyers-only policy + rate limits are maintained
- AI/manual 'seed' reviews are invented content with fake authors + backdated dates; under rating_source='all' approved fakes inflate the stored public rating; scheduler auto-applies without human review (defaults to pending as sole mitigation)
- rating_source='customers only' setting is cosmetic on Tokyo (it governs a stored aggregate the live storefront never reads)
- Scheduler/background applies cannot revalidate Next cache tags from a detached context (best-effort) — approved scheduled batches heal only within cacheLife on headless/legacy surfaces
- startReviewScheduler is module-local (NOT HMR-safe) — a dev HMR re-eval could start a second interval (duplicate generations still blocked by hasActive())
- No loyalty/credit grant-on-review exists: catalog.review.created has only cache-invalidation + webhook-doc subscribers; the hypothesized credit path is absent
- Doc/code mismatch: 'migrations frozen at 0007' but review features live in 0023/0024/0063/0136; schema hand-authored is the SoT (no db:generate/db:push proposed)

</details>


---

## 11. Médiathèque (media library admin)

The "Médiathèque" is one Catalogue nav entry (`/admin/media`) that merges two sub-tabs via a plain-link strip: the **library grid** and its **Réglages** (pipeline settings). Media is the one admin domain that uploads over **REST routes**, not Server Actions — but the list/edit/delete/settings mutations ARE Server Actions. It is also the only catalog subsection that **never reaches the live Tokyo storefront** on its own: the Tokyo snapshot freezes product image URL strings at export time, so a delete or détourage reprocess here can 404 Tokyo images until `scripts/tokyo-export-catalog.ts` is re-run.

### What the operator sees & does

Two views toggled by a pill (`media-panel.tsx:424-435`), and a sub-tab bar above (`media-subtabs.tsx`).

**Library view (`/admin/media`)**
- Header blurb linking to `/admin/media/settings`; a "Trouver les orphelins / Toutes les images" toggle.
- **Upload dropzone** (`UploadDropzone`, shown only with `media:create`, `media-panel.tsx:454-456`): a "Dossier" scope `SelectField` (Général/Produit/Catégorie/Marque/CMS → scopes `uploads|products|categories|brands|cms`, `media-panel.tsx:69-75`); an **import-by-URL** field (`submitUrl`, `:720`); a drag-drop / click dropzone accepting `jpg,jpeg,png,webp,avif,gif` (`ACCEPTED`, `:77-78`); a client size gate vs the live `max_upload_mb` (`:703-710`); a queue with object-URL previews, a shared "Texte alternatif (appliqué à tous)" field, and a per-file sequential uploader with per-file result rows (`submit`, `:747-777`).
- **Search** box (debounced 300ms, `:296-308`): in library view it is SERVER-side (spans the whole library, filename OR alt) by writing `?q=` into the URL; in orphans view it is a client filter over the loaded 200.
- **Grid** of cards (`MediaCard`, 2–5 cols). Each card: thumbnail, filename, `W×H · size`, and variant chips — AVIF/WebP/Orig./CDN ext. each a real link to the asset (`VariantChip`, `:1222-1248`). Hover overlay: **copy-URL** (always) and **delete** (with `media:delete`). A top-left **selection checkbox** (with `media:delete`). Clicking a card (with `media:update`) expands it into an inline **edit form** replacing the card body.
- **Edit form** fields (`MediaCard` expanded, `:1043-1060`): `altText` (textarea), `filename`, `urlOverride` ("URL externe (CDN — remplace l'URL générée)"). Save auto-closes on success.
- **Bulk bar** (with `media:delete`): "Tout sélectionner", count, "Supprimer la sélection" → `BulkDeleteDialog`. A selection over `BULK_MEDIA_MAX` (200) is refused before opening the confirm (`openBulkDelete`, `:388-400`).
- **Delete confirm** (`ConfirmDeleteModal`, `:1297`): fetches an **in-use count** (`mediaUsageCountAction`) and warns "⚠ Utilisée par N élément(s)…".
- **Bulk delete confirm** (`BulkDeleteDialog`, `:1432`): lists which selected images are still referenced (`listMediaInUseAction`), requires an explicit second-confirmation checkbox when any are in use, and re-surfaces server-returned `inUseIds` if the server re-check disagrees.
- **"Charger plus"** keyset pagination appends older batches from `GET /api/admin/media` (`loadMore`, `:235`); a post-mutation effect re-fetches the loaded depth so appended rows aren't stale (`:259-291`).
- **Browse-cap notice** ("N médias les plus récents affichés sur M") when idle and `total` exceeds what is shown (`:514-521`).
- **Read-only notice**: a role missing create/update/delete gets a banner naming the missing verbs instead of broken controls (`:177-189`).
- **Empty states**: "Médiathèque vide. Téléversez votre première image." vs "Aucun résultat pour cette recherche." (`:581-591`).

**Orphans view (`?view=orphans`)**: same grid, no dropzone, a dashed banner ("Aucune référence trouvée… Vous pouvez les supprimer en toute sécurité"), capped at the newest 200 with an "N affichés sur M" notice (`:522-531`).

**Réglages sub-tab (`/admin/media/settings`, `media-settings-form.tsx`)**: fully-controlled form (React-19 reset guard, `:52`). Sections: **Formats générés** (toggles `generate_webp`, `generate_avif`, `keep_original`, `product_white_bg` détourage, and the indented sub-toggle `product_white_bg_main_only`); **Détourage des produits existants** card (separate background job, below); **Qualité & dimensions** (`webp/avif/jpeg_quality` 30–100, `max_upload_mb` ≤16, `max_width_px`/`max_height_px` 0–8000); **Vie privée & livraison** (`strip_exif`, `default_alt_text`, `cdn_base_url` with an amber "host not in build" warning when outside the compiled allow-list, `:235-247`).

### Routes & components

- `src/app/admin/media/page.tsx` — **server** RSC. Guards `media:view`, resolves write-capability flags, primes CDN base, fetches settings + page + total, maps rows to card DTOs. Renders `MediaSubtabs` + `MediaPanel`.
- `src/app/admin/media/media-panel.tsx` — **client**. Houses `MediaPanel`, `UploadDropzone`, `MediaCard`, `VariantChip`, `Field`, `ConfirmDeleteModal`, `BulkDeleteDialog`. The whole interactive library.
- `src/app/admin/media/media-subtabs.tsx` — **client-ish** (just `Link`s). Library tab always; Réglages tab only when `canSettings` (`:18-20`).
- `src/app/admin/media/settings/page.tsx` — **server**. Guards `system_media:view`; calls `bustStorefrontForUnbustedJobs()` (`:17`); renders `MediaSettingsForm`.
- `src/app/admin/media/settings/media-settings-form.tsx` — **client** form + `Toggle`/`NumberField`.
- `src/app/admin/media/settings/product-white-bg-reprocess.tsx` — **client**. Fires + polls the détourage back-fill job (links to `/admin/system/jobs` for the cron, `:105`).
- `src/components/admin/media-picker.tsx` — **client**. `MediaPicker` (single/multi), `SelectedTile`, `MediaEditPanel`, `PickerDialog`. Embedded by product/variant, brand, category, collection, banner, blog, theme forms. Emits hidden `<input name=…>` so parent Server-Action forms pick up media ids natively; drives `/api/admin/media` (browse/ids), `/api/admin/media/upload`, `/api/admin/media/import-url`, and shares `updateMediaAction` for inline alt/filename/CDN edits.
- REST (all **server**, admin-gated, in `route-catalog.ts:210-212`): `src/app/api/admin/media/route.ts` (GET browse + `?ids=` hydrate), `upload/route.ts` (POST multipart), `import-url/route.ts` (POST json).

### Data model

**Owned table `media`** (`src/modules/media/schema.ts`):
- `id` (uuid v7 PK), `kind` enum `media_kind` = image|video|document|other (default image, `:30-35`), `storage_key`, `url` (canonical primary = quality JPEG), `filename`, `mime_type`, `size_bytes` (bigint), `width`, `height`, `alt_text`, `uploaded_by` (Better-Auth user id, **soft link, no FK**, not surfaced in any admin view, `:50`).
- Variant tracking (NULL = not generated): `webp_url`/`webp_size_bytes`, `avif_url`/`avif_size_bytes`, `original_url`/`original_size_bytes`/`original_mime_type` (`:54-60`).
- `url_override` — admin CDN escape hatch; when set, resolvers use it verbatim and skip variant resolution (`:64`).
- `timestamps()` + `softDelete()` (`deleted_at`, app-enforced).
- Index `media_live_idx`: partial composite on `(created_at desc, id desc) WHERE deleted_at IS NULL` — backs keyset pagination, the live `count()`, and `listOrphans` ordering (`:76-78`). (Filename trigram search uses the `media_filename_trgm` GIN index from a frozen migration.)

**Owned singleton `media_settings`** (`settings.schema.ts`): one row pinned to `SINGLETON_ID='…0001'` by a CHECK. Columns: `generate_webp`(T), `generate_avif`(T), `keep_original`(F), `product_white_bg`(F, frozen name — flood-fills ANY uniform border sweep, not just white), `product_white_bg_main_only`(F), `max_width_px`/`max_height_px`(2400), `webp_quality`(82)/`avif_quality`(60)/`jpeg_quality`(85), `strip_exif`(T), `max_upload_mb`(`DEFAULT_MAX_UPLOAD_MB`=8), `default_alt_text`, `cdn_base_url`.

**Joined (soft `*_media_id` links, no FK) — the reference-lockstep set** (`queries.ts:375-413`): `product_media.media_id` (the ONLY real uuid FK), `products.{video_poster,og_image}_media_id`, `product_variants.image_media_id`, `brands.{logo,hero,og_image,icon}_media_id`, `categories.{hero,og_image,icon,boutique_image}_media_id`, `collections.{image,og_image,icon}_media_id`, `banners.{image,image_mobile}_media_id`, `pages.og_image_media_id`, `hero_sections.image_media_id`, `cta_sections.background_image_media_id`, `blog_posts.featured_image_media_id`, `authors.avatar_media_id`, `site_settings` keys ending `%media_id`, plus JSON/inline sources: rich-HTML bodies (`bodyRefMatch`), `value_props[].iconMediaId`, landing trust JSON, `home.blocks`, `pages.blocks`, `nav_items.config`.

**Key invariants**: millimes/soft-delete conventions don't apply (media has no money). `uploaded_by` is provenance only. Enums: `media_kind` (only "image" is ever written by uploads) and the five upload **scopes** (`MEDIA_UPLOAD_SCOPES`, `validation.ts:17`) — interpolated verbatim into the S3 key prefix, so always allow-list-validated. `ALT_TEXT_MAX`=500, filename cap 200, `url_override` cap 2000 (`upload-media.ts:59`, `validation.ts:57`).

### Read path

- **Library list** → `mediaService.list({search, limit})` (`service.ts:59-115`): `WHERE deleted_at IS NULL`, optional filename-OR-alt ILIKE (LIKE-escaped), composite keyset cursor `"<µs-iso>__<uuid>"` compared as `(created_at,id) < (…)` at microsecond precision (page.tsx first batch limit 100; "Charger plus" via `GET /api/admin/media?cursor=` capped at 100, `route.ts:58`). Default service cap 200.
- **Total** → `mediaService.count()` (index-only live count) or `countOrphans()` in orphans view.
- **Orphans list** → `listOrphans(200)` (`queries.ts:423`) = `orphanMediaWhere()` NOT-EXISTS anti-join, newest first, no cursor.
- **Card DTO mapping** (page.tsx:79-99): `url`/`thumbUrl` via `normalizePublicUrl(url_override ?? …, cdnBase)` — override wins so a stale generated webp can't mask it; each variant carries its absolute URL. `primeCdnBase()` runs first so admin URLs match what the storefront serves.
- **Picker browse** → same `mediaService.list` over `GET /api/admin/media` (limit 24, cap 100); **`?ids=` hydrate** → `findMediaByIds` (cap 50, bad uuids dropped, `route.ts:39-49`).
- **Delete confirm counts** → `countMediaReferences(id)` (single) and `listReferencedMediaIds(ids)` (bulk) — both the positive twin of `orphanMediaWhere`.

### Write path

Uploads/imports go through **REST → workflow** (no action for the picker; the library's dropzone calls Server Actions that call the same workflow):
- **Upload**: `uploadMediaAction` (`catalog.ts:1528`, guard `media:create`, rate-limit `media-upload:<uid>` 30/60s) → `uploadMediaWorkflow` (`upload-media.ts:67`): validate MIME+settings size ceiling → `processImage` (scope-gated détourage) → PUT up to 4 variants under a shared base key → insert row → emit `media.uploaded`. If any enabled variant PUT or the INSERT fails, every candidate object is purged before abort (`purgeUploadedObjects`, `:133-143`). JSON route twin: `api/admin/media/upload/route.ts` (same-origin + 413 handling + MIME/scope gate).
- **Import-URL**: `importMediaFromUrlAction` (`catalog.ts:1563`) / `api/admin/media/import-url/route.ts` → `importMediaFromUrlWorkflow` (`import-url.ts`): SSRF-hardened `fetchRemoteImage` → wraps bytes in a `File` → reuses `uploadMediaWorkflow` verbatim.
- **Update (alt/filename/url_override)**: `updateMediaAction` (`catalog.ts:1733`, guard `media:update`) validates `url_override` against the build-host allow-list (`checkUrlOverride`, lets an unchanged stored value through) → `updateMediaWorkflow` (`upload-media.ts:270`): patches only provided fields (`urlOverride` ""/null both clear), emits `media.updated{changedFields}`.
- **Single delete**: `deleteMediaAction` (`catalog.ts:1588`, guard `media:delete`) → `deleteMediaWorkflow` (`upload-media.ts:236`): `softDelete` (tombstone) + emit `media.deleted{storageKeys}` (bus awaits subscribers → objects purged before return; NOT byte-recoverable).
- **Bulk delete**: `bulkDeleteMediaAction` (`catalog.ts:1658`, guard `media:delete`): parse 1..200 uuids; unless `confirmInUse===true`, re-check `listReferencedMediaIds` and refuse the whole list returning `inUseIds`; else fan out `workflows.media.delete` at concurrency 8, then one summary `media.bulk_deleted` (`storageKeys:[]` — each row already reaped by its own `media.deleted`).
- **Settings**: `updateMediaSettingsAction` (`catalog.ts:1779`, guard **`system_media:update`**) → `updateMediaSettingsWorkflow` (`settings.ts`): zod validation with field errors, `cdn_base_url` checked against `isCdnBaseAllowed(bakedMediaHostEntries())`, `mediaSettingsService.update` (clamps qualities/dimensions/upload-mb), `invalidateCdnBase()`, emit `media.settings_updated`.
- **Détourage back-fill job**: `startProductWhiteBgReprocessAction` (`data-jobs.ts:242`, guard **`system_media:update`**, global single-flight on `import_jobs`) fires `runProductWhiteBgReprocess` fire-and-forget; polled by `getReprocessJobStatusAction` (guard `system_media:view`, also busts storefront for finished jobs). The runner repoints each uniform-backdrop packshot to new `-nobg.*` keys, deletes old objects (keeping order-snapshot keys), emits product cache-busts. Cron twin `runScheduledProductDetourage` (`:401`) respects the `product_white_bg` kill-switch.

**Transactions**: individual service calls, not wrapped `db.transaction()` — the object-store side can't be transactional, so the workflows use the purge-on-failure compensation above. **Events**: `media.uploaded`, `media.updated`, `media.deleted`, `media.bulk_deleted`, `media.settings_updated`. **Subscribers**: `cleanup-media-storage.ts` purges S3 objects on `media.deleted`/`media.bulk_deleted` (keeping keys still shown by an order line, `listOrderReferencedStorageKeys`); `invalidate-media-cache.ts` busts broad storefront LIST tags on updated/settings_updated/deleted/bulk_deleted; `audit-trail.ts` records. **Revalidation**: actions `revalidatePath("/admin/media")` (+ `/admin/media/settings`).

### RBAC

- Registry (`rbac/registry.ts:80-81`): `media` (label "Médiathèque", full CRUD) and `system_media` (label "Médiathèque — réglages", VIEW_EDIT only), both in the **Catalogue** group.
- Library page guard: `requirePermission("media","view")` (page.tsx:28). Write controls are shown/hidden by `media:create|update|delete` resolved from the permission set, and every action re-checks server-side (upload/import `media:create`, update `media:update`, single+bulk delete `media:delete`, usage/in-use lookups `media:view`).
- Settings page + its action + the reprocess start/status: `system_media:{view|update}` (settings page.tsx:14, `catalog.ts:1783`, `data-jobs.ts:245,294`). The Réglages sub-tab only renders when the user holds `system_media:view`.
- REST routes all guard `media:view` (browse) / `media:create` (upload, import-url); `requirePermission` → 404 for unauthorized, so the endpoints are invisible. The picker turns that empty 404/403 into a named-permission message (`mediaAccessDeniedMessage`, `media-picker.tsx:102-107`).
- **No reused id here** (unlike Drip/Cartes-cadeaux reusing `products`): media owns `media` + `system_media` outright.

### Storefront linkage

Two different realities:

1. **Legacy (shell) storefront — LIVE DB.** The `invalidate-media-cache` subscriber busts product/category/brand/collection/pages/blog LIST cache tags on any media edit/delete/settings change, so the legacy storefront re-resolves media URLs/alt on next render. A `cdn_base_url` change rewrites every resolved URL store-wide (`media.settings_updated`).

2. **LIVE Tokyo storefront — FROZEN JSON snapshot.** `src/app/(shop)/(tokyo)/**` + `src/storefront/**` read product display data from the bundled `src/storefront/data/products.json`, regenerated only by manually running `scripts/tokyo-export-catalog.ts`. That script writes each product's image as a **resolved same-origin `/cdn/<key>` string** (`image: imageUrl(p.image)`, `:97`) — a frozen URL, not a media id, and it stores **no alt** (Tokyo fabricates ratings/discounts client-side in `src/storefront/lib/productMeta.ts`). Consequences for Médiathèque admin edits:
   - **Alt-text edits**: never reach Tokyo (products.json has no alt field).
   - **`url_override` edits**: do NOT appear on Tokyo until re-export (products.json keeps the old frozen URL); the old `/cdn/<key>` object isn't deleted by an override, so Tokyo keeps showing the old image (no 404).
   - **Delete of a media referenced by a product**: purges the S3 object → the frozen `/cdn/<key>` in products.json now **404s on Tokyo** (broken image) until re-export.
   - **Détourage reprocess (toggle future uploads, or the back-fill job / cron)**: re-keys product packshot objects to `-nobg.*` and **deletes the old objects** → every frozen `/cdn/<oldkey>` in products.json 404s on Tokyo until `tokyo-export-catalog.ts` is re-run and the JSON committed. (`bustStorefrontForUnbustedJobs` only busts the legacy Next cache tags; it does NOT touch the Tokyo JSON.)
   - **New uploads**: invisible to Tokyo until the product is edited to reference them AND the catalog is re-exported.

   So: state to the operator that ANY destructive media op (delete, détourage) on a product image is safe for the legacy storefront but will break the corresponding Tokyo image until a manual re-export.

### Edit / remove notes

- **Safe to edit in isolation**: all copy/labels in `media-panel.tsx` / `media-settings-form.tsx`; scope labels (`SCOPES`); the browse-cap / orphan-cap notices; `LIBRARY_PAGE`/`ORPHANS_CAP` page sizes; poll interval. The sub-tab strip is pure `Link`s — safe to restyle.
- **Change together (lockstep)**: the reference-source list appears in FOUR places — `orphanMediaWhere`, `listReferencedMediaIds`, `countMediaReferences`, and the per-source match helpers (`bodyRefMatch`, `valuePropIconMatch`, landing/home/page/nav matchers) in `queries.ts`. Dropping a source from `listReferencedMediaIds`/`countMediaReferences` lets the bulk/single delete and the destructive sweeps purge an in-use image (data loss); dropping one only from `orphanMediaWhere` merely over-counts orphans (safe).
- **Load-bearing, do not casually remove**: the purge-on-failure path in `uploadMediaWorkflow` (the only reclamation — there is no bucket sweep); the order-snapshot pin in `cleanup-media-storage`/reprocess (removing it breaks historical order thumbnails irreversibly); the keyset cursor's microsecond precision (`service.ts:88-114`, dropping to ms re-introduces page-seam row loss); `media_settings` singleton CHECK + `get()` materialization.
- **If removing a feature**: the import-by-URL field and the REST import-url route can be removed together (SSRF fetch + rate-limit are self-contained). The détourage feature spans the toggle (`product_white_bg[_main_only]`), `processor`/`white-bg`, the back-fill job + action + cron + the settings card — remove as a set. `uploaded_by` is written but unused in any view — safe to drop the column read without UI impact (but it is a frozen schema).
- **Scope changes are not free**: editing `MEDIA_UPLOAD_SCOPES` changes S3 key prefixes and the détourage gate; must be mirrored in both REST routes' inline allow-lists.

### Gaps & risks

- **No byte-level "replace" in the library.** The edit form only changes alt/filename/`url_override`; the picker's "Remplacer le média" just swaps the selected id. Replacing an image's bytes requires a new upload + repointing references (or a `url_override`).
- **Tokyo re-export is manual and silent.** Nothing in the Médiathèque warns that a delete/détourage will 404 Tokyo images, and no UI triggers `tokyo-export-catalog.ts`. This is the single biggest footgun of this subsection.
- **Orphan anti-join is leading-`%` ILIKE over body/JSON columns** (`bodyRefMatch`, `home.blocks`, `pages.blocks`, `nav_items.config`) — unindexable, run only on admin/destructive paths; fine at current scale but scans grow with content volume.
- **Orphans view and its search are capped at 200 with no cursor** — large orphan sets need delete-then-reload cycles.
- **`media_settings` is cached 30s in-process** (`settings.service.ts:29`); a settings change can lag the upload pipeline by up to the TTL on a multi-worker deploy where only the editing worker's cache is invalidated.
- **`cdn_base_url`/`url_override` build-host coupling**: a host valid in the DB but not compiled into `remotePatterns`/CSP is accepted-with-warning or rejected depending on path, and silently falls back to `/cdn` on the storefront — operators can set a CDN that "does nothing" until an image rebuild.
- **`media:create` vs `system_media`**: a user with `media` CRUD but not `system_media` cannot see the pipeline settings, yet their uploads are processed by those settings — expected, but worth noting for support.


<details>
<summary><strong>11. Quick index — key files · models · sources of truth · edit/remove · risks</strong></summary>

**Key files**

- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/media/page.tsx — library RSC: media:view guard, CDN prime, list/count/orphans fetch, card DTO mapping (url_override-first)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/media/media-panel.tsx — the whole client library: dropzone, import-URL, grid, inline edit form, single/bulk delete confirms, Charger-plus pagination
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/media/media-subtabs.tsx — library/Réglages sub-tab strip; settings tab gated on system_media:view
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/media/settings/page.tsx — settings RSC: system_media:view guard, bustStorefrontForUnbustedJobs
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/media/settings/media-settings-form.tsx — controlled settings form (formats/quality/privacy/CDN), build-host warning
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/media/settings/product-white-bg-reprocess.tsx — détourage back-fill job trigger + 2s poll, cron link
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/components/admin/media-picker.tsx — shared picker used by product/brand/category/collection/banner/blog forms; drives REST routes + updateMediaAction
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/media/schema.ts — media table + variant cols + url_override + media_live_idx partial index
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/media/service.ts — findById/insert/update/softDelete/list(keyset µs cursor)/count/deleteByIds(captures variant keys)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/media/queries.ts — orphanMediaWhere, listOrphans, countOrphans, listReferencedMediaIds, countMediaReferences, listOrderReferencedStorageKeys (the reference-lockstep)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/media/settings.schema.ts — media_settings singleton (SINGLETON_ID, all toggles/quality/détourage cols)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/media/settings.service.ts — singleton get(materialize)/update(clamp) + 30s in-process cache
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/media/limits.ts — DEFAULT_MAX_UPLOAD_MB=8, MAX_UPLOAD_MB_CEILING=16, BULK_MEDIA_MAX=200
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/media/validation.ts — MEDIA_UPLOAD_SCOPES, parseMediaUploadScope, checkUrlOverride
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/modules/media/url-resolver.ts — resolveMediaUrl (url_override→avif→webp→url→original) / Thumb (webp-first) / Social
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/media/upload-media.ts — uploadMediaWorkflow (purge-on-failure), deleteMediaWorkflow (soft-delete+emit), updateMediaWorkflow
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/media/import-url.ts — SSRF fetch then reuse uploadMediaWorkflow
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/media/settings.ts — updateMediaSettingsWorkflow (zod + CDN allow-list guard + invalidateCdnBase + event)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/workflows/media/reprocess-product-white-bg.ts — runProductWhiteBgReprocess, detourageProductMainImage, runScheduledProductDetourage (re-key -nobg, delete old objects)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/api/admin/media/route.ts — GET browse (keyset) + ?ids= hydrate (cap 50); media:view
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/api/admin/media/upload/route.ts — POST multipart upload; same-origin + media:create + rate-limit + 413 handling
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/api/admin/media/import-url/route.ts — POST import-by-URL; SSRF-hardened + media:create + rate-limit
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/catalog.ts — media Server Actions (upload/import/update/delete/bulkDelete/usageCount/listInUse/updateSettings), lines ~1528-1817
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/actions/data-jobs.ts — startProductWhiteBgReprocessAction / getReprocessJobStatusAction (system_media; single-flight; storefront bust)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/events/subscribers/cleanup-media-storage.ts — purges S3 objects on media.deleted/bulk_deleted, keeps order-snapshot keys
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/events/subscribers/invalidate-media-cache.ts — busts legacy storefront list tags on media.updated/settings_updated/deleted/bulk_deleted
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/rbac/registry.ts — media (CRUD) + system_media (VIEW_EDIT) in Catalogue group (lines 80-81)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/app/admin/_components/admin-shell.tsx — nav entry 'Médiathèque' → /admin/media (line 141)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/lib/api-auth/route-catalog.ts — the three admin.media REST routes (lines 210-212)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/scripts/tokyo-export-catalog.ts — freezes product image as /cdn URL string into products.json (manual re-run only)
- /home/mhoussem/Desktop/Work/Tokyo-Store-2026/src/storefront/lib/productMeta.ts — Tokyo fabricates ratings/discounts client-side (no real media alt/rating on snapshot)

**Models / tables**

- media (owned): id uuid v7 PK, kind media_kind enum(image|video|document|other default image), storage_key, url, filename, mime_type, size_bytes bigint, width, height, alt_text, uploaded_by (soft link to users.id, NO FK), webp_url/webp_size_bytes, avif_url/avif_size_bytes, original_url/original_size_bytes/original_mime_type, url_override, created_at/updated_at, deleted_at (soft delete); index media_live_idx partial (created_at desc, id desc) WHERE deleted_at IS NULL; media_filename_trgm GIN (frozen migration)
- media_settings (owned singleton, id pinned to SINGLETON_ID by CHECK): generate_webp(T), generate_avif(T), keep_original(F), product_white_bg(F), product_white_bg_main_only(F), max_width_px(2400), max_height_px(2400), webp_quality(82), avif_quality(60), jpeg_quality(85), strip_exif(T), max_upload_mb(8), default_alt_text, cdn_base_url, timestamps
- enum media_kind = image|video|document|other
- upload scopes (not a DB enum — MEDIA_UPLOAD_SCOPES literal): uploads|products|categories|brands|cms
- Joined via soft *_media_id text columns (no FK, media.id::text) EXCEPT product_media.media_id (real uuid FK = m.id): products.{video_poster,og_image}_media_id, product_variants.image_media_id, brands.{logo,hero,og_image,icon}_media_id, categories.{hero,og_image,icon,boutique_image}_media_id, collections.{image,og_image,icon}_media_id, banners.{image,image_mobile}_media_id, pages.og_image_media_id, hero_sections.image_media_id, cta_sections.background_image_media_id, blog_posts.featured_image_media_id, authors.avatar_media_id, site_settings %media_id keys
- Joined via JSON/inline (no column): rich-HTML bodies (blog_posts.body, products.description/short_desc, categories/brands/collections.editorial_body/description, text_sections.body), value_props[].iconMediaId, landing trust settings JSON, home.blocks, pages.blocks, nav_items.config
- import_jobs (shared, from import module): backs the détourage reprocess job status (queued/running/completed/failed, processed/total, result)

**Sources of truth**

- media_settings singleton (one row, SINGLETON_ID) is the pipeline config SoT — read via mediaSettingsService.get() with a 30s in-process cache; defaults live in settings.schema.ts and limits.ts (DEFAULT_MAX_UPLOAD_MB)
- The `media` DB table is the live SoT for the admin grid/picker (never the Tokyo JSON); soft-deleted rows are tombstones kept for referential safety, S3 bytes are purged immediately (not byte-recoverable)
- src/workflows/media/* is the true mutation API; src/app/api/admin/media/* and src/lib/actions/catalog.ts are thin transports that both call the same workflows
- The reference set is defined in src/modules/media/queries.ts and must stay lockstep across orphanMediaWhere / listReferencedMediaIds / countMediaReferences (+ the JSON/body match helpers)
- RBAC perms exist in src/lib/rbac/registry.ts (media, system_media); grants live in DB role_permissions/user_permission_overrides
- REST surface is catalogued in src/lib/api-auth/route-catalog.ts (admin.media, admin.media.upload, admin.media.import-url); contract enforced by the test suite (route-invariants.test.ts, media-safety.test.ts), no OpenAPI
- The build-time media host allow-list (cdn-allowlist.ts bakedMediaHostSources/Entries from S3_PUBLIC_URL + MEDIA_CDN_URL) is the SoT for valid cdn_base_url / url_override values
- scripts/tokyo-export-catalog.ts + the committed src/storefront/data/*.json are the SoT for what the LIVE Tokyo storefront shows — not the DB

**Editable / removable**

- EDIT freely: all French copy/labels in media-panel.tsx and media-settings-form.tsx; SCOPES display labels; browse-cap/orphan-cap notice text; LIBRARY_PAGE(100)/ORPHANS_CAP(200)/POLL_MS; sub-tab styling (pure Links)
- EDIT with care: media_settings defaults and clamp ranges (settings.service.ts/settings.schema.ts) — change the schema default and the limits.ts constant together (single-sourced); max_upload_mb is coupled to next.config proxyClientMaxBodySize (16mb) via MAX_UPLOAD_MB_CEILING
- LOCKSTEP — never edit one without the others: the reference-source list across orphanMediaWhere / listReferencedMediaIds / countMediaReferences + helpers (bodyRefMatch, valuePropIconMatch, landing/home/page/nav matchers) in queries.ts; and MEDIA_UPLOAD_SCOPES in validation.ts mirrored in both REST routes' inline SCOPES arrays
- LOAD-BEARING, do not casually remove: uploadMediaWorkflow purge-on-failure (only object reclamation — no bucket sweep); order-snapshot pin (listOrderReferencedStorageKeys) in cleanup-media-storage + reprocess (removing it irreversibly breaks historical order thumbnails); the µs-precision keyset cursor in service.ts; media_settings singleton CHECK + get() materialization
- REMOVABLE as a self-contained unit: import-by-URL (dropzone field + api/admin/media/import-url route + importMediaFromUrlWorkflow + SSRF fetch); the détourage feature as a set (product_white_bg[_main_only] toggles + processor/white-bg + reprocess job/action/cron + settings card)
- SAFE-ISH schema no-op: uploaded_by is written but surfaced in no admin view (schema is frozen, so don't drop the column, but no UI depends on it)
- NO byte-level replace exists in the library — adding one, or wiring a Tokyo re-export trigger, are the obvious enhancement points; the picker 'Remplacer le média' only swaps the selected id

**Gaps / risks**

- Tokyo storefront shows FROZEN product image URL strings from src/storefront/data/products.json (manual export). A media delete purges the S3 object and a détourage reprocess re-keys objects to -nobg.* and deletes the old ones → the frozen /cdn/<key> URLs 404 on Tokyo until tokyo-export-catalog.ts is re-run. Nothing in the admin warns about this or triggers the re-export.
- No byte-level 'replace' in the library; alt-text edits never reach Tokyo (products.json has no alt), url_override edits don't reach Tokyo until re-export.
- Orphan anti-join uses leading-% ILIKE over body/JSON columns (unindexable) — fine now, scans grow with content volume. Orphans view + its search are capped at 200 with no cursor.
- media_settings cached 30s in-process; on multi-worker deploys a settings change can lag the pipeline on workers that didn't do the write.
- cdn_base_url / url_override can accept a host not compiled into remotePatterns/CSP (build-time allow-list) → storefront silently falls back to /cdn; the amber warning is advisory only.
- Object storage is the only non-transactional half: upload relies on purge-on-failure compensation and there is NO bucket-wide orphan sweep — a failed delete leaks the object until removed by hand (logged).
- A user with media CRUD but not system_media cannot see the pipeline settings that process their uploads; détourage start/status require system_media:update/view (surfaced from the settings page, not the jobs console).

</details>


---

## Appendix A — Master Sources of Truth

The authoritative location of each subsection's state/config, consolidated across all 11 subsections.

### 1. Produits — core product CRUD, variants, promotions

- Mutation API = workflows: src/workflows/catalog/{create-product,duplicate-product,upsert-product-variants}.ts (run in db.transaction, emit events). Actions in src/lib/actions/catalog.ts only parse FormData + requirePermission + revalidate.
- Admin reads = src/modules/catalog/product/{service.ts listAdminPaged, queries.ts} + src/app/admin/catalog/products/[id]/page.tsx parallel loads.
- Storefront/ERP reads = src/lib/api/products.ts (mapProductRows). Legacy (shell) renders this live; the external REST/feeds use listApiProducts.
- LIVE Tokyo storefront render source = the bundled src/storefront/data/products.json (static import in src/storefront/lib/catalog.ts), regenerated ONLY by manually running scripts/tokyo-export-catalog.ts — NOT the DB at request time.
- RBAC = src/lib/rbac/registry.ts (products:view/create/update/delete/manage); grants in DB. Contract/tests = src/lib/db/tests/** (no OpenAPI).
- Schema = hand-authored src/modules/catalog/product/schema.ts; migrations frozen at 0007 snapshots — do NOT db:generate/db:push.

### 2. Produits — AI generation & auto-assign suite

- Job/draft/proposal state: the four dedicated tables product_generation_jobs/drafts, catalog_content_gen_jobs/drafts, ai_assign_jobs/proposals, ai_job_logs — detached job rows, NOT WorkflowResults and not the src/events bus state
- The TRUE mutation API for applying generated content = applyProductDrafts / applyContentDrafts (db.transaction + claimSelectedDrafts) and runAutoAssignApply (sequential, per-product, no wrapping tx)
- RBAC source of truth = requirePermission guards in the four action files + src/lib/rbac/registry.ts (grants live in DB)
- AI task catalog + default prompts = src/lib/ai/tasks.ts; admin overrides = ai_feature_prompts via getFeaturePrompt
- AI provider availability/aiEnabled = src/lib/ai/config.ts hasReadyAiProvider (coarse gate; runner re-validates per task)
- Tokyo storefront display data = bundled JSON snapshot src/storefront/data/{products,categories,taxonomy}.json, regenerated ONLY by scripts/tokyo-export-catalog.ts; its field shape is the source of truth for what generated content can ever appear on Tokyo
- Per-item progress/log = ai_job_logs read via aiJobLogService.listTail / getAiJobLogsAction
- Contract/tests: src/lib/db/tests/** (no OpenAPI); DB-only objects (CHECKs, one-active partial unique indexes, FK cascades) in hand-authored migrations 0064/0065/0106/0027/0071, not the frozen drizzle snapshot

### 3. Stock — inventory, locations, ERP, transfers, settings

- Sellable total: products.stock_qty / product_variants.stock_qty (NULL = untracked/unlimited); in_stock re-derived by nextInStockForQty
- Per-location detail: stock_levels (qty per location,product|variant) — Σ(active) == stock_qty, maintained delta-wise not recomputed
- All stock changes: append-only stock_movements ledger (8 reasons), one row per change in the same tx; never updated/deleted
- Transfers: stock_transfers + stock_transfer_items; status graph app-enforced in service.transition; stock moves ONLY on completed
- TRUE mutation API = Server Actions in lib/actions/stock-*.ts + bulkUpdateStockAction/setVariantStockDefaultAction in lib/actions/catalog.ts; order stock moves via workflows/order/*
- Settings SoT: site_settings keys resolved by pure modules locations-config.ts / erp-config.ts / low-stock.ts; variant-stock default in app_secrets
- Stock-state predicates: stockStateSql (SQL) + stock-state.ts/in-stock-rule.ts (JS twins) must agree
- REST ERP surface SoT: route-catalog.ts:138-140 (/api/stock GET/PATCH, /api/stock/movements GET), domain stock
- RBAC: rbac/registry.ts:74 single `stock` id {view,update}; grants in role_permissions / user_permission_overrides
- Storefront display SoT: bundled JSON snapshot src/storefront/data/products.json, regenerated only by manually running scripts/tokyo-export-catalog.ts

### 4. Collections (Catalogue admin)

- WRITE API = Server Actions in src/lib/actions/collection.ts → workflows in src/workflows/catalog/collection.ts (the real mutation API; runs in db.transaction, emits collection.created/updated/deleted)
- Schema SoT = src/modules/catalog/collection/schema.ts (hand-authored; trigram index + CASCADE FKs only in SQL migrations 0093/0104/0107/0108/0139 — migrations frozen, do NOT db:generate)
- Product membership SoT = product_collections join via productCollectionLinks.setForCollection (replace-semantics, collection owns the set)
- RBAC SoT = src/lib/rbac/registry.ts:77 (id 'collections', CRUD actions); grants in DB role_permissions/user_permission_overrides
- REST surface SoT = src/lib/api-auth/route-catalog.ts:123-128 (collections.list/create/upsert/update/delete)
- Storefront (shell) read SoT = src/modules/catalog/collection/queries.ts (cached, tagged CACHE_TAGS.collections)
- /collections magazine config SoT = pages.collections.* keys in site_settings, parsed by src/lib/pages/collections-landing-config.ts
- Contract/tests = src/lib/db/tests/** (route-invariants + registry tests enforce the RBAC guard on every page/action)

### 5. Catégories — taxonomy tree

- categories table schema is HAND-AUTHORED in src/modules/catalog/category/schema.ts (migrations FROZEN at 0007; do NOT db:generate/db:push)
- The TRUE mutation API is the workflow layer src/workflows/catalog/create-category.ts (runs in db.transaction, emits category.* events); server actions in src/lib/actions/catalog.ts are thin wrappers that guard RBAC + revalidate
- Admin tree read SoT = categoryQueries.getCategoryTree() via categoryService.listAllSlim() (returns inactive too, orphan/cycle-safe)
- Tokyo storefront category SoT = the bundled JSON snapshots src/storefront/data/{categories,taxonomy}.json, regenerated ONLY by manually re-running scripts/tokyo-export-catalog.ts and committing — NOT the DB at request time
- Legacy (shell) storefront category SoT = the live DB via lib/api/categories.ts (listCategories), busted by category.* cache tags
- RBAC permission existence SoT = src/lib/rbac/registry.ts (id 'categories', CRUD); grants live in DB role_permissions/user_permission_overrides
- Attribute-as-filter opt-in SoT = category_attribute_filters M2M, written only through setCategoryFiltersWorkflow
- Product→category filing SoT = product_categories M2M (is_primary drives breadcrumb/canonical/TVA chain); written by productCategoryLinks.set from the product form, not the category form

### 6. Marques (brands) — admin Catalogue subsection

- Schema (hand-authored, migrations frozen at 0007): src/modules/catalog/brand/schema.ts (brands) and src/associations/product-brand.ts (product_brands join)
- Mutation API: src/workflows/catalog/create-brand.ts (create/update/delete/reorder/setTaxRates workflows) invoked only through src/lib/actions/catalog.ts server actions
- RBAC permission registry: src/lib/rbac/registry.ts line 76 (id 'brands', CRUD, group Catalogue); grants in DB role_permissions/user_permission_overrides
- Storefront DISPLAY snapshot for Tokyo: src/storefront/data/products.json, regenerated ONLY by manually re-running scripts/tokyo-export-catalog.ts (brand carried as name string)
- Live /marques config: site_settings pages.marques.* via src/lib/pages/marques-landing-config.ts (saved by saveMarquesLandingAction in catalog.ts)
- REST/ERP contract: src/lib/api-auth/route-catalog.ts brands.* + the test suite src/lib/db/tests/** (no OpenAPI)

### 7. Drip & Exclusivité (tiered release / early access)

- Table schema: src/modules/catalog/product/tier-release.schema.ts (product_tier_release) + products.drip_start_at / early_access_enabled in src/modules/catalog/product/schema.ts
- Mutation API: workflows.catalog.updateProduct/createProduct in src/workflows/catalog/create-product.ts (runs in db.transaction, emits product.updated with changedFields incl tier_release/drip_start_at)
- Service: src/modules/catalog/product/tier-release.service.ts (setForProduct REPLACE semantics, countUsingLevel)
- Visibility rules: pure resolver src/lib/loyalty/tier-access.ts; storefront gate src/lib/loyalty/viewer-early-access.ts (filterEarlyAccessRows)
- Contract tests (no OpenAPI): src/lib/db/tests/tier-access.test.ts, early-access.test.ts, business-levels.test.ts, catalog-deletion-fanout.test.ts, public-gating.test.ts
- RBAC: permission id 'products' in src/lib/rbac/registry.ts (grants live in DB role_permissions/user_permission_overrides)
- Tokyo storefront display data: bundled snapshot src/storefront/data/products.json regenerated ONLY by scripts/tokyo-export-catalog.ts

### 8. Cartes cadeaux (gift cards)

- Mutation API: src/lib/gift-card/* orchestration (NOT src/workflows/*) — the admin gift-card actions transact directly here paired with the credit wallet; no event is emitted for admin mutations
- Order-driven issuance: src/events/subscribers/issue-gift-cards.ts (order.paid + status→delivered) → src/lib/gift-card/issue.ts
- Contract/spec: src/lib/db/tests/gift-card-*.test.ts (code, issue, redeem, lifecycle, schema-drift) — there is no OpenAPI
- Schema SoT split: Drizzle table in src/modules/gift-card/schema.ts; FKs + CHECK constraints in migration src/lib/db/migrations/0147_gift_cards.sql (schema-drift test enforces TS enums == DB CHECK literals)
- RBAC registry (permissions that EXIST): src/lib/rbac/registry.ts — gift cards reuse the 'products' id (view/manage); grants live in DB role_permissions/user_permission_overrides
- Money unit: integer millimes; *_cents columns hold millimes (src/lib/price.ts, MINOR_PER_DINAR=1000) — dinarsToMinor/minorToDinars used in the issue/redeem actions
- Setting SoT: cms.setting key 'giftcard.expiry_months' via getGiftCardConfig()/workflows.cms.upsertSettingsBatch; blank/0 = never expires
- Code secret SoT: keyed HMAC in src/lib/gift-card/code.ts with frozen domain label 'tokyo.giftcard.v1.' + PAYMENT_ENCRYPTION_KEY — only code_hash is stored, plaintext shown once

### 9. Attributs (product attributes & facets)

- Enum authority: attribute_kind pgEnum in src/modules/catalog/attribute/schema.ts:44 (select|multiselect|color|boolean|number|text); workflow validation derives from it (manage-attributes.ts:27) so it can't drift
- Value-list vs scalar authority: VALUE_LIST_ATTRIBUTE_KINDS (schema.ts:54, includes boolean) is the server truth; client _kinds.ts VALUE_LIST_KINDS (excludes boolean) is UI-only
- Mutation API: src/workflows/catalog/manage-attributes.ts (runs in db.transaction, emits events) — the ONLY correct write path; service methods alone bypass the guards
- RBAC existence: src/lib/rbac/registry.ts (attributes = CRUD); grants live in DB role_permissions/user_permission_overrides
- REST surface SoT: src/lib/api-auth/route-catalog.ts
- Contract/tests (no OpenAPI): src/lib/db/tests/attribute-validation.test.ts, attribute-guards.test.ts, attribute-filter.test.ts
- Storefront display data SoT: src/storefront/data/products.json (regenerated by scripts/tokyo-export-catalog.ts) — contains NO attribute data

### 10. Avis (Reviews) — moderation, AI generation & scheduling

- product_reviews table (status/source/verified_purchase) = the real review store; status enum gates visibility, only 'approved' feeds aggregate
- products.rating + products.reviews_count = the DENORMALIZED aggregate, sole writer is reviewService.recomputeProduct/recomputeAll; headline count/average read from here, never live AVG
- reviews.* site_settings (config-parse.ts resolveReviewConfig): enabled / policy(all|buyers_only) / require_approval / rating_source(all|customers)
- RBAC permission id 'reviews' with actions view/create/update/delete/manage (rbac/registry.ts:79); DB grants in role_permissions/user_permission_overrides
- src/workflows/catalog/review.ts = the true mutation API for customer/manual/moderation reviews (tx + events); src/lib/db/tests/** is the contract (no OpenAPI)
- review_schedule single-row config (schedule-service.get seeds defaults) = scheduler source of truth; next_run_at advanced atomically by claimDueRun
- review_generation_jobs_one_active partial-unique index = global single-flight backstop for all AI generation runs
- REST surface SoT src/lib/api-auth/route-catalog.ts:180 → reviews.list = reviews:read, read-only (no reviews:write scope offered)
- Tokyo storefront rating source of truth is NOT the DB — it is fakeRating(slug) in src/storefront/lib/productMeta.ts (fabricated)

### 11. Médiathèque (media library admin)

- media_settings singleton (one row, SINGLETON_ID) is the pipeline config SoT — read via mediaSettingsService.get() with a 30s in-process cache; defaults live in settings.schema.ts and limits.ts (DEFAULT_MAX_UPLOAD_MB)
- The `media` DB table is the live SoT for the admin grid/picker (never the Tokyo JSON); soft-deleted rows are tombstones kept for referential safety, S3 bytes are purged immediately (not byte-recoverable)
- src/workflows/media/* is the true mutation API; src/app/api/admin/media/* and src/lib/actions/catalog.ts are thin transports that both call the same workflows
- The reference set is defined in src/modules/media/queries.ts and must stay lockstep across orphanMediaWhere / listReferencedMediaIds / countMediaReferences (+ the JSON/body match helpers)
- RBAC perms exist in src/lib/rbac/registry.ts (media, system_media); grants live in DB role_permissions/user_permission_overrides
- REST surface is catalogued in src/lib/api-auth/route-catalog.ts (admin.media, admin.media.upload, admin.media.import-url); contract enforced by the test suite (route-invariants.test.ts, media-safety.test.ts), no OpenAPI
- The build-time media host allow-list (cdn-allowlist.ts bakedMediaHostSources/Entries from S3_PUBLIC_URL + MEDIA_CDN_URL) is the SoT for valid cdn_base_url / url_override values
- scripts/tokyo-export-catalog.ts + the committed src/storefront/data/*.json are the SoT for what the LIVE Tokyo storefront shows — not the DB


---

## Appendix B — Edit & Remove Notes

Consolidated safe-to-change vs. load-bearing notes — the direct answer to the edit/remove goal.

### 1. Produits — core product CRUD, variants, promotions

- SAFE: tab labels/order in TABS, TAB_GROUPS, WIZARD_STEPS (product-form.tsx:263-401) — keep FIELD_TAB (L299) in sync for error-focus.
- SAFE: removing a form field = drop its panel input + its FormData mapping in catalog.ts + its key in createProductSchema and the update `map` table (create-product.ts:576-613); leave the DB column (migrations frozen).
- SAFE: the inline promotions panel can be removed from the edit page without touching the promotions module; it is a pure consumer gated on promotions:*.
- LOAD-BEARING: millime conversion (priceFieldToMinor/dinarsToMinor) + the _cents=millimes convention — changing it corrupts every price.
- LOAD-BEARING: the `provided`-key guard in updateProductWorkflow (create-product.ts:486,623) — without it a partial save wipes content/links.
- LOAD-BEARING: stock compare-and-set + editedStockFields/variantStockFields — removing it resurrects sold units and fires false back-in-stock emails.
- LOAD-BEARING: variantsJson / faqItemsJson fold-in in updateProductAction (catalog.ts:1065-1103); id-stable replaceVariants (keeps cart/order variant refs).
- LOAD-BEARING: product.updated changedFields contract (drives cache bust, webhooks, audit, AI re-embed); emit it only on real changes.
- LOAD-BEARING: variable-can't-publish-without-variants + variable→simple demotion guards (create-product.ts:311,539,566) — prevent a dead-end PDP / price divergence.
- COUPLED: if you rename/remove name/slug/price/image/availability/condition/brand/category, update scripts/tokyo-export-catalog.ts too or the Tokyo storefront diverges.
- COUPLED: the Produits nav id `products` is reused by Drip & Exclusivité and Cartes cadeaux (admin-shell.tsx:134,137) — removing/renaming it affects their visibility.

### 2. Produits — AI generation & auto-assign suite

- Tunable without structural risk: FIELD_TOKENS (per-field output caps), AI_CONCURRENCY/PROGRESS_EVERY/DRAFT_FLUSH/LOG_CAP, poll intervals (POLL_MS 2000 / 2500), parse clamps in product-gen/parse.ts, and the default prompts in tasks.ts or per-task overrides in ai_feature_prompts (Système → IA, system_ai:update)
- Cost ceilings are editable but load-bearing: MAX_BULK_SCOPE (2000, scope.ts), MAX_SCOPE_COUNT (1000, normalize.ts), the ai:bulk rate limit (10/hour/actor) — lowering is safe, removing weakens cost control
- Removable as a unit: any single tool (A/B/C) by unmounting its control, deleting its action+runner+module, and dropping its kind from AI_JOB_KINDS — but its tables' DB objects live in frozen hand-authored migrations and must be handled manually (no db:generate/db:push)
- The one-click AiGenerateButton path (generateAiContentAction) is independent of the bulk jobs — removable/keepable separately; it only populates the form, no job rows
- ContentGenerationControl and AutoAssignControl are mounted on the sibling catalogue pages (categories/brands/collections/attributes), not on Produits — editing the Produits page affects only ProductGenerationControl and the product-form one-click buttons
- Do NOT casually remove: single-flight hasActive()+one-active unique indexes, failStaleRunning janitor, claimSelectedDrafts atomic claim (double-apply guard), the truncated-reply refusal, and the live re-validation in runAutoAssignApply — each is a correctness/cost safety
- Changing these tables' schema.ts will NOT regenerate the CHECK/index/FK objects (migrations frozen at 0007) — hand-author migrations

### 3. Stock — inventory, locations, ERP, transfers, settings

- Editable freely: French copy/labels, tab icons, filter chip set, pill colours, ERP disclaimer text, status-meta labels (keep status-meta client-safe: type-only import, it is shared with order page + print slip)
- Removable with care: locations/page.tsx redirect (only if ?tab=emplacements deep links are dropped); the ERP tab/toggles (stub, Phase-2 — removing does not affect live /api/stock + webhooks, except the pullStock-driven Inventaire banner)
- Feature-flag gated, reversible: Transferts, multi-location, carrier-link, auto-request — toggling off hides UI but keeps data
- Load-bearing, do NOT change casually: lock-ordering + dest-first leg order in stock-location/service.ts; nextInStockForQty/nextTotalForLevelWrite/stockStateSql twins; append-only stock_movements contract; the stock:update guard on every mutating action (route-invariants.test.ts)
- Do NOT run db:generate/db:push — migrations are frozen and schema is hand-authored

### 4. Collections (Catalogue admin)

- SAFE TO EDIT: admin UI (collections-panel.tsx), the 6-tab form (collection-form.tsx), and the magazine builder (collections-landing-settings.tsx + collections-landing-config.ts + saveCollectionsLandingAction) — these touch only admin + the shell /collections index, never Tokyo
- SAFE TO EDIT: storefront shell pages ((shell)/collection/[slug] and (shell)/collections) and their components — DB-live, isolated from Tokyo
- LOAD-BEARING (do not remove casually): the empty-sentinel collectionProductIds hidden input (clears membership on save); the FAQ fold-in via faqItemsJson; the single-tx field+product-set write; soft-delete + partial-unique slug/external_ref indexes
- REMOVING THE SUBSECTION requires top-down cleanup: admin NAV (admin-shell.tsx:127) → admin pages/actions → shell storefront routes → service/schema/join → RBAC registry (registry.ts:77) + route-catalog.ts + REST route → content-gen adapter, sitemap, media orphan lookup, product-card facet; then update src/lib/db/tests/**
- NO TOKYO IMPACT: deleting admin collection code does not affect the live Tokyo storefront (it has no collection dependency); conversely, editing collections can never surface on Tokyo without new routes + export work
- WATCH: collection id 'collections' is its OWN RBAC id (not reused like Drip/Cartes-cadeaux on 'products') — removing it will trip registry/route-invariants tests

### 5. Catégories — taxonomy tree

- SAFE: list/row UI and sub-tab wiring in categories-panel.tsx (self-contained client state, server actions revalidate).
- SAFE: form tabs/fields, labels, SEO/editorial/value-prop copy, AI buttons in category-form.tsx — affects admin + (shell) only.
- SAFE: the 'Page Boutique', 'Génération IA', 'Auto-catégoriser' sub-tabs can be removed independently (each is gated + rendered conditionally in page.tsx L103-123, 334-348) — they are adjacent features, not the taxonomy itself.
- LOAD-BEARING: getCategoryTree orphan+cycle handling (queries.ts:100-132) — all parent pickers + the tree depend on no live node dropping out.
- LOAD-BEARING: parent-cycle guard (create-category.ts:222-254) + edit-page self-subtree exclusion ([id]/page.tsx:55-68).
- LOAD-BEARING: deleteCategoryWorkflow single transaction (child promotion + product-link move + filter cleanup, create-category.ts:469-476).
- LOAD-BEARING: the `provided`-set gate in updateCategoryWorkflow (create-category.ts:192,259-266) guards against sparse-patch re-activation.
- LOAD-BEARING: the '' filter sentinel + hidden inputs (category-form.tsx:567-572) — needed to wipe the attribute M2M to empty.
- CANNOT be made to show on Tokyo by editing admin alone: any category change requires re-running scripts/tokyo-export-catalog.ts and committing src/storefront/data/{categories,taxonomy}.json.
- DESTRUCTIVE / do not run casually: scripts/tokyo-build-categories.ts wipes all categories/brands/products (seed only).

### 6. Marques (brands) — admin Catalogue subsection

- SAFE: all brand-form fields, Page-Marques builder, AI generation, reorder — write the DB and show on /marques immediately via the brands cache-tag bust
- SAFE to re-theme/relocate: the /marques index renders in the legacy (shell) design; moving it to Tokyo is purely additive (no DB dependency)
- LOAD-BEARING: product_brands 1:1 link + productBrandLink.* (product editor, tax cascade brand tier, brand-scoped promotions/coupons, storefront product.brand, sitemap counts) — brand form does NOT write it; product workflows do
- LOAD-BEARING: checkSlugAvailability (brand slugs share the flat /[slug] namespace with products/categories/CMS); CACHE_TAGS.brands bust + listActiveBrands 'use cache'/build-phase guard
- DELETE is soft and BLOCKED while live promotions target the brand (deleteBrandWorkflow); hard delete only via brandService.deleteAll (segmented clean, cascades product_brands)
- tax_rate_bps is supported by schema/workflow but NOT in the brand form — edited only on /admin/system/tax «Marques» (setBrandTaxRatesWorkflow); keep that path if touching tax
- To make brand landing pages live on Tokyo you must ADD a brand branch to (tokyo)/[slug] resolveSlug + a storefront brand resolver/view — none exist today

### 7. Drip & Exclusivité (tiered release / early access)

- Safe to edit: all admin UI copy/labels/formatting — page.tsx countdown() + label strings, drip-panel.tsx, drip-tabs.tsx, early-access-tiers-panel.tsx, and the DripExclusivityPicker UI in product-form.tsx (display-only)
- Tab 1 'Par niveau' (early-access-tiers-panel.tsx) is pure read-only display with no editor — removable with no functional loss; editing stays in Fidélité → Niveaux
- The dashboard 'Rendre public' button and sort/countdown logic can be reworked freely (presentation only)
- Load-bearing — do NOT remove without care: tier-release.service.setForProduct REPLACE + per-level advisory locks; the includeDisabled ladder ranking (page.tsx:94, viewer-tier-access.ts:55); the level-delete guards (loyalty-program.ts, business.ts, segments.ts) that stop soft-link orphaning; the re-publish anchor freeze (create-product.ts:690-704); every filterEarlyAccessRows call site
- To remove the feature: drop nav entry (admin-shell.tsx:134), the /admin/catalog/drip route, the product-form drip tab + parseTierSchedule, workflow schedule/anchor handling, and the delete guards — but FIRST clear all product_tier_release rows so the DB-live cart/order gate can't block checkout after the UI is gone
- product_tier_release.level_id has no FK (soft link) — any new level-delete path must call countUsingLevel or it orphans steps and exposes exclusives

### 8. Cartes cadeaux (gift cards)

- EDITABLE freely: all of gift-cards-panel.tsx presentation (stat tiles, status pill labels/colors in STATUS_META, row layout, empty-state copy) and page.tsx header copy — no behavioural coupling
- EDITABLE: the single Réglages field (expiry months) and its copy; the setting is additive and defaults to 'never' so changes are backward-safe
- LOAD-BEARING, do not weaken: conditional-update discipline in service.ts (claimForRedemption/voidCard/voidActiveForOrder are WHERE status='active' updates — never read-then-write) and the throw-not-return pattern in redeem.ts/reissue.ts/issue.ts (a return inside the tx commits)
- LOAD-BEARING: the gift-card discount-base exclusion spread across place-order.ts (giftCardSubtotalCents/discountBaseCents/discountableSub), discountable-subtotal.ts, scoped-coupon.ts, coupon-eligibility.ts, and is_discountable=false/0% TVA forced in create-product.ts — removing any one risks a money printer (buy below face, redeem at face)
- FROZEN: code.ts domain label 'tokyo.giftcard.v1.' and the PAYMENT_ENCRYPTION_KEY — changing either orphans every issued card; the GIFT_CARD_STATUSES/GIFT_CARD_ORIGINS TS enums must match the 0147 CHECKs (schema-drift test); migrations are frozen (no db:generate/db:push)
- REMOVABLE with care: the admin register page + nav entry (admin-shell.tsx:137) can be hidden (read-only + manual issue) WITHOUT touching issuance/redeem/undo logic in lib/gift-card/* and the subscriber, which run independently and must stay while any card exists
- ORPHANED / candidate for cleanup OR rewire: src/app/(shop)/(shell)/account/account-client.tsx GiftCardRedeemCard + GIFT_CARD_REDEEM_ENABLED flag — not mounted by any live page; redeemGiftCardAction is wired but unreachable from the live Tokyo storefront
- REMOVING products.is_gift_card column/flag would break issuance (issue.ts reads it), the discount/loyalty exclusions, and the per-order mint — not a safe standalone removal

### 9. Attributs (product attributes & facets)

- DELETE-SAFE (no storefront impact): the entire Attributs admin sub-page + module can be removed without changing any (tokyo) page, because nothing customer-facing reads attributes — BUT it is load-bearing for the backend (product variant axes via product_variant_values, TVA rules via tax_rules.attribute_value_id, product editor Attributs tab, bulk-tagging, category Filtres tab, AI auto-assign). Removing it breaks those.
- DEAD CODE, independently deletable: src/components/product-tabs.tsx (zero importers) and src/lib/catalog/attribute-filter.ts + its test (referenced only by tests). Verify getProductSpecs/listScalarsForProducts have no other caller first.
- WASTED-WORK cleanup: getProductsAttributeFilters (categories.ts:158) is still invoked by /recherche and /collection/[slug] but its result is discarded by the CategoryPageClient shim — either delete the computation from those callers or re-wire CategoryView to consume facets.
- LOAD-BEARING, do not weaken: the kind-change guards (manage-attributes.ts:224-268) and delete guards (value/attribute, :312, :455) — they are the only protection against cascading loss of variant combos and TVA overrides.
- LOAD-BEARING: deleteAttributeWorkflow must keep clearing category_attribute_filters links before soft delete (:348) or category filter saves brick.
- RBAC caution: the REST attribute endpoints depend on categories and products permissions (not attributes) for facet sync — trimming those grants silently breaks ERP facet/scalar sync.
- The Auto-attribuer tab on this page is a system_ai surface, not attributes — gate/remove it via system_ai, not the attributes id.

### 10. Avis (Reviews) — moderation, AI generation & scheduling

- Safe to retune in isolation: moderation PAGE_SIZE/MAX_QUERY (page.tsx:28-31), facet-badge math, filter chip sets, product-search behavior
- Safe to retune: AI prompt text, Tunisian name pools (generate.ts:24-30), RATING_WEIGHTS skews (:40-44), LANG_POOL mix (:59-66), per-review token budget
- Safe to retune: schedule defaults (schedule-service.ts:14-20), cadence/max clamps (review-generation.ts:303-304), ai:bulk rate limit, tick interval env REVIEW_SCHEDULER_TICK_MS
- Removable as a unit (AI generation + scheduling): Génération tab, review-generation-control.tsx, review-schedule-card.tsx, lib/actions/review-generation.ts, workflows/catalog/review-gen/*, generation-service/schedule-service, instrumentation start/drain (:83-84,:117-118), review_generation_*/review_schedule tables — core moderation is independent
- Load-bearing, do NOT break: recomputeProduct/recomputeAll (only writer of products.rating/reviews_count); call it after every approve/reject/delete/apply-approved
- Load-bearing: partial-unique (user_id,product_id) WHERE user_id IS NOT NULL + resubmitRejected rejected-only guard (dedupe + rejected resubmit correctness)
- Load-bearing: review_generation_jobs_one_active index + claimSelectedDrafts atomic claim (concurrent-run / double-apply guards)
- Load-bearing: deleteReviewsBySourceWorkflow must keep refusing source='customer'; scope.ts must keep restricting AI reviews to live+published products
- Product decision, not a safe silent edit: wiring real reviews onto Tokyo PDP (replace fakeRating in (tokyo)/[slug]/page.tsx + product-view.tsx, revive ProductReviews/product-tabs or use getApiProductReviews)

### 11. Médiathèque (media library admin)

- EDIT freely: all French copy/labels in media-panel.tsx and media-settings-form.tsx; SCOPES display labels; browse-cap/orphan-cap notice text; LIBRARY_PAGE(100)/ORPHANS_CAP(200)/POLL_MS; sub-tab styling (pure Links)
- EDIT with care: media_settings defaults and clamp ranges (settings.service.ts/settings.schema.ts) — change the schema default and the limits.ts constant together (single-sourced); max_upload_mb is coupled to next.config proxyClientMaxBodySize (16mb) via MAX_UPLOAD_MB_CEILING
- LOCKSTEP — never edit one without the others: the reference-source list across orphanMediaWhere / listReferencedMediaIds / countMediaReferences + helpers (bodyRefMatch, valuePropIconMatch, landing/home/page/nav matchers) in queries.ts; and MEDIA_UPLOAD_SCOPES in validation.ts mirrored in both REST routes' inline SCOPES arrays
- LOAD-BEARING, do not casually remove: uploadMediaWorkflow purge-on-failure (only object reclamation — no bucket sweep); order-snapshot pin (listOrderReferencedStorageKeys) in cleanup-media-storage + reprocess (removing it irreversibly breaks historical order thumbnails); the µs-precision keyset cursor in service.ts; media_settings singleton CHECK + get() materialization
- REMOVABLE as a self-contained unit: import-by-URL (dropzone field + api/admin/media/import-url route + importMediaFromUrlWorkflow + SSRF fetch); the détourage feature as a set (product_white_bg[_main_only] toggles + processor/white-bg + reprocess job/action/cron + settings card)
- SAFE-ISH schema no-op: uploaded_by is written but surfaced in no admin view (schema is frozen, so don't drop the column, but no UI depends on it)
- NO byte-level replace exists in the library — adding one, or wiring a Tokyo re-export trigger, are the obvious enhancement points; the picker 'Remplacer le média' only swaps the selected id


---

## Appendix C — Risk Register & Known Gaps

Every pitfall, mock, stale integration and coupling surfaced during the sweep. The cross-cutting ones are in §D.

### 1. Produits — core product CRUD, variants, promotions

- Export staleness: admin product edits do NOT appear on the live Tokyo storefront until scripts/tokyo-export-catalog.ts is manually re-run and products.json committed — no automation/subscriber triggers it.
- Tokyo storefront fabricates data: ratings (fakeRating), strike/compare-at prices (fakeStrike), warranty, specs and FAQ are invented from a slug hash in productMeta.ts — real rating/reviews_count and old_price_cents never reach the Tokyo PDP.
- Export is lossy: products.json carries only name/slug/first-image/display-price/availability/condition/brand/category; description, variants, SEO, video, old price, reviews are dropped.
- Admin list Stock column passes stockQty only for simple products (page.tsx:189); variable products show a flag-only pill.
- No un-delete UI: soft-deleted ('Supprimé') products are terminal in the panel; recovery is DB-only.
- Duplicate resets stock to 0 and clears SKU/GTIN/canonical — operator must re-enter before publishing.
- Best-effort fold-in: the product row can save ok while the folded-in variants/FAQ fail (action still returns ok:true with a caveat), so a variant/FAQ edit can be silently lost until retried.
- Variable product published with zero variants is a dead end (buy button but checkout refuses) — guarded in the workflow, but any new mutation path must preserve that guard.

### 2. Produits — AI generation & auto-assign suite

- TOKYO INVISIBILITY: generated product descriptions/FAQ/SEO and all entity content never reach the Tokyo snapshot even after re-export (RawProduct/categories/taxonomy shapes in tokyo-export-catalog.ts omit those columns). Only auto-assign categorize + brands reach Tokyo after a manual re-export; auto-assign attributes does not. Operators can spend AI tokens for zero Tokyo effect.
- Dry-run cost without apply rights: a system_ai:manage holder lacking products:update can fire a whole-catalogue auto-assign dry-run (one paid AI call per product) but is blocked at apply (ai-assign.ts:162-169) — paid cost, no payoff.
- No AI master kill-switch: aiEnabled/hasReadyAiProvider is only a coarse UX gate; disabling AI means disabling providers or per-task enabled flags. Runner re-validates per task.
- Rate limit degrades OPEN on limiter-store error (catch→{ok:true}) in all bulk start actions, removing the only per-actor fan-out cap; only MAX_BULK_SCOPE + single-flight remain.
- Auto-assign uses NO embeddings/pgvector — it feeds every active category/brand/attribute as a text candidate block into the prompt (unbounded; no size cap unlike one-click MAX_CONTEXT_CHARS). Large taxonomies bloat prompt/context and cost. (Semantic/pgvector lives separately in src/modules/search/*.)
- FAQ apply is post-commit and non-transactional: a FAQ failure leaves text applied but FAQ missing, surfaced only as amber apply_error + a faqFailed count — easy to miss at scale.
- runAutoAssignApply has no wrapping transaction (sequential per-product); a mid-run crash leaves a partially-applied job, and hasApplyForSource then blocks a clean retry of the remainder.
- Detached runners orphan a running/queued job on server restart until failStaleRunning(15) runs on the next start; entity/auto-assign pages rely on the next action to invoke the janitor.
- Migrations frozen at 0007: CHECKs, one-active partial unique indexes and FK cascades (migrations 0064/0065/0106/0027/0071) are not in the drizzle snapshot — editing schema.ts won't regenerate them; table removal needs manual migration work.

### 3. Stock — inventory, locations, ERP, transfers, settings

- Tokyo storefront availability is FROZEN at export time — admin stock edits are invisible on (tokyo) until scripts/tokyo-export-catalog.ts is manually re-run and the JSON committed; no admin trigger, no freshness indicator
- Storefront JSON carries only an in_stock/out_of_stock enum (no quantity, no per-location, no low-stock); real quantity never reaches (tokyo)
- productMeta.ts handles a `backorder` availability the export never emits (tokyo-export-catalog.ts:34,100) — dead path unless JSON is hand-edited
- ERP tab push/transfer/warranty toggles persist posture but enforcement is Phase-2 (stub); only /api/stock + stock.*/stock.transfer.*/warranty.claim.* webhooks are live, and only pullStock has a live UI effect (Inventaire banner)
- Auto-transfer can under-request when multiple orders land before either ships (same depot level read) — deliberate, documented in auto-transfer.ts
- 'Écart' drift between stock_qty and Σ(levels) is expected (sales move only the total); a level save then swings the total by the full difference if cells aren't re-aligned first
- deleteLocationAction evacuates one tx per line — a mid-way failure leaves committed lines + undeleted location (EvacuatePartialError) to reconcile manually
- No admin UI to read the stock_movements ledger (ERP API only)
- Manual admin stock edits do NOT emit low-stock/depleted alerts (only sales/order-edits/API crossings do) — by design, but can surprise operators
- Migrations frozen at 0007; schema comments cite later migration numbers (0120/0128/0129/0134) for indexes/sequence — informational only, do not regenerate

### 4. Collections (Catalogue admin)

- Collections are INVISIBLE on the live Tokyo storefront — not exported by tokyo-export-catalog.ts and no Tokyo route/nav references them; admin edits only ever show on the legacy (shell) /collection and /collections pages. Operators likely expect otherwise.
- Stale comment: [id]/page.tsx:34 says the product hydrate runs under 'collections:view' but the page gates on collections:update (:26).
- Loose UUID regex /^[0-9a-f-]{36}$/i in setCollectionActiveAction (actions/collection.ts:167) and optionalUuid/pickAllUuid (:371-380) accepts non-UUID shapes; the workflow Zod .uuid() is the real guard.
- FAQ persistence inside updateCollectionAction is best-effort — a failure still returns ok:true (with a warning message), so ok-only automation can miss dropped FAQs (actions/collection.ts:124-147).
- Product soft-delete leaves product_collections rows intact (FK cascades only on hard delete); admin count filters deleted products but the raw links persist.
- Legacy 'montres' copy lingers in the high-tech rebrand (e.g. collection-form.tsx:391 editorialTitle helper example).
- Per-collection display_order (form field) and bulk Réorganiser write the same column; reorderSiblings serializes via SELECT FOR UPDATE, but a form save can still clobber a just-reordered value.

### 5. Catégories — taxonomy tree

- Snapshot drift: no automation/CI/webhook ties a category write to a Tokyo re-export — admin and the live store can disagree indefinitely until scripts/tokyo-export-catalog.ts is re-run and committed.
- is_active is NOT in the Tokyo export, so a category deactivated/deleted in admin still appears (and may 404-link) on Tokyo until re-export; (shell) hides it live.
- Dual counts/visibility: (shell) uses live rollup counts + is_active chain; Tokyo uses frozen pruned taxonomy.json counts — the two can show different nav.
- Category attribute filters, FAQ, editorial block, hero/OG/boutique images, warranty/TVA, is_discountable have ZERO Tokyo surface — operators editing those tabs see no live effect (Tokyo fabricates ratings via fakeRating and has no attribute-filter UI).
- Media/icon references are soft (text uuids, no FK) — deleting a media row dangles hero_media_id/icon_media_id with no referential guarantee.
- Site-wide and sibling slug uniqueness are enforced only in the workflow (not the DB beyond the root-slug partial index); bypassing the workflow (raw insert / ERP path) could create shadowing slugs.
- scripts/tokyo-build-categories.ts is destructive (wipes categories/brands/products) and easily confused with the incremental export script.
- Reorder/toggle are inline optimistic actions relying on router.refresh(); a stale-id reorder is defended in reorderSiblings but the UI only re-sorts after refresh.

### 6. Marques (brands) — admin Catalogue subsection

- Dead brand landing pages on live Tokyo: (tokyo)/[slug] resolver has no brand branch, so /marques links and the admin 'Voir sur la boutique' link (/{slug}) 404 unless the slug matches a category/product/alias; all brand editorial/SEO/logo/hero/FAQ/value-props are unreachable on the live store
- Export staleness: only brand NAME reaches Tokyo product cards, and only after a manual tokyo-export-catalog re-run; display_order/featured/logo/icon/Page-Marques never reach Tokyo; a rename leaves products.json stale until re-export
- Design inconsistency: /marques renders in the legacy (shell) shell, not the Tokyo design
- setBrandActiveAction uses a loose /^[0-9a-f-]{36}$/i uuid check (catalog.ts:176) instead of isUuid
- Two display_order writers (form absolute field vs Réorganiser renumber) can silently overwrite each other
- Panel subtitle says 'le filtre catalogue' but the Tokyo storefront has no brand facet (brand filtering is legacy-shell only)

### 7. Drip & Exclusivité (tiered release / early access)

- CRITICAL: Drip/early-access does NOT function on the live Tokyo storefront — (tokyo)+src/storefront/** read the static JSON snapshot (staticSource default; http is a notImplemented stub), the snapshot has no tier/drip fields, and tokyo-export-catalog.ts builds it with listApiProducts({public:false}) = no embargo ('full catalogue, no viewer embargo', script:76). Exclusives/drip leak to everyone on Tokyo.
- Visible-but-not-buyable inconsistency: cart/order workflows (add-to-cart.ts:38, place-order.ts:464, place-quick-order.ts:160) still enforce the embargo against the live DB, so a Tokyo shopper who sees an embargoed product (from JSON) is blocked at add-to-cart/checkout.
- The global per-tier early-access delay (Tab 1's whole premise) is equally dead on Tokyo for the same snapshot reason.
- Soft-link fragility: level_id has no FK; correctness depends entirely on the delete guards (loyalty-program.ts:221, business.ts:771, segments.ts:1233/1258) + includeDisabled ranking + advisory locks. Any new/direct level delete orphans steps and silently flips exclusives public.
- Admin dashboard loads ALL scheduled products with no pagination (page.tsx:121-125) — unbounded at scale.
- Config is spread across 3 places: schedule (product form), per-tier delay (Fidélité→Niveaux), master switch loyaltyCfg.earlyAccessEnabled (Fidélité→Réglages). early_access_enabled=false silently nullifies a product's whole schedule (viewer-early-access.ts:144); the picker only warns.
- httpSource is a stub whose sketch mapping omits tier fields — flipping NEXT_PUBLIC_DATA_SOURCE=http would NOT restore drip without new work including a per-viewer gating call.

### 8. Cartes cadeaux (gift cards)

- Money-printer guard is distributed across 5+ files and relies on the is_gift_card subtraction for order-level member % and cart coupons (is_discountable=false only blocks product-scope promos) — a refactor dropping isGiftCard from any discount base regresses it silently
- Admin register has no pagination (newest 100, hard cap 500) and no reference/last4 search in the UI although the service supports findByReference — older cards become invisible
- No balance / partial redemption model: redemption is all-or-nothing into store credit; there is no remaining-balance column, so the register's amount is only the frozen denomination
- Expiry is never swept — an expired card stays status='active' in the DB (enforced only in the redemption WHERE + client display), so any future query keyed on status='active' alone over-counts expired/outstanding liability
- issue-standalone.ts inserts with 'as never' (schema.ts type bypass) — a future column change won't be type-checked on the standalone-mint path
- Storefront dead ends: redeem UI is fully built but unmounted on live Tokyo ((shell)/account/account-client.tsx is orphaned; (tokyo) AccountView has no redeem/credit UI), and the delivery email's redeem_url points to /account which on Tokyo has no redeem form — a delivered code has no self-service landing today
- Can a customer buy/redeem an own-brand gift card on Tokyo today? NO redeem; buying only mints if a product is flagged is_gift_card=true and sold through the Tokyo cart — no such product exists in seeds/feed, and the storefront 'Gift Cards' shelf is unrelated third-party recharges
- Lost code is unrecoverable by design; the only amber 'email failed' warning depends on the operator noticing the inline notice — a missed warning strands the customer with an unredeemable paid card

### 9. Attributs (product attributes & facets)

- Stale brief: migrations are NOT frozen at 0007 — repo has migrations through 0201; scalar columns + color/boolean/number/text kinds came in 0021, AI kind in 0022. The '0007' in schema comments is only the slug partial-unique index.
- Half-wired storefront: /recherche and /collection/[slug] compute live attribute facets (getProductsAttributeFilters, extra DB load per request) that CategoryPageClient then silently discards — confusing dead integration.
- Misleading comments: attribute-filter.ts claims it is 'shared verbatim by the client grid' and getProductSpecs/queries.ts describe a PDP integration — neither exists anymore (both consumers orphaned).
- No admin list pagination/search: the list loads every attribute + all values at once.
- Three-way REST permission split (attributes/categories/products) makes RBAC edits error-prone for facet sync.
- Hard vs soft delete asymmetry (attributes soft, values hard) plus the guard-only protection means any direct attributeService call outside the workflow risks cascading loss of variant combos and TVA overrides.
- Attributes carry real, invisible backend weight (variants + TVA). A removal that looks safe from the storefront can break tax calculation and variant rendering.

### 10. Avis (Reviews) — moderation, AI generation & scheduling

- Tokyo storefront fabricates ratings via fakeRating(slug) and does NOT read product_reviews — all admin Avis moderation/generation is INVISIBLE to live shoppers; the PDP JSON-LD AggregateRating uses the fake value (Google/FTC risk)
- Legacy real-review UI (product-reviews.tsx via product-tabs.tsx) is orphaned (zero importers) → customers currently have no way to submit a review on Tokyo, yet submitReviewAction + buyers-only policy + rate limits are maintained
- AI/manual 'seed' reviews are invented content with fake authors + backdated dates; under rating_source='all' approved fakes inflate the stored public rating; scheduler auto-applies without human review (defaults to pending as sole mitigation)
- rating_source='customers only' setting is cosmetic on Tokyo (it governs a stored aggregate the live storefront never reads)
- Scheduler/background applies cannot revalidate Next cache tags from a detached context (best-effort) — approved scheduled batches heal only within cacheLife on headless/legacy surfaces
- startReviewScheduler is module-local (NOT HMR-safe) — a dev HMR re-eval could start a second interval (duplicate generations still blocked by hasActive())
- No loyalty/credit grant-on-review exists: catalog.review.created has only cache-invalidation + webhook-doc subscribers; the hypothesized credit path is absent
- Doc/code mismatch: 'migrations frozen at 0007' but review features live in 0023/0024/0063/0136; schema hand-authored is the SoT (no db:generate/db:push proposed)

### 11. Médiathèque (media library admin)

- Tokyo storefront shows FROZEN product image URL strings from src/storefront/data/products.json (manual export). A media delete purges the S3 object and a détourage reprocess re-keys objects to -nobg.* and deletes the old ones → the frozen /cdn/<key> URLs 404 on Tokyo until tokyo-export-catalog.ts is re-run. Nothing in the admin warns about this or triggers the re-export.
- No byte-level 'replace' in the library; alt-text edits never reach Tokyo (products.json has no alt), url_override edits don't reach Tokyo until re-export.
- Orphan anti-join uses leading-% ILIKE over body/JSON columns (unindexable) — fine now, scans grow with content volume. Orphans view + its search are capped at 200 with no cursor.
- media_settings cached 30s in-process; on multi-worker deploys a settings change can lag the pipeline on workers that didn't do the write.
- cdn_base_url / url_override can accept a host not compiled into remotePatterns/CSP (build-time allow-list) → storefront silently falls back to /cdn; the amber warning is advisory only.
- Object storage is the only non-transactional half: upload relies on purge-on-failure compensation and there is NO bucket-wide orphan sweep — a failed delete leaks the object until removed by hand (logged).
- A user with media CRUD but not system_media cannot see the pipeline settings that process their uploads; détourage start/status require system_media:update/view (surfaced from the settings page, not the jobs console).


---

*Generated 2026-10-08 from an 11-agent code-verified sweep of the admin Catalogue group. Companion to the platform-wide [az-analysis-2026-10-08.md](az-analysis-2026-10-08.md). Code is the source of truth.*
