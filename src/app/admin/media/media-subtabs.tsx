import Link from "next/link";

/**
 * Sub-tab bar for the merged Médiathèque section (one Catalogue nav entry, two
 * sub-tabs: the library + its réglages). Plain links to the two routes so each
 * keeps its own RBAC gate; the Réglages tab only shows when the user can view
 * the media settings (`system_media`).
 */
export function MediaSubtabs({
  active,
  canSettings,
}: {
  active: "library" | "settings";
  canSettings: boolean;
}) {
  const tabs: { id: "library" | "settings"; label: string; href: string }[] = [
    { id: "library", label: "Médiathèque", href: "/admin/media" },
    ...(canSettings
      ? [{ id: "settings" as const, label: "Réglages", href: "/admin/media/settings" }]
      : []),
  ];
  return (
    // Route-based (per-route RBAC), so Links — hosted in the shared white nav
    // card + segmented track (matches SubTabBar) so the strip isn't lost on the
    // same-colour page canvas.
    <div className="rounded-[20px] border border-border bg-card p-2">
      <nav className="inline-flex w-full items-center gap-1 overflow-x-auto rounded-[14px] bg-[var(--background)] p-1 [scrollbar-width:none]">
        {tabs.map((t) => (
          <Link
            key={t.id}
            href={t.href}
            className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] px-[14px] py-[8px] text-[13px] transition ${
              active === t.id
                ? "bg-card font-extrabold text-primary shadow-[0_2px_8px_rgba(14,18,24,0.08)]"
                : "font-semibold text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
