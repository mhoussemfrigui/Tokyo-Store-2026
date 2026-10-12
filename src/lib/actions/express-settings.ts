"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";

/**
 * Save the "Achat express" page — the SINGLE control surface for the express
 * (1-tap "Acheter maintenant") purchase path. Owns: the master on/off and the
 * express form-field toggles. It does NOT own payment: express offers the same
 * methods enabled on the Paiement page and the customer always chooses COD vs
 * an online gateway (no express-specific routing). The COD method + gateway
 * enable flags live on Paiement; the field toggles were relocated here from
 * Réglages commande so express is configured in ONE place.
 */

// Every express setting is a boolean checkbox (the master switch + the form-
// field toggles); after the payment dedupe there is no text-typed key here.
type Field = { key: string; label: string };

const EXPRESS_FIELDS: Field[] = [
  { key: "checkout.quick.enabled", label: "Achat express — activé" },
  // Form-field toggles (relocated from Réglages commande). NB: phone is NOT
  // here — it's a hard, non-toggleable requirement on every order (see
  // quick-buy-config), so the panel no longer exposes a phone show/require
  // switch (and a stale save can't hide the field anymore).
  { key: "checkout.quick.email_enabled", label: "Email — afficher" },
  { key: "checkout.quick.email_required", label: "Email — requis" },
  { key: "checkout.quick.city_enabled", label: "Ville — afficher" },
  { key: "checkout.quick.street_line2_enabled", label: "Complément d'adresse — afficher" },
  { key: "checkout.quick.region_enabled", label: "Gouvernorat — afficher" },
  { key: "checkout.quick.postal_code_enabled", label: "Code postal — afficher" },
  { key: "checkout.quick.notes_enabled", label: "Notes — afficher" },
];

export async function saveExpressSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_express", "update");

  const errors: string[] = [];
  for (const f of EXPRESS_FIELDS) {
    const r = await workflows.cms.upsertSetting(
      {
        key: f.key,
        value: formData.get(f.key) === "on" ? "true" : "false",
        type: "boolean",
        groupKey: "checkout",
        label: f.label,
      },
      { actorUserId: session.user.id },
    );
    if (!r.ok) errors.push(`${f.label}: ${r.message}`);
  }

  revalidatePath("/admin/system/express");
  revalidatePath("/", "layout"); // storefront reads the express config

  if (errors.length > 0) {
    return { ok: false, error: "partial", message: `Erreurs : ${errors.join(" · ")}` };
  }
  return { ok: true, message: "Réglages de l'achat express enregistrés." };
}
