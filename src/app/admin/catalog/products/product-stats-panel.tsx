"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronDown,
  FileText,
  Image as ImageIcon,
  Layers,
  Package,
  PencilLine,
  Search,
  Tag,
  Tags,
  XCircle,
} from "lucide-react";

// Single source of truth for the stat shape — `getProductStats`'s return type.
// Type-only import, so the service's `server-only` guard is never bundled into
// this client component (the two 14-field copies used to be hand-synced).
import type { ProductStats } from "@/modules/catalog/product/service";

export type { ProductStats };

const fmt = (n: number) => n.toLocaleString("fr-FR");

/**
 * Produits statistics — a top summary pill (total / stock / publication) plus an
 * expandable catalogue-health breakdown (how many products are missing a category,
 * brand, description, SEO meta, characteristics, image…, and how many carry
 * variants or a sale price). Read-only overview; counts come from
 * `productService.getProductStats()`.
 */
export function ProductStatsPanel({ stats }: { stats: ProductStats }) {
  const [open, setOpen] = useState(false);

  const pills: { label: string; value: number; icon: React.ElementType; tone: string }[] = [
    { label: "Produits", value: stats.total, icon: Package, tone: "text-foreground" },
    { label: "En stock", value: stats.inStock, icon: CheckCircle2, tone: "text-[#15803d]" },
    { label: "En rupture", value: stats.outOfStock, icon: XCircle, tone: "text-[#b45309]" },
    { label: "Publiés", value: stats.published, icon: CheckCircle2, tone: "text-primary" },
    { label: "Brouillons", value: stats.draft, icon: PencilLine, tone: "text-muted-foreground" },
  ];

  const details: { label: string; value: number; icon: React.ElementType }[] = [
    { label: "Sans catégorie", value: stats.withoutCategory, icon: Tag },
    { label: "Sans marque", value: stats.withoutBrand, icon: Tags },
    { label: "Sans description", value: stats.withoutDescription, icon: FileText },
    { label: "Sans description courte", value: stats.withoutShort, icon: FileText },
    { label: "Sans méta SEO", value: stats.withoutMeta, icon: Search },
    { label: "Sans caractéristiques", value: stats.withoutSpecs, icon: Layers },
    { label: "Sans image", value: stats.withoutImage, icon: ImageIcon },
    { label: "Avec variantes", value: stats.withVariants, icon: Boxes },
    { label: "En promotion", value: stats.onSale, icon: Tag },
  ];

  return (
    <section className="rounded-[22px] border border-border bg-card">
      {/* Summary pill row */}
      <div className="flex flex-wrap items-stretch gap-2 p-3 sm:gap-3 sm:p-4">
        {pills.map((p) => (
          <div
            key={p.label}
            className="flex min-w-[9rem] flex-1 items-center gap-3 rounded-[14px] border border-border bg-[#fbf9f8] px-4 py-3"
          >
            <p.icon className={`h-5 w-5 shrink-0 ${p.tone}`} aria-hidden />
            <div className="min-w-0">
              <div className="text-xl font-black tabular-nums text-foreground">{fmt(p.value)}</div>
              <div className="truncate text-xs text-muted-foreground">{p.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Expandable detail */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-sm font-bold text-foreground transition-colors hover:bg-surface"
      >
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-[#b45309]" aria-hidden />
          Statistiques détaillées — complétude du catalogue
        </span>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-2 border-t border-border p-3 sm:grid-cols-3 sm:gap-3 sm:p-4 lg:grid-cols-5">
          {details.map((d) => (
            <div
              key={d.label}
              className="flex items-center gap-2.5 rounded-[14px] border border-border bg-[#fbf9f8] px-3 py-2.5"
            >
              <d.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <div
                  className={`text-lg font-black tabular-nums ${d.value > 0 ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {fmt(d.value)}
                </div>
                <div className="truncate text-[11px] leading-tight text-muted-foreground">{d.label}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
