"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Loader2, Plus, X } from "lucide-react";

import { createBrandInlineAction } from "@/lib/actions/catalog";

type BrandOption = { id: string; name: string; slug: string; isActive?: boolean };

/**
 * Searchable brand picker for the product editor — replaces the old plain
 * dropdown. Filters CLIENT-SIDE over the brands already loaded by the product
 * page (the /api/brands GET is key-gated, so we never call it from the admin
 * client). Supports inline brand creation: when the typed name matches no
 * existing brand, a "Créer « … »" action creates it via createBrandInlineAction
 * and selects it immediately. Submits the chosen brand id via a hidden input
 * (name=brandId), matching the previous SelectField contract.
 */
export function BrandPicker({
  name = "brandId",
  defaultBrandId = null,
  brands,
}: {
  name?: string;
  defaultBrandId?: string | null;
  brands: BrandOption[];
}) {
  const [list, setList] = useState<BrandOption[]>(brands);
  const [selectedId, setSelectedId] = useState<string>(defaultBrandId ?? "");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = list.find((b) => b.id === selectedId) ?? null;

  // Close the popover AND reset the transient search query, so reopening starts
  // from the full list (not a stale filter) — selection is held by id. Done in
  // the handlers (not an effect) to avoid a cascading-render setState-in-effect.
  const close = () => {
    setOpen(false);
    setQuery("");
  };

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? list.filter((b) => b.name.toLowerCase().includes(q)) : list).slice(0, 50),
    [list, q],
  );
  const exactMatch = list.some((b) => b.name.trim().toLowerCase() === q);

  const select = (id: string) => {
    setSelectedId(id);
    setQuery("");
    setOpen(false);
    setError(null);
  };

  const create = async () => {
    const name = query.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await createBrandInlineAction({ name });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const brand = { id: res.brand.id, name: res.brand.name, slug: res.brand.slug, isActive: true };
      setList((prev) => (prev.some((b) => b.id === brand.id) ? prev : [...prev, brand].sort((a, b) => a.name.localeCompare(b.name))));
      select(brand.id);
    } catch {
      setError("Échec de la création. Réessayez.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Marque
      </label>
      {/* The chosen brand id submitted with the product form. */}
      <input type="hidden" name={name} value={selectedId} />

      <div ref={rootRef} className="relative mt-1">
        <button
          type="button"
          onClick={() => (open ? close() : setOpen(true))}
          className="flex h-11 w-full items-center justify-between gap-2 rounded-2xl border border-border bg-background px-4 text-left text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <span className={selected ? "text-foreground" : "text-muted-foreground"}>
            {selected ? (
              <>
                {selected.name}
                {selected.isActive === false && (
                  <span className="ml-1 text-[10px] uppercase text-amber-600">(inactive)</span>
                )}
              </>
            ) : (
              "Aucune marque"
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>

        {open && (
          <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-2xl border border-border bg-card shadow-lift">
            <div className="border-b border-border p-2">
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Rechercher ou créer…"
                className="h-9 w-full rounded-xl border border-border bg-background px-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <ul className="max-h-64 overflow-y-auto py-1 text-sm">
              {/* Clear / none */}
              <li>
                <button
                  type="button"
                  onClick={() => select("")}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface"
                >
                  <span className="text-muted-foreground">Aucune marque</span>
                  {selectedId === "" && <Check className="h-4 w-4 text-primary" />}
                </button>
              </li>
              {filtered.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    onClick={() => select(b.id)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface"
                  >
                    <span className="text-foreground">
                      {b.name}
                      {b.isActive === false && (
                        <span className="ml-1 text-[10px] uppercase text-amber-600">(inactive)</span>
                      )}
                    </span>
                    {selectedId === b.id && <Check className="h-4 w-4 text-primary" />}
                  </button>
                </li>
              ))}
              {q && !exactMatch && (
                <li className="border-t border-border">
                  <button
                    type="button"
                    onClick={create}
                    disabled={creating}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left font-medium text-primary hover:bg-primary/5 disabled:opacity-60"
                  >
                    {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    Créer «&nbsp;{query.trim()}&nbsp;»
                  </button>
                </li>
              )}
              {filtered.length === 0 && !q && (
                <li className="px-3 py-2 text-xs text-muted-foreground">Aucune marque. Tapez pour en créer une.</li>
              )}
            </ul>
            {error && <p className="border-t border-border px-3 py-2 text-[11px] text-destructive">{error}</p>}
          </div>
        )}
      </div>

      {selected && (
        <button
          type="button"
          onClick={() => select("")}
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" /> Retirer la marque
        </button>
      )}
      <p className="mt-1 text-[10px] text-muted-foreground">
        Fabricant / éditeur du produit. Introuvable&nbsp;? Tapez son nom puis «&nbsp;Créer&nbsp;».
      </p>
    </div>
  );
}
