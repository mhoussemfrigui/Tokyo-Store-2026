"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { mediaQueries } from "@/modules/media";
import { bakedMediaHostSources } from "@/modules/media/cdn-allowlist";
import { BULK_MEDIA_MAX } from "@/modules/media/limits";
import { checkUrlOverride, parseMediaUploadScope } from "@/modules/media/validation";
import { productService } from "@/modules/catalog/product/service";
import { productQueries } from "@/modules/catalog/product";
import { brandService } from "@/modules/catalog/brand/service";
import { applyStockSet } from "@/lib/inventory/adjust";
import { editedStockFields, variantStockFields } from "@/lib/catalog/editor-stock-fields";
import { setSharedStockDefault, VARIANT_STOCK_SHARED_DEFAULT_KEY } from "@/lib/inventory/variant-stock";
import { bustCacheTag } from "@/lib/cache/revalidate";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { bus } from "@/events/bus";
import { requirePermission } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { isUuid } from "@/lib/utils/uuid";
import { parseFaqItemsJson } from "@/lib/cms/faq-items";
import {
  cleanFeaturedSlugs,
  coerceEnum,
  coerceMediaId,
  parseBoutiqueBlockOrder,
  parseMarquesBlockOrder,
  parseJsonArrayField,
} from "@/lib/pages/boutique-landing-parse";
import { type ActionState } from "@/lib/actions/types";
import { toIntOr, toIntOrNull, toNonNegInt } from "@/lib/actions/coerce";
import { dinarsToMinor } from "@/lib/price";
import { bpsFromPercent } from "@/lib/tax";
import type { CategoryValueProp } from "@/modules/catalog/category/schema";

// ──────────────────────────────────────────────────────────── BRANDS
export async function createBrandAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("brands", "create");
  const valueProps = parseValueProps(optional(formData, "valuePropsJson"));
  const result = await workflows.catalog.createBrand(
    {
      name: String(formData.get("name") ?? ""),
      slug: optional(formData, "slug"),
      description: nullable(formData, "description"),
      externalRef: nullable(formData, "externalRef"),
      logoMediaId: optionalUuid(formData, "logoMediaId") ?? null,
      icon: nullable(formData, "icon"),
      iconMediaId: formData.has("iconMediaId")
        ? (optionalUuid(formData, "iconMediaId") ?? null)
        : undefined,
      isActive: formData.get("isActive") === "on",
      isDiscountable: formData.get("isDiscountable") === "on",
      isPreorder: formData.get("isPreorder") === "on",
      preorderReleasesAt: nullable(formData, "preorderReleasesAt"),
      preorderMessage: nullable(formData, "preorderMessage"),
      displayOrder: optionalInt(formData, "displayOrder"),
      heroMediaId: formData.has("heroMediaId")
        ? (optionalUuid(formData, "heroMediaId") ?? null)
        : undefined,
      tagline: nullable(formData, "tagline"),
      editorialEyebrow: nullable(formData, "editorialEyebrow"),
      editorialTitle: nullable(formData, "editorialTitle"),
      editorialBody: nullable(formData, "editorialBody"),
      valueProps,
      metaTitle: nullable(formData, "metaTitle"),
      metaDescription: nullable(formData, "metaDescription"),
      canonicalUrl: nullable(formData, "canonicalUrl"),
      noindex: formData.get("noindex") === "on",
      ogImageMediaId: formData.has("ogImageMediaId")
        ? (optionalUuid(formData, "ogImageMediaId") ?? null)
        : undefined,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok)
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  revalidatePath("/admin/catalog/brands");
  return { ok: true, message: "Marque créée.", id: result.data.brandId };
}

export async function updateBrandAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("brands", "update");
  const brandId = optional(formData, "brandId");
  if (!brandId) return { ok: false, error: "validation", message: "ID requis." };
  const valueProps = parseValueProps(optional(formData, "valuePropsJson"));
  const result = await workflows.catalog.updateBrand(
    {
      brandId,
      name: optional(formData, "name"),
      slug: optional(formData, "slug"),
      description: nullable(formData, "description"),
      externalRef: nullable(formData, "externalRef"),
      logoMediaId: formData.has("logoMediaId")
        ? (optionalUuid(formData, "logoMediaId") ?? null)
        : undefined,
      icon: nullable(formData, "icon"),
      iconMediaId: formData.has("iconMediaId")
        ? (optionalUuid(formData, "iconMediaId") ?? null)
        : undefined,
      isActive: formData.get("isActive") === "on",
      isDiscountable: formData.get("isDiscountable") === "on",
      isPreorder: formData.get("isPreorder") === "on",
      preorderReleasesAt: nullable(formData, "preorderReleasesAt"),
      preorderMessage: nullable(formData, "preorderMessage"),
      displayOrder: optionalInt(formData, "displayOrder"),
      heroMediaId: formData.has("heroMediaId")
        ? (optionalUuid(formData, "heroMediaId") ?? null)
        : undefined,
      tagline: nullable(formData, "tagline"),
      editorialEyebrow: nullable(formData, "editorialEyebrow"),
      editorialTitle: nullable(formData, "editorialTitle"),
      editorialBody: nullable(formData, "editorialBody"),
      valueProps,
      metaTitle: nullable(formData, "metaTitle"),
      metaDescription: nullable(formData, "metaDescription"),
      canonicalUrl: nullable(formData, "canonicalUrl"),
      noindex: formData.get("noindex") === "on",
      ogImageMediaId: formData.has("ogImageMediaId")
        ? (optionalUuid(formData, "ogImageMediaId") ?? null)
        : undefined,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok)
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };

  // Persist the brand FAQs IN THE SAME SAVE — same fold-in as the product /
  // category editors. The FAQ editor mirrors its list into the MAIN form as
  // `faqItemsJson` once edited, so the single "Enregistrer" saves FAQs too and an
  // operator who edits FAQ rows then clicks the main button no longer loses them
  // (they used to persist only via the separate "Enregistrer la FAQ" button — the
  // brand analogue of the product form's "#1 my-FAQs-don't-show-up" footgun). Only
  // acts when the hidden input is present (⇒ the FAQ tab was edited). Best-effort:
  // a FAQ hiccup must not fail the brand save that already committed, but the
  // operator is told so their edits don't silently vanish.
  let faqOk = true;
  if (formData.has("faqItemsJson")) {
    const faqItems = parseFaqItemsJson(optional(formData, "faqItemsJson"));
    faqOk = await workflows.cms
      .upsertBrandFaqs({ brandId, items: faqItems }, { actorUserId: session.user.id })
      .then((r) => r.ok)
      .catch((err) => {
        console.error("[updateBrand] FAQ persist failed", err);
        return false;
      });
  }

  revalidatePath("/admin/catalog/brands");
  revalidatePath(`/admin/catalog/brands/${brandId}`);
  const brandSlug = optional(formData, "slug");
  if (brandSlug) revalidatePath(`/${brandSlug}`);
  return {
    ok: true,
    message: faqOk
      ? "Marque mise à jour."
      : "Marque mise à jour, mais l'enregistrement de la FAQ a échoué — réessayez depuis l'onglet FAQ.",
    id: brandId,
  };
}

export async function deleteBrandAction(brandId: string): Promise<ActionState> {
  const session = await requirePermission("brands", "delete");
  const result = await workflows.catalog.deleteBrand({ brandId }, { actorUserId: session.user.id });
  if (!result.ok)
    return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/catalog/brands");
  return { ok: true, message: "Marque supprimée." };
}

