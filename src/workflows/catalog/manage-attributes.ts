import "server-only";

import { z } from "zod";

import { db } from "@/lib/db/client";
import { attributeService } from "@/modules/catalog/attribute/service";
import { attributeKindEnum, VALUE_LIST_ATTRIBUTE_KINDS } from "@/modules/catalog/attribute/schema";
import { categoryService } from "@/modules/catalog/category/service";
import { productQueries } from "@/modules/catalog/product";
import { taxService } from "@/modules/tax";
import { bus } from "@/events/bus";
import { slugSchema, slugify } from "../helpers";
import { fail, flattenZodError, ok, workflow } from "../shared";

/**
 * Attributes workflows — PrestaShop / WooCommerce-style product attributes.
 *
 * Supersedes the old `categories.filter_config` JSONB column (dropped in
 * migration 0004) with a proper relational model. These workflows handle CRUD on the attribute +
 * value rows; M2M wiring (which products carry which value, which attributes
 * appear as filters on which category) is exposed through `attributeService`
 * for callers that already have an admin session.
 */

// Sourced from the pgEnum so the workflow validation can never drift from the
// DB enum (select | multiselect | color | boolean | number | text).
const attributeKindSchema = z.enum(attributeKindEnum.enumValues);

const attributeValueInputSchema = z.object({
  slug: slugSchema.optional(),
  label: z.string().trim().min(1).max(120),
  displayOrder: z.number().int().min(0).optional(),
  /** Hex colour for kind="color" values (e.g. "#1d4ed8"). */
  colorHex: z.string().trim().max(9).nullable().optional(),
});

export const createAttributeSchema = z.object({
  slug: slugSchema.optional(),
  name: z.string().trim().min(1).max(120),
  kind: attributeKindSchema.optional().default("multiselect"),
  displayOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional().default(true),
  /** Optional seed values inserted in the same transaction. */
  values: z.array(attributeValueInputSchema).max(50).optional(),
});

/** True for kinds whose data is a value list (select/multiselect/color/boolean). */
function isValueListKind(kind: string): boolean {
  return (VALUE_LIST_ATTRIBUTE_KINDS as readonly string[]).includes(kind);
}

/**
 * In-use guard for a kind change that would strand or hard-delete an
 * attribute's current values: blocks while live variants vary on them, products
 * carry them as facets, or a TVA rule targets one. `action` prefixes the French
 * message (« Conversion en booléen impossible : … »). Null when free to convert.
 */
async function valuesInUseFail(attributeId: string, action: string) {
  const valueIds = (await attributeService.listValuesForAttribute(attributeId)).map((v) => v.id);
  if (valueIds.length === 0) return null;
  const usedByVariants = await productQueries.countLiveVariantsUsingValues(valueIds);
  if (usedByVariants > 0) {
    return fail(
      "in_use",
      `${action} impossible : ${usedByVariants} variante(s) utilisent les valeurs actuelles — supprimez-les d'abord.`,
    );
  }
  const usedByFacets = await attributeService.countAssignmentsUsingValues(valueIds);
  if (usedByFacets > 0) {
    return fail(
      "in_use",
      `${action} impossible : ${usedByFacets} produit(s) filtrent sur les valeurs actuelles — retirez ces assignations d'abord.`,
    );
  }
  const usedByTax = await taxService.countRulesUsingValues(valueIds);
  if (usedByTax > 0) {
    return fail(
      "in_use",
      `${action} impossible : une règle de TVA porte sur une valeur actuelle — supprimez-la d'abord (Réglages → TVA).`,
    );
  }
  return null;
}

export const createAttributeWorkflow = workflow<
  [z.input<typeof createAttributeSchema>, { actorUserId: string }],
  { attributeId: string; slug: string }
