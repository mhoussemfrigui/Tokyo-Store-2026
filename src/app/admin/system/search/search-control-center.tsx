"use client";

import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, Database, ExternalLink, Lock } from "lucide-react";

import { FormTabs, FormTab } from "@/components/admin/_components/form-tabs";
import { AdminCallout } from "@/components/admin/_components/filter-bar";
import { type SearchConfig } from "@/modules/search/parse-config";
import type { SearchAliasRow } from "@/modules/search";
import { SearchSettingsForm } from "./search-settings-form";
import { SemanticSettingsForm } from "./semantic-settings-form";
import { SemanticBackfillPanel } from "./semantic-backfill-panel";
import { SearchAliasesPanel } from "./search-aliases-panel";
import { PurgeSearchLogButton } from "./purge-log-button";

type TabId = "stats" | "settings" | "aliases" | "semantic" | "purge";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "stats", label: "Statistiques" },
  { id: "settings", label: "Réglages" },
  { id: "aliases", label: "Alias" },
  { id: "semantic", label: "Sémantique" },
  { id: "purge", label: "Purge" },
];

export type PurgeState = {
  purgeMonths: number;
  /** retention_purge kill-switch (Tâches planifiées). */
  jobEnabled: boolean;
  /** Pre-formatted (fr-FR) timestamp of the last retention run, or null. */
  lastRunLabel: string | null;
  lastRunStatus: string | null;
  lastRunSummary: string | null;
};

/**
 * Recherche control center — one tabbed card hosting the analytics
 * (Statistiques), the engine tuning (Réglages) and the retention/purge
 * controls (Purge). `stats` is server-rendered JSX passed down from the RSC
 * page; the Réglages tab owns its own settings `<form>`, so the whole center is
 * NOT wrapped in a form.
 */
export function SearchControlCenter({
  stats,
  settings,
  purge,
  canManage,
  aliases,
  aliasCounts,
  aliasPrefillTerm = "",
}: {
  stats: React.ReactNode;
  settings: SearchConfig;
  purge: PurgeState;
  /** Whether the viewer holds system_search:manage (gates Réglages + Purge + Alias). */
  canManage: boolean;
  aliases: SearchAliasRow[];
  aliasCounts: { total: number; defaults: number };
  /** When set (from a zero-result « Créer alias » link), opens the Alias tab pre-filled. */
  aliasPrefillTerm?: string;
}) {
  return (
    <FormTabs<TabId> tabs={TABS} defaultTab={aliasPrefillTerm ? "aliases" : "stats"}>
      {(active) => (
        <>
          <FormTab id="stats" active={active}>
            {stats}
          </FormTab>
          <FormTab id="settings" active={active}>
            <SearchSettingsForm values={settings} canManage={canManage} />
          </FormTab>
          <FormTab id="aliases" active={active}>
            {canManage ? (
              <SearchAliasesPanel
                aliases={aliases}
                counts={aliasCounts}
                prefillTerm={aliasPrefillTerm}
              />
            ) : (
              <AdminCallout tone="warning" icon={Lock}>
                Lecture seule — la permission «&nbsp;gérer&nbsp;» est requise pour modifier les alias.
              </AdminCallout>
            )}
          </FormTab>
          <FormTab id="semantic" active={active}>
            <div className="space-y-6">
              <SemanticSettingsForm values={settings} canManage={canManage} />
              <SemanticBackfillPanel canManage={canManage} />
            </div>
          </FormTab>
          <FormTab id="purge" active={active}>
            <PurgePanel {...purge} canManage={canManage} />
          </FormTab>
        </>
      )}
    </FormTabs>
  );
}

function PurgePanel({
  purgeMonths,
  jobEnabled,
  lastRunLabel,
  lastRunStatus,
  lastRunSummary,
  canManage,
}: PurgeState & { canManage: boolean }) {
  const windowDays = purgeMonths * 30;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">
          Conservation &amp; purge du journal de recherche
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Chaque recherche sur la boutique ajoute une ligne au journal qui
          alimente les statistiques. Pour éviter une croissance illimitée, une
          purge automatique quotidienne supprime les lignes plus anciennes que
          la fenêtre configurée.
        </p>
      </div>

      {/* Configured window (read-only echo — edited in Réglages). */}
      <div className="flex flex-wrap items-center gap-3 rounded-[16px] border border-border bg-card px-4 py-3.5">
        <Database className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={2} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            Fenêtre de conservation : {purgeMonths} mois
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            ≈ {windowDays} jours. Modifiable dans l&apos;onglet{" "}
            <span className="font-medium text-foreground">Réglages</span>.
          </p>
        </div>
      </div>

      {/* Auto-purge kill-switch status (toggle lives in Tâches planifiées). */}
      <div
        className={`flex flex-wrap items-start gap-3 rounded-2xl border px-4 py-3.5 ${
          jobEnabled
            ? "border-[#cdebd6] bg-[#eaf7ee]"
            : "border-[#f3e3bd] bg-[#fff4e0]"
        }`}
      >
        {jobEnabled ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#15803d]" strokeWidth={2} />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#b45309]" strokeWidth={2} />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            {jobEnabled
              ? "Purge automatique active"
              : "Purge automatique en pause"}
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {jobEnabled
              ? "La tâche planifiée « retention_purge » s'exécute quotidiennement."
              : "La tâche planifiée « retention_purge » est désactivée : le journal n'est plus purgé automatiquement."}{" "}
            <Link
              href="/admin/system/jobs"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              Gérer dans Tâches planifiées
              <ExternalLink className="h-3 w-3" strokeWidth={2} />
            </Link>
          </p>
          {lastRunLabel && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Clock className="h-3 w-3" strokeWidth={2} />
              Dernière exécution : {lastRunLabel}
              {lastRunStatus ? ` · ${lastRunStatus}` : ""}
              {lastRunSummary ? ` — ${lastRunSummary}` : ""}
            </p>
          )}
        </div>
      </div>

      {/* Manual purge — uses the SAME configured window as the cron. */}
      <div className="rounded-[16px] border border-border bg-card px-4 py-3.5">
        <p className="text-sm font-semibold text-foreground">Purge manuelle</p>
        <p className="mt-0.5 mb-3 text-[11px] leading-relaxed text-muted-foreground">
          Lance immédiatement une purge selon la fenêtre configurée
          ({purgeMonths} mois). Les statistiques restent disponibles sur la
          période conservée.
        </p>
        {canManage ? (
          <PurgeSearchLogButton retentionDays={windowDays} />
        ) : (
          <p className="text-[11px] italic text-muted-foreground">
            Lecture seule — la permission « gérer » est requise pour purger.
          </p>
        )}
      </div>
    </div>
  );
}
