import { dinarsToMinor } from "@/lib/price";

/**
 * PURE admin money-input parser — no "server-only", no DB — shared by every
 * writer of a TND amount typed into an admin form (Réglages commande's
 * `checkout.delivery.*_cents` / `checkout.min_order_cents`, and the Livraison
 * page's global base fee, courier / pickup fees and per-zone rates).
 *
 * The two pages write the SAME `checkout.delivery.*` keys, so they must agree
 * on what an acceptable amount is: before this module the Livraison page
 * refused a negative (silently → "inherit") while Réglages commande stored it,
 * and the storefront reader (`parseCents`) then ignored it and charged the
 * built-in fallback — the admin showed "-7" while customers paid 7 TND.
 *
 * Semantics (mirrors the historical `tndToMillimes`):
 *   - blank                    → `{ ok: true, millimes: null }` (unset / inherit)
 *   - "7", "7.5", "7,500"      → integer millimes via `dinarsToMinor`
 *   - negative / non-numeric   → `{ ok: false, error }` — a French field error,
 *     never a silent null, so the operator sees WHY nothing was saved.
 *   - above the Postgres int4 ceiling → refused (the fee columns are `integer`).
 */

/** Largest millime amount an `integer` (*_cents) column can hold. */
export const MAX_MONEY_MILLIMES = 2_147_483_647;

export type MoneyInputResult =
  | { ok: true; millimes: number | null }
  | { ok: false; error: string };

export function parseTndInput(raw: unknown): MoneyInputResult {
  const s = String(raw ?? "").trim().replace(",", ".");
  if (s === "") return { ok: true, millimes: null };
  const n = Number(s);
  if (!Number.isFinite(n)) {
    return { ok: false, error: "Montant invalide : saisissez un nombre en TND (ex. 7 ou 7,500)." };
  }
  if (n < 0) return { ok: false, error: "Le montant ne peut pas être négatif." };
  const millimes = dinarsToMinor(n);
  if (millimes > MAX_MONEY_MILLIMES) return { ok: false, error: "Montant trop élevé." };
  return { ok: true, millimes };
}

/**
 * Parse several named TND inputs at once. Returns the parsed millimes per field
 * name, plus a `fieldErrors` map (keyed by the same form field names) when any
 * input is invalid — the caller refuses the whole save up front so a bad amount
 * never half-applies a form.
 */
export function parseTndFields<K extends string>(
  read: (name: K) => unknown,
  names: readonly K[],
): { ok: true; values: Record<K, number | null> } | { ok: false; fieldErrors: Record<string, string> } {
  const values = {} as Record<K, number | null>;
  const fieldErrors: Record<string, string> = {};
  for (const name of names) {
    const r = parseTndInput(read(name));
    if (r.ok) values[name] = r.millimes;
    else fieldErrors[name] = r.error;
  }
  return Object.keys(fieldErrors).length > 0 ? { ok: false, fieldErrors } : { ok: true, values };
}

/** Standard French banner for a money-validation refusal. */
export const INVALID_MONEY_MESSAGE =
  "Certains montants sont invalides — corrigez les champs signalés (nombre positif en TND).";
