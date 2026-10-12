"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { checkSuperAdmin, isSuperAdmin } from "@/lib/auth/super-admin";
import { paymentSettingsService } from "@/modules/payment";
import { isEncryptionConfigured } from "@/lib/crypto/secrets";
import { invalidatePaymentConfigCache } from "@/lib/payments/config";
import { providerSupportsTestMode, type GatewayMethod } from "@/lib/payments/shared";
import {
  PAYMENT_CREDENTIAL_PROVIDERS,
  decideGatewayEnable,
  planPaymentSettingsSave,
  snapshotStoredProvider,
  type StoredProviderSnapshot,
} from "@/lib/payments/settings-plan";
import { sanitizeCodLabel } from "@/lib/checkout/quick-buy-config";
import { type ActionState } from "@/lib/actions/types";

/**
 * Save the consolidated payments page: per-provider credentials (encrypted),
 * sandbox/prod, and enable on/off. Env-locked fields are skipped (the env value
 * force-overrides anyway, and their inputs submit nothing because they're
 * disabled). The enable flags are mirrored to `site_settings`
 * (`checkout.payment.<provider>_enabled`) — the keys the storefront reads.
 *
 * The credentials + sandbox toggle are super-admin only; the enable flags and
 * the COD method stay delegable. The rules (owner gate, « every credential »
 * enable guard) live in the pure `@/lib/payments/settings-plan` (unit-tested).
 */

const envSet = (name: string): boolean => Boolean((process.env[name] ?? "").trim());

export async function savePaymentSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_payments", "update");
  const errors: string[] = [];
  // Gateway refusals (incomplete credentials, unreadable row) keyed by the
  // enable toggle's input name, so the panel can point at the provider's tab.
  const fieldErrors: Record<string, string> = {};

  // What is stored BEFORE the save. A failed read is `null` (≠ no row): the
  // enable guard then keeps the stored flag instead of switching the gateway off.
  const stored: Partial<Record<GatewayMethod, StoredProviderSnapshot>> = {};
  for (const def of PAYMENT_CREDENTIAL_PROVIDERS) {
    stored[def.provider] = await paymentSettingsService.get(def.provider).then(
      (row) => snapshotStoredProvider(def, row),
      () => null,
    );
  }

  // Plan every provider BEFORE any write: a non-owner form carrying a secret or
  // a sandbox change is refused whole (nothing half-applied).
  const plan = planPaymentSettingsSave((name) => formData.get(name), {
    canEditCredentials: await isSuperAdmin(session.user.id),
    envLocked: envSet,
    supportsTestMode: providerSupportsTestMode,
    stored,
  });
  if (!plan.ok) {
    // Record the probe on the security trail (rbac.permission_denied).
    await checkSuperAdmin(session.user.id);
    return { ok: false, error: plan.error, message: plan.message };
  }
  if (plan.providers.some((p) => Object.keys(p.secrets).length > 0) && !isEncryptionConfigured()) {
    return {
      ok: false,
      error: "no_encryption_key",
      message:
        "Définissez PAYMENT_ENCRYPTION_KEY (ex. `openssl rand -base64 32`) avant d'enregistrer des clés API.",
    };
  }

  for (const p of plan.providers) {
    const { def } = p;
    const res = await workflows.payment.upsertProviderSettings(
      { provider: def.provider, testMode: p.testMode, secrets: p.secrets },
      { actorUserId: session.user.id },
    );
    if (!res.ok) errors.push(`${def.label}: ${res.message}`);

    // A provider may only be ENABLED when EVERY credential it needs resolves
    // (env-set, just SAVED, or already stored) — otherwise the storefront would
    // offer a dead-end gateway. Mirror the gated flag to site_settings (the
    // storefront source of truth); an unreadable row keeps the stored flag.
    const decision = decideGatewayEnable({
      def,
      requested: p.enableRequested,
      envLocked: envSet,
      saved: res.ok ? p.secrets : {},
      stored: stored[def.provider] ?? null,
    });
    const enableKey = `checkout.payment.${def.provider}_enabled`;
    if (decision.error) fieldErrors[enableKey] = decision.error;
    if (!decision.write) continue;
    const er = await workflows.cms.upsertSetting(
      {
        key: enableKey,
        value: decision.value ? "true" : "false",
        type: "boolean",
        groupKey: "checkout",
        label: `${def.label} — activé`,
      },
      { actorUserId: session.user.id },
    );
    if (!er.ok) errors.push(`${def.label} (activation): ${er.message}`);
  }

  // ── COD method (cod_enabled / cod_label) ─────────────────────────────────
  // The COD METHOD lives here (it's a payment method), alongside the gateway
  // enable flags. These are the SHARED allowed-methods set: both the cart and
  // the express ("Acheter maintenant") flow offer exactly these, and the
  // customer chooses. Express has no payment routing of its own.
  const codEnabled = formData.get("checkout.quick.cod_enabled") === "on";
  // Sanitised: an email-shaped value (password-manager autofill) is dropped to
  // null so it can never become the storefront COD label. See sanitizeCodLabel.
  const codLabel = sanitizeCodLabel(formData.get("checkout.quick.cod_label") as string) ?? "";

  // « Paiement manuel » — enable the operator-facing paid/partial/unpaid control.
  const manualPaymentEnabled = formData.get("orders.manual_payment_enabled") === "on";

  const codSettings: Array<{ key: string; value: string; type: "text" | "boolean"; groupKey: string; label: string }> = [
    { key: "checkout.quick.cod_enabled", value: codEnabled ? "true" : "false", type: "boolean", groupKey: "checkout", label: "Paiement à la livraison — activé" },
    { key: "checkout.quick.cod_label", value: codLabel, type: "text", groupKey: "checkout", label: "Paiement à la livraison — libellé" },
    { key: "orders.manual_payment_enabled", value: manualPaymentEnabled ? "true" : "false", type: "boolean", groupKey: "orders", label: "Paiement manuel — activé" },
  ];
  for (const s of codSettings) {
    const r = await workflows.cms.upsertSetting(
      {
        key: s.key,
        value: s.value || null,
        type: s.type,
        groupKey: s.groupKey,
        label: s.label,
      },
      { actorUserId: session.user.id },
    );
    if (!r.ok) errors.push(`${s.label}: ${r.message}`);
  }

  invalidatePaymentConfigCache();
  revalidatePath("/admin/system/payments");
  revalidatePath("/admin/system/express"); // COD label feeds the express Paiement tab's read-only methods echo
  revalidatePath("/", "layout"); // storefront reads the enable + COD flags

  const hasFieldErrors = Object.keys(fieldErrors).length > 0;
  if (errors.length > 0 || hasFieldErrors) {
    return {
      ok: false,
      error: "partial",
      message:
        errors.length > 0
          ? `Erreurs : ${errors.join(" · ")}`
          : "Réglages enregistrés, mais une passerelle n'a pas pu être activée :",
      ...(hasFieldErrors ? { fieldErrors } : {}),
    };
  }
  return { ok: true, message: "Réglages de paiement enregistrés." };
}
