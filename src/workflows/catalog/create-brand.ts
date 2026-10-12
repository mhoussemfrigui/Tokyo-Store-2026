import "server-only";

import { z } from "zod";

import { db } from "@/lib/db/client";
import { brandService } from "@/modules/catalog/brand/service";
import { countLivePromotionsForScope } from "@/modules/promotion/queries";
import { bus } from "@/events/bus";
import { checkSlugAvailability } from "@/lib/utils/slug-conflict";
import { syncEntityUrlRedirects } from "@/lib/redirects/auto-slug-redirect";
import { slugSchema, slugify } from "../helpers";
import { fail, ok, workflow } from "../shared";

const valuePropSchema = z.object({
  icon: z.string().trim().max(60),
  // Optional custom médiathèque icon image; wins over the lucide key at render.
  iconMediaId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(120),
  body: z.string().trim().max(500),
});

/**
 * A nullable, UNIQUE brand identifier (external_ref). Trims, then normalizes an
 * empty/whitespace value to NULL so "no reference" is stored as NULL and never
 * collides on the partial unique index. Mirrors products/categories.
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
 * Brand-level TVA override in BASIS POINTS (1900 = 19 %) — the brand tier of the
 * product → rule → brand → category → global cascade (see @/lib/tax). `null`
 * clears it (inherit). Capped at 10000 bps (100 %): DB + Zod both guard the range
 * (brands_tax_rate_bps_range, migration 0138) — a typo like 150 (%) can never
 * reach checkout as a 150 % surcharge.
 */
const taxRateBpsField = z.number().int().min(0).max(10000).nullable().optional();

export const createBrandSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema.optional(),
  // Long-form intro. HTML allowed (sanitized at render, like products/categories).
  // Nullable so a blank field CLEARS the column (form sends null, not undefined).
  description: z.string().trim().max(20000).nullable().optional(),
  // External reference for ERP linkage (unique among live brands; empty → null).
  externalRef: uniqueRefField(120),
  logoMediaId: z.string().uuid().nullable().optional(),
  // Listing chip icon — a curated lucide key (icon) + an optional custom image
  // (iconMediaId). Both nullable so a blank field clears the column.
  icon: z.string().trim().max(60).nullable().optional(),
  iconMediaId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().default(true),
  // Global per-brand discount opt-out (mirrors categories.isDiscountable).
  isDiscountable: z.boolean().default(true),
  // Manual list order; omitted → the workflow lands the brand at the end of the
  // flat group (max sibling order + 1).
  displayOrder: z.number().int().min(0).optional(),
  heroMediaId: z.string().uuid().nullable().optional(),
  tagline: z.string().trim().max(200).nullable().optional(),
  editorialEyebrow: z.string().trim().max(120).nullable().optional(),
  editorialTitle: z.string().trim().max(200).nullable().optional(),
  // Editorial body — HTML allowed (sanitized at render). Generous cap.
  editorialBody: z.string().trim().max(20000).nullable().optional(),
  valueProps: z.array(valuePropSchema).max(8).optional(),
  metaTitle: z.string().trim().max(160).nullable().optional(),
  metaDescription: z.string().trim().max(300).nullable().optional(),
  // Canonical override; empty → null (fall back to the settings-derived /slug).
  canonicalUrl: z.string().trim().max(500).nullable().optional(),
  noindex: z.boolean().optional().default(false),
  ogImageMediaId: z.string().uuid().nullable().optional(),
  taxRateBps: taxRateBpsField,
});

export const createBrandWorkflow = workflow<
  [z.input<typeof createBrandSchema>, { actorUserId: string }],
  { brandId: string; slug: string }