>("attribute.create", async (input, { actorUserId }) => {
  const parsed = createAttributeSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));

  const slug = parsed.data.slug ?? slugify(parsed.data.name);
  // A name that slugifies to nothing (emoji/punctuation-only, no explicit slug)
  // would otherwise persist with an empty slug — reject it, like the seed values below.
  if (!slugSchema.safeParse(slug).success) {
    return fail(
      "validation",
      "Le nom ne produit pas d'identifiant valide — utilisez des lettres ou des chiffres.",
      { name: "Nom invalide" },
    );
  }

  const conflict = await attributeService.findAttributeBySlug(slug);
  if (conflict) {
    return fail("conflict", "Slug déjà utilisé.", { slug: "Slug déjà utilisé" });
  }

  // Resolve every seed value BEFORE any write, so a bad value fails the whole
  // create cleanly instead of stranding a half-seeded attribute.
  type SeedValue = { slug: string; label: string; display_order: number; color_hex?: string | null };
  const seedValues: SeedValue[] = [];
  if (parsed.data.kind === "boolean") {
    // A boolean attribute carries EXACTLY ONE value ("Oui"); a product is
    // tagged with it or not. Always auto-seed that single value and IGNORE any
    // caller-supplied `values` — otherwise an ERP create like
    // { kind:"boolean", values:[A,B] } would mint a multi-value "boolean" the
    // single-toggle UI (which binds to values[0]) can't represent.
    seedValues.push({ slug: "oui", label: "Oui", display_order: 0 });
  } else if (
    // Only value-LIST kinds (select/multiselect/color) carry a value list.
    // number/text are per-product SCALARS — seeding values for them would mint
    // product_attribute_values rows no read path ever surfaces (silent dead data,
    // reachable via the ERP API / inline category-filter creator).
    VALUE_LIST_ATTRIBUTE_KINDS.includes(parsed.data.kind as (typeof VALUE_LIST_ATTRIBUTE_KINDS)[number]) &&
    parsed.data.values &&
    parsed.data.values.length > 0
  ) {
    // Dedupe by slug: labels that slugify alike ("Rouge, rouge", "Or rose,
    // Or-rose") would otherwise trip product_attribute_values_attribute_slug_unique
    // mid-insert. The first occurrence wins. A label that slugifies to nothing
    // ("—", emoji) is rejected — it would be stored with an empty slug.
    const seenSlugs = new Set<string>();
    for (const [idx, v] of parsed.data.values.entries()) {
      const valueSlug = v.slug ?? slugify(v.label);
      if (!slugSchema.safeParse(valueSlug).success) {
        return fail(
          "validation",
          `La valeur « ${v.label} » ne produit pas d'identifiant valide — utilisez des lettres ou des chiffres.`,
          { values: "Valeur invalide" },
        );
      }
      if (seenSlugs.has(valueSlug)) continue;
      seenSlugs.add(valueSlug);
      seedValues.push({
        slug: valueSlug,
        label: v.label,
        display_order: v.displayOrder ?? idx,
        color_hex: v.colorHex ?? null,
      });
    }
  }

  // Attribute + seed values in ONE transaction (the schema comment's contract):
  // a failed value insert rolls the attribute back, so a retry never hits a
  // phantom "Slug déjà utilisé" and no attribute exists without its event.
  const attribute = await db.transaction(async (tx) => {
    const row = await attributeService.insertAttribute(
      {
        slug,
        name: parsed.data.name,
        kind: parsed.data.kind,
        display_order: parsed.data.displayOrder ?? 0,
        is_active: parsed.data.isActive,
      },
      tx,
    );
    for (const v of seedValues) {
      await attributeService.insertValue({ attribute_id: row.id, ...v }, tx);
    }
    return row;
  });

  await bus.emit(
    "attribute.created",
    { attributeId: attribute.id, slug: attribute.slug },
    { actorUserId },
  );
  return ok({ attributeId: attribute.id, slug: attribute.slug });
});

export const updateAttributeSchema = createAttributeSchema
  .partial()
  .extend({ attributeId: z.string().uuid() })
  .omit({ values: true });

export const updateAttributeWorkflow = workflow<
  [z.input<typeof updateAttributeSchema>, { actorUserId: string }],
  { attributeId: string }
