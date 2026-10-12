/**
 * PURE variant matching for the PDP picker — no React/DOM, so it can be
 * unit-tested directly.
 *
 * The PDP shows one pill group per displayed axis; the shopper picks one value
 * per axis and we resolve the matching variant. A variant can carry a STALE
 * option value id for an axis that is no longer displayed (e.g. its attribute
 * was removed from the product, so the value's meta no longer resolves and the
 * axis isn't built — see lib/api/products.ts). Comparing a variant's FULL id set
 * against the selection would then never match, nulling the selection and
 * blocking checkout ("Choisissez une option… avant de commander."). Restricting
 * BOTH sides to the present-axis universe ignores those orphans.
 */

export type AxisLike = { attributeId: string; values: ReadonlyArray<{ id: string }> };
export type VariantLike = { optionValueIds: string[] };

const comboKey = (ids: string[]): string => [...ids].sort().join("|");

/** Value ids that belong to a currently-displayed axis. */
export function axisValueIdSet(options: ReadonlyArray<AxisLike>): Set<string> {
  return new Set(options.flatMap((o) => o.values.map((v) => v.id)));
}

/**
 * Resolve the variant matching `selected` (attributeId → valueId). Returns null
 * when not every axis has a selection, or no variant matches. Stale ids outside
 * the present axes are ignored on the variant side.
 */
export function resolveVariant<V extends VariantLike>(
  options: ReadonlyArray<AxisLike>,
  variants: ReadonlyArray<V>,
  selected: Record<string, string>,
): V | null {
  const ids = options.map((o) => selected[o.attributeId]).filter(Boolean);
  if (ids.length !== options.length) return null;
  const axis = axisValueIdSet(options);
  const key = comboKey(ids);
  return (
    variants.find((v) => comboKey(v.optionValueIds.filter((id) => axis.has(id))) === key) ?? null
  );
}
