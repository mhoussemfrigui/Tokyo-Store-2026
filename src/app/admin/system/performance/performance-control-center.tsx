"use client";

import { FormTabs, FormTab } from "@/components/admin/_components/form-tabs";
import { type PerfConfig } from "@/lib/telemetry/perf-config";
import { PerfSettingsForm } from "./perf-settings-form";

type TabId = "overview" | "history" | "metrics" | "settings";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "overview", label: "Aperçu" },
  { id: "history", label: "Historique" },
  { id: "metrics", label: "Métriques & cache" },
  { id: "settings", label: "Réglages" },
];

/**
 * Performance control center — one tabbed card hosting the live runtime overview
 * (Aperçu), the in-memory history (Historique), the event counters + cache/exec
 * info (Métriques & cache), and the sampling/threshold/alert settings (Réglages).
 * `overview`/`history`/`metrics` are passed as server/client nodes from the RSC
 * page; Réglages owns its form. Mirrors the Recherche / Journal d'audit pattern.
 */
export function PerformanceControlCenter({
  overview,
  history,
  metrics,
  settings,
  canManage,
}: {
  overview: React.ReactNode;
  history: React.ReactNode;
  metrics: React.ReactNode;
  settings: PerfConfig;
  /** Whether the viewer holds system_performance:manage (gates Réglages). */
  canManage: boolean;
}) {
  return (
    <FormTabs<TabId> tabs={TABS} defaultTab="overview">
      {(active) => (
        <>
          <FormTab id="overview" active={active}>
            {overview}
          </FormTab>
          <FormTab id="history" active={active}>
            {history}
          </FormTab>
          <FormTab id="metrics" active={active}>
            {metrics}
          </FormTab>
          <FormTab id="settings" active={active}>
            <PerfSettingsForm values={settings} canManage={canManage} />
          </FormTab>
        </>
      )}
    </FormTabs>
  );
}
