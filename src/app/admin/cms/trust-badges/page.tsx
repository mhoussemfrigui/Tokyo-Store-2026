import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { trustBadgeService } from "@/modules/cms/trust_badge/service";
import { productQueries } from "@/modules/catalog/product";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { getTrustBadgeAppearance } from "@/lib/cms/trust-badge-appearance";
import { getCheckoutCopy, CHECKOUT_COPY_FALLBACKS } from "@/lib/checkout/copy";
import { TrustBadgesPanel } from "./trust-badges-panel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Badges de confiance" };

export default async function TrustBadgesAdminPage() {
  await requirePermission("trust_badges", "view");
  const [rows, settings, nextOrder, sample, checkoutCopy] = await Promise.all([
    trustBadgeService.list(),
    // STRICT read (no fail-soft): this pre-fills the appearance SAVE form, so a
    // degraded empty read + save would silently overwrite storefront.trust_badges.*
    // with defaults — fail closed to the admin error boundary instead.
    getSettingsMap(),
    trustBadgeService.nextDisplayOrder().catch(() => 0),
    // A representative published product to open the real buy-box preview from.
    productQueries.listPublishedProducts({ limit: 1 }).then((p) => p[0]?.slug ?? null).catch(() => null),
    getCheckoutCopy().catch(() => CHECKOUT_COPY_FALLBACKS),
  ]);
  return (
    <TrustBadgesPanel
      items={rows.map((r) => ({
        id: r.id,
        label: r.label,
        icon: r.icon,
        kind: r.kind,
        visibility: r.visibility,
        isActive: r.is_active,
        displayOrder: r.display_order,
      }))}
      appearance={getTrustBadgeAppearance(settings)}
      nextOrder={nextOrder}
      sampleProductSlug={sample}
      checkoutCopy={{
        eta: checkoutCopy.etaLabel ?? "",
        warranty: checkoutCopy.warrantyLabel ?? "",
        returns: checkoutCopy.returnsLabel ?? "",
      }}
    />
  );
}
