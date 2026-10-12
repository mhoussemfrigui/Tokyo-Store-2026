/**
 * Warranty-claim (SAV / RMA) taxonomy — the reason codes, the status vocabulary
 * and the resolution outcomes, with their FR labels.
 *
 * Isomorphic + client-safe: NO drizzle / server-only imports, so the admin claims
 * console ("use client") can value-import these without shipping the
 * `warranty_claims` table definitions to the browser. Re-exported from
 * `schema.ts` for the server-side consumers. Mirrors `order/returns-reasons.ts`.
 */

/** Why the customer brought the item in (watch-relevant SAV motives). */
export const WARRANTY_REASON_CODES = [
  "malfunction",
  "battery",
  "water_resistance",
  "strap",
  "glass",
  "movement",
  "cosmetic",
  "other",
] as const;
export type WarrantyReasonCode = (typeof WARRANTY_REASON_CODES)[number];

export const WARRANTY_REASON_LABELS: Record<WarrantyReasonCode, string> = {
  malfunction: "Ne fonctionne plus",
  battery: "Pile / batterie",
  water_resistance: "Étanchéité",
  strap: "Bracelet",
  glass: "Verre / vitre",
  movement: "Mouvement",
  cosmetic: "Défaut esthétique",
  other: "Autre",
};

/**
 * Claim lifecycle. `open` → in progress (`in_repair` / `awaiting_parts`, which
 * interchange) → terminal (`resolved` / `rejected`). A terminal claim is never
 * re-processed (the workflows short-circuit on it, like a received/rejected return).
 */
export const WARRANTY_CLAIM_STATUSES = [
  "open",
  "in_repair",
  "awaiting_parts",
  "resolved",
  "rejected",
] as const;
export type WarrantyClaimStatus = (typeof WARRANTY_CLAIM_STATUSES)[number];

export const WARRANTY_CLAIM_STATUS_LABELS: Record<WarrantyClaimStatus, string> = {
  open: "Ouverte",
  in_repair: "En réparation",
  awaiting_parts: "En attente de pièces",
  resolved: "Résolue",
  rejected: "Refusée",
};

/** Terminal statuses — no further transition allowed. */
export const WARRANTY_CLAIM_TERMINAL: ReadonlySet<WarrantyClaimStatus> = new Set([
  "resolved",
  "rejected",
]);

/** Allowed forward transitions (guards the update workflow + the UI controls). */
export const WARRANTY_CLAIM_TRANSITIONS: Record<WarrantyClaimStatus, WarrantyClaimStatus[]> = {
  open: ["in_repair", "awaiting_parts", "resolved", "rejected"],
  in_repair: ["awaiting_parts", "resolved", "rejected"],
  awaiting_parts: ["in_repair", "resolved", "rejected"],
  resolved: [],
  rejected: [],
};

/** How a claim ended — captured on a `resolved`/`rejected` transition. */
export const WARRANTY_RESOLUTIONS = ["repaired", "replaced", "refunded", "rejected"] as const;
export type WarrantyResolution = (typeof WARRANTY_RESOLUTIONS)[number];

export const WARRANTY_RESOLUTION_LABELS: Record<WarrantyResolution, string> = {
  repaired: "Réparée",
  replaced: "Remplacée",
  refunded: "Remboursée",
  rejected: "Refusée",
};

/** Status-badge tone classes (Tailwind), for the admin console. */
export const WARRANTY_CLAIM_STATUS_TONES: Record<WarrantyClaimStatus, string> = {
  open: "bg-amber-500/10 text-amber-600",
  in_repair: "bg-primary/10 text-primary",
  awaiting_parts: "bg-accent/15 text-accent",
  resolved: "bg-emerald-500/10 text-emerald-600",
  rejected: "bg-destructive/10 text-destructive",
};