>("attribute.update", async (input, { actorUserId }) => {
  const parsed = updateAttributeSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));

  const existing = await attributeService.findAttributeById(parsed.data.attributeId);
  if (!existing) return fail("not_found", "Attribut introuvable.");

  // Zod KEEPS `.default()` through `.partial()`, so a sparse patch (e.g. just
  // { attributeId, name } from the API) parses `kind`→"multiselect" and
  // `isActive`→true — which, if applied, would silently flip a "select"
  // attribute or re-activate a deactivated one. Only apply a field the caller
  // actually sent (raw input keys), like updateProductWorkflow.
  const provided = new Set(Object.keys((input ?? {}) as Record<string, unknown>));

  const patch: Parameters<typeof attributeService.updateAttribute>[1] = {};
  if (provided.has("name") && parsed.data.name !== undefined && parsed.data.name !== existing.name) {
    patch.name = parsed.data.name;
  }
  if (provided.has("slug") && parsed.data.slug !== undefined && parsed.data.slug !== existing.slug) {
    const dup = await attributeService.findAttributeBySlug(parsed.data.slug);
    if (dup && dup.id !== existing.id) {
      return fail("conflict", "Slug déjà utilisé.", { slug: "Slug déjà utilisé" });
    }
    patch.slug = parsed.data.slug;
  }
  if (provided.has("kind") && parsed.data.kind !== undefined) patch.kind = parsed.data.kind;
  if (provided.has("displayOrder") && parsed.data.displayOrder !== undefined)
    patch.display_order = parsed.data.displayOrder;
  if (provided.has("isActive") && parsed.data.isActive !== undefined) patch.is_active = parsed.data.isActive;

  // Converting an existing attribute TO boolean HARD-deletes its current values
  // (the normalisation below loops attributeService.deleteValue → product_attribute_
  // assignments + product_variant_values + tax_rules all CASCADE). Guard like
  // deleteValueWorkflow BEFORE the kind is persisted, so an in-use attribute can't
  // be silently stripped — the operator clears the variants/facets/tax first.
  if (provided.has("kind") && parsed.data.kind === "boolean" && existing.kind !== "boolean") {
    const inUse = await valuesInUseFail(existing.id, "Conversion en booléen");
    if (inUse) return inUse;
  }
  // Converting a value-LIST attribute (select/multiselect/color/boolean) to a
  // SCALAR kind (number/text) keeps its values but hides them: the admin shows no
  // value list for scalar kinds and the product editor offers no picker, yet the
  // assignments survive — they keep driving TVA (taxRuleBpsForProducts joins
  // assignments → tax_rules with no kind check), variant axes keep pointing at
  // them, and deleteAttributeWorkflow then blocks on assignments nobody can see.
  // Same in-use guard as →boolean.
  if (
    provided.has("kind") &&
    parsed.data.kind !== undefined &&
    isValueListKind(existing.kind) &&
    !isValueListKind(parsed.data.kind)
  ) {
    const inUse = await valuesInUseFail(
      existing.id,
      `Conversion en ${parsed.data.kind === "number" ? "nombre" : "texte"}`,
    );
    if (inUse) return inUse;
  }
  // The REVERSE conversion — a SCALAR kind (number/text) → a value-list/boolean kind —
  // orphans the product_attribute_scalars rows: getProductSpecs only reads scalars for
  // number/text kinds, and deleteAttributeWorkflow's guard checks value assignments, not
  // scalars, so they'd linger as invisible dead data. Block it (don't prune) like the
  // forward guards — the operator clears the per-product values first.
  if (
    provided.has("kind") &&
    parsed.data.kind !== undefined &&
    (existing.kind === "number" || existing.kind === "text") &&
    parsed.data.kind !== existing.kind &&
    parsed.data.kind !== "number" &&
    parsed.data.kind !== "text"
  ) {
    const scalarCount = await attributeService.countScalarsForAttribute(existing.id);
    if (scalarCount > 0) {
      return fail(
        "in_use",
        `Conversion impossible : ${scalarCount} produit(s) portent une valeur pour cet attribut. Videz ces valeurs avant de changer le type.`,
        { kind: "in_use" },
      );
    }
  }

  // The kind write AND the boolean value-normalization below must be ATOMIC:
  // switching an existing attribute TO boolean must leave it with EXACTLY ONE
  // value ("Oui") — the single-toggle UI (product editor + storefront filter)
  // binds to values[0], so leftover values from the old kind would mislabel the
  // toggle and strand their product assignments. If it isn't already just [oui],
  // drop every existing value (their assignments cascade — this is the "données
  // inutilisées" the type-change warning covers) and seed "oui". Running the
  // persist + normalization in one transaction means a crash can't leave a
  // boolean attribute carrying stale multi-values (createAttributeWorkflow is
  // likewise transactional).
  const changed = Object.keys(patch).length > 0;
  const normalizeToBoolean = provided.has("kind") && parsed.data.kind === "boolean";
  if (changed || normalizeToBoolean) {
    await db.transaction(async (tx) => {
      if (changed) await attributeService.updateAttribute(existing.id, patch, tx);
      if (normalizeToBoolean) {
        const values = await attributeService.listValuesForAttribute(existing.id, tx);
        const alreadyOk = values.length === 1 && values[0].slug === "oui";
        if (!alreadyOk) {
          for (const v of values) await attributeService.deleteValue(v.id, tx);
          await attributeService.insertValue(
            { attribute_id: existing.id, slug: "oui", label: "Oui", display_order: 0 },
            tx,
          );
        }
      }
    });
  }

  // Emit only on a real change — a no-op PATCH (now more reachable since the
  // `provided` gate above drops Zod defaults) must not write an audit row or
  // bust the catalog cache. Post-commit, matching updateCategory/Brand/Product.
  if (changed) {
    await bus.emit(
      "attribute.updated",
      { attributeId: existing.id, changedFields: Object.keys(patch) },
      { actorUserId },
    );
  }
  return ok({ attributeId: existing.id });
});

