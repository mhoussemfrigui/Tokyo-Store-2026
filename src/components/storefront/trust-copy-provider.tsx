"use client";

import { createContext, useContext } from "react";

import {
  type TrustBadgeAppearance,
  TRUST_BADGE_APPEARANCE_DEFAULTS,
} from "@/lib/cms/trust-badge-appearance";

/**
 * Storefront trust labels (delivery ETA / warranty / returns), sourced from the
 * admin checkout-copy settings and provided once at the shop layout. Client
 * components deep in the tree (product cards, buy block, home rails) read them
 * via `useTrustCopy()` instead of hardcoding strings — so editing them in
 * `/admin/system/checkout` updates every surface at once.
 *
 * No hardcoded defaults: a label is the empty string until the operator sets
 * it, and every consumer hides the line/badge when it's blank. We never assert
 * a delivery / warranty / returns claim the operator hasn't entered.
 */
/**
 * One admin-managed buy-box reassurance badge (a row of `trust_badges`, mapped
 * to a client-safe shape in the shop layout). `kind` lets the buy-box special-
 * case copy; `visibility` is gated against product state at render.
 */
export type TrustBadgeView = {
  kind: string | null;
  label: string;
  icon: string;
  visibility: string;
};

export type TrustCopy = {
  eta: string;
  warranty: string;
  returns: string;
  /** Admin-managed reassurance badge strip (empty when none active / on failure). */
  badges: TrustBadgeView[];
  /** Strip appearance + per-surface placement (Badges de confiance → Apparence). */
  config: TrustBadgeAppearance;
};

const EMPTY: TrustCopy = {
  eta: "",
  warranty: "",
  returns: "",
  badges: [],
  config: TRUST_BADGE_APPEARANCE_DEFAULTS,
};

const TrustCopyContext = createContext<TrustCopy>(EMPTY);

export function TrustCopyProvider({
  value,
  children,
}: {
  value: TrustCopy;
  children: React.ReactNode;
}) {
  return <TrustCopyContext.Provider value={value}>{children}</TrustCopyContext.Provider>;
}

export function useTrustCopy(): TrustCopy {
  return useContext(TrustCopyContext);
}
