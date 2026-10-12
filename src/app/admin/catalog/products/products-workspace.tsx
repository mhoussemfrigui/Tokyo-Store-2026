"use client";

import Link from "next/link";
import { Plus } from "lucide-react";

import { AdminNote } from "@/components/admin/_components/filter-bar";

/**
 * Products page shell. The « Génération IA » (bulk AI content) and « Réglages
 * catalogue » (product scannable-code) sub-tabs were removed — the page is now
 * just the products list, preceded by the statistics panel. Kept as a thin shell
 * (header + « Nouveau produit ») so the server page stays a pure data loader.
 */
export function ProductsWorkspace({
  list,
  stats,
  canCreate = true,
}: {
  list: React.ReactNode;
  /** The statistics panel (pill + expandable breakdown), rendered above the list. */
  stats?: React.ReactNode;
  /** products:create grant — hides « Nouveau produit » for a view-only operator,
   *  whose click would 404 on the gated creation page. */
  canCreate?: boolean;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <div>
          <AdminNote className="max-w-3xl">
            Brouillons et publiés affichés ici — seuls les publiés apparaissent sur la boutique.
          </AdminNote>
        </div>
        {canCreate && (
          <Link
            href="/admin/catalog/products/new"
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
          >
            <Plus className="h-4 w-4" /> Nouveau produit
          </Link>
        )}
      </div>

      {stats}
      {list}
    </div>
  );
}