export const deleteAttributeWorkflow = workflow<
  [{ attributeId: string }, { actorUserId: string }],
  { attributeId: string }
>("attribute.delete", async ({ attributeId }, { actorUserId }) => {
  const existing = await attributeService.findAttributeById(attributeId);
  if (!existing) return fail("not_found", "Attribut introuvable.");
  // Block deletion while live variants still vary on this attribute. Soft-
  // deleting it would make the axis silently vanish on the PDP for those
  // variants (they keep pointing at a now-hidden attribute) — admin must
  // remove those variants first.
  const attrValues = await attributeService.listValuesForAttribute(attributeId);
  const attrValueIds = attrValues.map((v) => v.id);
  const attrUsedBy = await productQueries.countLiveVariantsUsingValues(attrValueIds);
  if (attrUsedBy > 0) {
    return fail(
      "in_use",
      `Cet attribut est utilisé par ${attrUsedBy} variante(s) — supprimez ces variantes avant de supprimer l'attribut.`,
    );
  }
  const attrFacets = await attributeService.countAssignmentsUsingValues(attrValueIds);
  if (attrFacets > 0) {
    return fail(
      "in_use",
      `Cet attribut est utilisé comme filtre par ${attrFacets} produit(s) — retirez ces assignations avant de le supprimer.`,
    );
  }
  // NOTE: no tax-rule guard here — this is a SOFT delete (the value rows survive),
  // so `tax_rules.attribute_value_id` doesn't cascade and the override is kept. The
  // tax guard lives on the paths that HARD-delete values (deleteValueWorkflow + the
  // kind→boolean normalisation).
  // Soft-delete doesn't cascade, but the category_attribute_filters links MUST
  // go: a lingering link to a soft-deleted attribute can't be shown/unticked in
  // the category editor (it's filtered out of the visible list) yet still gets
  // submitted, and setCategoryFilters then rejects the dead id — permanently
  // bricking that category's filter save. Clear the attribute's links first
  // (diff-to-empty) so no orphan filter row survives the delete.
  await attributeService.setAttributeCategories(attributeId, []);
  await attributeService.softDeleteAttribute(attributeId);
  await bus.emit("attribute.deleted", { attributeId }, { actorUserId });
  return ok({ attributeId });
});

