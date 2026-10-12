"use client";

import { useState } from "react";
import { Plus, X, ChevronUp, ChevronDown } from "lucide-react";

/**
 * Structured editor for a side-panel « Avantages » list — the bullet points shown
 * on /login or /register. Each perk is an add / remove / reorder ROW (a « bloc »)
 * rather than a raw newline textarea. Submits the SAME storage format (one perk per
 * line) via a hidden input, so the setting + `getAuthPagesConfig` are unchanged.
 * An empty list submits "" → the config falls back to the default perks.
 */
export function PerksEditor({
  name,
  defaultValue,
  label,
  helper,
}: {
  name: string;
  /** Newline-joined perks (the stored value, or the default). */
  defaultValue: string;
  label: string;
  helper?: string;
}) {
  const [items, setItems] = useState<string[]>(() =>
    defaultValue.split("\n").map((l) => l.trim()).filter(Boolean),
  );

  const setAt = (i: number, v: string) => setItems((a) => a.map((x, j) => (j === i ? v : x)));
  const removeAt = (i: number) => setItems((a) => a.filter((_, j) => j !== i));
  const add = () => setItems((a) => [...a, ""]);
  const move = (i: number, d: -1 | 1) =>
    setItems((a) => {
      const j = i + d;
      if (j < 0 || j >= a.length) return a;
      const n = [...a];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  // The setting keeps its newline-joined shape; blank rows are dropped.
  const serialized = items.map((s) => s.trim()).filter(Boolean).join("\n");

  return (
    <div>
      <label className="mb-1.5 block text-[13px] font-bold text-foreground">{label}</label>
      {/* Hidden input carries the value submitted with the form. */}
      <input type="hidden" name={name} value={serialized} />
      <ul className="space-y-2">
        {items.map((it, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                aria-label="Monter"
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === items.length - 1}
                aria-label="Descendre"
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
            <input
              value={it}
              onChange={(e) => setAt(i, e.target.value)}
              placeholder="Un avantage…"
              maxLength={120}
              className="h-11 flex-1 rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[15px] focus:border-foreground focus:bg-white focus:outline-none"
            />
            <button
              type="button"
              onClick={() => removeAt(i)}
              aria-label="Retirer"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition hover:bg-[#fdecef] hover:text-[#d40530]"
            >
              <X className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={add}
        className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3.5 text-[13px] font-bold text-foreground transition hover:bg-surface"
      >
        <Plus className="h-3.5 w-3.5" /> Ajouter un avantage
      </button>
      {helper && <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/80">{helper}</p>}
    </div>
  );
}
