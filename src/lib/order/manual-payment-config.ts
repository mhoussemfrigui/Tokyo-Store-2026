import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";

/** site_settings key for the « Paiement manuel » feature toggle (Système → Paiement). */
export const MANUAL_PAYMENT_SETTING_KEY = "orders.manual_payment_enabled";

/**
 * Whether operators may manually set an order's payment state (Payée /
 * Partiellement payée / Non payée). OFF by default — fail CLOSED so the control
 * + its action stay hidden/refused unless explicitly enabled (and if settings
 * are unreadable).
 */
export async function isManualPaymentEnabled(): Promise<boolean> {
  try {
    const settings = await getSettingsMap();
    return settings[MANUAL_PAYMENT_SETTING_KEY] === "true";
  } catch {
    return false;
  }
}
