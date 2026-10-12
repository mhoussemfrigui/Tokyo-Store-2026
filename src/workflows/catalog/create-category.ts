import "server-only";

import { z } from "zod";

import { db } from "@/lib/db/client";
import { categoryService } from "@/modules/catalog/category/service";
import { attributeService } from "@/modules/catalog/attribute/service";
import { productQueries } from "@/modules/catalog/product";
import { countLivePromotionsForScope } from "@/modules/promotion/queries";
import { productCategoryLinks } from "@/associations/catalog.service";
import { bus } from "@/events/bus";
import { checkSlugAvailability } from "@/lib/utils/slug-conflict";
import { syncEntityUrlRedirects } from "@/lib/redirects/auto-slug-redirect";
import { slugSchema, slugify } from "../helpers";
import { fail, flattenZodError, ok, workflow } from "../shared";

const valuePropSchema = z.object({
  icon: z.string().trim().max(60),
  // Optional custom médiathèque icon image; wins over the lucide key at render.
  iconMediaId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(120),
  body: z.string().trim().max(500),
});

/**
 * A nullable, UNIQUE category identifier (external_ref). Trims, then normalizes
 * an empty/whitespace value to NULL — so "no reference" is stored as NULL and
 * never as "", which would otherwise be a real value that collides on the
 * partial unique index. Mirrors the products `uniqueRefField` so an ERP syncing
 * ref-less categories never gets spurious 409s.
 */
const uniqueRefField = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema.optional(),
  // Nullable so a blank field CLEARS the column (the admin form sends null for
  // an emptied field, not undefined — see catalog.ts `nullable()`).
  tagline: z.string().trim().max(200).nullable().optional(),
  // Long-form intro. HTML is allowed (sanitized at render with sanitizeRichHtml,
  // same pipeline as product descriptions); the cap is generous for rich markup.
  description: z.string().trim().max(20000).nullable().optional(),
  // External reference for ERP linkage (unique among live categories; empty → null).
  externalRef: uniqueRefField(120),
  parentId: z.string().uuid().nullable().optional(),
  // Warranty default for products in this category (global → category →
  // product cascade, see @/lib/warranty). `null` clears → products fall back
  // to the global default; a number sets the category-level coverage in
  // months. A sub-category with its own value overrides its parent.
  warrantyMonths: z.number().int().min(0).max(600).nullable().optional(),
  warrantyLabel: z.string().trim().max(120).nullable().optional(),
  // Category-level TVA default in BASIS POINTS (1900 = 19 %), part of the
  // product → rule → brand → category → global cascade (see @/lib/tax). `null` clears
  // → products fall back to the global default; a number sets the rate for the
  // whole category. A sub-category value overrides its parent. Capped at 10000
  // bps (100 %). The admin enters a percent; the action converts to bps.
  taxRateBps: z.number().int().min(0).max(10000).nullable().optional(),
  displayOrder: z.number().int().min(0).optional(),
  metaTitle: z.string().trim().max(160).nullable().optional(),
  metaDescription: z.string().trim().max(300).nullable().optional(),
  // Canonical override; empty → null (fall back to the settings-derived /slug).
  canonicalUrl: z.string().trim().max(500).nullable().optional(),
  noindex: z.boolean().optional().default(false),
  ogImageMediaId: z.string().uuid().nullable().optional(),
  heroMediaId: z.string().uuid().nullable().optional(),
  // Dedicated /boutique chooser image (separate from the hero).
  boutiqueImageMediaId: z.string().uuid().nullable().optional(),
  // Listing chip icon — a curated lucide key (icon) + an optional custom image
  // (iconMediaId). Both nullable so a blank field clears the column.
  icon: z.string().trim().max(60).nullable().optional(),
  iconMediaId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional().default(true),
  isDiscountable: z.boolean().optional().default(true),
  editorialEyebrow: z.string().trim().max(120).nullable().optional(),
  editorialTitle: z.string().trim().max(200).nullable().optional(),
  // Editorial body — HTML allowed (sanitized at render). Generous cap.
  editorialBody: z.string().trim().max(20000).nullable().optional(),
  valueProps: z.array(valuePropSchema).max(8).optional(),
});

export const createCategoryWorkflow = workflow<
  [z.input<typeof createCategorySchema>, { actorUserId: string }],
  { categoryId: string; slug: string }
