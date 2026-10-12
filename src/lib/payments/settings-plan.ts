import type { GatewayMethod } from "@/lib/payments/shared";

/**
 * Pure rules behind the admin « Paiement » save (`savePaymentSettingsAction`)
 * — which gateway credentials / sandbox flags / enable flags get written for a
 * submitted form. Kept free of DB/session access so the security + integrity
 * invariants are unit-testable (src/lib/db/tests/payment-gateway-completeness.test.ts):
 *
 *   - Merchant CREDENTIALS and the SANDBOX toggle are super-admin (`*`) only.
 *     Online payments settle into whichever merchant account the stored
 *     credentials name, and a sandboxed ClicToPay « pays » real orders with
 *     public test cards — so a delegated `system_payments:update` operator
 *     could otherwise divert every payment to their own merchant account (or
 *     get orders marked paid for free). Same rule as the mail transport
 *     (`@/lib/email/mail-settings`). The enable flags and the COD method stay
 *     delegable. A form carrying a typed secret or a sandbox CHANGE from a
 *     non-owner is refused whole, before any write.
 *   - A gateway may only be ENABLED when EVERY credential it needs resolves
 *     (env-locked, just saved, or already stored): ClicToPay needs userName
 *     AND password, Flouci app token AND app secret. With one missing the
 *     storefront would offer a gateway whose initiation always fails. Such an
 *     enable request is REPORTED (not silently saved as « désactivé »).
 *   - When the stored credentials could not be READ, the stored enable flag is
 *     kept unchanged — a transient DB error must never switch a live gateway off.
 */

export type PaymentProviderDef = {
  provider: GatewayMethod;
  label: string;
  /** Env var that force-sets (and locks) the sandbox flag. */
  testEnv: string;
  /** Every credential the provider's client REQUIRES (all must resolve to enable it). */
  fields: ReadonlyArray<{ key: string; label: string; env: string }>;
};

export const PAYMENT_CREDENTIAL_PROVIDERS: ReadonlyArray<PaymentProviderDef> = [
  {
    provider: "clictopay",
    label: "ClicToPay",
    testEnv: "CLICTOPAY_TEST_MODE",
    fields: [
      { key: "username", label: "userName marchand", env: "CLICTOPAY_USERNAME" },
      { key: "password", label: "password marchand", env: "CLICTOPAY_PASSWORD" },
    ],
  },
  {
    provider: "flouci",
    label: "Flouci",
    testEnv: "FLOUCI_TEST_MODE",
    fields: [
      { key: "app_token", label: "app token", env: "FLOUCI_APP_TOKEN" },
      { key: "app_secret", label: "app secret", env: "FLOUCI_APP_SECRET" },
    ],
  },
];

/**
 * What is stored for a provider before the save — or `null` when the row could
 * not be READ (a DB error, which is NOT the same as "no row yet").
 */
export type StoredProviderSnapshot = {
  /** Effective stored sandbox flag (`row?.test_mode ?? true`, the resolver's default). */
  testMode: boolean;
  /** Credential field key → a ciphertext is stored for it. */
  hasField: Record<string, boolean>;
} | null;

/** Snapshot of a `payment_provider_settings` row (`null` row = nothing stored yet). */
export function snapshotStoredProvider(
  def: PaymentProviderDef,
  row: Record<string, unknown> | null | undefined,
): NonNullable<StoredProviderSnapshot> {
  const testMode = row?.test_mode;
  return {
    testMode: typeof testMode === "boolean" ? testMode : true,
    hasField: Object.fromEntries(def.fields.map((f) => [f.key, Boolean(row?.[`${f.key}_enc`])])),
  };
}

export const PAYMENT_OWNER_ONLY_MESSAGE =
  "Seul un super-administrateur peut modifier les identifiants de paiement et le mode sandbox.";

export type ProviderWritePlan = {
  def: PaymentProviderDef;
  /** Typed, non-env-locked secrets to encrypt + store (empty ⇒ keep the stored ones). */
  secrets: Record<string, string>;
  /** Sandbox flag to store, or `undefined` ⇒ keep the stored value. */
  testMode: boolean | undefined;
  /** The operator ticked « Activer … au paiement ». */
  enableRequested: boolean;
};

