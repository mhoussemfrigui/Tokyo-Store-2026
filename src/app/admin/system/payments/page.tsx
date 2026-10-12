import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { isSuperAdmin } from "@/lib/auth/super-admin";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { paymentSettingsService } from "@/modules/payment";
import type { PaymentProviderSettingsRow } from "@/modules/payment/schema";
import { parseTestModeEnv } from "@/lib/payments/config";
import { decryptSecret } from "@/lib/crypto/secrets";
import { AdminPageHeader } from "@/components/admin/page-header";

import { PaymentSettingsPanel, type ProviderTabData } from "./payment-settings-panel";

export const metadata: Metadata = { title: "Paiement" };

const truthy = (v: string | null | undefined): boolean => {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
};
const envSet = (n: string): boolean => Boolean((process.env[n] ?? "").trim());

type FieldDef = { key: string; label: string; envVar: string; col: keyof PaymentProviderSettingsRow };
const DEFS: {
  provider: ProviderTabData["provider"];
  label: string;
  testEnv: string;
  fields: FieldDef[];
}[] = [
  {
    provider: "clictopay",
    label: "ClicToPay (SMT)",
    testEnv: "CLICTOPAY_TEST_MODE",
    fields: [
      { key: "username", label: "userName marchand", envVar: "CLICTOPAY_USERNAME", col: "username_enc" },
      { key: "password", label: "password marchand", envVar: "CLICTOPAY_PASSWORD", col: "password_enc" },
    ],
  },
  {
    provider: "flouci",
    label: "Flouci",
    testEnv: "FLOUCI_TEST_MODE",
    fields: [
      { key: "app_token", label: "App token (apppublic)", envVar: "FLOUCI_APP_TOKEN", col: "app_token_enc" },
      { key: "app_secret", label: "App secret (appsecret)", envVar: "FLOUCI_APP_SECRET", col: "app_secret_enc" },
    ],
  },
];

/**
 * Consolidated payment configuration — credentials (encrypted at rest),
 * sandbox/prod, and the enable flag, per provider. A set environment variable
 * force-overrides and locks the matching field. Secrets are never sent to the
 * browser; the page only reports whether each is present.
 */
export default async function PaymentSettingsPage() {
  const session = await requirePermission("system_payments", "view");
  // No `.catch` on either read: both pre-fill the save form. A swallowed settings
  // read shows both gateways OFF, and a swallowed provider read shows sandbox ON
  // (`test_mode ?? true`) — a normal save would persist those over the live
  // config. A failure reaches the admin error boundary (retry) instead.
  const [rows, settings, canEditCredentials] = await Promise.all([
    paymentSettingsService.listAll(),
    getSettingsMap(),
    // Merchant credentials + the sandbox toggle are super-admin only (see
    // `@/lib/payments/settings-plan`); a delegate sees them read-only.
    isSuperAdmin(session.user.id),
  ]);
  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  const providers: ProviderTabData[] = DEFS.map((d) => {
    const row = byProvider.get(d.provider);
    // Parse *_TEST_MODE with the SAME strict tri-state the runtime resolver uses
    // (parseTestModeEnv): only a RECOGNIZED true/false env value locks + overrides the
    // displayed sandbox state. An unrecognized value (a typo like `prod`) is undefined →
    // NOT locked, falls through to row?.test_mode ?? true — matching resolvePaymentConfig
    // exactly, so the panel can never claim « sandbox » while the gateway charges real cards.
    const envTestMode = parseTestModeEnv(process.env[d.testEnv]);
    const testModeLocked = envTestMode !== undefined;
    return {
      provider: d.provider,
      label: d.label,
      enabled: truthy(settings[`checkout.payment.${d.provider}_enabled`]),
      testMode: envTestMode ?? (row?.test_mode ?? true),
      testModeLocked,
      fields: d.fields.map((f) => {
        const locked = envSet(f.envVar);
        // Presence reflects what the resolver can actually USE: a set env var (locked)
        // wins, else the stored ciphertext must DECRYPT. A rotated/ mismatched
        // PAYMENT_ENCRYPTION_KEY makes decryptSecret return "" → hasValue false → the
        // field shows « non défini » and the gateway won't render « prêt », prompting the
        // operator to re-enter (instead of a green "ready" over a dead key).
        const hasValue = locked || Boolean(decryptSecret(row?.[f.col] as string | null | undefined));
        return {
          key: f.key,
          label: f.label,
          name: `secret.${d.provider}.${f.key}`,
          hasValue,
          locked,
          envVar: f.envVar,
        };
      }),
    };
  });

  // This page owns payment METHODS: the online gateways (credentials + enable +
  // sandbox) and the COD method (cod_enabled / cod_label). These are the SHARED
  // allowed-methods set used by BOTH the cart and the express flow (the customer
  // always chooses among them). The express form fields live on the dedicated
  // "Achat express" page; express has no payment routing of its own.
  const cod = {
    // COD defaults to ON when never set (matches the storefront fallback in
    // getQuickBuyConfig, which treats null as enabled).
    codEnabled:
      truthy(settings["checkout.quick.cod_enabled"]) ||
      settings["checkout.quick.cod_enabled"] == null,
    codLabel: settings["checkout.quick.cod_label"] ?? "",
    // « Paiement manuel » — OFF unless explicitly enabled.
    manualPaymentEnabled: truthy(settings["orders.manual_payment_enabled"]),
  };

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Paiement"
        description="Méthodes de paiement : passerelles en ligne (clés chiffrées, sandbox/production, activation) et paiement à la livraison. Le parcours d'achat express se configure sur la page « Achat express ». Une variable d'environnement définie a la priorité et verrouille le champ correspondant."
      />
      <PaymentSettingsPanel
        providers={providers}
        cod={cod}
        canEditCredentials={canEditCredentials}
      />
    </div>
  );
}
