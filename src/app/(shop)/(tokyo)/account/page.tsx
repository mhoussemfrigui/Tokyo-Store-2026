import type { Metadata } from "next";

import { getCurrentUser } from "@/lib/auth/session";
import { customerUserLink } from "@/associations/customer-user.service";
import { customerService } from "@/modules/customer/service";
import {
  listOrdersForUserOrEmail,
  listItemsForOrders,
} from "@/modules/order/queries";
import type { OrderItemRow, OrderRow } from "@/modules/order/schema";
import {
  isPickupDelivery,
  orderStatusLabelFor,
  paymentMethodLabel,
  type OrderStatus,
} from "@/lib/order/status";
import { isOnlineMethod } from "@/lib/payments/shared";
import { orderTaxIncludedInTotal } from "@/lib/order/order-tax-mode";
import { minorToDinars } from "@/storefront/lib/price";
import {
  AccountView,
  type AccountAddress,
  type AccountOrder,
  type AccountProfile,
  type AccountSession,
} from "@/storefront/components/storefront/account-view";

export const metadata: Metadata = {
  title: "Mon compte",
  description:
    "Gérez vos commandes, favoris, garanties et coordonnées Tokyo Store. Service client et 3 boutiques en Tunisie.",
  robots: { index: false, follow: true },
};

/** Date, Tunisian French: "08 oct. 2026". Formatted on the SERVER so the client
 *  render matches (no hydration mismatch from locale differences). */
const fmtDate = (d: Date) =>
  d.toLocaleDateString("fr-TN", { day: "2-digit", month: "short", year: "numeric" });

/** Member-since month, Tunisian French: "mars 2023" (cosmetic precision). */
const fmtMonth = (d: Date) =>
  d.toLocaleDateString("fr-TN", { month: "long", year: "numeric" });

/** Grouped major-unit amount WITHOUT currency (e.g. 1449000 → "1 449"); the
 *  design renders the « TND » suffix separately. */
const fmtAmount = (cents: number) => minorToDinars(cents).toLocaleString("fr-TN");

/** Which account-history bucket an order falls in (filter pills + « En cours »). */
function bucketFor(status: OrderStatus): AccountOrder["bucket"] {
  if (status === "cancelled" || status === "refunded") return "cancel";
  if (status === "delivered") return "done";
  // pending / paid / preparing / shipped → in progress
  return "active";
}

/**
 * The design's 4-node (home) / 3-node (pickup) tracking rail, derived from the
 * REAL order status — collapsing order-steps' 5/6-step model. No per-step dates
 * (those need listStatusHistory per order; the FRONTIER alone is real).
 */
function trackFor(o: OrderRow): AccountOrder["track"] {
  if (o.status === "cancelled" || o.status === "refunded") {
    return { steps: [], frontier: -1, show: false };
  }
  const pickup = isPickupDelivery(o.delivery_method);
  const steps = pickup
    ? ["Confirmée", "Préparée", "Retirée"]
    : ["Confirmée", "Préparée", "Expédiée", "Livrée"];
  const last = steps.length - 1;
  let frontier: number;
  switch (o.status) {
    case "delivered":
      frontier = last;
      break;
    case "shipped":
      frontier = pickup ? 1 : 2;
      break;
    case "preparing":
      frontier = 1;
      break;
    default:
      // paid / pending → confirmed / received
      frontier = 0;
      break;
  }
  return { steps, frontier, show: true };
}

/** A status-derived headline for the active-order card (orders carry NO delivery
 *  ETA field, so this is derived copy, never fabricated data). */
function headlineFor(o: OrderRow): string {
  const pickup = isPickupDelivery(o.delivery_method);
  switch (o.status) {
    case "shipped":
      return pickup ? "Votre commande est prête" : "Votre commande est en route";
    case "preparing":
      return "Votre commande est en préparation";
    case "delivered":
      return pickup ? "Commande retirée" : "Commande livrée";
    default:
      return "Commande confirmée";
  }
}

