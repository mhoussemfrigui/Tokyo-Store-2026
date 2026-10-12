"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Undo2, PackageX } from "lucide-react";

/**
 * The Retours section tab bar — two flows side by side:
 *   - « Retour après vente » (/admin/orders/returns) : classic SAV/RMA, the goods
 *     reached the customer and come back.
 *   - « Retour d'expédition » (/admin/orders/returns/expedition) : a shipped parcel
 *     that never reached the customer (unreachable / refused) and bounces back (RTO).
 *
 * Rendered atop both pages so they read as one section. Icons are owned here (a
 * client component) — passing a lucide component across the RSC boundary crashes.
 */
type TabKey = "apres_vente" | "expedition";

const TABS: Record<TabKey, { label: string; href: string; match: (p: string) => boolean }> = {
  apres_vente: {
    label: "Retour après vente",
    href: "/admin/orders/returns",
    // Active for the SAV hub but NOT the /expedition sibling.
    match: (p) => p === "/admin/orders/returns" || p === "/admin/orders/returns/",
  },
  expedition: {
    label: "Retour d'expédition",
    href: "/admin/orders/returns/expedition",
    match: (p) => p.startsWith("/admin/orders/returns/expedition"),
  },
};

const ICON: Record<TabKey, typeof Undo2> = {
  apres_vente: Undo2,
  expedition: PackageX,
};

export function ReturnsSubnav() {
  const pathname = usePathname() ?? "";
  return (
    <div className="rounded-[20px] border border-border bg-card p-2">
      <nav
        aria-label="Sections Retours"
        className="inline-flex w-full items-center gap-1 overflow-x-auto rounded-[14px] bg-[var(--background)] p-1 [scrollbar-width:none]"
      >
        {(Object.keys(TABS) as TabKey[]).map((key) => {
          const tab = TABS[key];
          const Icon = ICON[key];
          const active = tab.match(pathname);
          return (
            <Link
              key={key}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] px-[14px] py-[8px] text-[13px] transition ${
                active
                  ? "bg-card font-extrabold text-primary shadow-[0_2px_8px_rgba(14,18,24,0.08)]"
                  : "font-semibold text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" /> {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
