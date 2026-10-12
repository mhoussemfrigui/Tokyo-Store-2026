import "server-only";

import { z } from "zod";

import { productService } from "@/modules/catalog/product/service";
import { PRODUCT_RELATED_MODES, PRODUCT_CONDITIONS } from "@/modules/catalog/product/schema";
import { attributeService } from "@/modules/catalog/attribute/service";
import { careService } from "@/modules/catalog/care/service";
import { validateAttributeRefs } from "@/lib/api/attribute-validation";
import {
  productBrandLink,
  productCategoryLinks,
  productMediaLink,
  productRelatedLinks,
  productComplementaryLinks,
} from "@/associations/catalog.service";
import { bus } from "@/events/bus";
import { db } from "@/lib/db/client";
import { isAvailable, nextInStockForQty } from "@/lib/inventory/in-stock-rule";
import { stockMovementService } from "@/modules/stock-movement";
import { checkSlugAvailability } from "@/lib/utils/slug-conflict";
import { syncEntityUrlRedirects } from "@/lib/redirects/auto-slug-redirect";
import { slugSchema, slugify } from "../helpers";
import { fail, flattenZodError, ok, workflow } from "../shared";

/**
 * A nullable, UNIQUE product identifier (sku / gtin / external_ref). Trims, then
 * normalizes an empty/whitespace value to NULL — so "no identifier" is stored as
 * NULL and never as "", which would otherwise be a real value that collides on
 * the partial unique index (the storefront admin form already maps empty→null;
 * this makes the JSON API path do the same so an ERP syncing ref-less products
 * doesn't get spurious 409s).
 */
const uniqueRefField = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

/**
 * Product-level GTIN format — the SAME rule the variant editor enforces
 * (upsert-product-variants): 8–14 digits (GTIN-8/12/13/14, leading zeros kept),
 * so a typo ("EAN-1234", "N/A") never reaches the Product JSON-LD `gtin` or the
 * Merchant feeds. Checked in the workflows rather than on the schema field so a
 * LEGACY non-conforming value stays saveable: an update only validates a gtin
 * that is new or changed (the editor re-sends every key on each save).
 */
const GTIN_RE = /^\d{8,14}$/;
const GTIN_MSG = "GTIN : 8 à 14 chiffres.";

/**
 * A `variable` product is sold THROUGH its variants. Published with none, the PDP
 * shows a plain buy button (no picker to render) while every checkout refuses the
 * line ("Choisissez une option…") — a dead end for the shopper. Drafts are fine:
 * the variant editor keeps the type in lock-step once variants are saved.
 */
const VARIABLE_CREATE_PUBLISH_MSG =
  "Un produit « Variable » ne peut pas être publié sans variantes : enregistrez-le en brouillon, ajoutez ses variantes (onglet Variantes), puis publiez-le.";
const VARIABLE_UPDATE_PUBLISH_MSG =
  "Ce produit « Variable » n'a aucune variante : ajoutez-en dans l'onglet Variantes avant de le publier, ou repassez-le en « Simple ».";

/** Order-insensitive equality of two id lists (duplicates collapse). */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/** Ordered equality — display-ordered lists (gallery, related, complementary). */
function sameIdList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The curated-list normalisation `productRelatedLinks.set` /
 *  `productComplementaryLinks.set` apply (de-dupe, drop self, keep order). */
