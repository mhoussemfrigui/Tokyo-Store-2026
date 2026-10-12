"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight, Boxes, MapPin, Plug, SlidersHorizontal } from "lucide-react";

import { SubTabBar, type FormTabDef } from "@/components/admin/_components/form-tabs";

/**
 * Sub-tab shell for the Stock page: INVENTAIRE (the editable table — primary,
 * default) · EMPLACEMENTS (locations CRUD) · TRANSFERTS (inter-location moves) ·
 * ERP (linkage) · RÉGLAGES (every stock setting — variant mode, alerts, multi-
 * stock + transfer settings, gathered here).
 *
 * All sections are kept MOUNTED and toggled with `hidden`, not unmounted — so the
 * inventory table's unsaved edit-drafts survive a quick peek at another tab. The
 * tab "hint" pills carry the at-a-glance status (location mode, transfers, ERP).
 */
type TabId = "inventaire" | "emplacements" | "transferts" | "erp" | "reglages";

const TAB_IDS: readonly TabId[] = ["inventaire", "emplacements", "transferts", "erp", "reglages"];

/** A raw `?tab=` / `#hash` value → a known tab id, else null. */
function asTabId(raw: string | null | undefined): TabId | null {
  const v = (raw ?? "").replace(/^#/, "").trim().toLowerCase();
  return (TAB_IDS as readonly string[]).includes(v) ? (v as TabId) : null;
}

export function StockTabs({
  inventory,
  locations,
  transfers,
  erp,
  reglages,
  locationHint,
  transferHint,
  erpHint,
  initialTab,
}: {
  inventory: React.ReactNode;
  locations: React.ReactNode;
  transfers: React.ReactNode;
  erp: React.ReactNode;
  reglages: React.ReactNode;
  /** Compact status shown on the Emplacements tab (e.g. "3 actifs" / "partagé"). */
  locationHint: string;
  /** Compact status shown on the Transferts tab (e.g. "2 en cours" / "désactivés"). */
  transferHint: string;
  /** Compact status shown on the ERP tab (e.g. "ERP maître" / "désactivé"). */
  erpHint: string;
  /** Tab to open first — the page's `?tab=` param (e.g. the old
   *  /admin/catalog/locations route redirects with `?tab=emplacements`).
   *  Unknown / missing → Inventaire. */
  initialTab?: string;
}) {
  const [active, setActive] = useState<TabId>(() => asTabId(initialTab) ?? "inventaire");

  // Legacy `…/stock#emplacements` links (the old redirect target): the hash
  // never reaches the server, so sync it on the client — on mount and whenever
  // it changes while the page is open.
  useEffect(() => {
    const syncFromHash = () => {
      const fromHash = asTabId(window.location.hash);
      if (fromHash) setActive(fromHash);
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);
  const tabs: FormTabDef<TabId>[] = [
    { id: "inventaire", label: "Inventaire", icon: Boxes },
    { id: "emplacements", label: "Emplacements", icon: MapPin, badge: locationHint || undefined },
    { id: "transferts", label: "Transferts", icon: ArrowLeftRight, badge: transferHint || undefined },
    { id: "erp", label: "ERP", icon: Plug, badge: erpHint || undefined },
    { id: "reglages", label: "Réglages", icon: SlidersHorizontal },
  ];

  return (
    <div className="space-y-3">
      {/* Standalone sub-tab strip in its own white nav card (the content below is
          several separate cards, so the strip can't live inside one). */}
      <SubTabBar tabs={tabs} activeTab={active} onSelect={setActive} />

      {/* Sections kept mounted; only the active one is shown. */}
      <div role="tabpanel" hidden={active !== "inventaire"}>
        {inventory}
      </div>
      <div role="tabpanel" hidden={active !== "emplacements"}>
        {locations}
      </div>
      <div role="tabpanel" hidden={active !== "transferts"}>
        {transfers}
      </div>
      <div role="tabpanel" hidden={active !== "erp"}>
        {erp}
      </div>
      <div role="tabpanel" hidden={active !== "reglages"}>
        {reglages}
      </div>
    </div>
  );
}
