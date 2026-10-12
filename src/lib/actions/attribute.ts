"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import type { AttributeKind } from "@/modules/catalog/attribute/schema";

// ──────────────────────────────────────────────────────────── ATTRIBUTES

/** Result of the inline "create filter attribute" action (called imperatively). */
export type CreateFilterAttributeResult =
  | { ok: true; attribute: { id: string; name: string; slug: string } }
  | { ok: false; error: string };

/**
 * Create an attribute (optionally with seed values) FROM the category editor's
 * filters tab, returning the new {id, name, slug} so the client can append it to
 * the list and tick it as a filter in one step. `valuesText` is one value per
 * line or comma-separated (e.g. "Rouge, Bleu"). Reuses the same workflow the
 * attributes admin uses; the category filter wiring happens on category save.
 */
export async function createCategoryFilterAttributeAction(input: {
  name: string;
  kind?: AttributeKind;
  valuesText?: string;
}): Promise<CreateFilterAttributeResult> {
  const session = await requirePermission("attributes", "create");
  const name = (input.name ?? "").trim();
  if (!name) return { ok: false, error: "Nom de l'attribut requis." };
  const values = (input.valuesText ?? "")
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((label, i) => ({ label, displayOrder: i }));
  const result = await workflows.catalog.createAttribute(
    {
      name,
      kind: input.kind ?? "multiselect",
      isActive: true,
      ...(values.length > 0 ? { values } : {}),
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.message };
  revalidatePath("/admin/catalog/attributes");
  return { ok: true, attribute: { id: result.data.attributeId, name, slug: result.data.slug } };
}

export async function createAttributeAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("attributes", "create");
  const result = await workflows.catalog.createAttribute(
    {
      name: String(formData.get("name") ?? ""),
      slug: optional(formData, "slug"),
      kind: parseKind(optional(formData, "kind")),
      displayOrder: optionalInt(formData, "displayOrder"),
      isActive: formData.get("isActive") === "on",
      ...(() => {
        const values = parseSeedValues(optional(formData, "valuesJson"));
        return values.length > 0 ? { values } : {};
      })(),
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
  revalidatePath("/admin/catalog/attributes");
  return { ok: true, message: "Attribut créé.", id: result.data.attributeId };
}

export async function updateAttributeAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("attributes", "update");
  const attributeId = optional(formData, "attributeId");
  if (!attributeId) return { ok: false, error: "validation", message: "ID requis." };
  const result = await workflows.catalog.updateAttribute(
    {
      attributeId,
      name: optional(formData, "name"),
      slug: optional(formData, "slug"),
      kind: parseKind(optional(formData, "kind")),
      displayOrder: optionalInt(formData, "displayOrder"),
      isActive: formData.get("isActive") === "on",
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
  revalidatePath("/admin/catalog/attributes");
  revalidatePath(`/admin/catalog/attributes/${attributeId}`);
  return { ok: true, message: "Attribut mis à jour.", id: attributeId };
}

export async function deleteAttributeAction(attributeId: string): Promise<ActionState> {
  const session = await requirePermission("attributes", "delete");
  const result = await workflows.catalog.deleteAttribute(
    { attributeId },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/catalog/attributes");
  return { ok: true, message: "Attribut supprimé." };
}

// ──────────────────────────────────────────────────────────── ATTRIBUTE VALUES
export async function createValueAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("attributes", "create");
  const attributeId = optional(formData, "attributeId");
  if (!attributeId) return { ok: false, error: "validation", message: "Attribut requis." };
  const result = await workflows.catalog.createAttributeValue(
    {
      attributeId,
      slug: optional(formData, "slug"),
      label: String(formData.get("label") ?? ""),
      displayOrder: optionalInt(formData, "displayOrder"),
      colorHex: colorHexField(formData),
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
  revalidatePath("/admin/catalog/attributes");
  revalidatePath(`/admin/catalog/attributes/${attributeId}`);
  return { ok: true, message: "Valeur ajoutée.", id: result.data.valueId };
}

export async function updateValueAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("attributes", "update");
  const valueId = optional(formData, "valueId");
  const attributeId = optional(formData, "attributeId");
  if (!valueId) return { ok: false, error: "validation", message: "ID requis." };
  const result = await workflows.catalog.updateAttributeValue(
    {
      valueId,
      slug: optional(formData, "slug"),
      label: optional(formData, "label"),
      displayOrder: optionalInt(formData, "displayOrder"),
      colorHex: colorHexField(formData),
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
  revalidatePath("/admin/catalog/attributes");
  if (attributeId) revalidatePath(`/admin/catalog/attributes/${attributeId}`);
  return { ok: true, message: "Valeur mise à jour.", id: valueId };
}

export async function deleteValueAction(
  valueId: string,
  attributeId?: string,
): Promise<ActionState> {
  const session = await requirePermission("attributes", "delete");
  const result = await workflows.catalog.deleteAttributeValue(
    { valueId },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath("/admin/catalog/attributes");
  if (attributeId) revalidatePath(`/admin/catalog/attributes/${attributeId}`);
  return { ok: true, message: "Valeur supprimée." };
}

// ──────────────────────────────────────────────────────────── BULK ASSIGN
/**
 * Bulk-assign attribute values to a set of products. Append-only:
 * existing assignments on each product are preserved. UUID-checked.
 */
export async function bulkAssignAttributesAction(input: {
  productIds: string[];
  attributeValueIds: string[];
}): Promise<ActionState & { successCount?: number }> {
  const session = await requirePermission("attributes", "update");
  const validProducts = input.productIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const validValues = input.attributeValueIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (validProducts.length === 0 || validValues.length === 0) {
    return {
      ok: false,
      error: "validation",
      message: "Sélection invalide.",
    };
  }
  const result = await workflows.catalog.bulkAssignAttributes(
    { productIds: validProducts, attributeValueIds: validValues },
    { actorUserId: session.user.id },
  );
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  }
  for (const productId of validProducts) {
    revalidatePath(`/admin/catalog/products/${productId}`);
  }
  revalidatePath("/admin/catalog/products");
  return {
    ok: true,
    message: `${result.data.successCount} produit${result.data.successCount > 1 ? "s" : ""} mis à jour.`,
    successCount: result.data.successCount,
  };
}

// ────────────────────────────────────────────────────── reorder + categories
/** Reorder an attribute's values (admin value editor up/down). */
export async function setAttributeValueOrderAction(
  attributeId: string,
  orderedValueIds: string[],
): Promise<ActionState> {
  const session = await requirePermission("attributes", "update");
  const result = await workflows.catalog.setValueOrder(
    { attributeId, orderedValueIds },
    { actorUserId: session.user.id },
  );
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath(`/admin/catalog/attributes/${attributeId}`);
  return { ok: true, message: "Ordre mis à jour." };
}

/** Set which categories expose this attribute as a filter (attribute-side picker). */
export async function setAttributeCategoriesAction(
  attributeId: string,
  categoryIds: string[],
): Promise<ActionState> {
  const session = await requirePermission("attributes", "update");
  const result = await workflows.catalog.setAttributeCategories(
    { attributeId, categoryIds },
    { actorUserId: session.user.id },
  );
  if (!result.ok)
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  revalidatePath(`/admin/catalog/attributes/${attributeId}`);
  revalidatePath("/admin/catalog/categories");
  return { ok: true, message: "Catégories mises à jour." };
}

// ────────────────────────────────────────────────────── helpers
/** Present-empty → null (clear); absent → undefined (leave unchanged); else the hex. */
function colorHexField(form: FormData): string | null | undefined {
  if (!form.has("colorHex")) return undefined;
  const v = String(form.get("colorHex") ?? "").trim();
  return v === "" ? null : v;
}

/** Parse the create-page's seed-values JSON ([{label, slug?, colorHex?}]). */
function parseSeedValues(
  raw: string | undefined,
): { label: string; slug?: string; colorHex?: string | null; displayOrder: number }[] {
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: { label: string; slug?: string; colorHex?: string | null; displayOrder: number }[] = [];
    arr.forEach((v, i) => {
      const item = v as { label?: unknown; slug?: unknown; colorHex?: unknown };
      const label = typeof item?.label === "string" ? item.label.trim() : "";
      if (!label) return;
      out.push({
        label,
        slug: typeof item.slug === "string" && item.slug.trim() ? item.slug.trim() : undefined,
        colorHex:
          typeof item.colorHex === "string" && item.colorHex.trim() ? item.colorHex.trim() : undefined,
        displayOrder: i,
      });
    });
    return out.slice(0, 50);
  } catch {
    return [];
  }
}

function optional(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  if (v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}
function optionalInt(form: FormData, key: string): number | undefined {
  const v = optional(form, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
const ATTRIBUTE_KINDS: readonly AttributeKind[] = [
  "select",
  "multiselect",
  "color",
  "boolean",
  "number",
  "text",
];
function parseKind(raw: string | undefined): AttributeKind | undefined {
  return raw && (ATTRIBUTE_KINDS as readonly string[]).includes(raw)
    ? (raw as AttributeKind)
    : undefined;
}
