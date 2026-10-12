"use client";

import { useActionState } from "react";
import { Loader2, Save } from "lucide-react";

import { type ActionState } from "@/lib/actions/types";

export type TaxRateItem = { id: string; name: string; percent: number | null };

/**
 * Bulk TVA-rate editor for a list of entities (marques OU catégories). Each row
 * is a `rate_<id>` percent input (0–100); an empty field inherits, a number sets
 * an explicit rate. One save posts the whole list plus a hidden `prev_<id>` (the
 * loaded value) so the action writes ONLY the rows the operator changed. A row
 * the server rejects is flagged inline (`fieldErrors["rate_<id>"]`). Generic over
 * the save action so the same UI serves both the brand and the category tier.
 */
export function EntityTaxEditor({
  title,
  description,
  items,
  action,
  emptyLabel,
}: {
  title: string;
  description: string;
  items: TaxRateItem[];
  action: (prev: ActionState | null, fd: FormData) => Promise<ActionState>;
  emptyLabel: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(action, null);
  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form action={formAction} className="space-y-4">
      <header>
        <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">{title}</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      </header>

      {items.length === 0 ? (
        <p className="rounded-[16px] border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
          {emptyLabel}
        </p>
      ) : (
        <div className="space-y-1.5">
          {items.map((it) => {
            const rowError = fieldErrors?.[`rate_${it.id}`];
            return (
              <div key={it.id} className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-xl px-2 py-1 hover:bg-surface/40">
                <span className="truncate text-sm text-foreground">
                  {it.name}
                  {rowError && <span className="ml-2 text-xs text-destructive">{rowError}</span>}
                </span>
                <div className="flex items-center gap-1">
                  <input
                    type="hidden"
                    name={`prev_${it.id}`}
                    value={it.percent != null ? String(it.percent) : ""}
                  />
                  <input
                    name={`rate_${it.id}`}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={100}
                    step="any"
                    defaultValue={it.percent != null ? String(it.percent) : ""}
                    placeholder="hériter"
                    aria-invalid={rowError ? true : undefined}
                    className={`h-9 w-24 rounded-[10px] border-[1.5px] bg-[#fbf9f8] px-2 text-sm tabular-nums text-foreground transition focus:bg-white focus:outline-none ${
                      rowError ? "border-destructive focus:border-destructive" : "border-input focus:border-foreground"
                    }`}
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {state?.message && (
        <div
          className={`rounded-[16px] border p-3 text-xs font-semibold ${
            state.ok ? "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]" : "border-destructive/40 bg-destructive/5 text-destructive"
          }`}
        >
          {state.message}
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Enregistrer les taux
      </button>
    </form>
  );
}
