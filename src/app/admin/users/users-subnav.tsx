"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck, SlidersHorizontal, Users } from "lucide-react";

/**
 * The Utilisateurs section tab bar — makes « Rôles & permissions » and « Réglages »
 * first-class surfaces instead of links buried on a page header. Rendered at the top
 * of /admin/users, /admin/users/[id], /admin/users/roles and /admin/users/settings so
 * the sibling pages read as one section (the single source of truth for who can do
 * what).
 *
 * The icon set is owned here (a client component) rather than passed from the server
 * page — passing a lucide COMPONENT across the RSC boundary crashes the render. The
 * server only passes which tab KEYS to show (a system_auth-only manager reaches
 * Réglages but not Comptes/Rôles).
 */
type TabKey = "comptes" | "roles" | "reglages";

const TABS: Record<TabKey, { label: string; href: string; match: (p: string) => boolean }> = {
  comptes: {
    label: "Comptes",
    href: "/admin/users",
    // Active for the list AND a user detail (/admin/users/<id>), but NOT for the
    // /roles or /settings siblings.
    match: (p) =>
      p === "/admin/users" ||
      (p.startsWith("/admin/users/") &&
        !p.startsWith("/admin/users/roles") &&
        !p.startsWith("/admin/users/settings")),
  },
  roles: {
    label: "Rôles & permissions",
    href: "/admin/users/roles",
    match: (p) => p.startsWith("/admin/users/roles"),
  },
  reglages: {
    label: "Réglages",
    href: "/admin/users/settings",
    match: (p) => p.startsWith("/admin/users/settings"),
  },
};

const ICON: Record<TabKey, typeof Users> = {
  comptes: Users,
  roles: ShieldCheck,
  reglages: SlidersHorizontal,
};

export function UsersSubnav({ show = ["comptes", "roles", "reglages"] }: { show?: TabKey[] }) {
  const pathname = usePathname() ?? "";
  return (
    <div className="rounded-[20px] border border-border bg-card p-2">
      <nav
        aria-label="Sections Utilisateurs"
        className="inline-flex w-full items-center gap-1 overflow-x-auto rounded-[14px] bg-[var(--background)] p-1 [scrollbar-width:none]"
      >
        {show.map((key) => {
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