// ─────────────────────────────────────────────────────── attribute values
export const createValueSchema = z.object({
  attributeId: z.string().uuid(),
  slug: slugSchema.optional(),
  label: z.string().trim().min(1).max(120),
  displayOrder: z.number().int().min(0).optional(),
  colorHex: z.string().trim().max(9).nullable().optional(),
});

export const createValueWorkflow = workflow<
  [z.input<typeof createValueSchema>, { actorUserId: string }],
  { valueId: string }
>("attribute.value.create", async (input, { actorUserId }) => {
  const parsed = createValueSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));

  const attribute = await attributeService.findAttributeById(parsed.data.attributeId);
  if (!attribute) return fail("not_found", "Attribut introuvable.");

  const slug = parsed.data.slug ?? slugify(parsed.data.label);
  // A label that slugifies to nothing (emoji/punctuation-only) would persist with an
  // empty slug — reject it, matching the seed-value guard in createAttributeWorkflow.
  if (!slugSchema.safeParse(slug).success) {
    return fail(
      "validation",
      "Le libellé ne produit pas d'identifiant valide — utilisez des lettres ou des chiffres.",
      { label: "Libellé invalide" },
    );
  }
  const conflict = await attributeService.findValueBySlug(attribute.id, slug);
  if (conflict) {
    return fail("conflict", "Slug déjà utilisé pour cet attribut.", {
      slug: "Slug déjà utilisé",
    });
  }

  const value = await attributeService.insertValue({
    attribute_id: attribute.id,
    slug,
    label: parsed.data.label,
    display_order: parsed.data.displayOrder ?? 0,
    color_hex: parsed.data.colorHex ?? null,
  });
  await bus.emit(
    "attribute_value.created",
    { attributeId: attribute.id, valueId: value.id, slug: value.slug },
    { actorUserId },
  );
  return ok({ valueId: value.id });
});

export const updateValueSchema = z.object({
  valueId: z.string().uuid(),
  slug: slugSchema.optional(),
  label: z.string().trim().min(1).max(120).optional(),
  displayOrder: z.number().int().min(0).optional(),
  colorHex: z.string().trim().max(9).nullable().optional(),
});

export const updateValueWorkflow = workflow<
  [z.input<typeof updateValueSchema>, { actorUserId: string }],
  { valueId: string }
>("attribute.value.update", async (input, { actorUserId }) => {
  const parsed = updateValueSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));

  const existing = await attributeService.findValueById(parsed.data.valueId);
  if (!existing) return fail("not_found", "Valeur introuvable.");

  const patch: Parameters<typeof attributeService.updateValue>[1] = {};
  if (parsed.data.label !== undefined && parsed.data.label !== existing.label) {
    patch.label = parsed.data.label;
  }
  if (parsed.data.slug !== undefined && parsed.data.slug !== existing.slug) {
    const dup = await attributeService.findValueBySlug(existing.attribute_id, parsed.data.slug);
    if (dup && dup.id !== existing.id) {
      return fail("conflict", "Slug déjà utilisé pour cet attribut.", {
        slug: "Slug déjà utilisé",
      });
    }
    patch.slug = parsed.data.slug;
  }
  if (parsed.data.displayOrder !== undefined) patch.display_order = parsed.data.displayOrder;
  if (parsed.data.colorHex !== undefined) {
    const next = parsed.data.colorHex?.trim() || null;
    if (next !== existing.color_hex) patch.color_hex = next;
  }

  // Emit only on a real change (see updateAttributeWorkflow) — no event, audit
  // row, or cache bust for a no-op PATCH.
  if (Object.keys(patch).length > 0) {
    await attributeService.updateValue(existing.id, patch);
    await bus.emit(
      "attribute_value.updated",
      { attributeId: existing.attribute_id, valueId: existing.id },
      { actorUserId },
    );
  }
  return ok({ valueId: existing.id });
});

export const deleteValueWorkflow = workflow<
  [{ valueId: string }, { actorUserId: string }],
  { valueId: string }
