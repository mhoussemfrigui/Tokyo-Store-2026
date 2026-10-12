import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { pickSettings } from "@/lib/settings/pick-settings";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { AdminPageHeader } from "@/components/admin/page-header";

import { ExpressSettingsPanel } from "./express-settings-panel";

export const metadata: Metadata = { title: "Achat express" };

const truthy = (v: string | null | undefined): boolean => {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
};

const GATEWAY_LABELS: Record<string, string> = {
  clictopay: "ClicToPay",
  flouci: "Flouci",
};

/**
 * Achat express — the control surface for the 1-tap "Acheter maintenant"
 * purchase path (availability + form fields), split into sub-tabs. The payment
 * METHODS (COD + the gateways) are configured on the Paiement page and shared
 * with the cart; express adds no payment routing of its own — the customer
 * always chooses COD vs an online gateway. The "Paiement" tab surfaces the
 * currently-allowed methods (read-only) so the operator sees what express
 * offers without leaving the page.
 */
export default async function ExpressSettingsPage() {
  await requirePermission("system_express", "view");
  // No `.catch`: a failed read must reach the admin error boundary (retry), not
  // pre-fill the form with defaults that a save would persist.
  const settings = await getSettingsMap();

  // The methods express currently offers (read-only echo for the Paiement tab):
  // COD (when enabled) + the online gateways enabled on the Paiement page.
  const codEnabled =
    truthy(settings["checkout.quick.cod_enabled"]) || settings["checkout.quick.cod_enabled"] == null;
  const enabledMethods: Array<{ value: string; label: string }> = [];
  if (codEnabled) {
    enabledMethods.push({ value: "cod", label: settings["checkout.quick.cod_label"]?.trim() || "Paiement à la livraison" });
  }
  for (const g of ["clictopay", "flouci"] as const) {
    if (truthy(settings[`checkout.payment.${g}_enabled`])) {
      enabledMethods.push({ value: g, label: GATEWAY_LABELS[g] });
    }
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Achat express"
        description="Le parcours d'achat rapide en 1 tap (« Acheter maintenant ») : disponibilité et champs du formulaire. Le paiement est partagé avec le panier — le client choisit COD ou paiement en ligne parmi les méthodes activées sur la page Paiement."
      />
      {/* Only the checkout.* keys the panel reads — never the whole table
          (other panels' secrets, SMTP identity, promo codes) into the client. */}
      <ExpressSettingsPanel
        settings={pickSettings(settings, ["checkout."])}
        enabledMethods={enabledMethods}
      />
    </div>
  );
}