function curatedIds(productId: string, ids: readonly string[]): string[] {
  const seen = new Set<string>([productId]);
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Canonical form of one attribute scalar — mirrors `attributeService.setScalar`'s
 *  coercion (non-finite/blank numeric → null, trimmed text, blank → null). */
function scalarKey(
  numeric: number | string | null | undefined,
  text: string | null | undefined,
): string {
  const n =
    numeric === null || numeric === undefined || numeric === "" || !Number.isFinite(Number(numeric))
      ? null
      : Number(numeric);
  const t = text != null && text.trim() !== "" ? text.trim() : null;
  return JSON.stringify([n, t]);
}

export const createProductSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: slugSchema.optional(),
  platform: z.string().trim().max(60).nullable().optional(),
  sku: uniqueRefField(60),
  // Identifiers. `gtin` is the umbrella for UPC/EAN/ISBN — kept as text (max
  // 14 = GTIN-14) to preserve leading zeros; `mpn` is the manufacturer code.
  gtin: uniqueRefField(14),
  mpn: z.string().trim().max(70).nullable().optional(),
  // Item condition (état). Defaults to brand-new.
  condition: z.enum(PRODUCT_CONDITIONS).default("new"),
  // External reference — a stable, opaque code from an EXTERNAL system (ERP /
  // PIM / marketplace) used to link & sync this product by reference. Unique
  // among live products (like sku/gtin); distinct from sku so the ERP key can
  // diverge from the merchandising SKU. Empty → null; `undefined` leaves it.
  externalRef: uniqueRefField(120),
  // Warranty override (global → category → product cascade, see @/lib/warranty).
  // `null` = inherit (fall back to the category/global default); a number pins
  // this product's own coverage. `0` is an explicit "no warranty" that still
  // overrides the inherited value — distinct from `null` ("inherit").
  warrantyMonths: z.number().int().min(0).max(600).nullable().optional(),
  warrantyLabel: z.string().trim().max(120).nullable().optional(),
  // Per-product TVA override in BASIS POINTS (1900 = 19 %), the most-specific
  // level of the product → rule → brand → category → global cascade (see @/lib/tax).
  // `null` = inherit (fall back to the matched rule / category / global); a
  // number pins this product's own rate. Capped at 10000 bps (100 %). The
  // admin enters a percent; the action converts to bps before this point.
  taxRateBps: z.number().int().min(0).max(10000).nullable().optional(),
  // Product shape + fulfillment. `variable` products carry variants (see
  // upsert-product-variants).
  productType: z.enum(["simple", "variable"]).default("simple"),
  // Variant stock mode (variable products): null = inherit global default,
  // true = variants share the parent stock_qty pool, false = per-variant stock.
  sharedVariantStock: z.boolean().nullable().optional(),
  shortDesc: z.string().trim().max(500).default(""),
  description: z.string().trim().max(20000).default(""),
  // "Caractéristiques clés" — operator-curated PDP key-feature bullets, ordered and
  // VARIABLE count. Free-text; the action strips blanks before this point. Empty []
  // = none (the PDP falls back to attribute specs, then a derived default).
  highlights: z.array(z.string().trim().min(1).max(160)).max(12).default([]),
  priceCents: z.number().int().nonnegative(),
  // `null` clears the compare-at / old price (admin blanked the field on edit);
  // `undefined` leaves it unchanged. A positive value sets the strike-through.
  oldPriceCents: z.number().int().positive().nullable().optional(),
  inStock: z.boolean().default(true),
  // `null` = untracked ("ne pas suivre les quantités" — always sellable while
  // in_stock); on update it CLEARS a tracked quantity. `undefined` leaves it.
  stockQty: z.number().int().min(0).nullable().optional(),
  // Per-product purchase-quantity limits (per order line). null clears, undefined
  // leaves unchanged. max=1 = "sold individually". DB CHECK enforces max >= min.
  minPurchaseQty: z.number().int().min(1).nullable().optional(),
  maxPurchaseQty: z.number().int().min(1).nullable().optional(),
  // Video block. `null` clears the field (the admin removed it); `undefined`
  // leaves it unchanged on update. The action layer maps an empty form
  // value to `null` so removing a video / poster / heading actually sticks.
  videoUrl: z.string().url().nullable().optional(),
  videoPosterMediaId: z.string().uuid().nullable().optional(),
  videoTitle: z.string().trim().max(120).nullable().optional(),
  videoDescription: z.string().trim().max(400).nullable().optional(),

  // SEO / Référencement block. Same null/undefined contract as the video
  // block: `null` clears (admin emptied the field), `undefined` leaves it
  // unchanged on update. The action layer maps empty form inputs to `null`.
  metaTitle: z.string().trim().max(160).nullable().optional(),
  metaDescription: z.string().trim().max(320).nullable().optional(),
  canonicalUrl: z.string().trim().max(500).nullable().optional(),
  noindex: z.boolean().default(false),
  ogImageMediaId: z.string().uuid().nullable().optional(),
  // Official external URLs (schema.org Product.sameAs), free text (one per
  // line). Stored as-is; parsed/validated to a clean URL list at render time
  // by lib/seo/same-as.ts. Capped to keep a pasted blob from bloating the row.
  sameAs: z.string().trim().max(2000).nullable().optional(),

  displayOrder: z.number().int().min(0).optional(),
  publish: z.boolean().default(false),
  /**
   * Global opt-out from product-targeted reductions: when false, auto-promos
   * and product/category/brand promotion scopes never lower this product's
   * price (enforced by the promotion module's discountable guard — see
   * promotion/queries.ts). Order-level reductions (cart-scope coupons, coin
   * redemption) are unaffected. Defaults true.
   */
  isDiscountable: z.boolean().default(true),

  categoryIds: z.array(z.string().uuid()).default([]),
  primaryCategoryId: z.string().uuid().optional(),
  /**
   * Brand link. A uuid sets it; `null` REMOVES it (the editor's « Retirer la
   * marque », or an API `brandId: null`); `undefined` (key absent) leaves it.
   */
  brandId: z.string().uuid().nullable().optional(),
  /** Media IDs to attach. The first is set as primary. */
  mediaIds: z.array(z.string().uuid()).default([]),
  /** "Vous aimerez aussi" rail mode (see PRODUCT_RELATED_MODES). */
  relatedMode: z.enum(PRODUCT_RELATED_MODES).default("auto"),
  /** Curated related product ids (used by the manual / ai modes; order = display order). */
  relatedProductIds: z.array(z.string().uuid()).default([]),
  /** Curated complementary ("Accessoires supplémentaires") product ids; order = display order. Manual-only. */
  complementaryProductIds: z.array(z.string().uuid()).default([]),
  /**
   * Tokyo Care per-product overrides. Each entry forces one plan ON (`include`)
   * or OFF (`exclude`) for THIS product, independently of the plan's category
   * scope (product wins — see product_care resolution). `overridePriceCents` (null
   * = use the plan's own price) only applies to an `include`. When PROVIDED (key
   * present), the workflow REPLACES the product's whole override set (empty array
   * clears it → the product follows category scope only). `undefined` leaves it.
   * Money arrives already in MILLIMES (converted at the action edge).
   */
  careLinks: z
    .array(
      z.object({
        carePlanId: z.string().uuid(),
        mode: z.enum(["include", "exclude"]),
        overridePriceCents: z.number().int().min(0).nullable().default(null),
      }),
    )
    .optional(),
  /**
   * M2M attribute-value IDs the product carries. When provided, the workflow
   * replaces the entire set inside the same transaction so the product save
   * is atomic.
   */
  attributeValueIds: z.array(z.string().uuid()).optional(),
  /**
   * Per-product SCALAR values for kind=number/text attributes. Each entry
   * upserts one (product, attribute) row; an entry with both fields empty
   * CLEARS that scalar. Written through `attributeService.setScalar`.
   */
  attributeScalars: z
    .array(
      z.object({
        attributeId: z.string().uuid(),
        numericValue: z.number().nullable().optional(),
        textValue: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

export const createProductWorkflow = workflow<
  [z.input<typeof createProductSchema>, { actorUserId: string }],
  { productId: string; slug: string }
>("product.create", async (input, { actorUserId }) => {
  const parsed = createProductSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  const d = parsed.data;

  // Purchase-qty window: max must be ≥ min (the DB CHECK is the backstop; this
  // surfaces a friendly field error instead of a 23514 round-trip). Each is
  // independently optional, so only compare when both are set.
  if (d.minPurchaseQty != null && d.maxPurchaseQty != null && d.maxPurchaseQty < d.minPurchaseQty) {
    return fail("validation", "La quantité maximum doit être supérieure ou égale à la quantité minimum.", {
      maxPurchaseQty: "Doit être ≥ la quantité minimum",
    });
  }

  if (d.gtin != null && !GTIN_RE.test(d.gtin)) {
    return fail("validation", `GTIN invalide — ${GTIN_MSG}`, { gtin: GTIN_MSG });
  }

  // A brand-new product has no variants yet (they're added AFTER creation, in the
  // Variantes tab), so a 'variable' product can only be created as a DRAFT.
  if (d.productType === "variable" && d.publish) {
    return fail("validation", VARIABLE_CREATE_PUBLISH_MSG, { productType: VARIABLE_CREATE_PUBLISH_MSG });
  }

  // Validate attribute references BEFORE the write — the SAME check the dedicated
  // /api/products/[slug]/attributes endpoint runs — so an unknown value id or a
  // scalar on the wrong attribute kind is a clean 400, not a silent dead EAV row
  // (or an FK 23503 → 500) written deep inside the transaction.
  const attrErr = await validateAttributeRefs(d.attributeValueIds ?? null, d.attributeScalars ?? null);
  if (attrErr) return fail("validation", attrErr);

  const slug = d.slug ?? slugify(d.name);

  // Products sit at `/[slug]` directly — same namespace as categories,
  // brands, and CMS pages. Use the centralised checker so the error
  // message points at *what* the conflict is (e.g. "déjà utilisé par la
  // catégorie « montres »") instead of a generic "Slug déjà utilisé."
  const availability = await checkSlugAvailability(slug);
  if (!availability.ok) {
    return fail("conflict", availability.message, { slug: availability.message });
  }

  // All writes inside a transaction so we never leave half-wired products.
  const result = await db.transaction(async (tx) => {
    const product = await productService.insert({
      name: d.name,
      slug,
      platform: d.platform ?? null,
      sku: d.sku ?? null,
      gtin: d.gtin ?? null,
      mpn: d.mpn ?? null,
      condition: d.condition,
      external_ref: d.externalRef ?? null,
      warranty_months: d.warrantyMonths ?? null,
      warranty_label: d.warrantyLabel ?? null,
      tax_rate_bps: d.taxRateBps ?? null,
      product_type: d.productType,
      shared_variant_stock: d.sharedVariantStock ?? null,
      short_desc: d.shortDesc,
      description: d.description,
      highlights: d.highlights,
      price_cents: d.priceCents,
      old_price_cents: d.oldPriceCents ?? null,
      // currency is store-global now (Commandes → Devises); the column keeps its
      // 'TND' default — the per-product field was removed.
      in_stock: d.inStock,
      stock_qty: d.stockQty ?? null,
      min_purchase_qty: d.minPurchaseQty ?? null,
      max_purchase_qty: d.maxPurchaseQty ?? null,
      video_url: d.videoUrl ?? null,
      video_poster_media_id: d.videoPosterMediaId ?? null,
      video_title: d.videoTitle ?? null,
      video_description: d.videoDescription ?? null,
      meta_title: d.metaTitle ?? null,
      meta_description: d.metaDescription ?? null,
      canonical_url: d.canonicalUrl ?? null,
      noindex: d.noindex,
      og_image_media_id: d.ogImageMediaId ?? null,
      same_as: d.sameAs ?? null,
      display_order: d.displayOrder ?? 0,
      is_published: d.publish,
      published_at: d.publish ? new Date() : null,
      is_discountable: d.isDiscountable,
      related_mode: d.relatedMode,
    }, tx);

    if (d.categoryIds.length > 0) {
      await productCategoryLinks.set(product.id, d.categoryIds, d.primaryCategoryId, tx);
    }
    if (d.brandId) {
      await productBrandLink.set(product.id, d.brandId, tx);
    }
    if (d.mediaIds.length > 0) {
      await productMediaLink.set(product.id, d.mediaIds, undefined, tx);
    }
    if (d.attributeValueIds && d.attributeValueIds.length > 0) {
      await attributeService.setProductAttributeValues(product.id, d.attributeValueIds, tx);
    }
    if (d.attributeScalars && d.attributeScalars.length > 0) {
      for (const s of d.attributeScalars) {
        await attributeService.setScalar(
          product.id,
          s.attributeId,
          { numericValue: s.numericValue ?? null, textValue: s.textValue ?? null },
          tx,
        );
      }
    }
    if (d.relatedProductIds.length > 0) {
      await productRelatedLinks.set(product.id, d.relatedProductIds, tx);
    }
    if (d.complementaryProductIds.length > 0) {
      await productComplementaryLinks.set(product.id, d.complementaryProductIds, tx);
    }
    // Tokyo Care per-product overrides (include/exclude + optional price).
    if (d.careLinks && d.careLinks.length > 0) {
      await careService.setProductCareForProduct(
        product.id,
        d.careLinks.map((c) => ({
          carePlanId: c.carePlanId,
          mode: c.mode,
          overridePriceCents: c.overridePriceCents ?? null,
        })),
        tx,
      );
    }

    return product;
  });

  await bus.emit(
    "product.created",
    {
      productId: result.id,
      slug: result.slug,
      // `result` is the just-inserted row — the ERP identifiers are on hand, no
      // extra query (same as review.ts enriching from its loaded product row).
      sku: result.sku,
      gtin: result.gtin,
      externalRef: result.external_ref,
    },
    { actorUserId },
  );
  if (result.is_published) {
    await bus.emit("product.published", { productId: result.id }, { actorUserId });
  }

  return ok({ productId: result.id, slug: result.slug });
});

export const updateProductSchema = createProductSchema
  .partial()
  .extend({
    productId: z.string().uuid(),
    /**
     * Compare-and-set guard for the admin editor: the stock_qty the operator SAW
     * when the page loaded. When present (and a stock key is sent), the workflow
     * locks the row and refuses with a `conflict` if the committed stock_qty has
     * moved since (a sale / return / ERP sync) — instead of silently writing the
     * stale page-load value back over it. Absent (API callers) ⇒ plain absolute
     * set, the caller's intent.
     */
    expectedStockQty: z.number().int().min(0).nullable().optional(),
  });

export const updateProductWorkflow = workflow<
  [z.input<typeof updateProductSchema>, { actorUserId: string }],
  { productId: string }
>("product.update", async (input, { actorUserId }) => {
  const parsed = updateProductSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  const d = parsed.data;

  // `updateProductSchema = createProductSchema.partial()` — but Zod KEEPS
  // `.default()` through `.partial()`, so a patch carrying only a couple of
  // keys (e.g. the Archiver toggle's { productId, publish }) parses into a
  // FULLY-populated object (productType:'simple', shortDesc:'', categoryIds:[],
  // mediaIds:[], …). Applying those would silently wipe a
  // product's content/links. Guard every field on whether the CALLER actually
  // sent that key (raw input), so a partial update only touches what it meant
  // to — the full product form sends every key, so it's unaffected.
  const provided = new Set(Object.keys((input ?? {}) as Record<string, unknown>));

  const existing = await productService.findById(d.productId);
  if (!existing) return fail("not_found", "Produit introuvable.");

  // Purchase-qty window on the EFFECTIVE (patch-merged) values — so raising max
  // below an existing min (or vice-versa) in a partial patch is caught, not just
  // when both arrive together. DB CHECK is the backstop.
  const effMinQty = provided.has("minPurchaseQty") ? d.minPurchaseQty : existing.min_purchase_qty;
  const effMaxQty = provided.has("maxPurchaseQty") ? d.maxPurchaseQty : existing.max_purchase_qty;
  if (effMinQty != null && effMaxQty != null && effMaxQty < effMinQty) {
    return fail("validation", "La quantité maximum doit être supérieure ou égale à la quantité minimum.", {
      maxPurchaseQty: "Doit être ≥ la quantité minimum",
    });
  }

  // GTIN format — only for a value that is new or CHANGED, so a legacy product
  // carrying a non-conforming code can still be saved untouched.
  if (provided.has("gtin") && d.gtin != null && d.gtin !== existing.gtin && !GTIN_RE.test(d.gtin)) {
    return fail("validation", `GTIN invalide — ${GTIN_MSG}`, { gtin: GTIN_MSG });
  }

  // Validate any attribute references the patch actually SENT (same check as the
  // dedicated /attributes endpoint) — a bad scalar/value → clean 400, not a
  // silent dead EAV row. Only the provided keys are checked (a sparse patch that
  // omits them isn't touching attributes).
  const attrErr = await validateAttributeRefs(
    provided.has("attributeValueIds") ? d.attributeValueIds ?? null : null,
    provided.has("attributeScalars") ? d.attributeScalars ?? null : null,
  );
  if (attrErr) return fail("validation", attrErr);

  // Cross-entity slug check on rename — products share `/[slug]` with
  // categories, brands, and CMS pages.
  if (d.slug && d.slug !== existing.slug) {
    const availability = await checkSlugAvailability(d.slug, {
      excludeKind: "product",
      excludeId: existing.id,
      currentPaths: [`/${existing.slug}`],
    });
    if (!availability.ok) {
      return fail("conflict", availability.message, { slug: availability.message });
    }
  }

  // DATA-LOSS GUARD: the main form always submits `productType` from an
  // uncontrolled <select> seeded at page load. If the operator added variants
  // via the Variantes tab AFTER opening the page (which promoted the product to
  // 'variable' in the DB) and then saves the main form — whose select still
  // reads 'simple' — the demotion branch below would SILENTLY soft-delete every
  // variant they just created. Refuse the demotion while live variants exist;
  // an intentional demotion still works once the admin empties the variants
  // first (in the Variantes tab).
  if (
    provided.has("productType") &&
    d.productType === "simple" &&
    existing.product_type === "variable"
  ) {
    const liveVariants = await productService.listVariantStock(d.productId);
    if (liveVariants.length > 0) {
      return fail(
        "has_variants",
        "Ce produit possède des variantes — supprimez-les d'abord dans l'onglet Variantes avant de le repasser en « simple ».",
      );
    }
  }

  // Post-save publish state + type (what the storefront will see).
  const effPublished =
    provided.has("publish") && d.publish !== undefined ? d.publish : existing.is_published;
  const effType =
    provided.has("productType") && d.productType !== undefined ? d.productType : existing.product_type;

  // PUBLISH GUARD (mirror of the create one): a LIVE 'variable' product needs at
  // least one live variant — without one the PDP sells it through a plain buy
  // button and checkout rejects every attempt. Covers a promotion to 'variable'
  // (incl. the stale main-form select after the Variantes tab emptied the set and
  // demoted it) and publishing such a draft. Only checked when this save touches
  // the type or the publish state, so a sparse API patch of an unrelated field on
  // a legacy row isn't refused.
  if ((provided.has("productType") || provided.has("publish")) && effType === "variable" && effPublished) {
    const liveVariants = await productService.listVariantStock(d.productId);
    if (liveVariants.length === 0) {
      return fail("validation", VARIABLE_UPDATE_PUBLISH_MSG, { productType: VARIABLE_UPDATE_PUBLISH_MSG });
    }
  }

  const changed: string[] = [];
  const patch: Parameters<typeof productService.update>[1] = {};

  const map: Record<string, keyof typeof patch> = {
    name: "name",
    slug: "slug",
    platform: "platform",
    sku: "sku",
    gtin: "gtin",
    mpn: "mpn",
    condition: "condition",
    externalRef: "external_ref",
    warrantyMonths: "warranty_months",
    warrantyLabel: "warranty_label",
    taxRateBps: "tax_rate_bps",
    productType: "product_type",
    sharedVariantStock: "shared_variant_stock",
    shortDesc: "short_desc",
    description: "description",
    priceCents: "price_cents",
    oldPriceCents: "old_price_cents",
    inStock: "in_stock",
    stockQty: "stock_qty",
    minPurchaseQty: "min_purchase_qty",
    maxPurchaseQty: "max_purchase_qty",
    videoUrl: "video_url",
    videoPosterMediaId: "video_poster_media_id",
    videoTitle: "video_title",
    videoDescription: "video_description",
    metaTitle: "meta_title",
    metaDescription: "meta_description",
    canonicalUrl: "canonical_url",
    noindex: "noindex",
    ogImageMediaId: "og_image_media_id",
    sameAs: "same_as",
    displayOrder: "display_order",
    isDiscountable: "is_discountable",
    relatedMode: "related_mode",
  };

  // `changed` lists only what ACTUALLY differs from the stored row: the editor
  // re-sends every key on each save, and product.updated's changedFields feeds
  // the outbound webhooks (selective ERP sync), the audit trail and the re-embed
  // gate — a no-op save must not read as a ~40-field change. Unchanged columns
  // are left out of the UPDATE too. Stock columns are the exception: they're
  // diffed against the LOCKED committed row inside the transaction (a sale may
  // have moved them since `existing` was read), so they always ride the patch.
  const existingCols = existing as unknown as Record<string, unknown>;
  for (const [k, dbKey] of Object.entries(map)) {
    if (!provided.has(k)) continue;
    const v = (d as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (dbKey === "stock_qty" || dbKey === "in_stock") {
      patch[dbKey] = v as never;
      continue;
    }
    if (v === existingCols[dbKey]) continue;
    patch[dbKey] = v as never;
    changed.push(String(dbKey));
  }

  // Highlights (jsonb string[]) — content-compared, NOT via the map's `===`, which
  // would always "differ" for arrays and flag every save as a change (spamming the
  // outbound webhooks / audit / re-embed gate). Kept out of `map` for that reason.
  if (provided.has("highlights") && d.highlights !== undefined) {
    const cur = (existing.highlights ?? []) as string[];
    if (JSON.stringify(cur) !== JSON.stringify(d.highlights)) {
      patch.highlights = d.highlights as never;
      changed.push("highlights");
    }
  }

  // Publish toggle gets its own event for cache invalidation.
  let publishEvent: "published" | "unpublished" | null = null;
  if (provided.has("publish") && d.publish !== undefined && d.publish !== existing.is_published) {
    patch.is_published = d.publish;
    patch.published_at = d.publish ? new Date() : existing.published_at;
    changed.push("is_published");
    publishEvent = d.publish ? "published" : "unpublished";
  }

  // Association diffs — each link set is REPLACE-semantics (set() deletes then
  // re-inserts), and a caller only touches the sets whose key it SENT (a partial
  // update, e.g. the Publier toggle, must never wipe links). Compare what was
  // sent with what's stored so only a set that actually differs is rewritten and
  // reported in changedFields.
  const sendsCategories = provided.has("categoryIds") && d.categoryIds !== undefined;
  const sendsBrand = provided.has("brandId") && d.brandId !== undefined;
  const sendsMedia = provided.has("mediaIds") && d.mediaIds !== undefined;
  const sendsValues = provided.has("attributeValueIds") && d.attributeValueIds !== undefined;
  const sendsScalars = provided.has("attributeScalars") && d.attributeScalars !== undefined;
  const sendsRelated = provided.has("relatedProductIds") && d.relatedProductIds !== undefined;
  const sendsComplementary =
    provided.has("complementaryProductIds") && d.complementaryProductIds !== undefined;
  // Tokyo Care overrides replace the whole set when the key is sent (empty clears).
  const sendsCare = provided.has("careLinks") && d.careLinks !== undefined;
  const [curCategories, curBrandId, curMedia, curValueIds, curScalars, curRelated, curComplementary, curCare] =
    await Promise.all([
      sendsCategories ? productCategoryLinks.listForProduct(d.productId) : [],
      sendsBrand ? productBrandLink.findBrandId(d.productId) : null,
      sendsMedia ? productMediaLink.list(d.productId) : [],
      sendsValues ? attributeService.listValueIdsForProduct(d.productId) : [],
      sendsScalars ? attributeService.getScalarsForProduct(d.productId) : [],
      sendsRelated ? productRelatedLinks.listForProduct(d.productId) : [],
      sendsComplementary ? productComplementaryLinks.listForProduct(d.productId) : [],
      sendsCare ? careService.getProductCare(d.productId) : [],
    ]);
  const nextCategoryIds = d.categoryIds ?? [];
  // set() flags `is_primary` only on a primary that is IN the sent set.
  const nextPrimaryCategory =
    d.primaryCategoryId && nextCategoryIds.includes(d.primaryCategoryId) ? d.primaryCategoryId : null;
  const writeCategories =
    sendsCategories &&
    (!sameIdSet(curCategories.map((c) => c.category_id), nextCategoryIds) ||
      (curCategories.find((c) => c.is_primary)?.category_id ?? null) !== nextPrimaryCategory);
  const writeBrand = sendsBrand && (d.brandId ?? null) !== curBrandId;
  const writeMedia = sendsMedia && !sameIdList(curMedia.map((m) => m.media_id), d.mediaIds ?? []);
  const writeValues = sendsValues && !sameIdSet(curValueIds, d.attributeValueIds ?? []);
  const writeRelated =
    sendsRelated && !sameIdList(curRelated, curatedIds(d.productId, d.relatedProductIds ?? []));
  const writeComplementary =
    sendsComplementary &&
    !sameIdList(curComplementary, curatedIds(d.productId, d.complementaryProductIds ?? []));
  // Tokyo Care: write ONLY when the submitted overrides differ from the stored
  // set (order-insensitive; one row per plan via the unique index). Without this
  // diff a full-form re-save churns product_care + always flags « care » changed,
  // defeating the no-op guard below (spurious product.updated / ERP webhook).
  const careKey = (planId: string, mode: string, price: number | null | undefined) =>
    `${planId}|${mode}|${price ?? ""}`;
  const curCareKeys = new Set(curCare.map((c) => careKey(c.care_plan_id, c.mode, c.override_price_cents)));
  const nextCareKeys = new Set(
    (d.careLinks ?? []).map((c) => careKey(c.carePlanId, c.mode, c.overridePriceCents ?? null)),
  );
  const writeCare =
    sendsCare &&
    (curCareKeys.size !== nextCareKeys.size || [...nextCareKeys].some((k) => !curCareKeys.has(k)));
  // Scalars upsert per attribute (sequential, last entry wins) — keep the last
  // entry per attribute and write only those that differ from the stored value.
  const scalarWrites: NonNullable<typeof d.attributeScalars> = [];
  if (sendsScalars) {
    const stored = new Map(curScalars.map((s) => [s.attribute_id, scalarKey(s.numeric_value, s.text_value)]));
    const lastByAttr = new Map<string, (typeof scalarWrites)[number]>();
    for (const s of d.attributeScalars ?? []) lastByAttr.set(s.attributeId, s);
    for (const s of lastByAttr.values()) {
      if (scalarKey(s.numericValue, s.textValue) !== (stored.get(s.attributeId) ?? scalarKey(null, null))) {
        scalarWrites.push(s);
      }
    }
  }

  // Stock keys this call actually carries. The admin editor sends them ONLY when
  // the operator changed them (see updateProductAction) — an unrelated edit must
  // never write the page-load stock snapshot back over a sale made since.
  const setsQty = provided.has("stockQty") && d.stockQty !== undefined;
  const setsInStock = provided.has("inStock") && d.inStock !== undefined;

  const txOut = await db.transaction(async (tx) => {
    // Lock the product row FIRST when this save writes stock and read the
    // COMMITTED stock: the compare-and-set, the in_stock derivation, the ledger
    // delta and the restock check all use it — never the pre-tx `existing`, which
    // a concurrent order decrement may have outdated.
    let stockBefore: { stock_qty: number | null; in_stock: boolean } = {
      stock_qty: existing.stock_qty,
      in_stock: existing.in_stock,
    };
    if (setsQty || setsInStock) {
      const locked = await productService.lockStock(d.productId, tx);
      if (locked) stockBefore = locked;
      // Compare-and-set (admin editor): the stock moved since the page loaded →
      // refuse rather than overwrite (nothing has been written yet in this tx).
      if (
        provided.has("expectedStockQty") &&
        d.expectedStockQty !== undefined &&
        stockBefore.stock_qty !== d.expectedStockQty
      ) {
        return { conflict: true as const };
      }
      // A quantity change without an explicit availability flag re-derives
      // in_stock by the shared sold-out rule: restocking a SOLD-OUT line re-lists
      // it (it was left 'Rupture' before), while a line the operator deliberately
      // delisted stays delisted.
      if (setsQty && !setsInStock) {
        patch.in_stock = nextInStockForQty(stockBefore.stock_qty, stockBefore.in_stock, d.stockQty ?? null);
      }
      // Stock columns are reported only when they differ from the LOCKED value.
      if (patch.stock_qty !== undefined && patch.stock_qty !== stockBefore.stock_qty) changed.push("stock_qty");
      if (patch.in_stock !== undefined && patch.in_stock !== stockBefore.in_stock) changed.push("in_stock");
    }

    let row = existing;
    let demoteReset = false;
    if (Object.keys(patch).length > 0) {
      const next = await productService.update(d.productId, patch, tx);
      if (next) row = next;
    }
    // Reconcile variant rows with the declared type. Demoting variable→simple
    // via the main form MUST clear live variants in the SAME tx — otherwise the
    // PDP hides the picker (the storefront mapper only loads variants for
    // product_type='variable') while the cart/order still resolve a stranded
    // variant's price+stock, so the same SKU can show three different prices.
    // Mirrors how the variant editor promotes to 'variable' on first save.
    if (patch.product_type === "simple" && existing.product_type === "variable") {
      const { removed } = await productService.replaceVariants(d.productId, [], tx);
      // Same as the variant editor: ledger each TRACKED removed variant's units
      // leaving (−old → 0). The has_variants guard normally leaves none here, but
      // it reads outside this tx — a variant added concurrently lands here.
      for (const r of removed) {
        if (r.stockQty != null && r.stockQty > 0) {
          await stockMovementService.record(
            { productId: d.productId, variantId: r.id, delta: -r.stockQty, resultingQty: 0, reason: "admin", actorUserId, note: "variante supprimée" },
            tx,
          );
        }
      }
      if (!changed.includes("variants")) changed.push("variants");
      // Mirror the variant-editor demotion: a variant-less ex-variable product
      // whose parent stock_qty is NULL ("untracked / always sellable") is reset
      // to a tracked, out-of-stock state. Guard on the EFFECTIVE post-patch stock
      // (`row` already reflects this save's patch) — NOT on key presence: the
      // admin action only sends stockQty when the operator changed it, and an API
      // patch may carry the key with an undefined value, so key presence says
      // nothing about the resulting stock. A save that set a real stock leaves
      // row.stock_qty a number and skips this.
      if (row.stock_qty === null) {
        const reset = await productService.update(d.productId, { stock_qty: 0, in_stock: false }, tx);
        if (reset) row = reset;
        demoteReset = true;
      }
    }
    // Ledger a stock change made via the full product editor (the bulk stock
    // page already ledgers as "admin"; this closes the other admin surface) —
    // from the LOCKED pre-value, so the delta is honest under concurrency.
    if ((setsQty || demoteReset) && stockBefore.stock_qty !== row.stock_qty) {
      const before = stockBefore.stock_qty;
      const after = row.stock_qty;
      await stockMovementService.record(
        {
          productId: d.productId,
          delta: typeof before === "number" && typeof after === "number" ? after - before : 0,
          resultingQty: after,
          reason: "admin",
          actorUserId,
        },
        tx,
      );
    }
    // Associations: only the sets the caller SENT and that differ from what's
    // stored (see the diff above) are rewritten.
    if (writeCategories) {
      await productCategoryLinks.set(d.productId, nextCategoryIds, d.primaryCategoryId, tx);
      changed.push("categories");
    }
    if (writeBrand) {
      // null → set() deletes the link (« Retirer la marque » / API brandId: null).
      await productBrandLink.set(d.productId, d.brandId ?? null, tx);
      changed.push("brand");
    }
    if (writeMedia) {
      await productMediaLink.set(d.productId, d.mediaIds ?? [], undefined, tx);
      changed.push("media");
    }
    if (writeValues) {
      await attributeService.setProductAttributeValues(d.productId, d.attributeValueIds ?? [], tx);
      changed.push("attributes");
    }
    if (scalarWrites.length > 0) {
      for (const s of scalarWrites) {
        await attributeService.setScalar(
          d.productId,
          s.attributeId,
          { numericValue: s.numericValue ?? null, textValue: s.textValue ?? null },
          tx,
        );
      }
      changed.push("attribute_scalars");
    }
    if (writeRelated) {
      await productRelatedLinks.set(d.productId, d.relatedProductIds ?? [], tx);
      changed.push("related");
    }
    if (writeComplementary) {
      await productComplementaryLinks.set(d.productId, d.complementaryProductIds ?? [], tx);
      changed.push("complementary");
    }
    if (writeCare) {
      await careService.setProductCareForProduct(
        d.productId,
        (d.careLinks ?? []).map((c) => ({
          carePlanId: c.carePlanId,
          mode: c.mode,
          overridePriceCents: c.overridePriceCents ?? null,
        })),
        tx,
      );
      changed.push("care");
    }
    return { conflict: false as const, row, stockBefore };
  });
  if (txOut.conflict) {
    const msg = "Le stock a changé depuis l'ouverture de la page — rechargez.";
    return fail("conflict", msg, { stockQty: msg });
  }
  const updatedRow = txOut.row;

  // Nothing actually changed (an untouched re-save) → no product.updated: no
  // cache bust, webhook, audit row or re-embed mark for a no-op. The events below
  // are all transition-gated, so they stay silent on their own.
  if (changed.length > 0) {
    await bus.emit(
      "product.updated",
      {
        productId: d.productId,
        slug: updatedRow.slug,
        changedFields: changed,
        // `updatedRow` is the post-update row — ERP identifiers already loaded.
        sku: updatedRow.sku,
        gtin: updatedRow.gtin,
        externalRef: updatedRow.external_ref,
      },
      { actorUserId },
    );
  }
  // Dedicated price-change event (carries old + new — product.updated only lists
  // changed-field NAMES). Drives the wishlist price-drop email. `existing` is the
  // pre-update row, `updatedRow` the post-update row, so this fires on any real change.
  if (existing.price_cents !== updatedRow.price_cents) {
    await bus.emit(
      "product.price_changed",
      {
        productId: d.productId,
        variantId: null,
        oldCents: existing.price_cents,
        newCents: updatedRow.price_cents,
      },
      { actorUserId },
    );
  }
  // Restock drives the back-in-stock email. Fire on an unavailable→available
  // TRANSITION — covering BOTH tracked stock (qty 0 → positive) and untracked
  // availability (stock_qty NULL, `in_stock` flipped false → true). The "before"
  // side is the LOCKED in-tx read when this save wrote stock.
  const wasAvailable = isAvailable(txOut.stockBefore.in_stock, txOut.stockBefore.stock_qty);
  const nowAvailable = isAvailable(updatedRow.in_stock, updatedRow.stock_qty);
  if (!wasAvailable && nowAvailable) {
    await bus.emit("product.restocked", { productId: d.productId }, { actorUserId });
  }
  if (publishEvent === "published") {
    await bus.emit("product.published", { productId: d.productId }, { actorUserId });
  } else if (publishEvent === "unpublished") {
    await bus.emit("product.unpublished", { productId: d.productId }, { actorUserId });
  }
  // Redirect upkeep (see syncEntityUrlRedirects): renaming a LIVE product keeps
  // the old `/[slug]` URL working (301 old → new — indexed URLs, backlinks and
  // already-sent emails embed it; a draft's URL was never public), and a rename
  // or publication frees the product's URL from an active rule that would
  // shadow it.
  await syncEntityUrlRedirects(
    {
      wasLive: existing.is_published,
      isLive: updatedRow.is_published,
      before: [`/${existing.slug}`],
      after: [`/${updatedRow.slug}`],
    },
    { actorUserId, label: `slug du produit « ${updatedRow.name} » modifié` },
  );

  return ok({ productId: d.productId });
});

export const deleteProductWorkflow = workflow<
  [{ productId: string }, { actorUserId: string }],
  { productId: string }
>("product.delete", async ({ productId }, { actorUserId }) => {
  const existing = await productService.findById(productId);
  if (!existing) return fail("not_found", "Produit introuvable.");
  // Release everything the tombstone would otherwise keep holding, in ONE tx:
  //  - the product row (deleted_at) + its product-pool per-location levels;
  //  - its live VARIANTS: replaceVariants(id, []) frees their sku/gtin (the
  //    partial unique indexes span live VARIANT rows only, so a live variant of
  //    a deleted product kept its codes reserved forever — re-creating the
  //    listing failed with "Ce SKU de variante est déjà utilisé."), soft-deletes
  //    them at stock 0 and drops their stock_levels;
  //  - its attribute-value assignments, so a value used only by deleted
  //    products no longer blocks that value's deletion ("in use").
  // Order history is unaffected (order_items snapshot sku / label / image).
  await db.transaction(async (tx) => {
    await productService.softDelete(productId, tx);
    await productService.replaceVariants(productId, [], tx);
    await attributeService.setProductAttributeValues(productId, [], tx);
    // Tokyo Care per-product overrides — cleared so a deleted product leaves no
    // dangling include/exclude rows (the plan's category scope is unaffected).
    await careService.setProductCareForProduct(productId, [], tx);
  });
  await bus.emit(
    "product.deleted",
    {
      productId,
      // `existing` was loaded at the top of the workflow — the ERP identifiers let
      // a consumer tombstone its own linked record without a (now-404) callback.
      sku: existing.sku,
      gtin: existing.gtin,
      externalRef: existing.external_ref,
    },
    { actorUserId },
  );
  return ok({ productId });
});
