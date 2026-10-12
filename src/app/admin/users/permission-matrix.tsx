"use client";

import { useMemo } from "react";
import { Check } from "lucide-react";

import {
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  type PermissionAction,
  type PermissionModule,
} from "@/lib/rbac/registry";
import { AdminSearch } from "@/components/admin/_components/filter-bar";

/**
 * Shared Section × action permission GRID — the control the role editor and the
 * per-user overlay editor BOTH render, so they look and behave identically. Purely
 * presentational: the parent owns the meaning of each cell (a role editor's flat set
 * vs. the overlay's inherited/allow/deny tri-state) via `cellState` + the toggle
 * callbacks. Columns = the shared action vocabulary; the last column is the per-module
 * wildcard (« Tout »), and each group has bulk Tout/Effacer + a filter box.
 */
export const ACTION_LABEL: Record<PermissionAction, string> = {
  view: "Voir",
  create: "Créer",
  update: "Modifier",
  delete: "Supprimer",
  manage: "Gérer",
  export: "Exporter",
  // `users`-only high-trust slices (see registry.ts): roles = grant access to
  // others, policy = shop-wide session policy.
  roles: "Rôles & accès",
  policy: "Sessions",
};

/** PERMISSION_MODULES grouped by nav group, order preserved. */
const GROUPED: { group: string; modules: readonly PermissionModule[] }[] = (() => {
  const order: string[] = [];
  const map = new Map<string, PermissionModule[]>();
  for (const m of PERMISSION_MODULES) {
    if (!map.has(m.group)) {
      map.set(m.group, []);
      order.push(m.group);
    }
    map.get(m.group)!.push(m);
  }
  return order.map((group) => ({ group, modules: map.get(group)! }));
})();

/** Visual + semantic state of one cell, computed by the parent. */
export type CellTone = "normal" | "inherited" | "allow" | "deny";
export type MatrixCellState = { checked: boolean; disabled: boolean; tone: CellTone };
export type WildState = { on: boolean; disabled: boolean; tone: CellTone };

function toneRing(tone: CellTone): string {
  switch (tone) {
    case "allow":
      return "text-[#15803d] focus:ring-[#15803d]/30 ring-1 ring-[#cdebd6]";
    case "deny":
      return "text-[#d40530] focus:ring-[#d40530]/30 ring-1 ring-[#f6d3dc]";
    case "inherited":
      return "text-primary/80 focus:ring-primary/30";
    default:
      return "text-primary focus:ring-primary/30";
  }
}

export function PermissionMatrix({
  query,
  onQueryChange,
  cellState,
  wildState,
  onToggleAction,
  onToggleWild,
  onGroupAll,
  onGroupClear,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  cellState: (moduleId: string, action: PermissionAction) => MatrixCellState;
  wildState: (moduleId: string) => WildState;
  onToggleAction: (moduleId: string, action: PermissionAction) => void;
  onToggleWild: (module: PermissionModule) => void;
  onGroupAll: (modules: readonly PermissionModule[]) => void;
  onGroupClear: (modules: readonly PermissionModule[]) => void;
}) {
  const groupsToRender = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUPED;
    return GROUPED.map(({ group, modules }) => ({
      group,
      modules: modules.filter(
        (m) => m.label.toLowerCase().includes(q) || group.toLowerCase().includes(q),
      ),
    })).filter((g) => g.modules.length > 0);
  }, [query]);

  return (
    <div>
      <AdminSearch
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Filtrer les sections (ex. Catalogue, Commandes, Utilisateurs)…"
        className="mb-2 w-full"
      />

      <div className="max-h-[60vh] overflow-y-auto rounded-[22px] border border-border">
        {groupsToRender.length === 0 && (
          <p className="px-4 py-8 text-center text-[14px] text-muted-foreground">
            Aucune section ne correspond à « {query} ».
          </p>
        )}
        {groupsToRender.map(({ group, modules }) => (
          <div key={group} className="border-b border-border last:border-b-0">
            <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-[#fbf9f8]/90 px-4 py-2 backdrop-blur">
              <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                {group}
              </span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onGroupAll(modules)}
                  className="rounded-full border-[1.5px] border-input bg-card px-2.5 py-1 text-[11px] font-bold text-muted-foreground hover:bg-surface hover:text-foreground"
                  title="Tout accorder dans cette section"
                >
                  Tout
                </button>
                <button
                  type="button"
                  onClick={() => onGroupClear(modules)}
                  className="rounded-full border-[1.5px] border-input bg-card px-2.5 py-1 text-[11px] font-bold text-muted-foreground hover:bg-surface hover:text-foreground"
                  title="Réinitialiser cette section"
                >
                  Effacer
                </button>
              </span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.06em] text-[#8a857f]">
                  <th className="px-4 py-1 text-left font-bold">Section</th>
                  {PERMISSION_ACTIONS.map((a) => (
                    <th key={a} className="px-2 py-1 text-center font-bold">
                      {ACTION_LABEL[a]}
                    </th>
                  ))}
                  <th className="px-3 py-1 text-right font-bold">Tout</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {modules.map((m) => {
                  const wild = wildState(m.id);
                  return (
                    <tr key={m.id} className="hover:bg-[#fffbfb]">
                      <td className="px-4 py-2.5 align-middle">
                        <span className="text-[14px] font-semibold text-foreground">{m.label}</span>
                      </td>
                      {PERMISSION_ACTIONS.map((a) => {
                        if (!m.actions.includes(a)) {
                          return (
                            <td key={a} className="px-2 py-2.5 text-center align-middle">
                              <span className="text-muted-foreground/30">—</span>
                            </td>
                          );
                        }
                        const c = cellState(m.id, a);
                        return (
                          <td key={a} className="px-2 py-2.5 text-center align-middle">
                            <input
                              type="checkbox"
                              checked={c.checked}
                              disabled={c.disabled}
                              onChange={() => onToggleAction(m.id, a)}
                              aria-label={`${m.label} — ${ACTION_LABEL[a]}`}
                              title={`${m.label} — ${ACTION_LABEL[a]}`}
                              className={`h-4 w-4 cursor-pointer rounded border-border focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50 ${toneRing(c.tone)}`}
                            />
                          </td>
                        );
                      })}
                      <td className="px-3 py-2.5 text-right align-middle">
                        <button
                          type="button"
                          onClick={() => onToggleWild(m)}
                          disabled={wild.disabled}
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                            wild.on
                              ? wild.tone === "deny"
                                ? "bg-[#d40530] text-white"
                                : wild.tone === "allow"
                                  ? "bg-[#15803d] text-white"
                                  : "bg-primary text-primary-foreground"
                              : "border-[1.5px] border-input bg-card text-muted-foreground hover:bg-surface"
                          }`}
                          title="Toutes les actions de cette section (présentes et futures)"
                        >
                          {wild.on && <Check className="h-3 w-3" />} Tout
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