export default async function AccountPage() {
  const user = await getCurrentUser();

  if (!user) {
    return <AccountView session={null} profile={null} addresses={[]} orders={[]} />;
  }

  const session: AccountSession = {
    fullName: (user.name ?? "").trim() || user.email,
    email: user.email,
    image: user.image ?? null,
    twoFactorEnabled: Boolean(user.twoFactorEnabled),
    memberSinceLabel: user.createdAt ? fmtMonth(user.createdAt) : null,
    greetingName: "",
    initials: "",
  };

  // Profile read path: user → link → profile (may be null for admin/unlinked).
  const link = await customerUserLink.findByUserId(user.id).catch(() => null);
  const profileRow = link
    ? await customerService.findProfileById(link.customer_profile_id).catch(() => null)
    : null;

  // Derive greeting + initials from the profile first/last, falling back to the
  // auth user's name, then the email local-part.
  const first = (profileRow?.first_name ?? user.name?.trim().split(/\s+/)[0] ?? "").trim();
  const last = (profileRow?.last_name ?? user.name?.trim().split(/\s+/).slice(1).join(" ") ?? "").trim();
  const fullName = [first, last].filter(Boolean).join(" ") || (user.name ?? "").trim() || user.email;
  session.fullName = fullName;
  session.greetingName = first || (user.name ?? "").trim().split(/\s+/)[0] || user.email;
  const initials =
    ((first[0] ?? "") + (last[0] ?? "")).toUpperCase() ||
    (user.email[0] ?? "?").toUpperCase();
  session.initials = initials;

  const profile: AccountProfile | null = profileRow
    ? {
        firstName: profileRow.first_name,
        lastName: profileRow.last_name,
        phone: profileRow.phone ?? "",
        birthday: profileRow.birthday ?? "",
        marketingOptIn: profileRow.marketing_opt_in,
      }
    : null;

  // Addresses (shipping book) — only when the profile is linked.
  const addressRows = profileRow
    ? await customerService.listAddressesByProfile(profileRow.id).catch(() => [])
    : [];
  const addresses: AccountAddress[] = addressRows.map((a) => ({
    id: a.id,
    label: a.label,
    fullName: a.full_name,
    line1: a.street_line1,
    line2: a.street_line2,
    city: a.city,
    region: a.region,
    postalCode: a.postal_code,
    phone: a.phone,
    isDefaultShipping: a.is_default_shipping,
  }));

  // Orders — include pre-signup guest orders placed under this email, matching
  // the customer-360 (listOrdersForUserOrEmail restricts the email arm to guests).
  const orderRows = await listOrdersForUserOrEmail(user.id, user.email, { limit: 50 }).catch(
    () => [] as OrderRow[],
  );
  const itemRows = orderRows.length
    ? await listItemsForOrders(orderRows.map((o) => o.id)).catch(() => [] as OrderItemRow[])
    : [];
  const itemsByOrder = new Map<string, OrderItemRow[]>();
  for (const it of itemRows) {
    const arr = itemsByOrder.get(it.order_id);
    if (arr) arr.push(it);
    else itemsByOrder.set(it.order_id, [it]);
  }

  const orders: AccountOrder[] = orderRows.map((o) => {
    const its = itemsByOrder.get(o.id) ?? [];
    const itemCount = its.reduce((s, it) => s + it.quantity, 0);
    const isHome = o.delivery_method === "home_delivery";
    const effectiveTax = o.tax_manual_cents ?? o.tax_cents;
    const taxIncluded = orderTaxIncludedInTotal(o);
    const pendingOnline = o.status === "pending" && isOnlineMethod(o.payment_method);

    // Shipping line — mirror the (shell) order-detail rules.
    let shippingLabel: string;
    if (isHome) shippingLabel = o.shipping_cents > 0 ? `${fmtAmount(o.shipping_cents)} TND` : "Offerte";
    else shippingLabel = o.shipping_cents > 0 ? `${fmtAmount(o.shipping_cents)} TND` : "Incluse";

    const addressLabel = isHome
      ? [o.ship_street_line1, o.ship_city].filter(Boolean).join(", ")
      : [o.pickup_location_name, o.pickup_location_address].filter(Boolean).join(" — ") ||
        o.ship_city;

    return {
      id: o.id,
      number: o.order_number,
      status: o.status,
      statusLabel: orderStatusLabelFor(o.status, o.delivery_method),
      bucket: bucketFor(o.status),
      placedAtLabel: fmtDate(o.created_at),
      itemCount,
      itemCountLabel: `${itemCount} article${itemCount > 1 ? "s" : ""}`,
      totalLabel: fmtAmount(o.total_cents),
      subtotalLabel: fmtAmount(o.subtotal_cents),
      discountLabel: o.discount_cents > 0 ? `− ${fmtAmount(o.discount_cents)} TND` : null,
      shippingLabel,
      careLabel: o.care_cents > 0 ? `${fmtAmount(o.care_cents)} TND` : null,
      taxLabel: effectiveTax > 0 && !taxIncluded ? `${fmtAmount(effectiveTax)} TND` : null,
      taxIncludedNote:
        effectiveTax > 0 && taxIncluded ? `dont TVA ${fmtAmount(effectiveTax)} TND` : null,
      paymentLabel: paymentMethodLabel(o.payment_method),
      deliveryModeLabel: isHome ? "Livraison à" : "Retrait à",
      addressLabel,
      headline: headlineFor(o),
      invoiceHref: pendingOnline ? null : `/facture/${o.id}?autoprint=1`,
      callable: bucketFor(o.status) === "active",
      track: trackFor(o),
      thumbs: its.slice(0, 3).map((it) => it.variant_image_url ?? it.product_image_url ?? null),
      moreCount: Math.max(0, its.length - 3),
      items: its.map((it) => ({
        id: it.id,
        name: it.product_name,
        slug: it.product_slug,
        qty: it.quantity,
        image: it.variant_image_url ?? it.product_image_url ?? null,
        variantLabel: it.variant_label,
        lineTotalLabel: fmtAmount(it.subtotal_cents),
      })),
    };
  });

  return (
    <AccountView session={session} profile={profile} addresses={addresses} orders={orders} />
  );
}