>("attribute.value.delete", async ({ valueId }, { actorUserId }) => {
  const existing = await attributeService.findValueById(valueId);
  if (!existing) return fail("not_found", "Valeur introuvable.");
  // Block deletion while live variants are defined by this value — a hard
  // delete cascades product_variant_values and would silently strip the value
  // from those variants' combos (broken combo + drifted label).
  const valueUsedBy = await productQueries.countLiveVariantsUsingValues([valueId]);
  if (valueUsedBy > 0) {
    return fail(
      "in_use",
      `Cette valeur est utilisée par ${valueUsedBy} variante(s) — retirez-la de ces variantes avant de la supprimer.`,
    );
  }
  // Also block when the value is a product attribute FACET (drives category
  // filtering): a hard delete cascades product_attribute_assignments and would
  // silently strip it from every product's facet set + the storefront filter
  // chips. Consistent with the variant guard — block, don't silently strip.
  const valueFacets = await attributeService.countAssignmentsUsingValues([valueId]);
  if (valueFacets > 0) {
    return fail(
      "in_use",
      `Cette valeur est utilisée comme filtre par ${valueFacets} produit(s) — retirez-la de ces produits avant de la supprimer.`,
    );
  }
  // Also block when a per-value TVA rule targets it: `tax_rules.attribute_value_id`
  // CASCADEs, so a silent delete would drop the override and revert affected
  // products to the category/global tax tier (wrong tax charged). Block like the
  // variant/assignment guards.
  const valueTaxRules = await taxService.countRulesUsingValues([valueId]);
  if (valueTaxRules > 0) {
    return fail(
      "in_use",
      "Cette valeur porte une règle de TVA — supprimez d'abord la règle (Réglages → TVA) avant de supprimer la valeur.",
    );
  }
  await attributeService.deleteValue(valueId);
  await bus.emit(
    "attribute_value.deleted",
    { attributeId: existing.attribute_id, valueId },
    { actorUserId },
  );
  return ok({ valueId });
});

// ─────────────────────────────────────────────────── product assignments
/**
 * Append (don't replace) attribute-value assignments across many products
 * in one bulk action. Used by the admin "bulk tag" UI — keeps existing
 * tags so an operator can layer e.g. a new color filter on every product
 * in a category without scripting an SQL update.
 *
 * Each product upsert is independent; one failure does not abort the
 * batch. Returns the count actually written so the UI can surface partial
 * success.
 */
export const bulkAssignAttributesSchema = z.object({
  productIds: z.array(z.string().uuid()).min(1),
  attributeValueIds: z.array(z.string().uuid()).min(1),
});

export const bulkAssignAttributesWorkflow = workflow<
  [z.input<typeof bulkAssignAttributesSchema>, { actorUserId: string }],
  { successCount: number }
>("product.attributes.bulk_assign", async (input, { actorUserId }) => {
  const parsed = bulkAssignAttributesSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  // Rows per product for the product.updated payload: slug (cache busting keys on
  // it) + the ERP identifiers (sku/gtin/external_ref) carried on the enriched event.
  const rows = await productQueries.listProductsByIds(parsed.data.productIds).catch(() => []);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  let successCount = 0;
  for (const productId of parsed.data.productIds) {
    // Per-item try/catch so ONE failure (e.g. a stale attribute-value id deleted
    // in another tab → a 23503 mid-loop) doesn't abort the batch and discard the
    // successes already committed — matching the doc contract above. successCount
    // counts only rows actually written; the emit is best-effort and never
    // un-counts a successful write.
    try {
      await attributeService.addProductAttributeValues(productId, parsed.data.attributeValueIds);
      successCount++;
    } catch (err) {
      console.error(`[product.attributes.bulk_assign] product ${productId} skipped`, err);
      continue;
    }
    // Mirror every other product-mutating workflow: emit so the audit trail +
    // catalog cache invalidation fire (this bulk path previously emitted none).
    const row = rowById.get(productId);
    if (row) {
      await bus
        .emit(
          "product.updated",
          {
            productId,
            slug: row.slug,
            changedFields: ["attributes"],
            sku: row.sku,
            gtin: row.gtin,
            externalRef: row.external_ref,
          },
          { actorUserId },
        )
        .catch(() => {});
    }
  }
  return ok({ successCount });
});

