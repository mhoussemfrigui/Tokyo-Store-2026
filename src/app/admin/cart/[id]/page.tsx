import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { cartService } from "@/modules/cart/service";
import { authService } from "@/modules/auth/service";
import { listProductsByIds } from "@/modules/catalog/product/queries";
import { isUuid } from "@/lib/utils/uuid";
import { requirePermission } from "@/lib/auth/session";
import { AdminCallout } from "@/components/admin/_components/filter-bar";
import { formatCents } from "@/lib/price";

export const metadata: Metadata = { title: "Détail panier" };

const formatTnd = formatCents;

export default async function AdminCartDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requirePermission("cart", "view");
  // Reject malformed UUIDs before the DB driver throws on the cast — keeps
  // bad probes (e.g. ../traversal, "new", literal injection attempts) at the
  // 404 floor instead of bubbling a 500.
  if (!isUuid(id)) notFound();
  const cart = await cartService.findById(id);
  if (!cart) notFound();

  const items = await cartService.listItems(cart.id);
  const productIds = items.map((it) => it.product_id);
  const products = await listProductsByIds(productIds);
  const productMap = new Map(products.map((p) => [p.id, p]));
  const user = cart.user_id ? await authService.findById(cart.user_id) : null;

  // Add-time prices (the storefront reprices live at checkout) — labelled so.
  const subtotalCents = items.reduce(
    (acc, it) => acc + it.unit_price_cents * it.quantity,
    0,
  );
  // Last activity = the latest of the cart row and its lines (the same rule as
  // the list): carts written before `updated_at` was bumped on line writes still
  // show their real last change.
  const lastActivityMs = Math.max(
    new Date(cart.updated_at).getTime(),
    ...items.map((it) => new Date(it.updated_at).getTime()),
  );

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/cart"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux paniers
        </Link>
        <h1 className="mt-2 text-2xl font-black tracking-[-0.02em] text-foreground sm:text-3xl">
          Panier{" "}
          <code className="rounded bg-surface px-1.5 py-0.5 text-base">
            {cart.id.slice(0, 8)}
          </code>
        </h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">
          {user ? `${user.name} · ${user.email}` : "Visiteur anonyme"}
          {" · "}
          dernière activité{" "}
          {new Date(lastActivityMs).toLocaleString("fr-FR", {
            dateStyle: "long",
            timeStyle: "short",
          })}
        </p>
      </div>

      {cart.merged_from_cart_id && cart.merged_at && (
        <AdminCallout tone="info" title="Historique de fusion">
          <p className="mt-1 text-[12px]">
            Fusionné depuis panier invité{" "}
            <code className="rounded bg-surface px-1.5 py-0.5">
              #{cart.merged_from_cart_id.slice(0, 8)}
            </code>{" "}
            le{" "}
            {new Date(cart.merged_at).toLocaleString("fr-FR", {
              dateStyle: "long",
              timeStyle: "short",
            })}
            .
          </p>
        </AdminCallout>
      )}

      <section className="rounded-[28px] border border-border bg-card">
        <header className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">
            Articles ({items.length})
          </h2>
          <span className="text-right">
            <span className="block text-sm font-semibold">{formatTnd(subtotalCents)}</span>
            <span className="block text-[11px] text-muted-foreground">
              prix à l&apos;ajout — recalculé au paiement
            </span>
          </span>
        </header>
        {items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Aucun article dans le panier.</p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((it) => {
              const product = productMap.get(it.product_id);
              return (
                <li key={it.id} className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {product?.name ?? it.product_id}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {product?.slug ?? "produit supprimé"}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold">
                      {it.quantity} × {formatTnd(it.unit_price_cents)}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      = {formatTnd(it.unit_price_cents * it.quantity)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
