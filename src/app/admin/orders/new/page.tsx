import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { requirePermissionAny } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { ORDER_NEW_VIEW_GRANTS } from "@/lib/rbac/nav-access";
import { deliveryService } from "@/modules/delivery";
import { promotionService } from "@/modules/promotion";
import { minorToDinars } from "@/lib/price";
import { ManualOrderForm } from "./manual-order-form";

export const metadata: Metadata = { title: "Nouvelle commande" };

/**
 * Operator-created order. The form reuses placeOrderWorkflow (stock, coins,
 * snapshots, promo) and records an OFFLINE settlement (cash / wire / COD).
 * Gated by its OWN grant `orders_new:view` (the tab) OR the broader
 * `orders:manage` (ORDER_NEW_VIEW_GRANTS — the SAME list drives the sidebar item
 * and the Commandes-list button) — mirrors the create action (orders_new:create
 * OR orders:manage). Without the OR, a NEW role granted orders:manage AFTER
 * migration 0109 (which back-filled orders_new only to EXISTING orders:manage
 * roles) could create manual orders via caisse but not open this page.
 *
 * A delegated « Nouvelle commande » operator may hold NO `orders:view`: the
 * order detail + the Commandes list both 404 for them, so the back link is
 * hidden and the form confirms in place instead of redirecting to the order.
 */
export default async function NewOrderPage() {
  const session = await requirePermissionAny(ORDER_NEW_VIEW_GRANTS);
  const perms = await resolveUserPermissions(session.user.id);
  const canViewOrders = permissionSetAllows(perms, "orders", "view");
  const [agents, pickups, coupons] = await Promise.all([
    deliveryService.listEnabledAgents().catch(() => []),
    deliveryService.listEnabledPickups().catch(() => []),
    // Live COUPON promos for the « Code promo » picker (degrade to none on error —
    // never block order creation). placeOrderWorkflow re-validates eligibility.
    promotionService.listLiveCoupons().catch(() => []),
  ]);
  // Light DTO for the picker: the code + an informative label (discount + min-cart).
  const couponOptions = coupons
    .filter((c) => c.code)
    .map((c) => {
      const discount =
        c.discount_type === "percent"
          ? `−${c.discount_value}%`
          : `−${minorToDinars(c.discount_value)} TND`;
      const minCart = c.min_cart_cents > 0 ? `, min ${minorToDinars(c.min_cart_cents)} TND` : "";
      return { code: c.code!, label: `${c.code} — ${c.name} (${discount}${minCart})` };
    });

  return (
    <div className="space-y-6">
      <div>
        {canViewOrders && (
          <Link
            href="/admin/orders"
            className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Retour aux commandes
          </Link>
        )}
        <p className="mt-3 max-w-3xl text-[14px] leading-relaxed text-muted-foreground">
          Créez une commande pour un client et enregistrez le paiement hors-ligne (espèces, virement
          ou à la livraison). Le stock, la TVA, les promotions et les points s&apos;appliquent comme
          pour une commande web.
        </p>
      </div>

      <ManualOrderForm
        agents={agents.map((a) => ({ id: a.id, name: a.name }))}
        pickups={pickups.map((p) => ({ id: p.id, name: p.name, kind: p.kind }))}
        coupons={couponOptions}
        canViewOrders={canViewOrders}
      />
    </div>
  );
}
