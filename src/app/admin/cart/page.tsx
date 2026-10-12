import type { Metadata } from "next";
import Link from "next/link";

import { cartService } from "@/modules/cart/service";
import { authService } from "@/modules/auth/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { requirePermission } from "@/lib/auth/session";
import { AdminPageHeader } from "@/components/admin/page-header";
import { formatCents } from "@/lib/price";

export const metadata: Metadata = { title: "Paniers" };

const formatTnd = formatCents;

const PAGE_SIZE = 50;

export default async function AdminCartPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const sp = await searchParams;
  await requirePermission("cart", "view");
  // Keyset page (newest activity first); empty + quick-buy carts are filtered in
  // SQL before the LIMIT, so every page is full of real carts.
  const cursor = typeof sp.cursor === "string" ? sp.cursor : null;
  const { items: carts, nextCursor } = await cartService.listCartsWithSummary({
    cursor,
    limit: PAGE_SIZE,
  });

  // Resolve user emails for non-anonymous carts.
  const userIds = Array.from(
    new Set(carts.map((c) => c.userId).filter((id): id is string => Boolean(id))),
  );
  const userById = await authService.findUsersByIds(userIds);
  // Map each cart's user to its customer 360 (profile id) so the operator can pivot
  // cart → client. Guests (no account) have no profile and stay plain text.
  const profileByUser = await customerUserLink.profileIdsByUserIds(userIds);

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Paniers"
        description="Paniers actifs et abandonnés — utiles pour identifier des opportunités de relance."
      />

      {carts.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
          {cursor ? "Aucun autre panier." : "Aucun panier actif."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[22px] border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
              <tr>
                <th className="px-5 py-3">Client</th>
                <th className="px-5 py-3">Articles</th>
                <th className="px-5 py-3" title="Somme des prix enregistrés à l'ajout au panier — le prix facturé est recalculé au paiement.">
                  Sous-total (prix à l&apos;ajout)
                </th>
                <th className="px-5 py-3">Dernière activité</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {carts.map((c) => {
                const user = c.userId ? userById.get(c.userId) : null;
                const profileId = c.userId ? profileByUser.get(c.userId) : null;
                return (
                  <tr key={c.id} className="transition hover:bg-[#fffbfb]">
                    <td className="px-5 py-3 align-middle">
                      {user ? (
                        profileId ? (
                          <Link
                            href={`/admin/customers/${profileId}`}
                            className="block transition-colors hover:text-primary"
                          >
                            <p className="font-medium text-foreground">{user.name}</p>
                            <p className="text-[11px] text-muted-foreground">{user.email}</p>
                          </Link>
                        ) : (
                          <div>
                            <p className="font-medium text-foreground">{user.name}</p>
                            <p className="text-[11px] text-muted-foreground">{user.email}</p>
                          </div>
                        )
                      ) : (
                        <span className="rounded-full bg-surface px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                          Anonyme
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 align-middle text-[12px]">{c.itemCount}</td>
                    <td className="px-5 py-3 align-middle text-[12px] font-semibold">
                      {formatTnd(c.subtotalCents)}
                    </td>
                    <td className="px-5 py-3 align-middle text-[12px] text-muted-foreground">
                      {new Date(c.lastActivityAt).toLocaleString("fr-FR", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="px-5 py-3 align-middle text-right">
                      <Link
                        href={`/admin/cart/${c.id}`}
                        className="inline-flex h-8 items-center rounded-full border-[1.5px] border-input bg-card px-3 text-[11px] font-bold text-foreground transition hover:bg-surface"
                      >
                        Voir
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(cursor || nextCursor) && (
        <nav className="flex items-center justify-between gap-3" aria-label="Pagination des paniers">
          {cursor ? (
            <Link
              href="/admin/cart"
              className="inline-flex h-9 items-center rounded-full border border-border bg-card px-4 text-[12px] font-semibold text-foreground hover:bg-surface"
            >
              ← Paniers les plus récents
            </Link>
          ) : (
            <span />
          )}
          {nextCursor && (
            <Link
              href={`/admin/cart?cursor=${encodeURIComponent(nextCursor)}`}
              className="inline-flex h-9 items-center rounded-full bg-foreground px-4 text-[12px] font-semibold text-background"
            >
              Page suivante →
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
