import type { CurrencySymbolPosition } from "@/modules/currency/schema";

/**
 * PURE currency helpers — no "server-only", no DB — so the admin-input
 * normalizers, the row→ActiveCurrency mapper, the TND default, and the
 * delete-active guard are all unit-testable. The DB-bound `getActiveCurrency`
 * loader lives in ./active (which re-exports the type + default from here).
 */

// NOTE: no per-currency `decimals` here — display precision is governed globally by
// the `price.decimals` setting (MoneyProvider), so the currencies.decimals column is
// unused metadata and is deliberately not surfaced on ActiveCurrency.
export type ActiveCurrency = {
  code: string;
  name: string;
  symbol: string;
  symbolPosition: CurrencySymbolPosition;
};

/** Fallback when no currency row is active (cold/empty DB). */
export const DEFAULT_CURRENCY: ActiveCurrency = {
  code: "TND",
  name: "Dinar tunisien",
  symbol: "TND",
  symbolPosition: "after",
};

/** Map a currencies row to the resolved ActiveCurrency shape. */
export function rowToActiveCurrency(row: {
  code: string;
  name: string;
  symbol: string;
  symbol_position: CurrencySymbolPosition;
}): ActiveCurrency {
  return {
    code: row.code,
    name: row.name,
    symbol: row.symbol,
    symbolPosition: row.symbol_position,
  };
}

/** ISO 4217 — uppercase letters only, max 3 ("tnd"→"TND", "us$d2"→"USD"). */
export function normalizeCode(v: unknown): string {
  return String(v ?? "").trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
}

/** Symbol placement — anything but "before" is "after". */
export function normalizePosition(v: unknown): CurrencySymbolPosition {
  return String(v ?? "").trim() === "before" ? "before" : "after";
}

/** Non-negative integer, clamped to [0, max]; fallback on blank/garbage. */
export function clampInt(v: unknown, fallback: number, max = 6): number {
  const n = Math.trunc(Number(String(v ?? "").trim()));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
}

/** Never delete the active currency — the store must always have one. */
export function canDeleteCurrency(
  activeId: string | null | undefined,
  targetId: string,
): boolean {
  return activeId !== targetId;
}
