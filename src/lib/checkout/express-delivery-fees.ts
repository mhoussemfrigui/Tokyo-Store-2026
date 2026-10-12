/**
 * PURE (client-safe) fee preview for the express (« Acheter maintenant ») home
 * delivery options. The PDP builds its quick-buy config at subtotal 0, so the
 * option fees it carries are the raw rates — without this, the express picker
 * showed « + 7 TND » on a watch above the free-shipping threshold that
 * `resolveDelivery` then delivers for free. Re-applies, against the live
 * goods amount (price × quantity), the SAME rules the server charges with:
 *   - a courier zone-priced for the chosen gouvernorat → `zoneHomeAgentFee`;
 *   - otherwise the option's own free-shipping threshold
 *     (`QuickBuyConfig.delivery.homeFreeThresholds`, `""` = the global base)
 *     through `applyFreeThreshold`.
 * An option with no known threshold keeps its preview fee. Display only — the
 * authoritative fee is always recomputed server-side at order time.
 */
import {
  applyFreeThreshold,
  zoneHomeAgentFee,
  type RegionAgentFeeIndex,
} from "@/lib/checkout/delivery-fee";
import type { DeliveryOption } from "@/lib/checkout/delivery";

export function expressHomeOptionFees(
  home: readonly DeliveryOption[],
  ctx: {
    /** Goods amount the fee is judged against (unit price × quantity), millimes. */
    goodsCents: number;
    region: string | null | undefined;
    zoneFeeIndex: RegionAgentFeeIndex | null | undefined;
    homeFreeThresholds: Readonly<Record<string, number>> | null | undefined;
  },
): DeliveryOption[] {
  return home.map((o) => {
    // The base option (no id) is never zone-priced (resolveDelivery routes it
    // through previewShipping).
    const zoned =
      o.id !== undefined ? zoneHomeAgentFee(ctx.zoneFeeIndex, ctx.region, o.id, ctx.goodsCents) : null;
    if (zoned) return { ...o, feeCents: zoned.feeCents, freeApplied: zoned.freeApplied };
    const threshold = ctx.homeFreeThresholds?.[o.id ?? ""];
    if (threshold === undefined) return o;
    const f = applyFreeThreshold(o.feeCents, threshold, ctx.goodsCents);
    return { ...o, feeCents: f.feeCents, freeApplied: f.freeApplied };
  });
}
