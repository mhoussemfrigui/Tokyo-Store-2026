"use client";

import { FormTabs, FormTab } from "@/components/admin/_components/form-tabs";
import { type AuditConfig } from "@/lib/audit/parse-config";
import { AuditSettingsForm } from "./audit-settings-form";
import { AuditPurgePanel, type AuditPurgeState } from "./audit-purge-panel";

type TabId = "journal" | "stats" | "settings" | "purge";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "journal", label: "Journal" },
  { id: "stats", label: "Statistiques" },
  { id: "settings", label: "Réglages" },
  { id: "purge", label: "Purge" },
];

/**
 * Audit control center — one tabbed card hosting the log (Journal), the KPIs
 * (Statistiques), the capture/debug/retention settings (Réglages) and the
 * retention/purge controls (Purge). `journal` + `stats` are passed down as
 * server-rendered nodes from the RSC page; Réglages + Purge own their controls.
 * Mirrors the Recherche control-center pattern.
 */
export function AuditControlCenter({
  journal,
  stats,
  settings,
  purge,
  canManage,
}: {
  journal: React.ReactNode;
  stats: React.ReactNode;
  settings: AuditConfig;
  purge: AuditPurgeState;
  /** Whether the viewer holds system_audit:manage (gates Réglages + Purge). */
  canManage: boolean;
}) {
  return (
    <FormTabs<TabId> tabs={TABS} defaultTab="journal">
      {(active) => (
        <>
          <FormTab id="journal" active={active}>
            {journal}
          </FormTab>
          <FormTab id="stats" active={active}>
            {stats}
          </FormTab>
          <FormTab id="settings" active={active}>
            <AuditSettingsForm values={settings} canManage={canManage} />
          </FormTab>
          <FormTab id="purge" active={active}>
            <AuditPurgePanel {...purge} canManage={canManage} />
          </FormTab>
        </>
      )}
    </FormTabs>
  );
}
