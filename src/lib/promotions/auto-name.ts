/**
 * Compose a readable INTERNAL promotion name from the live discount + trigger +
 * entity, for the auto-name (inline product) creation flow so the merchant never
 * types one. Examples: « −20 % · Rolex Submariner », « Code BLACKFRIDAY · −10 TND
 * · Rolex Submariner », « Livraison offerte · Rolex Submariner ».
 *
 * Pure + client-safe (no React / server imports) so it is shared by the
 * `PromotionForm` client component AND unit-tested. Capped at 160 — the
 * promotion `name` schema is `z.string().trim().min(2).max(160)`, and the
 * generated string is always ≥ 2 (the « Promo » fallback), so the SUBMITTED name
 * can never fail validation regardless of the entity length.
 */
export function buildAutoPromoName(o: {
  triggerKind: "auto" | "code" | "url";
  discountType: "percent" | "fixed";
  /** The DISPLAYED value: raw 1-100 for percent, dinars for a fixed amount. */
  discountValue: string;
  code: string;
  urlSlug: string;
  grantsFreeShipping: boolean;
  entityName: string;
}): string {
  const n = Number(o.discountValue);
  const valid = Number.isFinite(n) && n > 0;
  const benefit =
    o.discountType === "percent" && valid
      ? `−${n} %`
      : o.discountType === "fixed" && valid
        ? `−${n} TND`
        : o.grantsFreeShipping
          ? "Livraison offerte"
          : "Promo";
  const trigger =
    o.triggerKind === "code" && o.code.trim()
      ? `Code ${o.code.trim().toUpperCase()}`
      : o.triggerKind === "url" && o.urlSlug.trim()
        ? `URL ${o.urlSlug.trim()}`
        : null;
  return [trigger, benefit, o.entityName]
    .filter((p): p is string => Boolean(p))
    .join(" · ")
    .slice(0, 160);
}