>("category.create", async (input, { actorUserId }) => {
  const parsed = createCategorySchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));

  const slug = parsed.data.slug ?? slugify(parsed.data.name);
  const parentId = parsed.data.parentId ?? null;

  // Validate the parent exists and is LIVE. The self-FK only enforces physical
  // row existence (so a soft-deleted parent would satisfy it yet leave the child
  // dangling off a tombstoned row — the very orphan state Phase A prevents), and
  // a nonexistent uuid would raise an unmapped 23503 → opaque 500. findById
  // filters deleted_at, so this turns both cases into a clean validation error.
  const parent = parentId != null ? await categoryService.findById(parentId) : null;
  if (parentId != null && !parent) {
    return fail("validation", "Catégorie parente introuvable.", { parentId: "Parent invalide" });
  }

  // Categories sit on top-level URLs (`/montres`, `/submariner`, …),
  // sharing the namespace with products, brands, and CMS pages. A category
  // slug colliding with any of them — or with a static route like
  // `/about` — would shadow the URL silently. `checkSlugAvailability`
  // covers every entity in one pass and returns a precise reason (a
  // sub-category's nested `/parent/slug` is checked for an active redirect too).
  const availability = await checkSlugAvailability(slug, {
    extraPaths: parent ? [`/${parent.slug}/${slug}`] : [],
  });
  if (!availability.ok) {
    return fail("conflict", availability.message, { slug: availability.message });
  }
  // Also enforce sibling uniqueness for parent-child trees (independent of
  // the cross-entity check — two categories under different parents can
  // both be `montres` only if the cross-entity guard passed, which it
  // won't unless one is renamed). Kept as a belt-and-braces safeguard.
  const sibling = await categoryService.findBySlug(slug, parentId);
  if (sibling) {
    return fail("conflict", "Slug déjà utilisé dans ce niveau.", { slug: "Slug déjà utilisé" });
  }

  // Default a new category to the END of its sibling group (max sibling order + 1)
  // instead of 0 — otherwise every freshly-created category defaulted to 0 and sat
  // tied at the TOP of its level until an operator manually reordered. An explicit
  // displayOrder from the caller (e.g. an ERP import) still wins.
  let displayOrder = parsed.data.displayOrder;
  if (displayOrder == null) {
    const siblings = await categoryService.listChildren(parentId);
    displayOrder = siblings.reduce((max, s) => Math.max(max, s.display_order), -1) + 1;
  }

  const cat = await categoryService.insert({
    name: parsed.data.name,
    slug,
    tagline: parsed.data.tagline ?? null,
    description: parsed.data.description ?? null,
    external_ref: parsed.data.externalRef ?? null,
    parent_id: parentId,
    warranty_months: parsed.data.warrantyMonths ?? null,
    warranty_label: parsed.data.warrantyLabel ?? null,
    tax_rate_bps: parsed.data.taxRateBps ?? null,
    display_order: displayOrder,
    meta_title: parsed.data.metaTitle ?? null,
    meta_description: parsed.data.metaDescription ?? null,
    canonical_url: parsed.data.canonicalUrl ?? null,
    noindex: parsed.data.noindex,
    og_image_media_id: parsed.data.ogImageMediaId ?? null,
    hero_media_id: parsed.data.heroMediaId ?? null,
    boutique_image_media_id: parsed.data.boutiqueImageMediaId ?? null,
    icon: parsed.data.icon ?? null,
    icon_media_id: parsed.data.iconMediaId ?? null,
    is_active: parsed.data.isActive,
    is_discountable: parsed.data.isDiscountable,
    editorial_eyebrow: parsed.data.editorialEyebrow ?? null,
    editorial_title: parsed.data.editorialTitle ?? null,
    editorial_body: parsed.data.editorialBody ?? null,
    value_props: parsed.data.valueProps ?? null,
  });

  await bus.emit(
    "category.created",
    { categoryId: cat.id, slug: cat.slug, parentId },
    { actorUserId },
  );
  return ok({ categoryId: cat.id, slug: cat.slug });
});

export const updateCategorySchema = createCategorySchema
  .partial()
  .extend({ categoryId: z.string().uuid() });

export const updateCategoryWorkflow = workflow<
  [z.input<typeof updateCategorySchema>, { actorUserId: string }],
  { categoryId: string }