/**
 * Plan the credential / sandbox writes for every provider — no write yet. A
 * non-owner (`canEditCredentials: false`) form carrying any typed secret, or a
 * sandbox value that differs from the stored one, is refused WHOLE (`forbidden`)
 * so nothing is half-applied. The owner-locked inputs are rendered disabled for
 * a non-owner, and a disabled input posts nothing — so an ABSENT sandbox box
 * means « keep » for them (never « turn sandbox off »), and a normal delegated
 * save (enable flags, COD) never trips the refusal.
 */
export function planPaymentSettingsSave(
  read: (name: string) => unknown,
  opts: {
    canEditCredentials: boolean;
    envLocked: (envVar: string) => boolean;
    supportsTestMode: (provider: GatewayMethod) => boolean;
    stored: Partial<Record<GatewayMethod, StoredProviderSnapshot>>;
    providers?: ReadonlyArray<PaymentProviderDef>;
  },
): { ok: true; providers: ProviderWritePlan[] } | { ok: false; error: "forbidden"; message: string } {
  const plans: ProviderWritePlan[] = [];
  for (const def of opts.providers ?? PAYMENT_CREDENTIAL_PROVIDERS) {
    // Only the secrets that were typed AND aren't env-locked (env wins; its
    // input is disabled and submits nothing anyway).
    const secrets: Record<string, string> = {};
    for (const f of def.fields) {
      if (opts.envLocked(f.env)) continue;
      const v = String(read(`secret.${def.provider}.${f.key}`) ?? "").trim();
      if (v) secrets[f.key] = v;
    }
    if (!opts.canEditCredentials && Object.keys(secrets).length > 0) {
      return { ok: false, error: "forbidden", message: PAYMENT_OWNER_ONLY_MESSAGE };
    }

    // Sandbox: skipped (undefined → stored value kept) when env-locked or when
    // the provider's client doesn't act on test_mode (e.g. Flouci — the panel
    // renders no toggle, so there is nothing to read and nothing to flip).
    let testMode: boolean | undefined;
    if (!opts.envLocked(def.testEnv) && opts.supportsTestMode(def.provider)) {
      const raw = read(`test_mode.${def.provider}`);
      if (opts.canEditCredentials) {
        testMode = raw === "on";
      } else if (raw != null) {
        // A non-owner's toggle is disabled (posts nothing): a posted value is a
        // crafted form — accepted only when it provably matches what's stored.
        const stored = opts.stored[def.provider];
        if (!stored || (raw === "on") !== stored.testMode) {
          return { ok: false, error: "forbidden", message: PAYMENT_OWNER_ONLY_MESSAGE };
        }
      }
    }

    plans.push({
      def,
      secrets,
      testMode,
      enableRequested: read(`checkout.payment.${def.provider}_enabled`) === "on",
    });
  }
  return { ok: true, providers: plans };
}

/**
 * The `checkout.payment.<provider>_enabled` write for one gateway, decided
 * AFTER its credentials write: `saved` holds the secrets that write actually
 * stored (empty when it failed). `write: false` ⇒ leave the stored flag as is.
 */
export type EnableDecision =
  | { write: true; value: boolean; error?: string }
  | { write: false; error: string };

export function decideGatewayEnable(input: {
  def: PaymentProviderDef;
  requested: boolean;
  envLocked: (envVar: string) => boolean;
  saved: Record<string, string>;
  stored: StoredProviderSnapshot;
}): EnableDecision {
  const { def } = input;
  // Disabling never needs credentials.
  if (!input.requested) return { write: true, value: false };
  const unresolved = def.fields.filter((f) => !input.envLocked(f.env) && !input.saved[f.key]);
  if (unresolved.length === 0) return { write: true, value: true };
  if (input.stored === null) {
    return {
      write: false,
      error: `${def.label} : identifiants illisibles pour le moment — activation inchangée, réessayez.`,
    };
  }
  const stored = input.stored;
  const missing = unresolved.filter((f) => !stored.hasField[f.key]);
  if (missing.length === 0) return { write: true, value: true };
  return {
    write: true,
    value: false,
    error: `${def.label} : identifiants incomplets (${missing
      .map((f) => f.label)
      .join(", ")} manquant) — passerelle non activée.`,
  };
}