>("brand.create", async (input, { actorUserId }) => {
  const parsed = createBrandSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", "Validation échouée", flattenErrors(parsed.error));
  }
  const slug = parsed.data.slug ?? slugify(parsed.data.name);

  // Brands sit on `/[slug]` — same flat namespace as categories, products,
  // and CMS pages. The centralised checker returns a precise reason on
  // collision (e.g. "déjà utilisé par le produit « submariner »").
  const availability = await checkSlugAvailability(slug);
  if (!availability.ok) {
    return fail("conflict", availability.message, { slug: availability.message });
  }

  // Land a new brand at the END of the flat list (max order + 1) instead of 0, so
  // fresh brands don't all pile at the top until reordered. An explicit
  // displayOrder (e.g. an ERP import) still wins.
  let displayOrder = parsed.data.displayOrder;
  if (displayOrder == null) {
    const all = await brandService.listAll();
    displayOrder = all.reduce((max, b) => Math.max(max, b.display_order), -1) + 1;
  }

  const brand = await brandService.insert({
    name: parsed.data.name,
    slug,
    description: parsed.data.description ?? null,
    external_ref: parsed.data.externalRef ?? null,
    logo_media_id: parsed.data.logoMediaId ?? null,
    icon: parsed.data.icon ?? null,
    icon_media_id: parsed.data.iconMediaId ?? null,
    is_active: parsed.data.isActive,
    is_discountable: parsed.data.isDiscountable,
    display_order: displayOrder,
    hero_media_id: parsed.data.heroMediaId ?? null,
    tagline: parsed.data.tagline ?? null,
    editorial_eyebrow: parsed.data.editorialEyebrow ?? null,
    editorial_title: parsed.data.editorialTitle ?? null,
    editorial_body: parsed.data.editorialBody ?? null,
    value_props: parsed.data.valueProps ?? null,
    meta_title: parsed.data.metaTitle ?? null,
    meta_description: parsed.data.metaDescription ?? null,
    canonical_url: parsed.data.canonicalUrl ?? null,
    noindex: parsed.data.noindex,
    og_image_media_id: parsed.data.ogImageMediaId ?? null,
    tax_rate_bps: parsed.data.taxRateBps ?? null,
  });

  await bus.emit("brand.created", { brandId: brand.id, slug: brand.slug }, { actorUserId });
  return ok({ brandId: brand.id, slug: brand.slug });
});

export const updateBrandSchema = z.object({
  brandId: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  slug: slugSchema.optional(),
  description: z.string().trim().max(20000).optional().nullable(),
  externalRef: uniqueRefField(120),
  logoMediaId: z.string().uuid().nullable().optional(),
  icon: z.string().trim().max(60).nullable().optional(),
  iconMediaId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
  // NO `.default()` here — this schema is not `.partial()`, so an omitted key must
  // stay undefined (not fall back to a default that a sparse ERP PATCH would apply).
  isDiscountable: z.boolean().optional(),
  displayOrder: z.number().int().min(0).optional(),
  heroMediaId: z.string().uuid().nullable().optional(),
  tagline: z.string().trim().max(200).nullable().optional(),
  editorialEyebrow: z.string().trim().max(120).nullable().optional(),
  editorialTitle: z.string().trim().max(200).nullable().optional(),
  editorialBody: z.string().trim().max(20000).nullable().optional(),
  valueProps: z.array(valuePropSchema).max(8).nullable().optional(),
  metaTitle: z.string().trim().max(160).nullable().optional(),
  metaDescription: z.string().trim().max(300).nullable().optional(),
  canonicalUrl: z.string().trim().max(500).nullable().optional(),
  noindex: z.boolean().optional(),
  ogImageMediaId: z.string().uuid().nullable().optional(),
  taxRateBps: taxRateBpsField,
});

export const updateBrandWorkflow = workflow<
  [z.input<typeof updateBrandSchema>, { actorUserId: string }],
  { brandId: string }