/** Inline activate/deactivate toggle from the brands list (mirrors setCategoryActiveAction). */
export async function setBrandActiveAction(brandId: string, isActive: boolean): Promise<ActionState> {
  const session = await requirePermission("brands", "update");
  if (!/^[0-9a-f-]{36}$/i.test(brandId)) {
    return { ok: false, error: "validation", message: "ID marque invalide." };
  }
  const result = await workflows.catalog.updateBrand(
    { brandId, isActive },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/catalog/brands");
  return { ok: true, message: isActive ? "Marque activée." : "Marque désactivée." };
}

/** Persist a new brand order from the admin "Réorganiser" mode (flat, mirrors reorderCategoriesAction). */
export async function reorderBrandsAction(orderedIds: string[]): Promise<ActionState> {
  const session = await requirePermission("brands", "update");
  const result = await workflows.catalog.reorderBrands(
    { orderedIds },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/catalog/brands");
  return { ok: true, message: "Ordre des marques mis à jour." };
}

/** Result of the inline "create brand" action (called imperatively from the product editor). */
export type CreateBrandInlineResult =
  | { ok: true; brand: { id: string; name: string; slug: string } }
  | { ok: false; error: string };

/**
 * Create a brand FROM the product editor's brand picker, returning the new
 * {id, name, slug} so the client can append it to the list and select it in one
 * step — no detour to /admin/catalog/brands losing in-progress form state.
 * Mirrors createCategoryFilterAttributeAction.
 */
export async function createBrandInlineAction(input: {
  name: string;
  slug?: string;
}): Promise<CreateBrandInlineResult> {
  const session = await requirePermission("brands", "create");
  const name = (input.name ?? "").trim();
  if (!name) return { ok: false, error: "Nom de la marque requis." };
  const result = await workflows.catalog.createBrand(
    { name, slug: input.slug?.trim() || undefined, isActive: true },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.message };
  revalidatePath("/admin/catalog/brands");
  return { ok: true, brand: { id: result.data.brandId, name, slug: result.data.slug } };
}

// ──────────────────────────────────────────────────────────── CATEGORIES
export async function createCategoryAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("categories", "create");
  const valueProps = parseValueProps(optional(formData, "valuePropsJson"));
  const result = await workflows.catalog.createCategory(
    {
      name: String(formData.get("name") ?? ""),
      slug: optional(formData, "slug"),
      tagline: nullable(formData, "tagline"),
      description: nullable(formData, "description"),
      externalRef: nullable(formData, "externalRef"),
      parentId: optionalUuid(formData, "parentId"),
      warrantyMonths: nullableInt(formData, "warrantyMonths"),
      warrantyLabel: nullable(formData, "warrantyLabel"),
      taxRateBps: taxBpsField(formData, "taxRateBps"),
      displayOrder: optionalInt(formData, "displayOrder"),
      metaTitle: nullable(formData, "metaTitle"),
      metaDescription: nullable(formData, "metaDescription"),
      canonicalUrl: nullable(formData, "canonicalUrl"),
      noindex: formData.get("noindex") === "on",
      ogImageMediaId: formData.has("ogImageMediaId")
        ? (optionalUuid(formData, "ogImageMediaId") ?? null)
        : undefined,
      heroMediaId: formData.has("heroMediaId")
        ? (optionalUuid(formData, "heroMediaId") ?? null)
        : undefined,
      boutiqueImageMediaId: formData.has("boutiqueImageMediaId")
        ? (optionalUuid(formData, "boutiqueImageMediaId") ?? null)
        : undefined,
      icon: nullable(formData, "icon"),
      iconMediaId: formData.has("iconMediaId")
        ? (optionalUuid(formData, "iconMediaId") ?? null)
        : undefined,
      isActive: formData.get("isActive") === "on",
      isDiscountable: formData.get("isDiscountable") === "on",
      isPreorder: formData.get("isPreorder") === "on",
      preorderReleasesAt: nullable(formData, "preorderReleasesAt"),
      preorderMessage: nullable(formData, "preorderMessage"),
      editorialEyebrow: nullable(formData, "editorialEyebrow"),
      editorialTitle: nullable(formData, "editorialTitle"),
      editorialBody: nullable(formData, "editorialBody"),
      valueProps,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok)
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  // Wire the M2M `category_attribute_filters` once the row exists. Goes
  // through the workflow so the `category.filter_attributes.updated` event
  // fires alongside it.
  const createFilterIds = pickAllUuid(formData, "filterAttributeIds");
  const filtersResult = await workflows.catalog.setCategoryFilters(
    { categoryId: result.data.categoryId, attributeIds: createFilterIds },
    { actorUserId: session.user.id },
  );
  revalidatePath("/admin/catalog/categories");
  if (!filtersResult.ok) {
    return {
      ok: true,
      message: "Catégorie créée, mais les filtres n'ont pas pu être mis à jour.",
      id: result.data.categoryId,
    };
  }
  return { ok: true, message: "Catégorie créée.", id: result.data.categoryId };
}

export async function updateCategoryAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("categories", "update");
  const categoryId = optional(formData, "categoryId");
  if (!categoryId) return { ok: false, error: "validation", message: "ID requis." };
  const valueProps = parseValueProps(optional(formData, "valuePropsJson"));
  const result = await workflows.catalog.updateCategory(
    {
      categoryId,
      name: optional(formData, "name"),
      slug: optional(formData, "slug"),
      tagline: nullable(formData, "tagline"),
      description: nullable(formData, "description"),
      externalRef: nullable(formData, "externalRef"),
      parentId: formData.has("parentId")
        ? (optionalUuid(formData, "parentId") ?? null)
        : undefined,
      warrantyMonths: nullableInt(formData, "warrantyMonths"),
      warrantyLabel: nullable(formData, "warrantyLabel"),
      taxRateBps: taxBpsField(formData, "taxRateBps"),
      displayOrder: optionalInt(formData, "displayOrder"),
      metaTitle: nullable(formData, "metaTitle"),
      metaDescription: nullable(formData, "metaDescription"),
      canonicalUrl: nullable(formData, "canonicalUrl"),
      noindex: formData.get("noindex") === "on",
      ogImageMediaId: formData.has("ogImageMediaId")
        ? (optionalUuid(formData, "ogImageMediaId") ?? null)
        : undefined,
      heroMediaId: formData.has("heroMediaId")
        ? (optionalUuid(formData, "heroMediaId") ?? null)
        : undefined,
      boutiqueImageMediaId: formData.has("boutiqueImageMediaId")
        ? (optionalUuid(formData, "boutiqueImageMediaId") ?? null)
        : undefined,
      icon: nullable(formData, "icon"),
      iconMediaId: formData.has("iconMediaId")
        ? (optionalUuid(formData, "iconMediaId") ?? null)
        : undefined,
      isActive: formData.get("isActive") === "on",
      isDiscountable: formData.get("isDiscountable") === "on",
      isPreorder: formData.get("isPreorder") === "on",
      preorderReleasesAt: nullable(formData, "preorderReleasesAt"),
      preorderMessage: nullable(formData, "preorderMessage"),
      editorialEyebrow: nullable(formData, "editorialEyebrow"),
      editorialTitle: nullable(formData, "editorialTitle"),
      editorialBody: nullable(formData, "editorialBody"),
      valueProps,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok)
    return {
      ok: false,
      error: result.error,
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  // Replace the M2M `category_attribute_filters` set with whatever the
  // admin checked in the new attribute-linker. Empty list ⇒ all unlinked.
  let filtersOk = true;
  if (formData.has("filterAttributeIds")) {
    const updateFilterIds = pickAllUuid(formData, "filterAttributeIds");
    const filtersResult = await workflows.catalog.setCategoryFilters(
      { categoryId, attributeIds: updateFilterIds },
      { actorUserId: session.user.id },
    );
    filtersOk = filtersResult.ok;
  }

  // Persist the category FAQs IN THE SAME SAVE — same fold-in as the product
  // editor. The FAQ editor mirrors its list into the main form as
  // `faqItemsJson` ONCE the operator edits it, so the single "Enregistrer"
  // saves FAQs too and an operator who edits FAQ rows and clicks the main
  // button no longer loses them (they used to persist only via the separate
  // "Enregistrer la FAQ" button — the category analogue of the product form's
  // "#1 my-FAQs-don't-show-up" footgun). Only acts when the hidden input is
  // present (⇒ the FAQ tab was edited); absent ⇒ FAQs untouched, so an
  // unrelated save never re-writes them. Best-effort: a FAQ hiccup must not
  // fail the category save that already committed — but the operator is told
  // so their FAQ edits don't silently vanish.
  let faqOk = true;
  if (formData.has("faqItemsJson")) {
    const faqItems = parseFaqItemsJson(optional(formData, "faqItemsJson"));
    faqOk = await workflows.cms
      .upsertCategoryFaqs({ categoryId, items: faqItems }, { actorUserId: session.user.id })
      .then((r) => r.ok)
      .catch((err) => {
        console.error("[updateCategory] FAQ persist failed", err);
        return false;
      });
  }

  revalidatePath("/admin/catalog/categories");
  revalidatePath(`/admin/catalog/categories/${categoryId}`);
  // Storefront category page — refresh the slug so a FAQ / content edit shows
  // immediately (the flat /[slug] route reads FAQ/editorial uncached, but the
  // cached DTOs are tag-busted by the emitted event; this covers the rest).
  const catSlug = optional(formData, "slug");
  if (catSlug) revalidatePath(`/${catSlug}`);

  // Name the sub-editors that failed so the success banner points the operator
  // at the tab to retry from, instead of reporting clean success over a
  // silently-dropped filter / FAQ edit.
  const failed = [!filtersOk && "les filtres", !faqOk && "la FAQ"].filter(Boolean) as string[];
  return {
    ok: true,
    message:
      failed.length === 0
        ? "Catégorie mise à jour."
        : `Catégorie mise à jour, mais l'enregistrement de ${failed.join(" et ")} a échoué — réessayez depuis l'onglet concerné.`,
    id: categoryId,
  };
}

export async function deleteCategoryAction(categoryId: string): Promise<ActionState> {
  const session = await requirePermission("categories", "delete");
  const result = await workflows.catalog.deleteCategory(
    { categoryId },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/catalog/categories");
  return { ok: true, message: "Catégorie supprimée." };
}

/**
 * Flip a category's `is_active` from the list panel (no full-form round trip).
 * Mirrors setProductArchivedAction. NOTE the cascade: is_active hides the WHOLE
 * subtree on the storefront (isCategoryChainActive), so the panel confirms
 * before deactivating a node with children.
 */
export async function setCategoryActiveAction(
  categoryId: string,
  isActive: boolean,
): Promise<ActionState> {
  const session = await requirePermission("categories", "update");
  if (!/^[0-9a-f-]{36}$/i.test(categoryId)) {
    return { ok: false, error: "validation", message: "ID catégorie invalide." };
  }
  const result = await workflows.catalog.updateCategory(
    { categoryId, isActive },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/catalog/categories");
  return { ok: true, message: isActive ? "Catégorie activée." : "Catégorie désactivée." };
}

/**
 * Reorder one sibling group by display_order from the drill-down panel.
 * `parentId` is null for root categories. The workflow scopes the renumber to
 * that parent, so a foreign id can never reorder another branch.
 */
export async function reorderCategoriesAction(
  parentId: string | null,
  orderedIds: string[],
): Promise<ActionState> {
  const session = await requirePermission("categories", "update");
  const result = await workflows.catalog.reorderCategories(
    { parentId, orderedIds },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/catalog/categories");
  return { ok: true, message: "Ordre mis à jour." };
}

// ──────────────────────────────────────────────────────────── PRODUCTS

/**
 * Parse the "Caractéristiques clés" hidden field (`highlightsJson`, a JSON array of
 * free-text bullet strings emitted by HighlightsEditor) into a trimmed, blank-stripped,
 * order-preserving string[] (capped at 12 — the workflow schema's max). An absent or
 * malformed field yields [] (the editor always emits a valid array, so malformed is
 * only a crafted post; [] then simply clears the curated bullets).
 */
function parseHighlights(formData: FormData): string[] {
  const { arr } = parseJsonArrayField(formData.get("highlightsJson"));
  return arr
    .map((x) => String(x ?? "").trim())
    .filter((s) => s.length > 0)
    .slice(0, 12);
}

export async function createProductAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("products", "create");
  // Required-field gate — surface EVERY missing essential at once (name + price)
  // so the operator fixes them in one pass rather than discovering them one
  // submit at a time. The product form disables native HTML validation
  // (`noValidate`) because its required inputs sit on mounted-but-hidden
  // tabs/steps the browser can't focus, so this server check is what produces
  // the visible, tab-jumping notification. Price clarity: a BLANK price is NOT
  // silently defaulted to 0 (which would create a FREE product unawares) —
  // it is an explicit error; type `0` deliberately for a genuinely free product.
  const rawName = String(formData.get("name") ?? "").trim();
  const rawPriceTnd = String(formData.get("priceTnd") ?? "").trim();
  const missing: Record<string, string> = {};
  if (!rawName) missing.name = "Le nom du produit est requis.";
  if (rawPriceTnd === "") {
    missing.priceTnd = "Saisissez un prix (indiquez 0 pour un produit gratuit).";
  }
  if (Object.keys(missing).length > 0) {
    const labels: string[] = [];
    if (missing.name) labels.push("le nom");
    if (missing.priceTnd) labels.push("le prix");
    return {
      ok: false,
      error: "validation",
      message: `Informations manquantes : renseignez ${labels.join(" et ")} pour créer le produit.`,
      fieldErrors: missing,
    };
  }
  // A PRESENT-but-invalid price (thousands space "1 200", a stray letter "249o",
  // a doubled separator) stays a distinct "invalid" error.
  if (priceFieldToMinor(formData, "priceTnd") === undefined) {
    return {
      ok: false,
      error: "validation",
      message: "Prix invalide.",
      fieldErrors: { priceTnd: "Prix invalide — utilisez uniquement des chiffres (ex : 249.900)." },
    };
  }
  const result = await workflows.catalog.createProduct(
    {
      name: String(formData.get("name") ?? ""),
      slug: optional(formData, "slug"),
      platform: nullable(formData, "platform"),
      sku: nullable(formData, "sku"),
      gtin: nullable(formData, "gtin"),
      mpn: nullable(formData, "mpn"),
      condition:
        (optional(formData, "condition") as "new" | "used" | "refurbished" | undefined) ?? "new",
      externalRef: nullable(formData, "externalRef"),
      warrantyMonths: nullableInt(formData, "warrantyMonths"),
      warrantyLabel: nullable(formData, "warrantyLabel"),
      taxRateBps: taxBpsField(formData, "taxRateBps"),
      productType: (optional(formData, "productType") as "simple" | "variable" | undefined) ?? "simple",
      sharedVariantStock: variantStockMode(formData),
      shortDesc: String(formData.get("shortDesc") ?? ""),
      description: String(formData.get("description") ?? ""),
      highlights: parseHighlights(formData),
      priceCents: priceFieldToMinor(formData, "priceTnd") ?? 0,
      oldPriceCents: oldPriceFieldToMinor(formData, "oldPriceTnd"),
      inStock: formData.get("inStock") === "on",
      stockQty: optionalInt(formData, "stockQty"),
      // Purchase-qty limits: blank or <1 → null (no limit). max=1 = sold individually.
      minPurchaseQty: ((n) => (n != null && n >= 1 ? n : null))(optionalInt(formData, "minPurchaseQty")),
      maxPurchaseQty: ((n) => (n != null && n >= 1 ? n : null))(optionalInt(formData, "maxPurchaseQty")),
      videoUrl: nullable(formData, "videoUrl"),
      videoPosterMediaId: nullable(formData, "videoPosterMediaId"),
      videoTitle: nullable(formData, "videoTitle"),
      videoDescription: nullable(formData, "videoDescription"),
      metaTitle: nullable(formData, "metaTitle"),
      metaDescription: nullable(formData, "metaDescription"),
      canonicalUrl: nullable(formData, "canonicalUrl"),
      noindex: formData.get("noindex") === "on",
      ogImageMediaId: nullable(formData, "ogImageMediaId"),
      // Only present when the global sameAs switch is on (field rendered);
      // absent ⇒ nullable() returns undefined ⇒ create stores NULL, update
      // leaves the existing value unchanged.
      sameAs: nullable(formData, "sameAs"),
      displayOrder: optionalInt(formData, "displayOrder"),
      publish: formData.get("publish") === "on",
      isDiscountable: formData.get("isDiscountable") === "on",
      isPreorder: formData.get("isPreorder") === "on",
      preorderReleasesAt: nullable(formData, "preorderReleasesAt"),
      preorderMessage: nullable(formData, "preorderMessage"),
      categoryIds: pickAll(formData, "categoryIds"),
      primaryCategoryId: optionalUuid(formData, "primaryCategoryId"),
      brandId: optionalUuid(formData, "brandId"),
      mediaIds: pickAll(formData, "mediaIds"),
      attributeValueIds: pickAllUuid(formData, "attributeValueIds"),
      attributeScalars: pickScalars(formData),
      relatedMode: optional(formData, "relatedMode") as
        | "auto"
        | "same_subcategory"
        | "same_brand"
        | "mixed"
        | "ai"
        | "manual"
        | undefined,
      relatedProductIds: pickAllUuid(formData, "relatedProductIds"),
      complementaryProductIds: pickAllUuid(formData, "complementaryProductIds"),
      careLinks: pickCareLinks(formData),
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok)
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  revalidatePath("/admin/catalog/products");
  return { ok: true, message: "Produit créé.", id: result.data.productId };
}

export async function updateProductAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("products", "update");
  const productId = optional(formData, "productId");
  if (!productId) return { ok: false, error: "validation", message: "ID requis." };
  // Price clarity (mirror of createProductAction): a PRESENT-but-invalid price
  // ("1 200", "249o", a doubled separator) makes priceFieldToMinor return
  // undefined, which the update workflow SKIPS — so the edited price would
  // silently NOT save while the action still reports success. Reject it up front.
  // (A blank price on EDIT legitimately means "leave unchanged", so only a
  // non-empty-but-unparseable value is an error here.)
  const rawPriceTnd = String(formData.get("priceTnd") ?? "").trim();
  if (rawPriceTnd !== "" && priceFieldToMinor(formData, "priceTnd") === undefined) {
    return {
      ok: false,
      error: "validation",
      message: "Prix invalide.",
      fieldErrors: { priceTnd: "Prix invalide — utilisez uniquement des chiffres (ex : 249.900)." },
    };
  }
  const result = await workflows.catalog.updateProduct(
    {
      // Stock keys ONLY when the operator changed them (+ the page-load value for
      // the workflow's compare-and-set) — see editedStockFields.
      ...editedStockFields(formData),
      productId,
      name: optional(formData, "name"),
      slug: optional(formData, "slug"),
      platform: nullable(formData, "platform"),
      sku: nullable(formData, "sku"),
      gtin: nullable(formData, "gtin"),
      mpn: nullable(formData, "mpn"),
      condition:
        (optional(formData, "condition") as "new" | "used" | "refurbished" | undefined) ?? "new",
      externalRef: nullable(formData, "externalRef"),
      warrantyMonths: nullableInt(formData, "warrantyMonths"),
      warrantyLabel: nullable(formData, "warrantyLabel"),
      taxRateBps: taxBpsField(formData, "taxRateBps"),
      productType: (optional(formData, "productType") as "simple" | "variable" | undefined) ?? "simple",
      sharedVariantStock: variantStockMode(formData),
      // These two are always-mounted in the editor, so an empty submit means the
      // admin CLEARED them — read present-but-empty as "" (not undefined, which
      // optional() returns and the workflow then drops, making a blank impossible).
      shortDesc: String(formData.get("shortDesc") ?? ""),
      description: String(formData.get("description") ?? ""),
      highlights: parseHighlights(formData),
      priceCents: priceFieldToMinor(formData, "priceTnd"),
      oldPriceCents: oldPriceFieldToMinor(formData, "oldPriceTnd"),
      // Purchase-qty limits: blank or <1 → null (no limit). max=1 = sold individually.
      minPurchaseQty: ((n) => (n != null && n >= 1 ? n : null))(optionalInt(formData, "minPurchaseQty")),
      maxPurchaseQty: ((n) => (n != null && n >= 1 ? n : null))(optionalInt(formData, "maxPurchaseQty")),
      videoUrl: nullable(formData, "videoUrl"),
      videoPosterMediaId: nullable(formData, "videoPosterMediaId"),
      videoTitle: nullable(formData, "videoTitle"),
      videoDescription: nullable(formData, "videoDescription"),
      metaTitle: nullable(formData, "metaTitle"),
      metaDescription: nullable(formData, "metaDescription"),
      canonicalUrl: nullable(formData, "canonicalUrl"),
      noindex: formData.get("noindex") === "on",
      ogImageMediaId: nullable(formData, "ogImageMediaId"),
      // Only present when the global sameAs switch is on (field rendered);
      // absent ⇒ nullable() returns undefined ⇒ create stores NULL, update
      // leaves the existing value unchanged.
      sameAs: nullable(formData, "sameAs"),
      displayOrder: optionalInt(formData, "displayOrder"),
      publish: formData.get("publish") === "on",
      isDiscountable: formData.get("isDiscountable") === "on",
      isPreorder: formData.get("isPreorder") === "on",
      preorderReleasesAt: nullable(formData, "preorderReleasesAt"),
      preorderMessage: nullable(formData, "preorderMessage"),
      categoryIds: pickAll(formData, "categoryIds"),
      primaryCategoryId: optionalUuid(formData, "primaryCategoryId"),
      // The brand picker always posts `brandId`; « Retirer la marque » posts it
      // EMPTY, which must CLEAR the link (null) — optionalUuid alone collapsed it
      // to undefined ("leave unchanged"), so the removal silently never stuck. A
      // malformed non-empty value still leaves the brand untouched.
      brandId: !formData.has("brandId")
        ? undefined
        : optional(formData, "brandId") === undefined
          ? null
          : optionalUuid(formData, "brandId"),
      mediaIds: pickAll(formData, "mediaIds"),
      attributeValueIds: pickAllUuid(formData, "attributeValueIds"),
      attributeScalars: pickScalars(formData),
      relatedMode: optional(formData, "relatedMode") as
        | "auto"
        | "same_subcategory"
        | "same_brand"
        | "mixed"
        | "ai"
        | "manual"
        | undefined,
      relatedProductIds: pickAllUuid(formData, "relatedProductIds"),
      complementaryProductIds: pickAllUuid(formData, "complementaryProductIds"),
      careLinks: pickCareLinks(formData),
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok)
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };

  // Persist the product FAQs IN THE SAME SAVE. The editor also carries them in a
  // sibling form with its own button, but folding them into the main submit means
  // an operator who edits FAQs and clicks the main "Enregistrer" no longer loses
  // them (the #1 "my FAQs don't show up" cause). Only acts when the hidden input
  // is present (it is whenever the FAQ tab rendered = edit mode); absent ⇒ left
  // untouched so we never wipe FAQs from a context that doesn't manage them.
  // Best-effort: a FAQ hiccup must not fail the product save that already
  // committed — BUT the operator must be told the FAQ didn't persist, otherwise
  // they see full success while their FAQ edits silently vanished (the exact
  // "my FAQs don't show up" confusion this fold-in exists to end).
  let faqOk = true;
  if (formData.has("faqItemsJson")) {
    const faqItems = parseFaqItemsJson(optional(formData, "faqItemsJson"));
    faqOk = await workflows.cms
      .upsertProductFaqs({ productId, items: faqItems }, { actorUserId: session.user.id })
      .then((r) => r.ok)
      .catch((err) => {
        console.error("[updateProduct] FAQ persist failed", err);
        return false;
      });
  }

  // Persist the product VARIANTS IN THE SAME SAVE — same fold-in as the FAQ
  // above. The variant editor mirrors its set into the main form as
  // `variantsJson` ONCE the operator edits it, so the single "Enregistrer" saves
  // variants too (no separate variants button). Only acts when the hidden input
  // is present (⇒ the Variantes tab was touched); absent ⇒ variants untouched, so
  // an unrelated product save never re-writes them. Best-effort like the FAQ: a
  // variant hiccup (bad price, duplicate SKU, stale stock) must not fail the
  // product save that already committed — but the operator is told so their
  // variant edits don't silently vanish.
  let variantsOk = true;
  if (formData.has("variantsJson")) {
    const variantItems = parseVariantsJson(optional(formData, "variantsJson"));
    if (variantItems === null) {
      variantsOk = false;
    } else {
      variantsOk = await workflows.catalog
        .upsertProductVariants(
          { productId, variants: toVariantWorkflowInput(variantItems) },
          { actorUserId: session.user.id },
        )
        .then((r) => r.ok)
        .catch((err) => {
          console.error("[updateProduct] variants persist failed", err);
          return false;
        });
    }
  }

  revalidatePath("/admin/catalog/products");
  revalidatePath(`/admin/catalog/products/${productId}`);
  // Storefront PDP is force-dynamic, but revalidate the slug anyway so any
  // cached fetch/segment for it refreshes immediately after a FAQ/content edit.
  const slug = optional(formData, "slug");
  if (slug) revalidatePath(`/${slug}`);
  // Name the sub-editors that failed so the success banner points the operator
  // at the tab to retry from, instead of reporting a clean success over a
  // silently-dropped FAQ / variant edit.
  const failed = [!faqOk && "la FAQ", !variantsOk && "les variantes"].filter(Boolean) as string[];
  return {
    ok: true,
    message:
      failed.length === 0
        ? "Produit mis à jour."
        : `Produit mis à jour, mais l'enregistrement de ${failed.join(" et ")} a échoué — réessayez depuis l'onglet concerné.`,
    id: productId,
  };
}

/**
 * Save the full variant set for a product (the admin variant editor submits
 * the whole list as `variantsJson`). Mirrors the FAQ editor pattern: a
 * separate action keyed off a JSON blob, so the variant UI doesn't have to
 * cram dynamic rows into the main product FormData.
 */
type VariantJsonItem = {
  id?: string | null;
  label?: string;
  sku?: string | null;
  gtin?: string | null;
  mpn?: string | null;
  priceCents?: number;
  oldPriceCents?: number | null;
  stockQty?: number | null;
  inStock?: boolean;
  /** Page-load stock of an EXISTING variant (the editor sends them so only a
   *  stock the operator changed is written — see lib/catalog/editor-stock-fields). */
  origStockQty?: number | null;
  origInStock?: boolean;
  imageMediaId?: string | null;
  displayOrder?: number;
  isDefault?: boolean;
  attributeValueIds?: string[];
};

/** Parse the editor's `variantsJson` blob. `null` = malformed (caller reports a
 *  clear error); `[]` = empty/absent. Shared by the standalone action and the
 *  folded-in product save so both agree on parsing + defaults. */
function parseVariantsJson(raw: string | undefined): VariantJsonItem[] | null {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as VariantJsonItem[];
  } catch {
    return null;
  }
}

/** Map parsed variant rows → the upsert-variants workflow input. Shared by the
 *  standalone `upsertProductVariantsAction` and `updateProductAction`'s fold-in
 *  so the two paths stay byte-for-byte identical. */
function toVariantWorkflowInput(items: VariantJsonItem[]) {
  return items.map((v) => ({
    id: v.id ?? null,
    label: v.label?.trim() || "",
    sku: v.sku?.trim() || null,
    gtin: v.gtin?.trim() || null,
    mpn: v.mpn?.trim() || null,
    priceCents: toNonNegInt(v.priceCents),
    oldPriceCents:
      v.oldPriceCents != null && v.oldPriceCents !== 0 ? toIntOrNull(v.oldPriceCents) : null,
    ...variantStockFields(v),
    imageMediaId: v.imageMediaId || null,
    displayOrder: toIntOr(v.displayOrder, 0),
    isDefault: v.isDefault === true,
    attributeValueIds: Array.isArray(v.attributeValueIds) ? v.attributeValueIds : [],
  }));
}

export async function upsertProductVariantsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("products", "update");
  const productId = optional(formData, "productId");
  if (!productId) return { ok: false, error: "validation", message: "productId requis." };

  const items = parseVariantsJson(optional(formData, "variantsJson"));
  if (items === null)
    return { ok: false, error: "validation", message: "Données de variantes invalides." };

  const result = await workflows.catalog.upsertProductVariants(
    { productId, variants: toVariantWorkflowInput(items) },
    { actorUserId: session.user.id },
  );
  if (!result.ok)
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };

  revalidatePath(`/admin/catalog/products/${productId}`);
  revalidatePath("/admin/catalog/products");
  const slug = optional(formData, "productSlug");
  if (slug) revalidatePath(`/${slug}`);
  return { ok: true, message: `${result.data.count} variante(s) enregistrée(s).` };
}

/**
 * Bulk-update inventory for the global /admin/catalog/stock page.
 *
 * Bypasses `workflows.catalog.updateProduct` (a full product save) and writes
 * each row through `applyStockSet` — the lock-safe, ledgered stock helper
 * (`SELECT … FOR UPDATE`, records an "admin" `stock_movements` row, re-derives
 * an untouched availability from the new quantity). Only the stock columns
 * (`stock_qty` / `in_stock`, or the variant's) are written; `is_published` and
 * every other product column are left untouched.
 *
 * We still emit `product.updated` per row so the catalog-cache invalidator and
 * the `onAny` subscribers (audit row, outbound webhooks, metrics) fire the same
 * way the workflow would. The payload mirrors `updateProductWorkflow`'s emit so
 * subscribers don't need to special-case this surface.
 *
 * Future API hook: when an inventory provider lands, swap the body of
 * the per-row loop for `inventoryProvider.pushStock(row)` — the action
 * signature and the per-row error model stay stable.
 */
export async function bulkUpdateStockAction(
  updates: Array<{
    productId: string;
    /** When set, the edit targets this CHILD VARIANT (per-variant mode) instead
     *  of the product-level pool. The variant must belong to `productId`. */
    variantId?: string | null;
    inStock: boolean;
    stockQty: number | null;
    /** The operator explicitly toggled Disponible on this row. Otherwise an
     *  availability left as it was is RE-DERIVED from the new quantity (sold-out
     *  rule: restocking a sold-out line re-lists it; a delisted line stays so). */
    inStockExplicit?: boolean;
    /** The operator actually edited the QUANTITY on this row. When false, the
     *  quantity is left untouched (only the availability is written) — so a row
     *  where only Disponible was toggled can't re-write a stale page-load qty and
     *  resurrect sold units. Omitted (legacy/non-browser caller) ⇒ always write. */
    qtyExplicit?: boolean;
    /** The committed quantity the operator SAW when they started editing this row
     *  (optimistic compare-and-set). When present with a qty edit, the write is
     *  refused if the DB moved since — see applyStockSet's StockConflictError. */
    expectedStockQty?: number | null;
  }>,
): Promise<
  ActionState & {
    /** Per-row failures (productId + variantId + message) so the client can keep
     *  only the failed rows dirty and reconcile the rest. */
    failures?: Array<{ productId: string; variantId: string | null; message: string }>;
    /** Rows that committed (full or partial success) — lets the client clear
     *  exactly those drafts instead of wiping every view's edits. */
    saved?: Array<{ productId: string; variantId: string | null }>;
  }
> {
  const session = await requirePermission("stock", "update");

  if (!Array.isArray(updates) || updates.length === 0) {
    return { ok: false, error: "validation", message: "Aucune modification reçue." };
  }
  if (updates.length > 500) {
    return { ok: false, error: "too_many", message: "Trop de lignes à enregistrer en une fois (max 500)." };
  }

  type RowUpdate = (typeof updates)[number];
  const processRow = async (u: RowUpdate) => {
    const vid = u.variantId ?? null;
    const fail = (message: string) => ({ ok: false as const, productId: u.productId, variantId: vid, message });
    if (!/^[0-9a-f-]{36}$/i.test(u.productId)) return fail("ID invalide.");
    if (u.variantId != null && !/^[0-9a-f-]{36}$/i.test(u.variantId)) return fail("ID de variante invalide.");
    // Validate stock_qty server-side (the JS UI clamps, but a non-browser /
    // future inventory-hook caller could send a negative or NaN, which would
    // otherwise hit the products_stock_qty_nonneg CHECK as a raw DB error).
    if (u.stockQty !== null && (!Number.isInteger(u.stockQty) || u.stockQty < 0)) {
      return fail("Stock invalide (entier ≥ 0 ou vide).");
    }
    // Write the quantity only when the operator actually edited it (qtyExplicit).
    // A row where only Disponible was toggled leaves stock_qty untouched — it can
    // no longer re-write the stale page-load qty and resurrect sold units. When it
    // IS a qty edit, carry expectedStockQty so applyStockSet refuses (per-row
    // conflict) if the DB moved since the operator read it. A legacy caller that
    // sends neither flag keeps the old always-write, no-compare behaviour.
    const qtyPatch =
      u.qtyExplicit === false
        ? {}
        : { setQty: u.stockQty, ...("expectedStockQty" in u ? { expectedQty: u.expectedStockQty } : {}) };
    try {
      const prod = await productService.findById(u.productId);
      if (!prod) return fail("Produit introuvable.");

      // ── Variant target (per-variant stock mode) ──────────────────────────
      if (u.variantId != null) {
        const variant = await productQueries.findVariantById(u.variantId);
        if (!variant || variant.product_id !== u.productId) return fail("Variante introuvable.");
        // Availability the operator didn't touch (and left as it was) is
        // re-derived under the row lock from the new quantity — typing 10 on a
        // sold-out row now re-lists it instead of leaving it "Rupture".
        const explicitVariantInStock = u.inStockExplicit === true || u.inStock !== variant.in_stock;
        const res = await applyStockSet(
          { kind: "variant", rowId: u.variantId, productId: u.productId, variantId: u.variantId },
          { ...qtyPatch, ...(explicitVariantInStock ? { setInStock: u.inStock } : {}) },
          { reason: "admin", actorUserId: session.user.id },
        );
        // The parent product's listing availability may flip (its display
        // in-stock is "any variant in stock"), so revalidate via product.updated.
        await bus.emit(
          "product.updated",
          {
            productId: u.productId,
            slug: prod.slug,
            changedFields: ["variant_stock"],
            // `prod` loaded via findById above — ERP identifiers already on hand.
            sku: prod.sku,
            gtin: prod.gtin,
            externalRef: prod.external_ref,
          },
          { actorUserId: session.user.id },
        );
        // Unavailable → available, computed from the LOCKED before/after rows.
        if (res.becameAvailable) {
          await bus.emit("product.restocked", { productId: u.productId }, { actorUserId: session.user.id });
        }
        return { ok: true as const, productId: u.productId, variantId: vid };
      }

      // ── Product target (simple / shared-variant pool) ────────────────────
      // Stock + in_stock via the lock-safe, ledgered helper (FOR UPDATE inside —
      // serializes vs a concurrent order decrement and records an honest "admin"
      // movement). An untouched, unchanged availability is re-derived from the
      // new quantity (see the variant branch).
      const explicitInStock = u.inStockExplicit === true || u.inStock !== prod.in_stock;
      const res = await applyStockSet(
        { kind: "product", rowId: u.productId, productId: u.productId, variantId: null },
        { ...qtyPatch, ...(explicitInStock ? { setInStock: u.inStock } : {}) },
        { reason: "admin", actorUserId: session.user.id },
      );

      const changed = ["in_stock", "stock_qty"];
      await bus.emit(
        "product.updated",
        {
          productId: u.productId,
          slug: prod.slug,
          changedFields: changed,
          // `prod` loaded via findById above — ERP identifiers already on hand.
          sku: prod.sku,
          gtin: prod.gtin,
          externalRef: prod.external_ref,
        },
        { actorUserId: session.user.id },
      );
      // Restock drives the back-in-stock email to wishlist watchers. Fire on an
      // unavailable→available TRANSITION — covering BOTH tracked stock (qty 0 →
      // positive) and untracked availability (stock_qty NULL, the `in_stock`
      // toggle flips false → true) — computed from the LOCKED before/after rows.
      if (res.becameAvailable) {
        await bus.emit("product.restocked", { productId: u.productId }, { actorUserId: session.user.id });
      }
      return { ok: true as const, productId: u.productId, variantId: vid };
    } catch (err) {
      return fail(err instanceof Error ? err.message : "Erreur inattendue lors de la mise à jour.");
    }
  };

  // Process in chunks so a 500-row save can't exhaust the connection pool.
  const results: Array<Awaited<ReturnType<typeof processRow>>> = [];
  const CHUNK = 16;
  for (let i = 0; i < updates.length; i += CHUNK) {
    results.push(...(await Promise.all(updates.slice(i, i + CHUNK).map(processRow))));
  }

  const failed = results.filter((r) => !r.ok);
  const saved = results
    .filter((r) => r.ok)
    .map((r) => ({ productId: r.productId, variantId: r.variantId }));
  revalidatePath("/admin/catalog/stock");
  revalidatePath("/admin/catalog/products");

  if (failed.length === 0) {
    return { ok: true, message: `${updates.length} produit(s) mis à jour.`, saved };
  }
  // Partial failure: report WHICH rows failed (productId + variantId + message)
  // AND which committed, so the client keeps only the failed rows dirty and
  // reconciles the rest instead of treating the whole batch as lost.
  return {
    ok: false,
    error: "partial_failure",
    message: `${failed.length} ligne(s) en erreur sur ${updates.length}. La première : ${failed[0]?.message ?? "inconnue"}.`,
    failures: failed.map((f) => ({ productId: f.productId, variantId: f.variantId ?? null, message: f.message })),
    saved,
  };
}

/**
 * Set the GLOBAL default variant-stock mode (per-product overrides win). When
 * ON, a variable product with no explicit override shares one parent pool.
 *
 * The mode is baked into the CACHED product DTO (each variant's inStock/stockQty
 * + the product's availability, lib/api/products.ts 'use cache'), while the cart
 * and checkout read it live — so bust the product tags (every cached PDP entry
 * carries `products:list`) or the PDP keeps showing the old mode's availability
 * for up to the cacheLife ceiling. The store-wide change is audited through
 * `setting.upserted` (the admin settings event); the key stays in app_secrets.
 */
export async function setVariantStockDefaultAction(shared: boolean): Promise<ActionState> {
  const session = await requirePermission("stock", "update");
  try {
    await setSharedStockDefault(shared);
  } catch (err) {
    console.error("[setVariantStockDefault] persist failed", err);
    return {
      ok: false,
      error: "internal",
      message: "Impossible d'enregistrer le mode de stock des variantes. Réessayez.",
    };
  }
  bustCacheTag(CACHE_TAGS.productsList);
  bustCacheTag(CACHE_TAGS.products);
  revalidatePath("/", "layout");
  revalidatePath("/admin/catalog/stock");
  await bus.emit(
    "setting.upserted",
    { key: VARIANT_STOCK_SHARED_DEFAULT_KEY, groupKey: "stock" },
    { actorUserId: session.user.id },
  );
  return { ok: true, message: shared ? "Stock partagé activé par défaut." : "Stock par variante par défaut." };
}

/**
 * Duplicate an existing product as a fresh draft. The heavy lifting lives
 * in `workflows.catalog.duplicateProduct` so association replication +
 * event emission stays inside the workflow layer.
 */
export async function duplicateProductAction(productId: string): Promise<ActionState> {
  const session = await requirePermission("products", "create");
  if (!/^[0-9a-f-]{36}$/i.test(productId)) {
    return { ok: false, error: "validation", message: "ID produit invalide." };
  }
  const result = await workflows.catalog.duplicateProduct(
    { productId },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/catalog/products");
  return {
    ok: true,
    // The copy never inherits the source's physical units — say so, so the
    // operator enters the real count before publishing.
    message: result.data.stockReset
      ? "Produit dupliqué (brouillon). Le stock de la copie a été remis à 0 — saisissez sa quantité réelle."
      : "Produit dupliqué (brouillon).",
    id: result.data.productId,
  };
}

/**
 * Publish / unpublish a product (the UI labels are "Publier" / "Dépublier";
 * `archived = true` means unpublish). This ONLY flips `is_published = false` —
 * the product then surfaces under the list's "Brouillon" filter (visible to
 * admin, hidden from storefront). It is NOT a soft-delete: the list's
 * "Supprimé" status filter is a DISTINCT view of soft-deleted rows
 * (`deleted_at IS NOT NULL`), so unpublished and deleted are separate buckets —
 * this action never touches `deleted_at`.
 */
export async function setProductArchivedAction(
  productId: string,
  archived: boolean,
): Promise<ActionState> {
  const session = await requirePermission("products", "update");
  if (!/^[0-9a-f-]{36}$/i.test(productId)) {
    return { ok: false, error: "validation", message: "ID produit invalide." };
  }
  const result = await workflows.catalog.updateProduct(
    { productId, publish: !archived },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/catalog/products");
  return {
    ok: true,
    // This action only flips is_published — say "dépublié/publié", not
    // "archivé" (which would read as the distinct soft-delete / "Supprimé").
    message: archived ? "Produit dépublié." : "Produit publié.",
  };
}

export async function deleteProductAction(productId: string): Promise<ActionState> {
  const session = await requirePermission("products", "delete");
  const result = await workflows.catalog.deleteProduct(
    { productId },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/catalog/products");
  return { ok: true, message: "Produit supprimé." };
}

// ──────────────────────────────────────────────────────────── MEDIA
export async function uploadMediaAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("media", "create");
  // Throttle the heavy sharp/S3 pipeline per admin — the JSON upload route caps
  // this, and the Médiathèque page drives THIS action, so it needs the same cap
  // (shared bucket) or the limit is bypassable. The workflow itself stays
  // un-throttled: bulk internal callers (demo seed, product import) rely on it.
  const rl = await checkRateLimit({ bucket: `media-upload:${session.user.id}`, max: 30, windowSeconds: 60 });
  if (!rl.ok) {
    return { ok: false, error: "rate_limited", message: "Trop de requêtes. Réessayez dans un instant." };
  }
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "no_file", message: "Aucun fichier sélectionné." };
  }
  const result = await workflows.media.upload({
    file,
    // Allow-listed (buildStorageKey interpolates it verbatim as the S3 prefix,
    // and it gates the products-only détourage) — mirrors the JSON routes.
    scope: parseMediaUploadScope(formData.get("scope")),
    altText: optional(formData, "altText"),
    uploadedBy: session.user.id,
  });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/media");
  return { ok: true, message: "Image téléversée.", id: result.data.mediaId };
}

/**
 * Import an image by URL into the médiathèque. The server downloads it
 * (SSRF-hardened) and runs the identical pipeline as a file upload, so the
 * result is a normal media row with webp/avif variants.
 */
export async function importMediaFromUrlAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("media", "create");
  // Same anti-abuse cap as the import-url JSON route (shared bucket): this action
  // triggers an OUTBOUND server-side fetch + re-encode, so an un-throttled path
  // is an egress/CPU amplifier. Workflow stays open for the bulk product import.
  const rl = await checkRateLimit({ bucket: `media-import:${session.user.id}`, max: 30, windowSeconds: 60 });
  if (!rl.ok) {
    return { ok: false, error: "rate_limited", message: "Trop de requêtes. Réessayez dans un instant." };
  }
  const url = optional(formData, "url");
  if (!url) return { ok: false, error: "no_url", message: "URL requise." };
  const result = await workflows.media.importFromUrl({
    url,
    scope: parseMediaUploadScope(formData.get("scope")),
    altText: optional(formData, "altText"),
    uploadedBy: session.user.id,
  });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/media");
  return { ok: true, message: "Image importée depuis l'URL.", id: result.data.mediaId };
}

export async function deleteMediaAction(mediaId: string): Promise<ActionState> {
  const session = await requirePermission("media", "delete");
  const result = await workflows.media.delete({ mediaId }, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/media");
  return { ok: true, message: "Image supprimée." };
}

/**
 * How many catalogue/CMS/blog records still reference a media — for the delete
 * confirm so the admin is warned before removing an in-use asset (delete purges
 * the S3 bytes, so an in-use image silently vanishes from the storefront).
 */
export async function mediaUsageCountAction(mediaId: string): Promise<number> {
  await requirePermission("media", "view");
  // countMediaReferences casts ${mediaId}::uuid in raw SQL; a non-UUID would
  // raise 22P02 instead of a clean answer. Guard the boundary (mirrors the
  // /api/admin/media route) — an unknown id simply has zero references.
  if (!isUuid(mediaId)) return 0;
  return mediaQueries.countMediaReferences(mediaId);
}

/**
 * Validate a client-supplied bulk selection: an array of 1..BULK_MEDIA_MAX UUIDs
 * (deduped). Returns the clean list or a French error message. The cap lives in
 * modules/media/limits so the Médiathèque panel checks the same number.
 */
function parseBulkMediaIds(raw: unknown): { ids: string[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Aucune image sélectionnée." };
  if (raw.length > BULK_MEDIA_MAX) {
    return { error: `Sélection trop grande (${BULK_MEDIA_MAX} images maximum à la fois).` };
  }
  if (!raw.every((id) => isUuid(id))) return { error: "Identifiant d'image invalide." };
  return { ids: Array.from(new Set(raw as string[])) };
}

/**
 * Which of the selected media are still referenced by a catalogue / CMS / blog /
 * aid / settings record — for the BULK delete confirm, so the admin sees (and
 * must explicitly acknowledge) the in-use images before an irreversible purge.
 * Same source list as the single-delete count (listReferencedMediaIds ⇔
 * countMediaReferences ⇔ listOrphans). Invalid input (empty, over the cap,
 * non-UUID) THROWS rather than returning [] — an empty list would read as « none
 * in use » in the confirm, while a rejection makes the dialog say it could not
 * check (the delete action re-validates and re-checks server-side anyway).
 */
export async function listMediaInUseAction(mediaIds: string[]): Promise<string[]> {
  await requirePermission("media", "view");
  const parsed = parseBulkMediaIds(mediaIds);
  if ("error" in parsed) throw new Error(parsed.error);
  const used = await mediaQueries.listReferencedMediaIds(parsed.ids);
  return parsed.ids.filter((id) => used.has(id));
}

/**
 * Bulk-delete a list of media rows — each row is soft-deleted then its S3
 * objects are permanently purged (not byte-recoverable). Fans out the
 * single-delete workflow with BOUNDED concurrency — each row touches its own DB
 * row + S3 keys + audit event (no shared state to race on), but an unbounded
 * Promise.all over a select-all (~100 rows × ~4 variant deletes) would storm the
 * node-postgres pool + object store; batches of `CONCURRENCY` cap that pressure.
 * Partial failures are tallied — caller decides what to show.
 *
 * In-use guard: unless `confirmInUse` is explicitly true, a selection containing
 * any still-referenced image is REFUSED as a whole (nothing deleted) and the
 * in-use ids are returned (`error: "in_use"`), so the confirm dialog can list
 * them and ask for the explicit second confirmation. Re-checked here — not
 * trusted from the dialog — so a reference added after the dialog opened (or a
 * stale client) still can't purge an in-use image blind.
 */
export async function bulkDeleteMediaAction(input: {
  mediaIds: string[];
  /** The operator explicitly acknowledged deleting images that are still in use. */
  confirmInUse?: boolean;
}): Promise<ActionState & { successCount?: number; failCount?: number; inUseIds?: string[] }> {
  const session = await requirePermission("media", "delete");
  const parsed = parseBulkMediaIds(input?.mediaIds);
  if ("error" in parsed) return { ok: false, error: "validation", message: parsed.error };
  const mediaIds = parsed.ids;

  if (input.confirmInUse !== true) {
    const used = await mediaQueries.listReferencedMediaIds(mediaIds);
    const inUseIds = mediaIds.filter((id) => used.has(id));
    if (inUseIds.length > 0) {
      const n = inUseIds.length;
      return {
        ok: false,
        error: "in_use",
        message:
          n > 1
            ? `${n} images de la sélection sont encore utilisées — confirmez explicitement pour les supprimer aussi.`
            : "1 image de la sélection est encore utilisée — confirmez explicitement pour la supprimer aussi.",
        inUseIds,
      };
    }
  }

  const CONCURRENCY = 8;
  const results: Awaited<ReturnType<typeof workflows.media.delete>>[] = [];
  for (let i = 0; i < mediaIds.length; i += CONCURRENCY) {
    const batch = mediaIds.slice(i, i + CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map((mediaId) =>
          workflows.media.delete({ mediaId }, { actorUserId: session.user.id }),
        ),
      )),
    );
  }
  const successCount = results.filter((r) => r.ok).length;
  const failCount = results.length - successCount;
  // One operator-level summary event for the whole action (curated audit row +
  // storefront cache bust + webhook). `results` is index-aligned with
  // `mediaIds` (batches + Promise.all preserve order). `storageKeys` is EMPTY on
  // purpose: every row's objects were already reaped by its own `media.deleted`
  // (cleanup-media-storage), so the storage subscriber has nothing left to do.
  const deletedIds = mediaIds.filter((_, i) => results[i]?.ok);
  if (deletedIds.length > 0) {
    await bus.emit(
      "media.bulk_deleted",
      { mediaIds: deletedIds, deletedCount: deletedIds.length, storageKeys: [] },
      { actorUserId: session.user.id },
    );
  }
  revalidatePath("/admin/media");
  if (successCount === 0 && failCount > 0) {
    return {
      ok: false,
      error: "all_failed",
      message: `Aucune image supprimée (${failCount} échec${failCount > 1 ? "s" : ""}).`,
      successCount,
      failCount,
    };
  }
  return {
    ok: true,
    message:
      failCount > 0
        ? `${successCount} supprimée(s), ${failCount} échec(s).`
        : `${successCount} image(s) supprimée(s).`,
    successCount,
    failCount,
  };
}

export async function updateMediaAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("media", "update");
  const mediaId = optional(formData, "mediaId");
  if (!mediaId) return { ok: false, error: "validation", message: "ID requis." };
  const urlOverride = formData.has("urlOverride")
    ? (optional(formData, "urlOverride") ?? null)
    : undefined;
  // url_override is the FIRST link of every resolver chain: a `javascript:` /
  // `data:` value, a typo or a host next/image + the CSP don't allow would break
  // the image everywhere it's used, silently. Same build-time host allow-list
  // as cdn_base_url (modules/media/cdn-allowlist). An UNCHANGED stored value
  // (e.g. an external URL written by a catalogue import) is let through so
  // editing the alt text still saves.
  if (urlOverride) {
    const urlError = checkUrlOverride(urlOverride, bakedMediaHostSources());
    if (urlError) {
      const current = isUuid(mediaId)
        ? (await mediaQueries.findMediaByIds([mediaId])).get(mediaId)
        : undefined;
      if ((current?.url_override ?? "").trim() !== urlOverride) {
        return {
          ok: false,
          error: "validation",
          message: "URL externe invalide.",
          fieldErrors: { urlOverride: urlError },
        };
      }
    }
  }
  const result = await workflows.media.update(
    {
      mediaId,
      altText: formData.has("altText") ? (optional(formData, "altText") ?? null) : undefined,
      filename: optional(formData, "filename"),
      urlOverride,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/media");
  return { ok: true, message: "Image mise à jour." };
}

export async function updateMediaSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_media", "update");
  const result = await workflows.media.updateSettings(
    {
      generate_webp: formData.get("generate_webp") === "on",
      generate_avif: formData.get("generate_avif") === "on",
      keep_original: formData.get("keep_original") === "on",
      product_white_bg: formData.get("product_white_bg") === "on",
      product_white_bg_main_only: formData.get("product_white_bg_main_only") === "on",
      strip_exif: formData.get("strip_exif") === "on",
      max_width_px: optionalInt(formData, "max_width_px"),
      max_height_px: optionalInt(formData, "max_height_px"),
      webp_quality: optionalInt(formData, "webp_quality"),
      avif_quality: optionalInt(formData, "avif_quality"),
      jpeg_quality: optionalInt(formData, "jpeg_quality"),
      max_upload_mb: optionalInt(formData, "max_upload_mb"),
      default_alt_text: formData.has("default_alt_text")
        ? (optional(formData, "default_alt_text") ?? null)
        : undefined,
      cdn_base_url: formData.has("cdn_base_url")
        ? (optional(formData, "cdn_base_url") ?? null)
        : undefined,
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok)
    return {
      ok: false,
      error: result.error,
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  revalidatePath("/admin/media");
  revalidatePath("/admin/media/settings");
  return { ok: true, message: "Réglages enregistrés." };
}

// ────────────────────────────────────────────────────── helpers
/**
 * Tri-state variant stock mode from the editor's <select name="sharedVariantStock">:
 *   "shared" → true, "per_variant" → false, "inherit"/"" → null (use global
 *   default). Absent (field not submitted) → undefined (leave unchanged on PATCH).
 */
function variantStockMode(form: FormData): boolean | null | undefined {
  if (!form.has("sharedVariantStock")) return undefined;
  const v = String(form.get("sharedVariantStock") ?? "");
  if (v === "shared") return true;
  if (v === "per_variant") return false;
  return null; // "inherit" / ""
}

function optional(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  if (v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}
/**
 * Like `optional`, but distinguishes "field absent" (→ undefined, leave
 * unchanged) from "field present but empty" (→ null, explicitly clear).
 * Use for editable fields that must be removable — e.g. the video block,
 * where blanking the URL should hide the section, not no-op.
 */
function nullable(form: FormData, key: string): string | null | undefined {
  if (!form.has(key)) return undefined;
  const s = String(form.get(key) ?? "").trim();
  return s.length ? s : null;
}
function optionalInt(form: FormData, key: string): number | undefined {
  const v = optional(form, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
/**
 * Reads a price field entered in DINARS (major units, "249,9" or "249.9") and
 * returns integer minor units (millimes), or undefined when absent/blank/invalid.
 * Accepts the fr-FR decimal comma. See src/lib/price.ts for the scale.
 */
function priceFieldToMinor(form: FormData, key: string): number | undefined {
  const v = optional(form, key);
  if (v === undefined) return undefined;
  const n = Number(v.replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return undefined;
  return dinarsToMinor(n);
}
/**
 * Like `priceFieldToMinor`, but distinguishes "field absent" (→ undefined,
 * leave unchanged) from "field present but empty" (→ null, explicitly clear).
 * Used for the compare-at / old price so blanking it on edit actually removes
 * the strike-through instead of no-oping.
 */
function priceFieldToMinorNullable(form: FormData, key: string): number | null | undefined {
  if (!form.has(key)) return undefined;
  const s = String(form.get(key) ?? "").trim();
  if (!s.length) return null;
  const n = Number(s.replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return null;
  return dinarsToMinor(n);
}
/**
 * Compare-at / OLD-price field. Like `priceFieldToMinorNullable`, but treats a
 * typed `0` (or any non-positive) as "no compare-at" → null, instead of letting a
 * 0 reach the schema's `oldPriceCents: z.number().positive()` and fail with a
 * cryptic "Validation échouée". Mirrors the variant editor, which serializes a 0
 * old-price as null (product-variants-editor.tsx). "field absent" → undefined
 * (leave unchanged); present-but-blank/0/invalid → null (clear the strike-through);
 * present-positive → millimes. Kept separate from `priceFieldToMinor`, which the
 * MAIN price field reuses where 0 is a legal value ("produit gratuit").
 */
function oldPriceFieldToMinor(form: FormData, key: string): number | null | undefined {
  const v = priceFieldToMinorNullable(form, key);
  if (v === undefined) return undefined;
  return v !== null && v > 0 ? v : null;
}
/**
 * Like `nullable`, but for integers. "field absent" → undefined (leave the
 * column unchanged), "present but empty" → null (explicitly clear → inherit),
 * "present with a number" → that integer. Non-numeric input collapses to null
 * so a stray value never silently pins the wrong number. Used for the warranty
 * override, where a blank field must mean "inherit from category/global".
 */
function nullableInt(form: FormData, key: string): number | null | undefined {
  if (!form.has(key)) return undefined;
  const s = String(form.get(key) ?? "").trim();
  if (!s.length) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}
/**
 * Reads a TVA rate entered as a PERCENT ("19", "19,5") and returns the value
 * in BASIS POINTS for the `tax_rate_bps` columns. Same absent/empty/value
 * semantics as `nullableInt`: "field absent" → undefined (leave unchanged),
 * "present but empty" → null (clear → inherit category/global), "present with a
 * number" → `bpsFromPercent(value)`. Accepts the fr-FR decimal comma. Negative
 * or non-numeric input collapses to null so a stray value never pins a wrong
 * rate.
 */
function taxBpsField(form: FormData, key: string): number | null | undefined {
  if (!form.has(key)) return undefined;
  const s = String(form.get(key) ?? "").trim();
  if (!s.length) return null;
  const n = Number(s.replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return null;
  return bpsFromPercent(n);
}
function optionalUuid(form: FormData, key: string): string | undefined {
  const v = optional(form, key);
  return v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined;
}
function pickAll(form: FormData, key: string): string[] {
  return form.getAll(key).map((v) => String(v).trim()).filter(Boolean);
}
function pickAllUuid(form: FormData, key: string): string[] {
  return pickAll(form, key).filter((v) => /^[0-9a-f-]{36}$/i.test(v));
}

/**
 * Read per-product attribute SCALARS from the product form. The picker submits
 * one hidden input per number/text attribute:
 *   `attrScalarNum.<attributeId>`  → numeric value (string)
 *   `attrScalarText.<attributeId>` → free text
 * An empty value is kept (it CLEARS that scalar via setScalar). Only well-formed
 * UUID keys + finite numbers survive. Returns one entry per submitted attribute.
 */
const UUID_RE = /^[0-9a-f-]{36}$/i;
function pickScalars(
  form: FormData,
): { attributeId: string; numericValue?: number | null; textValue?: string | null }[] {
  const out: { attributeId: string; numericValue?: number | null; textValue?: string | null }[] = [];
  for (const [key, raw] of form.entries()) {
    const value = String(raw);
    if (key.startsWith("attrScalarNum.")) {
      const id = key.slice("attrScalarNum.".length);
      if (!UUID_RE.test(id)) continue;
      const trimmed = value.trim();
      const n = trimmed === "" ? null : Number(trimmed);
      out.push({ attributeId: id, numericValue: n !== null && Number.isFinite(n) ? n : null });
    } else if (key.startsWith("attrScalarText.")) {
      const id = key.slice("attrScalarText.".length);
      if (!UUID_RE.test(id)) continue;
      out.push({ attributeId: id, textValue: value.trim() === "" ? null : value });
    }
  }
  return out;
}

/**
 * Read the "Tokyo Care" per-product overrides from the product form. The picker
 * submits one field per plan the operator moved off "Auto":
 *   `careMode.<planId>`     → "include" | "exclude"
 *   `careOverride.<planId>` → price in DINARS (optional; only for an include) →
 *                             MILLIMES here. A plan left on "Auto" emits NOTHING
 *                             (it follows the plan's category scope — no row).
 * The returned array is always sent to the workflow (even empty), so a save
 * REPLACES the product's whole override set — matching the picker, which is
 * pre-filled from the stored overrides.
 */
function pickCareLinks(
  form: FormData,
): { carePlanId: string; mode: "include" | "exclude"; overridePriceCents: number | null }[] {
  const out: { carePlanId: string; mode: "include" | "exclude"; overridePriceCents: number | null }[] = [];
  for (const [key, raw] of form.entries()) {
    if (!key.startsWith("careMode.")) continue;
    const id = key.slice("careMode.".length);
    if (!UUID_RE.test(id)) continue;
    const mode = String(raw).trim();
    if (mode !== "include" && mode !== "exclude") continue;
    let overridePriceCents: number | null = null;
    if (mode === "include") {
      const ov = optional(form, `careOverride.${id}`);
      if (ov !== undefined) {
        const n = Number.parseFloat(ov.replace(/\s/g, "").replace(",", "."));
        if (Number.isFinite(n) && n >= 0) overridePriceCents = dinarsToMinor(n);
      }
    }
    out.push({ carePlanId: id, mode, overridePriceCents });
  }
  return out;
}

/**
 * Parse a JSON-encoded value-prop array from a hidden form field. Returns
 * `undefined` when the field is blank (so the workflow leaves the column
 * untouched) and silently drops malformed entries.
 */
function parseValueProps(raw: string | undefined): CategoryValueProp[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    return parsed
      .filter(
        (p): p is CategoryValueProp =>
          p !== null &&
          typeof p === "object" &&
          typeof (p as { icon?: unknown }).icon === "string" &&
          typeof (p as { title?: unknown }).title === "string" &&
          typeof (p as { body?: unknown }).body === "string",
      )
      .map((p) => ({
        icon: p.icon,
        iconMediaId:
          typeof (p as { iconMediaId?: unknown }).iconMediaId === "string"
            ? (p as { iconMediaId: string }).iconMediaId
            : null,
        title: p.title,
        body: p.body,
      }));
  } catch {
    return undefined;
  }
}
