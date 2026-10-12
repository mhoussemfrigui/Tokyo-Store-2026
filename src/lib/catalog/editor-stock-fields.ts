/**
 * Admin product / variant editor → the STOCK keys a save may write. PURE (no
 * server-only deps) so the dirty-gate is unit-testable in isolation; used by
 * updateProductAction / upsertProductVariantsAction (lib/actions/catalog.ts).
 *
 * Both editors re-post the stock they were SEEDED with at page load on every
 * save (the Stock tab stays mounted; the variant editor serialises every row).
 * Forwarding that snapshot blindly was a lost update: an SEO-only / price-only
 * edit made after a sale wrote the sold unit back (qty 0 → 1, re-listed, phantom
 * "admin +1" ledger row, false back-in-stock email). The editors therefore also
 * post the page-load values, and only what the operator CHANGED is sent —
 * together with `expectedStockQty` (the page-load qty), so the workflow refuses
 * with a `conflict` (compare-and-set under the row lock) when the committed stock
 * moved since the page loaded.
 *
 * An availability left as loaded + a new quantity ⇒ `inStock` omitted, so the
 * workflow re-derives it by the shared sold-out rule (in-stock-rule.ts): a
 * restock of a sold-out line re-lists it, a delisted line stays delisted.
 */
import { toIntOrNull } from "@/lib/actions/coerce";

export type EditedStockFields = {
  stockQty?: number | null;
  inStock?: boolean;
  expectedStockQty?: number | null;
};

/** A quantity value → integer, or null (blank = untracked). The variant editor
 *  clamps at 0 (as it always did); the product form keeps a negative so the
 *  workflow schema rejects it with a field error instead of silently zeroing. */
const qty = (v: unknown, opts: { min?: number } = {}): number | null => toIntOrNull(v, opts);

/**
 * The product editor's Stock tab. A blank quantity means null = untracked
 * ("Laisser vide = ne pas suivre les quantités") — clearing the field really
 * stops tracking (it used to be a silent no-op on edit). Without the page-load
 * originals (`stockQtyOriginal` / `inStockOriginal`) both keys are sent as-is.
 */
export function editedStockFields(form: FormData): EditedStockFields {
  if (!form.has("stockQty")) return {};
  const stockQty = qty(String(form.get("stockQty") ?? "").trim());
  const inStock = form.get("inStock") === "on";
  if (!form.has("stockQtyOriginal")) return { stockQty, inStock };
  const origQty = qty(String(form.get("stockQtyOriginal") ?? "").trim());
  const origInStock = form.get("inStockOriginal") === "on";
  return changedOnly(stockQty, inStock, origQty, origInStock);
}

/**
 * One row of the variant editor's JSON payload. For an EXISTING variant that
 * carries its page-load values (`origStockQty` / `origInStock`) only a changed
 * stock is sent — an unchanged one is omitted = left untouched by
 * replaceVariants. New variants (and a payload without originals) keep absolute
 * semantics.
 */
export function variantStockFields(v: {
  id?: string | null;
  stockQty?: unknown;
  inStock?: boolean;
  origStockQty?: unknown;
  origInStock?: boolean;
}): EditedStockFields {
  const stockQty = qty(v.stockQty, { min: 0 });
  const inStock = v.inStock !== false;
  if (!v.id || !("origStockQty" in v)) return { stockQty, inStock };
  return changedOnly(stockQty, inStock, qty(v.origStockQty, { min: 0 }), v.origInStock !== false);
}

function changedOnly(
  stockQty: number | null,
  inStock: boolean,
  origQty: number | null,
  origInStock: boolean,
): EditedStockFields {
  const qtyChanged = stockQty !== origQty;
  const inStockChanged = inStock !== origInStock;
  if (!qtyChanged && !inStockChanged) return {};
  return {
    ...(qtyChanged ? { stockQty } : {}),
    ...(inStockChanged ? { inStock } : {}),
    expectedStockQty: origQty,
  };
}