>("brand.update", async (input, { actorUserId }) => {
  const parsed = updateBrandSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenErrors(parsed.error));

  const existing = await brandService.findById(parsed.data.brandId);
  if (!existing) return fail("not_found", "Marque introuvable.");

  const patch: Parameters<typeof brandService.update>[1] = {};
  const changed: string[] = [];
  if (parsed.data.name !== undefined && parsed.data.name !== existing.name) {
    patch.name = parsed.data.name;
    changed.push("name");
  }
  if (parsed.data.slug !== undefined && parsed.data.slug !== existing.slug) {
    const availability = await checkSlugAvailability(parsed.data.slug, {
      excludeKind: "brand",
      excludeId: existing.id,
      currentPaths: [`/${existing.slug}`],
    });
    if (!availability.ok) {
      return fail("conflict", availability.message, { slug: availability.message });
    }
    patch.slug = parsed.data.slug;
    changed.push("slug");
  }
  if (parsed.data.description !== undefined) {
    patch.description = parsed.data.description;
    changed.push("description");
  }
  if (parsed.data.externalRef !== undefined) {
    patch.external_ref = parsed.data.externalRef;
    changed.push("external_ref");
  }
  if (parsed.data.logoMediaId !== undefined) {
    patch.logo_media_id = parsed.data.logoMediaId;
    // The webhook contract promises DB COLUMN names (every other field pushes its
    // real column) — emit "logo_media_id", not the "logo" DTO alias.
    changed.push("logo_media_id");
  }
  if (parsed.data.icon !== undefined) {
    patch.icon = parsed.data.icon;
    changed.push("icon");
  }
  if (parsed.data.iconMediaId !== undefined) {
    patch.icon_media_id = parsed.data.iconMediaId;
    changed.push("icon_media_id");
  }
  if (parsed.data.isActive !== undefined) {
    patch.is_active = parsed.data.isActive;
    changed.push("is_active");
  }
  if (parsed.data.isDiscountable !== undefined) {
    patch.is_discountable = parsed.data.isDiscountable;
    changed.push("is_discountable");
  }
  if (parsed.data.displayOrder !== undefined) {
    patch.display_order = parsed.data.displayOrder;
    changed.push("display_order");
  }
  if (parsed.data.heroMediaId !== undefined) {
    patch.hero_media_id = parsed.data.heroMediaId;
    changed.push("hero_media_id");
  }
  if (parsed.data.tagline !== undefined) {
    patch.tagline = parsed.data.tagline;
    changed.push("tagline");
  }
  if (parsed.data.editorialEyebrow !== undefined) {
    patch.editorial_eyebrow = parsed.data.editorialEyebrow;
    changed.push("editorial_eyebrow");
  }
  if (parsed.data.editorialTitle !== undefined) {
    patch.editorial_title = parsed.data.editorialTitle;
    changed.push("editorial_title");
  }
  if (parsed.data.editorialBody !== undefined) {
    patch.editorial_body = parsed.data.editorialBody;
    changed.push("editorial_body");
  }
  if (parsed.data.valueProps !== undefined) {
    patch.value_props = parsed.data.valueProps;
    changed.push("value_props");
  }
  if (parsed.data.metaTitle !== undefined) {
    patch.meta_title = parsed.data.metaTitle;
    changed.push("meta_title");
  }
  if (parsed.data.metaDescription !== undefined) {
    patch.meta_description = parsed.data.metaDescription;
    changed.push("meta_description");
  }
  if (parsed.data.canonicalUrl !== undefined) {
    patch.canonical_url = parsed.data.canonicalUrl;
    changed.push("canonical_url");
  }
  if (parsed.data.noindex !== undefined) {
    patch.noindex = parsed.data.noindex;
    changed.push("noindex");
  }
  if (parsed.data.ogImageMediaId !== undefined) {
    patch.og_image_media_id = parsed.data.ogImageMediaId;
    changed.push("og_image_media_id");
  }
  if (parsed.data.taxRateBps !== undefined && parsed.data.taxRateBps !== existing.tax_rate_bps) {
    patch.tax_rate_bps = parsed.data.taxRateBps;
    changed.push("tax_rate_bps");
  }

  if (Object.keys(patch).length > 0) {
    await brandService.update(existing.id, patch);
    await bus.emit("brand.updated", { brandId: existing.id, changedFields: changed }, { actorUserId });
  }
  // Redirect upkeep (see syncEntityUrlRedirects): renaming an ACTIVE brand keeps
  // its old flat `/[slug]` URL working (301 old → new; `/brand/old` already 308s
  // to `/old`, so it follows), and a rename or re-activation frees the brand's
  // URL from an active rule that would shadow it.
  await syncEntityUrlRedirects(
    {
      wasLive: existing.is_active,
      isLive: patch.is_active ?? existing.is_active,
      before: [`/${existing.slug}`],
      after: [`/${patch.slug ?? existing.slug}`],
    },
    { actorUserId, label: `slug de la marque « ${patch.name ?? existing.name} » modifié` },
  );
  return ok({ brandId: existing.id });
});

