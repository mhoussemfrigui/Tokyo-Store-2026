"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Layers,
  Loader2,
  Lock,
  Package,
} from "lucide-react";

import {
  listDataJobsAction,
  startDataJobAction,
  type DataJobView,
} from "@/lib/actions/data-jobs";
import { AdminCallout } from "@/components/admin/_components/filter-bar";
import { JobCard } from "@/components/admin/data-jobs/data-jobs-panel";
import type { ImportJobView } from "@/lib/actions/import";

import { ImportPanel } from "./import-panel";
import { NavRepairCard } from "./nav-repair-card";
import { PurgeRelaunchCard } from "./purge-relaunch-card";

/**
 * Merged « Import data » tab (`/admin/system/import-data`) — one home for the
 * former « Import catalogue » (file/URL upload) + « Importer la démo » (bundled
 * one-click), with Contenu / Produits sub-tabs and the super-admin purge.
 *
 * Three bundled one-click targets drive the shared data-jobs runner:
 *   • Tout importer  → `all`     — tree + content snapshot + catalog + redirects
 *   • Contenu        → `content` — the CMS content snapshot applied verbatim
 *   • Produits       → `products`— tree + the bundled 447-watch catalog + redirects
 * File/URL uploads use the embedded `ImportPanel` (its own action). ONE activity
 * list (this panel's) covers every import job — the embedded panel hides its own
 * history and pings `refreshJobs` after a launch.
 *
 * Single-flight: while any import job is queued/running every launch button is
 * disabled (the runner enforces it server-side too). `canRunJobs`
 * (system_jobs:manage) gates the bundled buttons; `canImportFile`
 * (system_import:view) gates the upload sub-panel; `canPurge` (RBAC `*`) the
 * danger zone.
 */

const POLL_INTERVAL_MS = 2500;

type Target = "all" | "content" | "products";

