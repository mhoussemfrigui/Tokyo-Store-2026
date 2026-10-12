import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightLeft, FileWarning, SlidersHorizontal, Wrench } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { redirectQueries } from "@/modules/redirects";
import { AdminPageHeader } from "@/components/admin/page-header";
import { RedirectsManager } from "./redirects-manager";
import {
  RedirectEngineSettingsForm,
  NotFoundSettingsForm,
  MaintenanceSettingsForm,
} from "./settings-forms";
import { parseSiteMode } from "@/lib/site-mode/parse";

export const metadata: Metadata = { title: "Redirections & 404" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

// House panel chrome (same as the AI / SEO / Currency settings cards): a raised
// card so each settings tab reads as its own surface instead of blending into the
// page background, and spans the full admin column instead of capping left. The
// « Redirections » list tab brings its own cards, so it stays uncarded here.
const SETTINGS_CARD = "rounded-2xl border border-border bg-card p-5 sm:p-6";

const TABS = [
  { id: "list", label: "Redirections", icon: ArrowRightLeft },
  { id: "settings", label: "Réglages", icon: SlidersHorizontal },
  { id: "notfound", label: "Page 404", icon: FileWarning },
  { id: "maintenance", label: "Maintenance", icon: Wrench },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default async function AdminRedirectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission("system_redirects", "view");
  // Every write here (redirect CRUD / toggle / CSV import, engine + 404 settings,
  // site mode) is system_redirects:manage — gate the controls for UI honesty
  // (like the Search / AI pages) so a view-only role gets read-only forms instead
  // of a click that 404s the page. The actions re-check server-side.
  const canManage = permissionSetAllows(
    await resolveUserPermissions(session.user.id),
    "system_redirects",
    "manage",
  );
  const sp = await searchParams;
  const pick = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const tab = (TABS.some((t) => t.id === pick("tab")) ? pick("tab") : "list") as TabId;
  const q = pick("q");
  const page = Math.max(1, parseInt(pick("page") || "1", 10) || 1);

  const [settings, counts] = await Promise.all([
    // No `.catch`: the engine / 404 / maintenance forms are pre-filled from this.
    // A swallowed read shows `site.mode` as « live », so a normal save on the
    // Maintenance tab would LIFT maintenance mid-migration. A failure reaches
    // the admin error boundary (retry) instead.
    getSettingsMap(),
    redirectQueries.counts().catch(() => ({ total: 0, active: 0 })),
  ]);

  const list =
    tab === "list"
      ? await redirectQueries
          .listPage({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, search: q })
          .catch(() => ({ rows: [], total: 0 }))
      : { rows: [], total: 0 };

  const bool = (k: string, fb: boolean) => {
    const x = (settings[k] ?? "").trim().toLowerCase();
    if (["true", "1", "on", "yes"].includes(x)) return true;
    if (["false", "0", "off", "no"].includes(x)) return false;
    return fb;
  };

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Redirections & 404"
        description="Créez des redirections 301/302 pour les anciennes URL (migration, pages retirées), importez-les en masse par CSV, personnalisez la page 404, et gérez la disponibilité du site (maintenance / bientôt disponible)."
      />

      {/* KPI strip — two full-width cards (split the row 50/50). */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-border bg-card px-5 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Redirections</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{counts.total}</p>
        </div>
        <div className="rounded-2xl border border-border bg-card px-5 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Actives</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-[#15803d]">{counts.active}</p>
        </div>
      </div>

      {/* Tab strip — the house segmented pill look (matches SubTabBar) in its own
          white nav card, as server-driven links so pagination/search stay shareable.
          Full-width + horizontally scrollable so the strip never floats on the bare
          canvas. */}
      <div className="rounded-[20px] border border-border bg-card p-2">
        <nav className="inline-flex w-full items-center gap-1 overflow-x-auto rounded-[14px] bg-[var(--background)] p-1 [scrollbar-width:none]">
          {TABS.map((t) => {
            const active = t.id === tab;
            const Icon = t.icon;
            return (
              <Link
                key={t.id}
                href={`/admin/system/redirects?tab=${t.id}`}
                aria-current={active ? "page" : undefined}
                className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] px-[14px] py-[8px] text-[13px] transition ${
                  active
                    ? "bg-card font-extrabold text-primary shadow-[0_2px_8px_rgba(14,18,24,0.08)]"
                    : "font-semibold text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {tab === "list" && (
        <RedirectsManager
          rows={list.rows.map((r) => ({
            id: r.id,
            source: r.source_path,
            destination: r.destination,
            status: r.status_code,
            active: r.is_active,
            hits: r.hits,
            notes: r.notes ?? "",
          }))}
          total={list.total}
          page={page}
          pageSize={PAGE_SIZE}
          q={q}
          canManage={canManage}
        />
      )}

      {tab === "settings" && (
        <div className={SETTINGS_CARD}>
          <RedirectEngineSettingsForm
            enabled={bool("redirects.enabled", true)}
            canManage={canManage}
          />
        </div>
      )}

      {tab === "notfound" && (
        <div className={SETTINGS_CARD}>
          <NotFoundSettingsForm
            canManage={canManage}
            title={settings["notfound.title"] ?? ""}
            message={settings["notfound.message"] ?? ""}
            showSearch={bool("notfound.show_search", true)}
            showSuggestions={bool("notfound.show_suggestions", true)}
          />
        </div>
      )}

      {tab === "maintenance" && (
        <div className={SETTINGS_CARD}>
          <MaintenanceSettingsForm
            canManage={canManage}
            mode={parseSiteMode(settings["site.mode"])}
            title={settings["site.maintenance_title"] ?? ""}
            message={settings["site.maintenance_message"] ?? ""}
            // Raw datetime-local string as stored (the input round-trips it verbatim).
            launchAt={settings["site.launch_at"] ?? ""}
            showCountdown={bool("site.show_countdown", true)}
          />
        </div>
      )}
    </div>
  );
}
