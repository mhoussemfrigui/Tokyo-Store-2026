import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { pickSettings } from "@/lib/settings/pick-settings";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { AdminPageHeader } from "@/components/admin/page-header";

import { CheckoutSettingsPanel } from "./checkout-settings-panel";

export const metadata: Metadata = { title: "Commande" };

/**
 * Global commerce settings (« Réglages commande ») : delivery pricing +
 * labels, returns & warranty copy, the quick-buy form field toggles and
 * order behaviour. Payment (COD + online gateways) is configured on
 * /admin/system/payments — this page links there instead.
 *
 * Backed by the `site_settings` table — no dedicated schema. Keys are
 * grouped under `checkout.*` so the regular settings panel can still see
 * them, but admins editing checkout will reach for this dedicated page.
 */
export default async function CheckoutSettingsPage() {
  await requirePermission("checkout", "view");
  // No `.catch`: a failed read must reach the admin error boundary (retry), not
  // pre-fill the form with defaults that a save would persist.
  const settings = await getSettingsMap();

  // Pass ONLY the keys this panel reads. `getSettingsMap()` returns the whole
  // `site_settings` table, which also holds OTHER panels' encrypted secrets
  // (e.g. `mail.*_enc`); forwarding the full map would ship that ciphertext
  // into the client bundle. Behaviour-preserving — the panel reads exactly
  // these prefixes.
  const panelSettings = pickSettings(settings, [
    "checkout.",
    "warranty.",
    "price.",
    "invoice.",
    "delivery.",
    "tax.",
  ]);

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Commande"
        description="Livraison, retours & garantie, comportement du tunnel de commande et formulaire d'achat express. Les valeurs sont stockées dans les réglages site (clés checkout.*)."
      />
      <p className="rounded-2xl border border-dashed border-border bg-surface/40 px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
        Le paiement à la livraison se configure sur{" "}
        <a
          href="/admin/system/payments"
          className="font-semibold text-primary hover:underline"
        >
          Système → Paiement
        </a>
        .
      </p>
      <CheckoutSettingsPanel settings={panelSettings} />
    </div>
  );
}
