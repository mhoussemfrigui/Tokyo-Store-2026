"use client";

import { useState } from "react";
import { Download, ChevronDown, Check } from "lucide-react";

/**
 * Reusable CSV export control with an operator field picker. The operator ticks
 * exactly which columns leave in the file; the download URL carries `?fields=` (the
 * route validates it against its own catalog). When EVERY column is selected the
 * `fields` param is omitted, so the URL stays backward-compatible with the plain
 * "export all" link. Shared by the Clients / Newsletter / (per-segment) exports so
 * the RBAC `export` grant + the field control behave identically everywhere.
 */
export function ExportFieldPicker({
  baseUrl,
  fields,
  extraParams,
  label = "Exporter CSV",
}: {
  /** The export route (e.g. "/api/admin/customers/export"). */
  baseUrl: string;
  /** The catalog of selectable columns (key + French label). */
  fields: ReadonlyArray<{ key: string; label: string }>;
  /** Non-field query params to preserve (e.g. the newsletter status / search). */
  extraParams?: Record<string, string | undefined>;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(fields.map((f) => f.key)));

  const allOn = selected.size === fields.length;
  const toggle = (k: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(fields.map((f) => f.key)));

  const doExport = () => {
    if (selected.size === 0) return;
    const params = new URLSearchParams();
    const keys = fields.filter((f) => selected.has(f.key)).map((f) => f.key);
    // Omit `fields` when everything is selected → the route exports the full catalog.
    if (keys.length > 0 && keys.length < fields.length) params.set("fields", keys.join(","));
    for (const [k, v] of Object.entries(extraParams ?? {})) if (v) params.set(k, v);
    const qs = params.toString();
    window.location.href = qs ? `${baseUrl}?${qs}` : baseUrl;
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-[12px] font-semibold text-foreground transition hover:bg-surface"
      >
        <Download className="h-3.5 w-3.5" /> {label}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-30 mt-2 w-64 rounded-2xl border border-border bg-card p-3 shadow-lg">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Colonnes à exporter
              </p>
              <button
                type="button"
                onClick={toggleAll}
                className="text-[11px] font-medium text-primary hover:underline"
              >
                {allOn ? "Aucune" : "Toutes"}
              </button>
            </div>
            <div className="max-h-64 space-y-0.5 overflow-y-auto">
              {fields.map((f) => {
                const on = selected.has(f.key);
                return (
                  <label
                    key={f.key}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] hover:bg-surface"
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        on ? "border-primary bg-primary text-primary-foreground" : "border-border"
                      }`}
                    >
                      {on && <Check className="h-3 w-3" />}
                    </span>
                    <input type="checkbox" checked={on} onChange={() => toggle(f.key)} className="sr-only" />
                    <span className="text-foreground">{f.label}</span>
                  </label>
                );
              })}
            </div>
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={doExport}
              className="mt-3 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl bg-primary px-4 text-[12px] font-semibold text-primary-foreground disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" /> Exporter ({selected.size})
            </button>
          </div>
        </>
      )}
    </div>
  );
}
