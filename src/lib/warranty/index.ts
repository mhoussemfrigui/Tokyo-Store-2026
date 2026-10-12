import "server-only";

import { cache } from "react";

import { getSettingsMap } from "@/modules/cms/setting/queries";

export type WarrantyInput = { months: number | null; label: string | null };

export type ResolvedWarranty = {
  /** Resolved duration in months (0 = no warranty). */
  months: number;
  /** Resolved custom label, or null. */
  label: string | null;
  /** Which level of the cascade won — for admin clarity. */
  source: "product" | "category" | "global";
  /** Ready-to-show string ("Garantie 2 ans" / a custom label), or null. */
  display: string | null;
};

const DEFAULT_GLOBAL_MONTHS = 0;

/** Human duration: 24 → "2 ans", 12 → "1 an", 18 → "18 mois". */
export function formatWarrantyDuration(months: number): string {
  if (months <= 0) return "Sans garantie";
  if (months % 12 === 0) {
    const years = months / 12;
    return `${years} an${years > 1 ? "s" : ""}`;
  }
  return `${months} mois`;
}

/**
 * A custom warranty label may carry the literal placeholder "X" — the admin
 * helper shows the auto format as « Garantie X ans », so operators sometimes
 * type « Garantie Constructeur X » (or « Garantie X ans ») expecting the number
 * to fill in. But custom labels are otherwise shown verbatim, so the bare "X"
 * leaks to the storefront. Substitute a STANDALONE uppercase "X" with the
 * resolved duration so the placeholder never ships:
 *   "Garantie X ans" + 24mo   → "Garantie 2 ans"
 *   "Garantie Constructeur X" + 24mo → "Garantie Constructeur 2 ans"
 *   any "… X …" with no duration → the stray "X" is dropped.
 * Conservative: only a whitespace-delimited / trailing uppercase "X" is touched,
 * so legitimate labels (no standalone X) pass through unchanged.
 */
export function fillWarrantyLabelPlaceholder(label: string, months: number): string {
  const dur = months > 0 ? formatWarrantyDuration(months) : "";
  const out = label
    // "X ans" / "X an" / "X mois" → the full formatted duration ("2 ans").
    .replace(/\bX\s+(?:ans?|mois)\b/g, dur)
    // A bare standalone / trailing "X" (no unit) → the duration, or dropped.
    .replace(/(^|\s)X(?=\s|$)/g, (_m, pre) => (dur ? `${pre}${dur}` : ""));
  return out.replace(/\s{2,}/g, " ").trim();
}

/** Minimal shape of a category row needed for warranty resolution — accepts
 *  the full `CategoryRow` (warranty_months/label are a subset of it). */
export type CategoryWarrantyNode = {
  warranty_months: number | null;
  warranty_label: string | null;
};

/**
 * Pick the category-level warranty from a category ANCESTOR CHAIN ordered
 * child → root (see `loadCategoryChains` in @/lib/catalog/category-chain): the
 * FIRST node with its own `warranty_months` wins — at any depth, so a warranty
 * set on the root still reaches a product filed three levels down — and brings
 * its label with it. Returns `null` when no node sets one — the caller then
 * falls through to the global default. Centralised so the storefront mapper,
 * the admin "inherited" hint, and the order snapshot all agree on precedence.
 */
export function categoryWarrantyFromChain(
  chain: readonly (CategoryWarrantyNode | null | undefined)[] | null | undefined,
): WarrantyInput | null {
  for (const node of chain ?? []) {
    if (node && node.warranty_months != null) {
      return { months: node.warranty_months, label: node.warranty_label ?? null };
    }
  }
  return null;
}

/**
 * Resolve the warranty cascade for a product: the most-specific level that
 * sets `months` wins (product → category → global), and supplies the label
 * from that same level so the warranty reads as one coherent unit.
 */
export function resolveWarranty(
  product: WarrantyInput,
  category: WarrantyInput | null,
  global: WarrantyInput,
): ResolvedWarranty {
  let months: number;
  let label: string | null;
  let source: ResolvedWarranty["source"];

  if (product.months != null) {
    months = product.months;
    label = product.label;
    source = "product";
  } else if (category && category.months != null) {
    months = category.months;
    label = category.label;
    source = "category";
  } else {
    months = global.months ?? DEFAULT_GLOBAL_MONTHS;
    label = global.label;
    source = "global";
  }

  const trimmed = label?.trim() || null;
  // Storefront display fills any "X" placeholder in a custom label; the admin
  // still sees the raw `label` they typed (returned unchanged).
  const filled = trimmed ? fillWarrantyLabelPlaceholder(trimmed, months) || null : null;
  const display = filled ?? (months > 0 ? `Garantie ${formatWarrantyDuration(months)}` : null);
  return { months, label: trimmed, source, display };
}

/**
 * Add whole calendar months to a date. Month-length overflow CLAMPS forward per
 * JS `Date.setMonth` (e.g. +1mo on Jan 31 → Mar 3, on Aug 31 → Oct 1). This only
 * ever extends coverage slightly in the CUSTOMER's favour — never short — so it's
 * the safe direction for a warranty expiry. Documented so staff aren't surprised
 * by a date that looks a day or two "off" for end-of-month purchases.
 */
export function addMonths(date: Date, months: number): Date {
  const r = new Date(date.getTime());
  r.setMonth(r.getMonth() + months);
  return r;
}