>("category.update", async (input, { actorUserId }) => {
  const parsed = updateCategorySchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));

  // Zod KEEPS `.default()` through `.partial()`, so a sparse patch (e.g. just
  // { categoryId, name } from the API) parses isActive/isDiscountable back to
  // their `true` defaults — which, if applied, would silently re-activate an
  // archived category or re-enable discounts the operator turned off. Gate every
  // field on whether the CALLER actually sent that key (raw input), exactly like
  // updateProductWorkflow. The admin form sends every key, so it's unaffected.
  const provided = new Set(Object.keys((input ?? {}) as Record<string, unknown>));

  const existing = await categoryService.findById(parsed.data.categoryId);
  if (!existing) return fail("not_found", "Catégorie introuvable.");

  // Cross-entity slug check when the slug is changing — plus an active redirect
  // on the category's URLs after the rename (flat + nested `/parent/slug`); one
  // leading back to its CURRENT URLs is the rename-back case (released below).
  if (parsed.data.slug && parsed.data.slug !== existing.slug) {
    const [oldParentSlug, newParentSlug] = await Promise.all([
      parentSlugOf(existing.parent_id),
      parentSlugOf(parsed.data.parentId !== undefined ? parsed.data.parentId : existing.parent_id),
    ]);
    const availability = await checkSlugAvailability(parsed.data.slug, {
      excludeKind: "category",
      excludeId: existing.id,
      extraPaths: newParentSlug ? [`/${newParentSlug}/${parsed.data.slug}`] : [],
      currentPaths: categoryPaths(existing.slug, oldParentSlug),
    });
    if (!availability.ok) {
      return fail("conflict", availability.message, { slug: availability.message });
    }
  }

  // Parent-cycle guard. Re-parenting a category under itself or under one of
  // its OWN descendants creates a `parent_id` loop that would make the tree
  // recursion (getCategoryTree) and breadcrumb walks spin. Walk UP from the
  // proposed parent: if we reach this category's id, the chosen parent is a
  // descendant → reject. (The depth cap is a belt-and-braces stop for any
  // pre-existing loop in the data.)
  const nextParentId = parsed.data.parentId;
  if (nextParentId != null && nextParentId !== existing.parent_id) {
    if (nextParentId === existing.id) {
      return fail("validation", "Une catégorie ne peut pas être son propre parent.", {
        parentId: "Parent invalide",
      });
    }
    // Reject re-parenting onto a nonexistent / soft-deleted target (would 23503→500
    // for a missing uuid, or silently dangle the node under a tombstone). findById
    // filters deleted_at, so a null result covers both. Doubles as the seed for the
    // cycle walk below (the walk uses the same deleted_at-filtered lookups).
    const target = await categoryService.findById(nextParentId);
    if (!target) {
      return fail("validation", "Catégorie parente introuvable.", { parentId: "Parent invalide" });
    }
    let cursor: string | null = nextParentId;
    const seen = new Set<string>();
    let depth = 0;
    while (cursor && depth < 32) {
      if (cursor === existing.id) {
        return fail(
          "validation",
          "Le parent choisi est une sous-catégorie de cette catégorie.",
          { parentId: "Hiérarchie invalide" },
        );
      }
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const node = await categoryService.findById(cursor);
      cursor = node?.parent_id ?? null;
      depth++;
    }
  }

  const patch: Parameters<typeof categoryService.update>[1] = {};
  const changed: string[] = [];

  const set = <K extends string>(key: K, dbKey: keyof typeof patch, value: unknown) => {
    // Only apply a field the caller actually sent (guards against Zod defaults
    // injected through `.partial()` — see `provided` above).
    if (provided.has(key) && value !== undefined) {
      patch[dbKey] = value as never;
      changed.push(String(dbKey));
    }
  };

  set("name", "name", parsed.data.name);
  set("slug", "slug", parsed.data.slug);
  set("tagline", "tagline", parsed.data.tagline);
  set("description", "description", parsed.data.description);
  set("externalRef", "external_ref", parsed.data.externalRef);
  set("displayOrder", "display_order", parsed.data.displayOrder);
  set("metaTitle", "meta_title", parsed.data.metaTitle);
  set("metaDescription", "meta_description", parsed.data.metaDescription);
  set("canonicalUrl", "canonical_url", parsed.data.canonicalUrl);
  set("noindex", "noindex", parsed.data.noindex);
  set("ogImageMediaId", "og_image_media_id", parsed.data.ogImageMediaId);
  set("heroMediaId", "hero_media_id", parsed.data.heroMediaId);
  set("boutiqueImageMediaId", "boutique_image_media_id", parsed.data.boutiqueImageMediaId);
  set("icon", "icon", parsed.data.icon);
  set("iconMediaId", "icon_media_id", parsed.data.iconMediaId);
  set("isActive", "is_active", parsed.data.isActive);
  set("isDiscountable", "is_discountable", parsed.data.isDiscountable);
  set("parentId", "parent_id", parsed.data.parentId);
  set("warrantyMonths", "warranty_months", parsed.data.warrantyMonths);
  set("warrantyLabel", "warranty_label", parsed.data.warrantyLabel);
  set("taxRateBps", "tax_rate_bps", parsed.data.taxRateBps);
  set("editorialEyebrow", "editorial_eyebrow", parsed.data.editorialEyebrow);
  set("editorialTitle", "editorial_title", parsed.data.editorialTitle);
  set("editorialBody", "editorial_body", parsed.data.editorialBody);
  set("valueProps", "value_props", parsed.data.valueProps);

  if (Object.keys(patch).length > 0) {
    await categoryService.update(existing.id, patch);
    await bus.emit(
      "category.updated",
      { categoryId: existing.id, changedFields: changed },
      { actorUserId },
    );
  }

  // Redirect upkeep (see syncEntityUrlRedirects): renaming an ACTIVE category
  // keeps its old URLs working (301 → the new canonical FLAT `/[slug]`): the flat
  // `/old` every nav / sitemap link uses, and for a sub-category also its nested
  // `/parent/old` form (served by `/[slug]/[sub]`, whose canonical is the flat
  // URL too). A rename, a re-parent or a re-activation frees the category's URLs
  // from an active rule that would shadow them.
  const finalSlug = patch.slug ?? existing.slug;
  const finalParentId = patch.parent_id !== undefined ? patch.parent_id : existing.parent_id;
  const finalActive = patch.is_active ?? existing.is_active;
  if (
    finalSlug !== existing.slug ||
    finalParentId !== existing.parent_id ||
    (finalActive && !existing.is_active)
  ) {
    const [oldParentSlug, newParentSlug] = await Promise.all([
      parentSlugOf(existing.parent_id),
      parentSlugOf(finalParentId),
    ]);
    await syncEntityUrlRedirects(
      {
        wasLive: existing.is_active,
        isLive: finalActive,
        before: categoryPaths(existing.slug, oldParentSlug),
        after: categoryPaths(finalSlug, newParentSlug),
      },
      { actorUserId, label: `slug de la catégorie « ${patch.name ?? existing.name} » modifié` },
    );
  }
  return ok({ categoryId: existing.id });
});