export function ImportDataPanel({
  initialDataJobs,
  initialImportJobs,
  canRunJobs,
  canViewJobs,
  canImportFile,
  canRepairNav,
  canPurge,
  productsInDb,
}: {
  initialDataJobs: DataJobView[];
  initialImportJobs: ImportJobView[];
  canRunJobs: boolean;
  canViewJobs: boolean;
  canImportFile: boolean;
  canRepairNav: boolean;
  canPurge: boolean;
  productsInDb: number;
}) {
  const [tab, setTab] = useState<"content" | "products">("content");
  const [jobs, setJobs] = useState<DataJobView[]>(initialDataJobs);
  const [banner, setBanner] = useState<{ type: "ok" | "error"; message: string } | null>(null);
  const [isStarting, startStart] = useTransition();
  const [, startRefresh] = useTransition();

  const refreshJobs = useCallback(() => {
    if (!canViewJobs) return;
    startRefresh(async () => {
      try {
        setJobs(await listDataJobsAction("import"));
      } catch {
        // transient — the next poll retries.
      }
    });
  }, [canViewJobs, startRefresh]);

  const hasActiveJob = jobs.some((j) => j.status === "queued" || j.status === "running");
  const disabled = hasActiveJob || isStarting;

  useEffect(() => {
    if (!hasActiveJob || !canViewJobs) return;
    const interval = setInterval(refreshJobs, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [hasActiveJob, canViewJobs, refreshJobs]);

  const fire = useCallback(
    (target: Target) => {
      if (disabled || !canRunJobs) return;
      startStart(async () => {
        try {
          const res = await startDataJobAction("import", target);
          if (res.ok) {
            setBanner({ type: "ok", message: "Import lancé — il tourne en arrière-plan." });
            refreshJobs();
          } else {
            setBanner({ type: "error", message: res.message });
          }
        } catch {
          setBanner({ type: "error", message: "L'import n'a pas pu être lancé — réessayez." });
        }
      });
    },
    [disabled, canRunJobs, refreshJobs, startStart],
  );

  const orderedJobs = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="max-w-3xl text-[14px] leading-relaxed text-muted-foreground">
            Montez toute la boutique en un clic : le contenu du site (identité,
            page d&apos;accueil, pages, bannières, navigation, FAQ), le catalogue
            high-tech Tokyo Store (images ré-hébergées dans la médiathèque) et les
            redirections depuis les anciennes URL. Chaque opération tourne en
            arrière-plan et est ré-exécutable sans risque (idempotente).
          </p>
        </div>
      </header>

      {banner && (
        <div
          role="status"
          className={`flex items-start gap-3 rounded-[16px] border p-3.5 text-sm ${
            banner.type === "ok"
              ? "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]"
              : "border-[#f6cdd6] bg-[#fdecef] text-[#d40530]"
          }`}
        >
          {banner.type === "ok" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <p className="font-medium">{banner.message}</p>
        </div>
      )}

      {/* One-click bring-up */}
      <div className="rounded-[28px] border border-primary/30 bg-primary/5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
              <Layers className="h-5 w-5 text-primary" aria-hidden />
              Tout importer
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Enchaîne l&apos;arborescence de catégories, le contenu du site, le
              catalogue complet puis les redirections — la boutique est prête d&apos;un
              seul geste. Idéal après une mise en production sur une base vierge.
            </p>
          </div>
          <button
            type="button"
            disabled={disabled || !canRunJobs}
            onClick={() => fire("all")}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-primary px-6 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />}
            Tout importer
          </button>
        </div>
        {!canRunJobs && (
          <AdminCallout tone="warning" icon={Lock} className="mt-3">
            Lecture seule — la permission « Tâches planifiées : gérer » est requise pour lancer un import.
          </AdminCallout>
        )}
      </div>

      {/* Sub-tabs */}
      <div>
        <div className="flex gap-1 rounded-full border border-border bg-[var(--background)] p-1">
          <TabButton active={tab === "content"} onClick={() => setTab("content")} icon={FileText} label="Contenu" />
          <TabButton active={tab === "products"} onClick={() => setTab("products")} icon={Package} label="Produits" />
        </div>

        <div className="mt-4">
          {tab === "content" ? (
            <section className="rounded-[28px] border border-border bg-card p-6">
              <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">Contenu du site</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Applique l&apos;instantané de contenu « tel quel » : réglages (identité,
                contact, réseaux, SEO), blocs de la page d&apos;accueil, pages,
                bannières, menus de navigation, FAQ. Les images référencées sont
                ré-hébergées dans la médiathèque.
                N&apos;importe pas de produits.
              </p>
              <div className="mt-5">
                <button
                  type="button"
                  disabled={disabled || !canRunJobs}
                  onClick={() => fire("content")}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                  Importer le contenu du site
                </button>
              </div>
            </section>
          ) : (
            <div className="space-y-6">
              <section className="rounded-[28px] border border-border bg-card p-6">
                <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">
                  Catalogue Tokyo Store
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Importe le catalogue high-tech complet (iPhones &amp; smartphones, gaming
                  console &amp; PC, audio, objets connectés, accessoires — Apple, Samsung,
                  Xiaomi, Sony, Nintendo, JBL…) classé dans l&apos;arborescence de
                  catégories, ré-héberge les images dans la médiathèque et pose les
                  redirections depuis les anciennes URL. Ré-exécutable sans risque
                  (mise à jour par référence produit).{" "}
                  {productsInDb > 0 ? `${productsInDb} produit(s) en base.` : "Base vide."}
                </p>
                <div className="mt-5">
                  <button
                    type="button"
                    disabled={disabled || !canRunJobs}
                    onClick={() => fire("products")}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Package className="h-4 w-4" />}
                    Importer le catalogue
                  </button>
                </div>
              </section>

              {canImportFile && (
                <div>
                  <div className="mb-3 flex items-center gap-3">
                    <span className="h-px flex-1 bg-border" />
                    <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      ou importer un fichier
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <ImportPanel
                    initialJobs={initialImportJobs}
                    hideHistory
                    onJobStarted={refreshJobs}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Unified activity list */}
      {canViewJobs ? (
        <section>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">Activité récente</h2>
            {hasActiveJob && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Opération en cours…
              </span>
            )}
          </div>
          {orderedJobs.length === 0 ? (
            <div className="mt-4 rounded-[16px] border border-dashed border-border bg-surface/30 p-6 text-center text-sm text-muted-foreground">
              Aucun import pour le moment.
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {orderedJobs.map((job) => (
                <JobCard key={job.id} job={job} operation="import" />
              ))}
            </ul>
          )}
        </section>
      ) : (
        <p className="rounded-[16px] border border-[#f3e3bd] bg-[#fff4e0] px-4 py-3 text-xs font-semibold text-[#b45309]">
          Le suivi des imports nécessite la permission « Tâches planifiées : voir ».
        </p>
      )}

      {/* Maintenance — repair the navigation after an import */}
      {canRepairNav && <NavRepairCard />}

      {/* Super-admin danger zone */}
      {canPurge && <PurgeRelaunchCard />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof FileText;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex flex-1 items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition ${
        active
          ? "bg-card font-extrabold text-primary shadow-[0_2px_8px_rgba(14,18,24,0.08)]"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {label}
    </button>
  );
}