/** Store timezone — warranty dates render in Africa/Tunis, never the host TZ. */
const STORE_TIME_ZONE = "Africa/Tunis";

export type WarrantyStatus = {
  /** "active" = still covered, "expired" = window passed, "none" = no warranty,
   *  "not_covered" = the line carries a warranty but its ORDER gives no right to
   *  it (pending / cancelled / refunded — see `computeOrderLineWarranty`). */
  state: "active" | "expired" | "none" | "not_covered";
  /** Expiry date — null when there's no warranty or no known purchase date. */
  expiresAt: Date | null;
  /** Ready-to-show French status line. */
  display: string;
  /** The snapshot label carried on the order line, if any. */
  label: string | null;
};

/**
 * Compute the warranty status of a purchased line from its snapshotted
 * duration + purchase date. Drives the SAV / device-lookup screen so staff
 * can tell at a glance whether a unit is still covered. `now` is injectable
 * for deterministic tests.
 */
export function computeWarrantyStatus(
  purchasedAt: Date | null,
  months: number | null,
  label: string | null,
  now: Date = new Date(),
): WarrantyStatus {
  const trimmedLabel = label?.trim() || null;
  if (!months || months <= 0) {
    return { state: "none", expiresAt: null, display: "Sans garantie", label: trimmedLabel };
  }
  if (!purchasedAt) {
    // Duration known but no purchase date — report the coverage length only.
    return {
      state: "active",
      expiresAt: null,
      display: trimmedLabel
        ? fillWarrantyLabelPlaceholder(trimmedLabel, months) ||
          `Garantie ${formatWarrantyDuration(months)}`
        : `Garantie ${formatWarrantyDuration(months)}`,
      label: trimmedLabel,
    };
  }
  const expiresAt = addMonths(purchasedAt, months);
  const active = now.getTime() <= expiresAt.getTime();
  // Render in the STORE timezone, not the host's — a UTC Coolify/Docker server
  // would otherwise print an expiry one calendar day early for late-evening
  // Tunis purchases.
  const dateStr = expiresAt.toLocaleDateString("fr-FR", { timeZone: STORE_TIME_ZONE });
  return {
    state: active ? "active" : "expired",
    expiresAt,
    display: active
      ? `Sous garantie jusqu'au ${dateStr}`
      : `Garantie expirée le ${dateStr}`,
    label: trimmedLabel,
  };
}

/** The order facts that decide a sold line's warranty (admin SAV surfaces). */
export type WarrantyOrderFacts = {
  status: string;
  createdAt: Date;
  /** Payment settlement — at checkout for online, AT DELIVERY for COD. */
  paidAt: Date | null;
  /** First `→ delivered` transition (status history), if any. */
  deliveredAt: Date | null;
};

/**
 * When a sold line's warranty starts: at DELIVERY (the goods are in the
 * customer's hands), else at payment settlement (`paid_at`), else at the order
 * date. A COD order delivered weeks after it was placed no longer loses those
 * weeks of coverage; the fallbacks only apply while no delivery is recorded.
 */
export function warrantyStartDate(order: Omit<WarrantyOrderFacts, "status">): Date {
  return order.deliveredAt ?? order.paidAt ?? order.createdAt;
}

/** Order statuses that give NO right to the lines' warranty — the goods were
 *  never handed over (pending), or the sale was voided (cancelled / refunded). */
const NOT_COVERED_DISPLAY: ReadonlyMap<string, string> = new Map([
  ["pending", "Pas encore couverte — commande en attente"],
  ["cancelled", "Non couverte — commande annulée"],
  ["refunded", "Non couverte — commande remboursée"],
]);

/** True when an order in this status owes NO warranty (see NOT_COVERED_DISPLAY). */
export function orderStatusVoidsWarranty(status: string): boolean {
  return NOT_COVERED_DISPLAY.has(status);
}

/**
 * Warranty verdict for one line OF A GIVEN ORDER — the SAV lookup + order
 * detail. A line with no warranty stays « Sans garantie »; on a pending /
 * cancelled / refunded order a warrantied line reads a NEUTRAL « Non couverte »
 * (never a green « Sous garantie » staff might honour for goods never delivered
 * or already returned); otherwise coverage runs from `warrantyStartDate`.
 */
export function computeOrderLineWarranty(
  order: WarrantyOrderFacts,
  months: number | null,
  label: string | null,
  now: Date = new Date(),
): WarrantyStatus {
  const status = computeWarrantyStatus(warrantyStartDate(order), months, label, now);
  const notCovered = NOT_COVERED_DISPLAY.get(order.status);
  if (status.state === "none" || !notCovered) return status;
  return { state: "not_covered", expiresAt: null, display: notCovered, label: status.label };
}

/** Global warranty default from site settings (`warranty.default_*`). */
export const getDefaultWarranty = cache(async (): Promise<WarrantyInput> => {
  let settings: Record<string, string | null> = {};
  try {
    settings = await getSettingsMap();
  } catch {
    // Settings table unavailable on a cold DB — fall back to "no warranty".
  }
  const raw = settings["warranty.default_months"];
  const n = raw != null && raw.trim() !== "" ? Number(raw) : NaN;
  const months = Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULT_GLOBAL_MONTHS;
  const label = settings["warranty.default_label"]?.trim() || null;
  return { months, label };
});