/**
 * Bulk-set brand TVA rates — the « Marques » tab of /admin/system/tax (the only
 * place a brand rate is edited). Validates EVERY row first (0–100 %, the same
 * `taxRateBpsField` as updateBrand), then writes only the rows whose rate differs
 * from the stored one, ALL in one transaction (never a partial save), and emits
 * `brand.updated` per changed brand after commit — so the audit trail, outbound
 * webhooks and the brand cache tag see each change exactly as updateBrandWorkflow
 * would (`changedFields: ["tax_rate_bps"]` does not trigger a re-embed). Ids that
 * no longer resolve to a live brand are skipped.
 */
export const setBrandTaxRatesSchema = z.object({
  rates: z
    .array(
      z.object({
        brandId: z.string().uuid(),
        taxRateBps: taxRateBpsField.transform((v) => v ?? null),
      }),
    )
    .max(5000),
});

export const setBrandTaxRatesWorkflow = workflow<
  [z.input<typeof setBrandTaxRatesSchema>, { actorUserId: string }],
  { changedIds: string[] }
>("brand.tax_rates.set", async (input, { actorUserId }) => {
  const parsed = setBrandTaxRatesSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", "Taux invalide : saisissez un pourcentage entre 0 et 100.", flattenErrors(parsed.error));
  }

  const wanted = new Map(parsed.data.rates.map((r) => [r.brandId, r.taxRateBps]));
  const current = await brandService.findByIds([...wanted.keys()]);
  const changes = current
    .filter((b) => (b.tax_rate_bps ?? null) !== wanted.get(b.id))
    .map((b) => ({ id: b.id, bps: wanted.get(b.id) ?? null }));
  if (changes.length === 0) return ok({ changedIds: [] });

  await db.transaction(async (tx) => {
    for (const c of changes) await brandService.update(c.id, { tax_rate_bps: c.bps }, tx);
  });
  for (const c of changes) {
    await bus.emit("brand.updated", { brandId: c.id, changedFields: ["tax_rate_bps"] }, { actorUserId });
  }
  return ok({ changedIds: changes.map((c) => c.id) });
});

/**
 * Reorder the FLAT brand list by `display_order`. The admin "Réorganiser" mode
 * sends every live brand id in its new order; the service renumbers 0..n and
 * returns the ids that actually moved. Emits `brand.updated` per moved brand so the
 * `brands` cache tag busts (the /marques index + nav strip re-read) and the change
 * lands in the audit trail + outbound webhooks — the parentless twin of
 * reorderCategoriesWorkflow. `changedFields: ["display_order"]` does NOT re-embed.
 */
export const reorderBrandsSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(1000),
});

export const reorderBrandsWorkflow = workflow<
  [z.input<typeof reorderBrandsSchema>, { actorUserId: string }],
  { changed: string[] }
>("brand.reorder", async (input, { actorUserId }) => {
  const parsed = reorderBrandsSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenErrors(parsed.error));
  const changed = await brandService.reorderSiblings(parsed.data.orderedIds);
  for (const brandId of changed) {
    await bus.emit("brand.updated", { brandId, changedFields: ["display_order"] }, { actorUserId });
  }
  return ok({ changed });
});

export const deleteBrandWorkflow = workflow<
  [{ brandId: string }, { actorUserId: string }],
  { brandId: string }
>("brand.delete", async ({ brandId }, { actorUserId }) => {
  const existing = await brandService.findById(brandId);
  if (!existing) return fail("not_found", "Marque introuvable.");
  // Same guard as deleteCategoryWorkflow: a promotion / scoped coupon still
  // targeting this brand would point at a tombstone nobody can pick or see any
  // more (the brand link readers ignore deleted brands, so it would silently
  // stop applying). Product links stay on this SOFT delete and stop resolving.
  const livePromos = await countLivePromotionsForScope("brand", brandId);
  if (livePromos > 0) {
    return fail(
      "conflict",
      `Cette marque est ciblée par ${livePromos} promotion(s) active(s) — désactivez-les d'abord.`,
    );
  }
  await brandService.softDelete(brandId);
  await bus.emit("brand.deleted", { brandId }, { actorUserId });
  return ok({ brandId });
});

function flattenErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    out[issue.path[0]?.toString() ?? "form"] = issue.message;
  }
  return out;
}
