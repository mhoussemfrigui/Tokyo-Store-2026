/**
 * Pure resolution of the admin-managed `trust_badges` reassurance strip into the
 * two rendered groups. Kept out of the component so the gating rules (which are
 * subtle: per-surface stock state, per-product warranty, dynamic
 * delivery/returns copy) are unit-testable in isolation.
 *
 * Shared by every surface the strip renders on (product buy-box, cart, checkout
 * — see `TrustBand`), each supplying its own `BuyBoxState`. Isomorphic +
 * dependency-free: the renderer maps the returned icon names to components via
 * the shared trust-icon map.
 *
 * Visibility is `always | in_stock`. The retired `preorder` value (preorders
 * were removed store-wide) is migrated to `in_stock` by migration 0179 and
 * rejected on write, so it is no longer gated here.
 */

export type TrustBadgeInput = {
  kind: string | null;
  label: string;
  icon: string;
  visibility: string;
};

export type ResolvedBadge = { icon: string; label: string };

export type BuyBoxState = {
  /** Whether the surface's items are in stock (an `in_stock`-gated badge hides
   *  when false). Cart/checkout pass true; the PDP passes the product's state. */
  inStock: boolean;
  /** Warranty copy for a `warranty`-kind badge: the product's own coverage on
   *  the PDP, or the generic checkout warranty line on cart/checkout. Null drops
   *  the warranty badge. */
  warranty: string | null;
  /** Admin checkout copy — the dynamic delivery ETA + returns lines. */
  etaCopy: string;
  returnsCopy: string;
};

/**
 * Resolve the active badges into the two rendered groups:
 *   - `security`: the centered "Paiement sécurisé"-style line(s).
 *   - `list`: the bordered reassurance list.
 *
 * Built-in `kind`s carry dynamic copy: warranty → the product's own coverage
 * (dropped when the product has none); delivery/returns → the admin ETA/returns
 * copy. Custom badges (kind null) always use their own label.
 */
export function resolveBuyBoxBadges(
  badges: TrustBadgeInput[],
  s: BuyBoxState,
): { security: ResolvedBadge[]; list: ResolvedBadge[] } {
  const visible = (b: TrustBadgeInput) =>
    b.visibility === "always" || (b.visibility === "in_stock" && s.inStock);

  const resolveLabel = (b: TrustBadgeInput): string | null => {
    if (b.kind === "warranty") return s.warranty || null;
    if (b.kind === "delivery") return s.etaCopy || b.label || null;
    if (b.kind === "returns") return s.returnsCopy || b.label || null;
    return b.label || null;
  };

  const shown = badges
    .filter(visible)
    .map((b) => ({ b, label: resolveLabel(b) }))
    .filter((x): x is { b: TrustBadgeInput; label: string } => Boolean(x.label));

  const security = shown
    .filter((x) => x.b.kind === "security")
    .map((x) => ({ icon: x.b.icon, label: x.label }));
  const rest = shown
    .filter((x) => x.b.kind !== "security")
    .map((x) => ({ icon: x.b.icon, label: x.label }));

  return { security, list: rest };
}