/**
 * Replace the M2M `category_attribute_filters` set on a category. Empty
 * input means "this category exposes no attribute filters". Emits the
 * `category.filter_attributes.updated` event for cache busters /
 * storefront refreshes.
 */
export const setCategoryFiltersSchema = z.object({
  categoryId: z.string().uuid(),
  attributeIds: z.array(z.string().uuid()),
});

export const setCategoryFiltersWorkflow = workflow<
  [z.input<typeof setCategoryFiltersSchema>, { actorUserId: string }],
  { categoryId: string }
>("category.filter_attributes.set", async (input, { actorUserId }) => {
  const parsed = setCategoryFiltersSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));

  // Validate the category + every attribute id is LIVE before wiring. Without
  // this, a nonexistent id raises an unmapped FK 23503 → opaque 500, and a
  // soft-deleted attribute id (e.g. archived in another tab between render and
  // submit) would be silently linked as a filter that the storefront then hides.
  const category = await categoryService.findById(parsed.data.categoryId);
  if (!category) return fail("not_found", "Catégorie introuvable.");
  const uniqueIds = [...new Set(parsed.data.attributeIds)];
  for (const attrId of uniqueIds) {
    const attr = await attributeService.findAttributeById(attrId);
    if (!attr) {
      return fail("validation", "Attribut introuvable ou archivé.", { attributeIds: "Attribut invalide" });
    }
  }
  await attributeService.setCategoryFilters(parsed.data.categoryId, uniqueIds);
  await bus.emit(
    "category.filter_attributes.updated",
    { categoryId: parsed.data.categoryId, attributeIds: uniqueIds },
    { actorUserId },
  );
  return ok({ categoryId: parsed.data.categoryId });
});

/**
 * Reorder an attribute's values (admin value editor up/down). The ordered ids
 * become display_order 0..n; ids from another attribute are ignored by the
 * service's attribute_id guard.
 */
export const setValueOrderSchema = z.object({
  attributeId: z.string().uuid(),
  orderedValueIds: z.array(z.string().uuid()),
});

export const setValueOrderWorkflow = workflow<
  [z.input<typeof setValueOrderSchema>, { actorUserId: string }],
  { attributeId: string }
>("attribute.values.reorder", async (input, { actorUserId }) => {
  const parsed = setValueOrderSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  const attr = await attributeService.findAttributeById(parsed.data.attributeId);
  if (!attr) return fail("not_found", "Attribut introuvable.");
  await attributeService.setValueOrder(parsed.data.attributeId, parsed.data.orderedValueIds);
  await bus.emit(
    "attribute.updated",
    { attributeId: attr.id, changedFields: ["value_order"] },
    { actorUserId },
  );
  return ok({ attributeId: attr.id });
});

/**
 * Set, FROM THE ATTRIBUTE SIDE, which categories expose this attribute as a
 * filter (the reverse of setCategoryFilters; writes the same M2M, diff-based to
 * preserve each category's filter order). Validates every category is live.
 */
export const setAttributeCategoriesSchema = z.object({
  attributeId: z.string().uuid(),
  categoryIds: z.array(z.string().uuid()),
});

export const setAttributeCategoriesWorkflow = workflow<
  [z.input<typeof setAttributeCategoriesSchema>, { actorUserId: string }],
  { attributeId: string }
>("attribute.categories.set", async (input, { actorUserId }) => {
  const parsed = setAttributeCategoriesSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  const attr = await attributeService.findAttributeById(parsed.data.attributeId);
  if (!attr) return fail("not_found", "Attribut introuvable.");
  const uniqueIds = [...new Set(parsed.data.categoryIds)];
  for (const cid of uniqueIds) {
    const c = await categoryService.findById(cid);
    if (!c) {
      return fail("validation", "Catégorie introuvable ou archivée.", {
        categoryIds: "Catégorie invalide",
      });
    }
  }
  await attributeService.setAttributeCategories(parsed.data.attributeId, uniqueIds);
  await bus.emit(
    "attribute.updated",
    { attributeId: attr.id, changedFields: ["categories"] },
    { actorUserId },
  );
  return ok({ attributeId: attr.id });
});
