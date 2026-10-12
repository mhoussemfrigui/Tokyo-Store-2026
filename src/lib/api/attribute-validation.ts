import "server-only";

import { attributeService } from "@/modules/catalog/attribute/service";
import { isUuid } from "@/lib/utils/uuid";

/**
 * Shared attribute-reference validation for the product write paths.
 *
 * Returns a French error string when any referenced value id (must be a LIVE
 * value) or scalar attribute id (must be a live attribute of a scalar KIND, with
 * the payload field matching that kind) is wrong; null when all references
 * resolve. Used by BOTH the dedicated `/api/products/[slug]/attributes` PUT and
 * the main product create/update workflows so the two can't diverge — otherwise
 * the main endpoint silently writes dead EAV rows (a scalar on a value-list
 * attribute, or a number attribute carrying only `textValue`) that NO read path
 * surfaces, letting an ERP accumulate invisible garbage.
 */
export async function validateAttributeRefs(
  valueIds: unknown[] | null | undefined,
  scalars: unknown[] | null | undefined,
): Promise<string | null> {
  if (valueIds && valueIds.length > 0) {
    // LIVE = the value exists and its attribute is not deleted — active OR
    // inactive. Deactivating an attribute only hides it from the category
    // filters (docs/modules.md); the product editor re-submits every assigned
    // value id, so an active-only check made every product carrying a value of
    // a deactivated attribute unsaveable (and 400'd an ERP GET→PUT round-trip).
    // Same rule as the scalar branch below (findAttributeById ignores
    // is_active) and the variant path (findExistingValueIds).
    const ids = valueIds.filter((id): id is string => typeof id === "string");
    const live = await attributeService.findLiveValueIds(Array.from(new Set(ids.filter(isUuid))));
    for (const id of ids) {
      // Postgres returns uuids lower-cased; the uuid column accepts either case.
      if (!live.has(id.toLowerCase())) {
        return `Valeur d'attribut inconnue : ${id}.`;
      }
    }
  }
  if (scalars && scalars.length > 0) {
    const seen = new Set<string>();
    for (const s of scalars) {
      const attributeId = (s as { attributeId?: unknown })?.attributeId;
      if (typeof attributeId !== "string" || seen.has(attributeId)) continue;
      seen.add(attributeId);
      const attr = await attributeService.findAttributeById(attributeId);
      if (!attr) return `Attribut inconnu : ${attributeId}.`;
      // Scalars only belong to number/text attributes — writing one to a
      // value-list kind (select/multiselect/color/boolean) would create a dead
      // row no read path surfaces. Reject so the ERP can't accumulate garbage.
      if (attr.kind !== "number" && attr.kind !== "text") {
        return `L'attribut « ${attr.name} » (${attr.kind}) n'accepte pas de valeur scalaire (réservé aux types number/text).`;
      }
      // The payload field must match the kind: a number attribute reads
      // numeric_value, a text attribute reads text_value. A number-kind scalar
      // carrying only textValue (or the reverse) is accepted by setScalar but
      // NEVER surfaced on read — reject so the caller gets a clear error instead
      // of a storefront-invisible row. (Both-empty is a clear — allow it.)
      const numericValue = (s as { numericValue?: unknown }).numericValue;
      const textValue = (s as { textValue?: unknown }).textValue;
      const hasNumeric = numericValue !== null && numericValue !== undefined && numericValue !== "";
      const hasText = typeof textValue === "string" && textValue.trim() !== "";
      if (attr.kind === "number" && hasText && !hasNumeric) {
        return `L'attribut « ${attr.name} » (number) attend « numericValue », pas « textValue ».`;
      }
      if (attr.kind === "text" && hasNumeric && !hasText) {
        return `L'attribut « ${attr.name} » (text) attend « textValue », pas « numericValue ».`;
      }
    }
  }
  return null;
}