/** A category's parent slug (null for a root / missing parent). */
async function parentSlugOf(parentId: string | null | undefined): Promise<string | null> {
  if (!parentId) return null;
  return (await categoryService.findById(parentId))?.slug ?? null;
}

/** A category's storefront URLs: the canonical flat `/slug`, then the nested `/parent/slug`. */
function categoryPaths(slug: string, parentSlug: string | null): string[] {
  return parentSlug ? [`/${slug}`, `/${parentSlug}/${slug}`] : [`/${slug}`];
}

/**
 * Bulk-set category TVA rates — the « Catégories » tab of /admin/system/tax.
 * Validates EVERY row first (0–100 %, the same `taxRateBps` rule as the category
 * form, mirroring the `categories_tax_rate_bps_range` CHECK), then writes only
 * the rows whose rate differs from the stored one, ALL in one transaction — a bad
 * row can no longer raise a raw 23514 halfway through a loop of auto-committed
 * updates (partial save + error screen). Emits `category.updated` per changed
 * category after commit so the audit trail, outbound webhooks and the category
 * cache tags see each change like updateCategoryWorkflow would. Ids that no
 * longer resolve to a live category are skipped.
 */
export const setCategoryTaxRatesSchema = z.object({
  rates: z
    .array(
      z.object({
        categoryId: z.string().uuid(),
        taxRateBps: createCategorySchema.shape.taxRateBps.transform((v) => v ?? null),
      }),
    )
    .max(5000),
});

export const setCategoryTaxRatesWorkflow = workflow<
  [z.input<typeof setCategoryTaxRatesSchema>, { actorUserId: string }],
  { changedIds: string[] }
>("category.tax_rates.set", async (input, { actorUserId }) => {
  const parsed = setCategoryTaxRatesSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      "validation",
      "Taux invalide : saisissez un pourcentage entre 0 et 100.",
      flattenZodError(parsed.error),
    );
  }

  const wanted = new Map(parsed.data.rates.map((r) => [r.categoryId, r.taxRateBps]));
  const current = await categoryService.findByIds([...wanted.keys()]);
  const changes = [...current.values()]
    .filter((c) => (c.tax_rate_bps ?? null) !== wanted.get(c.id))
    .map((c) => ({ id: c.id, bps: wanted.get(c.id) ?? null }));
  if (changes.length === 0) return ok({ changedIds: [] });

  await db.transaction(async (tx) => {
    for (const c of changes) await categoryService.update(c.id, { tax_rate_bps: c.bps }, tx);
  });
  for (const c of changes) {
    await bus.emit(
      "category.updated",
      { categoryId: c.id, changedFields: ["tax_rate_bps"] },
      { actorUserId },
    );
  }
  return ok({ changedIds: changes.map((c) => c.id) });
});

