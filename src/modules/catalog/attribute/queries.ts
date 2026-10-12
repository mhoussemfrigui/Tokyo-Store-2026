import "server-only";

import { cacheTag, cacheLife } from "next/cache";

import { CACHE_TAGS, cacheTag as catTag } from "@/lib/cache/tags";
import { attributeService } from "./service";
import type { AttributeKind, AttributeRow, AttributeValueRow } from "./schema";

export type AttributeWithValues = AttributeRow & {
  values: AttributeValueRow[];
};

/**
 * One characteristic row for the PDP "Caractéristiques" block. Value-list kinds
 * carry their assigned labels (colour adds a swatch); number/text carry the
 * product's scalar as `text`.
 */
export type ProductSpec = {
  attributeId: string;
  attributeName: string;
  kind: AttributeKind;
  values: { label: string; colorHex: string | null }[];
  text: string | null;
};

/**
 * Resolve a product's attribute characteristics for storefront display, ordered
 * by attribute display_order. Only ACTIVE attributes that the product actually
 * carries data for are returned (so the block stays compact). Batched (one pass
 * over value-ids + scalars + the attribute catalogue) — no per-attribute N+1.
 */
export async function getProductSpecs(productId: string): Promise<ProductSpec[]> {
  "use cache";
  // Product-scoped, cross-request cached: this fires 4 attribute queries on every
  // force-dynamic PDP render. Deps: the attribute catalogue/values (attribute edits
  // bust CACHE_TAGS.attributes via invalidate-attribute-cache) + this product's own
  // value/scalar assignments (a product save busts product:<id>). cacheLife("hours")
  // is the safety-net TTL; the tags give instant busts.
  cacheLife("hours");
  cacheTag(CACHE_TAGS.attributes, catTag.product(productId));
  const [valueIds, scalars, attributes] = await Promise.all([
    attributeService.listValueIdsForProduct(productId),
    attributeService.getScalarsForProduct(productId),
    attributeService.listActiveAttributes(),
  ]);
  if (attributes.length === 0) return [];
  const valueSet = new Set(valueIds);
  const scalarByAttr = new Map(scalars.map((s) => [s.attribute_id, s]));
  const valuesByAttr = await attributeService.listValuesForAttributes(attributes.map((a) => a.id));

  const specs: ProductSpec[] = [];
  for (const a of attributes) {
    if (a.kind === "number" || a.kind === "text") {
      const s = scalarByAttr.get(a.id);
      if (!s) continue;
      const text =
        a.kind === "number"
          ? s.numeric_value != null && Number.isFinite(Number(s.numeric_value))
            ? String(Number(s.numeric_value))
            : null
          : (s.text_value?.trim() || null);
      if (!text) continue;
      specs.push({ attributeId: a.id, attributeName: a.name, kind: a.kind, values: [], text });
    } else {
      const vals = (valuesByAttr.get(a.id) ?? []).filter((v) => valueSet.has(v.id));
      if (vals.length === 0) continue;
      specs.push({
        attributeId: a.id,
        attributeName: a.name,
        kind: a.kind,
        values: vals.map((v) => ({ label: v.label, colorHex: v.color_hex })),
        text: null,
      });
    }
  }
  return specs;
}

/**
 * All active attributes, ordered by display_order.
 */
export async function listAttributes(): Promise<AttributeRow[]> {
  return attributeService.listActiveAttributes();
}

/**
 * Every attribute (live + active OR live + inactive) — used in the admin
 * list so an admin can re-enable a disabled attribute.
 */
export async function listAllAttributes(): Promise<AttributeRow[]> {
  return attributeService.listAllAttributes();
}

/**
 * Single attribute + its values eager-loaded. Returns null when the
 * attribute is missing or soft-deleted.
 */
export async function getAttributeWithValues(id: string): Promise<AttributeWithValues | null> {
  const attribute = await attributeService.findAttributeById(id);
  if (!attribute) return null;
  const values = await attributeService.listValuesForAttribute(attribute.id);
  return { ...attribute, values };
}

/**
 * The category ids this attribute is opted into as a filter (attribute-side
 * picker). Reverse view of the category editor's Filtres tab over the same
 * `category_attribute_filters` table.
 */
export async function listCategoriesForAttribute(attributeId: string): Promise<string[]> {
  return attributeService.listCategoriesForAttribute(attributeId);
}

/**
 * Every live attribute with its values eager-loaded — fans-out one extra
 * SELECT to populate all value rows in a single query.
 */
export async function listAttributesWithValues(): Promise<AttributeWithValues[]> {
  const attributes = await attributeService.listAllAttributes();
  if (attributes.length === 0) return [];
  const valuesByAttribute = await attributeService.listValuesForAttributes(
    attributes.map((a) => a.id),
  );
  return attributes.map((a) => ({ ...a, values: valuesByAttribute.get(a.id) ?? [] }));
}

/** Value rows by id (any attribute) — for the storefront variant build to
 *  resolve only the values variants reference. */
export async function findValuesByIds(ids: string[]) {
  return attributeService.findValuesByIds(ids);
}

/** Live products that currently carry this attribute (value or scalar) — the
 *  cross-product usage view on the attribute detail page. */
export async function listProductsUsingAttribute(attributeId: string) {
  return attributeService.listProductsUsingAttribute(attributeId);
}

/** Attribute rows by id (no is_active/deleted_at filter) — so an existing
 *  variant's axis still renders even if its attribute was later deactivated. */
export async function findAttributesByIds(ids: string[]) {
  return attributeService.findAttributesByIds(ids);
}
