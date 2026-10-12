"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { INVALID_MONEY_MESSAGE, parseTndFields } from "@/lib/checkout/money-input";

/**
 * Money settings the admin enters in DINARS (major units) but we store as
 * integer minor units (millimes). The form fields keep their historical
 * `*_cents` key names — read those as "integer minor units", not centimes.
 */
const DINAR_INPUT_KEYS = [
  "checkout.delivery.default_fee_cents",
  "checkout.delivery.free_threshold_cents",
  "checkout.min_order_cents",
] as const;
const DINAR_INPUT_KEY_SET = new Set<string>(DINAR_INPUT_KEYS);

/**
 * Bulk-saves a list of `(key, value)` pairs into `site_settings` from one
 * form submit. The form names match `checkout.*` setting keys 1:1 so the
 * action just iterates without per-field branching.
 *
 * Each upsert hits `workflows.cms.upsertSetting`, which is idempotent and
 * preserves group_key / label so the regular settings panel
 * (`/admin/cms/settings`) doesn't lose context.
 *
 * Unknown keys are ignored (FormData often carries auxiliary fields like
 * the React form action sentinel).
 */

type Field = {
  key: string;
  label: string;
  description?: string;
  // Matches the workflow's `upsertSettingSchema.type` enum.
  type?: "text" | "boolean" | "number" | "media";
};

/**
 * The set of settings the `/admin/system/checkout` page edits. Keep this
 * in sync with the form on that page. Listing them here means the action
 * doesn't try to upsert FormData garbage (the form-action sentinel, file
 * inputs, etc.).
 */
const CHECKOUT_FIELDS: Field[] = [
  // Achat express (the checkout.quick.* form-field toggles + master on/off) is
  // fully owned by /admin/system/express now; the COD method + gateway enable
  // flags live on /admin/system/payments and are shared with the cart. This
  // action touches neither, so it can never clobber them.
  // Delivery
  { key: "checkout.delivery.default_fee_cents", label: "Frais de livraison (TND)", type: "number" },
  { key: "checkout.delivery.free_threshold_cents", label: "Seuil livraison offerte (TND)", type: "number" },
  { key: "checkout.delivery.eta_label", label: "Estimation de livraison", type: "text" },
  // Structured delivery window (DAY counts, not money — NOT in DINAR_INPUT_KEYS).
  // Drives the PDP Offer JSON-LD deliveryTime (handling + transit).
  { key: "checkout.delivery.handling_days_min", label: "Préparation — délai min (jours)", type: "number" },
  { key: "checkout.delivery.handling_days_max", label: "Préparation — délai max (jours)", type: "number" },
  { key: "checkout.delivery.transit_days_min", label: "Transport — délai min (jours)", type: "number" },
  { key: "checkout.delivery.transit_days_max", label: "Transport — délai max (jours)", type: "number" },
  { key: "checkout.delivery.click_collect_label", label: "Click & Collect — texte", type: "text" },
  // Returns & warranty (PDP "Livraison" tab + trust strips) — read by
  // getCheckoutCopy; an unset label is hidden on the storefront.
  { key: "checkout.returns.label", label: "Retours — libellé", type: "text" },
  { key: "checkout.returns.conditions_label", label: "Retours — conditions", type: "text" },
  { key: "checkout.returns.refund_label", label: "Retours — remboursement", type: "text" },
  // Static checkout trust-strip badge — marketing copy only.
  { key: "checkout.warranty.label", label: "Garantie — bandeau de confiance (checkout)", type: "text" },
  // Global product-warranty default — the BASE of the per-product cascade
  // (global → category → product). Read by `@/lib/warranty.getDefaultWarranty`
  // and resolved into `product.warranty` on every PDP + snapshotted onto each
  // order line. A category or product value overrides it. Distinct from the
  // trust-strip badge above, which is just static copy on the checkout page.
  { key: "warranty.default_months", label: "Garantie produit — durée par défaut (mois)", type: "number" },
  { key: "warranty.default_label", label: "Garantie produit — libellé par défaut", type: "text" },
  // Order behaviour / policy
  { key: "checkout.order.number_prefix", label: "Préfixe numéro de commande", type: "text" },
  // Minimum order amount (hard checkout floor; 0/empty = none). DINAR input.
  { key: "checkout.min_order_cents", label: "Montant minimum de commande (TND)", type: "number" },
  // Require an account to order (no guest checkout) — ties every order to a
  // registered account. Enforced authoritatively in place-order.
  { key: "checkout.require_account", label: "Compte requis pour commander", type: "boolean" },
  // Price display precision (0 = whole dinars, 3 = millimes). Stored verbatim
  // (NOT a dinar amount) and read server-side by `@/lib/price-format`.
  { key: "price.decimals", label: "Affichage des prix — décimales", type: "number" },
  // Documents & facturation — prefixes for the gapless fiscal/logistics numbers
  // (facture / avoir / bon de livraison). Read by @/lib/actions/documents +
  // the BL route; blank falls back to the code defaults (FA / AV / BL).
  { key: "invoice.number_prefix", label: "Préfixe facture", type: "text" },
  { key: "invoice.credit_prefix", label: "Préfixe avoir", type: "text" },
  { key: "delivery.note_prefix", label: "Préfixe bon de livraison", type: "text" },
];

export async function saveCheckoutSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("checkout", "update");

  // Admin enters DINARS; we store integer minor units (millimes). The shared
  // parser (the SAME rule the Livraison page applies to these very keys)
  // accepts "," or "." as the decimal separator, keeps blank as null ("unset",
  // e.g. no free-shipping threshold configured) and REFUSES a negative or
  // non-numeric amount — validated for every money field BEFORE any write, so
  // a bad amount never half-saves the form or stores a value the storefront
  // would silently ignore (it falls back to the built-in default fee).
  const money = parseTndFields((key) => formData.get(key), DINAR_INPUT_KEYS);
  if (!money.ok) {
    return {
      ok: false,
      error: "validation",
      message: INVALID_MONEY_MESSAGE,
      fieldErrors: money.fieldErrors,
    };
  }

  const errors: string[] = [];
  for (const field of CHECKOUT_FIELDS) {
    // Booleans: checkboxes submit "on" when ticked, nothing when not.
    // We always write so the off state is persisted.
    let value: string | null;
    if (field.type === "boolean") {
      value = formData.get(field.key) === "on" ? "true" : "false";
    } else if (DINAR_INPUT_KEY_SET.has(field.key)) {
      const millimes = money.values[field.key as (typeof DINAR_INPUT_KEYS)[number]];
      value = millimes == null ? null : String(millimes);
    } else {
      const raw = formData.get(field.key);
      value = raw === null ? null : String(raw).trim() || null;
    }

    const result = await workflows.cms.upsertSetting(
      {
        key: field.key,
        value,
        type: field.type ?? "text",
        groupKey: "checkout",
        label: field.label,
        description: field.description,
      },
      { actorUserId: session.user.id },
    );
    if (!result.ok) errors.push(`${field.label}: ${result.message}`);
  }

  // The storefront layout caches site settings — refresh so changes
  // propagate without redeploy.
  revalidatePath("/", "layout");
  revalidatePath("/admin/system/checkout");

  if (errors.length > 0) {
    return {
      ok: false,
      error: "partial",
      message: `Certains réglages n'ont pas été enregistrés : ${errors.join(" · ")}`,
    };
  }
  return { ok: true, message: "Réglages enregistrés." };
}
