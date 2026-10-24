import type { Metadata } from "next";

import { CheckoutView } from "@/storefront/components/storefront/checkout-view";
import { deliveryQueries } from "@/modules/delivery/queries";
import { getQuickBuyConfig } from "@/lib/checkout/quick-buy-config";
import { getCurrentUser } from "@/lib/auth/session";
import { customerUserLink } from "@/associations/customer-user.service";
import { customerService } from "@/modules/customer/service";

export const metadata: Metadata = {
  title: "Commande",
  description: "Finalisez votre commande Tokyo Store en toute sécurité.",
  robots: { index: false, follow: false },
};

export default async function CheckoutPage() {
  // Real in-store pickup points (Commandes → Livraison) + the signed-in viewer
  // (identity card + prefill + address book). Each read is graceful.
  const [pickupRows, user, quickConfig] = await Promise.all([
    deliveryQueries.listEnabledPickups("in_store").catch(() => []),
    getCurrentUser().catch(() => null),
    // Same admin payment config the express flow uses — so the 3-step checkout
    // offers exactly the enabled methods (COD / ClicToPay / Flouci) instead of a
    // hardcoded COD+Flouci pair. The server action re-gates authoritatively.
    getQuickBuyConfig().catch(() => null),
  ]);
  const payment = quickConfig
    ? {
        codEnabled: quickConfig.payment.codEnabled,
        codLabel: quickConfig.payment.codLabel,
        codDescription: quickConfig.payment.codDescription,
        clictopayEnabled: quickConfig.payment.clictopayEnabled,
        clictopayLabel: quickConfig.payment.clictopayLabel,
        flouciEnabled: quickConfig.payment.flouciEnabled,
        flouciLabel: quickConfig.payment.flouciLabel,
      }
    : null;
  const pickups = pickupRows.map((p) => ({
    id: p.id,
    name: p.name,
    address: [p.address_line, p.city].filter(Boolean).join(", ") || null,
    city: p.city,
    phone: p.phone,
    // Carry the pickup handling fee so the checkout total/tiles match the amount
    // the backend charges for this location (most pickups are free → 0).
    feeCents: p.fee_cents ?? 0,
  }));

  // Signed-in customer profile → phone prefill + saved shipping addresses.
  const link = user ? await customerUserLink.findByUserId(user.id).catch(() => null) : null;
  const profile = link
    ? await customerService.findProfileById(link.customer_profile_id).catch(() => null)
    : null;
  const addressRows = profile
    ? await customerService.listAddressesByProfile(profile.id).catch(() => [])
    : [];
  const addresses = addressRows.map((a) => ({
    id: a.id,
    label: a.label,
    fullName: a.full_name,
    line1: a.street_line1,
    line2: a.street_line2,
    city: a.city,
    region: a.region,
    postalCode: a.postal_code,
    phone: a.phone,
    isDefault: a.is_default_shipping,
  }));

  const viewer = user
    ? {
        name:
          [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() ||
          (user.name ?? "").trim() ||
          user.email,
        email: user.email,
        phone: profile?.phone ?? "",
      }
    : null;

  return (
    <CheckoutView
      pickups={pickups}
      viewer={viewer}
      addresses={addresses}
      hasProfile={!!profile}
      payment={payment}
    />
  );
}
