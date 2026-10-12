"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";

/**
 * "Caractéristiques clés" editor — an ordered, VARIABLE-count list of free-text
 * key-feature bullets shown on the PDP (the « Neuf · testé… / Facture officielle… »
 * chips). DYNAMIC: add / remove / reorder up to `max` bullets (default 12, matching
 * the createProduct schema's `.max(12)`).
 *
 * Emits a hidden `<input name="highlightsJson">` carrying the trimmed JSON string[]
 * (ORDER preserved), read by create/update-product via `parseHighlights`. Blank rows
 * are stripped at serialise time. Lives inside its tab panel — hidden panels still submit.
 * Empty list ⇒ the PDP falls back to attribute specs, then a derived marketing default.
 */

const MAX_DEFAULT = 12;

export function HighlightsEditor({
  name = "highlightsJson",
  initial,
  max = MAX_DEFAULT,
}: {
  name?: string;
  initial?: string[] | null;
  max?: number;
}) {
  const [items, setItems] = useState<string[]>(
    initial && initial.length > 0 ? initial : [""],
  );

  const update = (idx: number, value: string) =>
    setItems((prev) => prev.map((s, i) => (i === idx ? value : s)));
  const remove = (idx: number) =>
    setItems((prev) => (prev.length <= 1 ? [""] : prev.filter((_, i) => i !== idx)));
  const add = () => setItems((prev) => (prev.length >= max ? prev : [...prev, ""]));
  const move = (idx: number, dir: -1 | 1) =>
    setItems((prev) => {
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });

  // Strip blank rows + cap before serialising (mirrors the action's parseHighlights).
  const trimmed = items
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, max);

  return (
    <div className="border-t border-border pt-4">
      <input type="hidden" name={name} value={JSON.stringify(trimmed)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Caractéristiques clés ({max} max)
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Puces mises en avant en haut de la fiche produit (ex : « Neuf · testé par nos
            techniciens »). Ordre modifiable ; les puces vides sont ignorées. Laisser vide
            pour retomber automatiquement sur les attributs du produit.
          </p>
        </div>
        <button
          type="button"
          onClick={add}
          disabled={items.length >= max}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-medium hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Ajouter une puce
        </button>
      </div>
      <div className="mt-3 space-y-2">
        {items.map((val, idx) => (
          <div
            key={idx}
            className="flex items-center gap-2 rounded-2xl border border-border bg-background p-2"
          >
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => move(idx, -1)}
                disabled={idx === 0}
                aria-label="Monter"
                className="grid h-4 w-6 place-items-center rounded text-muted-foreground transition hover:text-foreground disabled:opacity-30"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => move(idx, 1)}
                disabled={idx === items.length - 1}
                aria-label="Descendre"
                className="grid h-4 w-6 place-items-center rounded text-muted-foreground transition hover:text-foreground disabled:opacity-30"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
            <span className="w-5 shrink-0 text-center text-[11px] font-semibold text-muted-foreground">
              {idx + 1}
            </span>
            <input
              type="text"
              value={val}
              onChange={(e) => update(idx, e.target.value)}
              placeholder="ex : Facture officielle incluse"
              maxLength={160}
              className="h-10 flex-1 rounded-xl border border-border bg-card px-3 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <button
              type="button"
              onClick={() => remove(idx)}
              aria-label="Supprimer cette caractéristique"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
