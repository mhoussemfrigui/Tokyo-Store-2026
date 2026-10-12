import type { Metadata } from "next";

import { CheckoutView } from "@/storefront/components/storefront/checkout-view";
import { deliveryQueries } from "@/modules/delivery/queries";
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
  const [pickupRows, user] = await Promise.all([
    deliveryQueries.listEnabledPickups("in_store").catch(() => []),
    getCurrentUser().catch(() => null),
  ]);
  const pickups = pickupRows.map((p) => ({
    id: p.id,
    name: p.name,
    address: [p.address_line, p.city].filter(Boolean).join(", ") || null,
    city: p.city,
    phone: p.phone,
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
    />
  );
}