/**
 * Reorder ONE sibling group by `display_order`. The drill-down panel sends the
 * parent (null for roots) and the sibling ids in their new order; the service
 * renumbers 0..n scoped to that parent only (a foreign id can't touch another
 * branch) and returns the ids that actually moved. Emits `category.updated`
 * per moved category so the mega-menu / listing chip order cache busts and the
 * change lands in the audit trail + outbound webhooks — same post-write emit as
 * setCategoryTaxRatesWorkflow.
 */
export const reorderCategoriesSchema = z.object({
  parentId: z.string().uuid().nullable().optional(),
  orderedIds: z.array(z.string().uuid()).min(1).max(500),
});

export const reorderCategoriesWorkflow = workflow<
  [z.input<typeof reorderCategoriesSchema>, { actorUserId: string }],
  { changed: string[] }
>("category.reorder", async (input, { actorUserId }) => {
  const parsed = reorderCategoriesSchema.safeParse(input);
  if (!parsed.success)
    return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  const changed = await categoryService.reorderSiblings(
    parsed.data.parentId ?? null,
    parsed.data.orderedIds,
  );
  for (const categoryId of changed) {
    await bus.emit(
      "category.updated",
      { categoryId, changedFields: ["display_order"] },
      { actorUserId },
    );
  }
  return ok({ changed });
});

export const deleteCategoryWorkflow = workflow<
  [{ categoryId: string }, { actorUserId: string }],
  { categoryId: string }
>("category.delete", async ({ categoryId }, { actorUserId }) => {
  const existing = await categoryService.findById(categoryId);
  if (!existing) return fail("not_found", "Catégorie introuvable.");
  // A promotion / scoped coupon still targeting this category would keep
  // pointing at a tombstone the operator can no longer pick or see (the link
  // readers ignore deleted categories, so it would silently stop applying).
  // Make the operator retire it first.
  const livePromos = await countLivePromotionsForScope("category", categoryId);
  if (livePromos > 0) {
    return fail(
      "conflict",
      `Cette catégorie est ciblée par ${livePromos} promotion(s) active(s) — désactivez-les d'abord.`,
    );
  }
  // Soft-delete AND promote any live children one level up (to this node's own
  // parent) in one transaction — so a deleted parent's sub-tree stays attached
  // and navigable instead of dangling off a tombstoned row (which used to make
  // those children vanish from the admin tree entirely).
  //
  // Its PRODUCT links move to that parent in the same transaction (is_primary
  // kept): left on the tombstone they dropped the products out of the parent's
  // listing / nav counts and — via a dead primary — out of the category TVA /
  // warranty chain. A ROOT category has no parent: its links stay (the product↔
  // category FK only CASCADEs on a hard delete) and simply stop resolving — every
  // link reader skips deleted categories.
  //
  // The category_attribute_filters links MUST go in the same transaction (the
  // mirror of deleteAttributeWorkflow): the FK only cascades on a hard delete, so
  // a lingering link to this tombstoned category would be loaded by the
  // attribute-side « Catégories » picker, re-submitted on every save, and rejected
  // there as "Catégorie introuvable ou archivée" — permanently bricking it.
  const movedProductIds = await db.transaction(async (tx) => {
    const { parentId } = await categoryService.softDeleteWithChildPromotion(categoryId, tx);
    const moved = parentId
      ? await productCategoryLinks.moveToCategory(categoryId, parentId, tx)
      : [];
    await attributeService.setCategoryFilters(categoryId, [], tx);
    return moved;
  });
  await bus.emit("category.deleted", { categoryId }, { actorUserId });
  // The moved products' category set changed: product.updated per live product
  // (like the auto-assign apply) busts their cached PDP / listing tags, re-marks
  // their embedding (category names are embedded — category.deleted's own
  // re-mark finds no link left once they moved) and lands in the audit trail /
  // webhooks. Post-commit, best-effort.
  if (movedProductIds.length > 0) {
    const rows = await productQueries.listProductsByIds(movedProductIds).catch(() => []);
    for (const r of rows) {
      await bus
        .emit(
          "product.updated",
          {
            productId: r.id,
            slug: r.slug,
            changedFields: ["categories"],
            // Full rows loaded — carry the ERP identifiers on the enriched event.
            sku: r.sku,
            gtin: r.gtin,
            externalRef: r.external_ref,
          },
          { actorUserId },
        )
        .catch(() => {});
    }
  }
  return ok({ categoryId });
});
