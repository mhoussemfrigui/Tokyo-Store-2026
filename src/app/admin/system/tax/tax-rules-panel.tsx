"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Loader2, Check, X } from "lucide-react";

import { saveTaxRuleAction } from "@/lib/actions/tax";
import { type ActionState } from "@/lib/actions/types";

/** A single attribute value + its current rule rate (percent, or null). */
export type TaxRuleValueRow = {
  valueId: string;
  label: string;
  /** Current rule rate as a PERCENT (e.g. 19), or null if no rule set. */
  currentPercent: number | null;
};

/** One attribute group (e.g. "Type") with its values. */
export type TaxRuleGroup = {
  attributeName: string;
  values: TaxRuleValueRow[];
};

/**
 * "Règles par filtre" — the FILTER tier of the tax cascade. Lists every
 * attribute value grouped by attribute; each row carries an optional rate %.
 * Setting a rate upserts a `tax_rules` row; clearing it deletes the rule (the
 * value then falls back to the category/global tier).
 *
 * Each row is its own `<form>` so saving one value never touches the others —
 * mirrors how per-row admin tables submit independently.
 */
export function TaxRulesPanel({ groups }: { groups: TaxRuleGroup[] }) {
  const hasValues = groups.some((g) => g.values.length > 0);

  return (
    <div>
      <header className="mb-5">
        <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">
          Règles par filtre
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          Surchargez le taux pour une valeur de filtre précise (ex. « Type =
          Montre »). Laissez vide pour aucune règle — la valeur retombe alors
          sur la marque, puis la catégorie, puis le taux global.
        </p>
      </header>

      {!hasValues ? (
        <p className="rounded-[16px] border border-dashed border-border bg-surface/40 px-4 py-6 text-center text-xs text-muted-foreground">
          Aucune valeur de filtre. Créez des attributs et des valeurs dans{" "}
          <a
            href="/admin/catalog/attributes"
            className="font-semibold text-primary hover:underline"
          >
            Catalogue → Attributs
          </a>{" "}
          pour pouvoir définir des règles de taxe par filtre.
        </p>
      ) : (
        <div className="space-y-6">
          {groups
            .filter((g) => g.values.length > 0)
            .map((group) => (
              <div key={group.attributeName}>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.attributeName}
                </p>
                <div className="space-y-2">
                  {group.values.map((v) => (
                    <RuleRow key={v.valueId} value={v} />
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function RuleRow({ value }: { value: TaxRuleValueRow }) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveTaxRuleAction,
    null,
  );
  // Mirror the input to local state so the placeholder/initial value resets
  // cleanly after a save reflects through `currentPercent` on the next render.
  const [pct, setPct] = useState<string>(
    value.currentPercent != null ? String(value.currentPercent) : "",
  );

  // After a save, show an inline confirmation that auto-fades. `dismissed`
  // hides the badge ~2.5s later; the effect only sets state from inside a
  // timeout callback (never synchronously), so it doesn't cascade renders.
  const [dismissed, setDismissed] = useState(false);
  const lastSeen = useRef<ActionState | null>(null);
  useEffect(() => {
    if (!state || state === lastSeen.current) return;
    lastSeen.current = state;
    setDismissed(false);
    const t = setTimeout(() => setDismissed(true), 2500);
    return () => clearTimeout(t);
  }, [state]);
  const flash: null | "ok" | "err" =
    !state || dismissed ? null : state.ok ? "ok" : "err";

  // A failed save keeps its message on screen (unlike the success tick, which
  // auto-fades): a cryptic red X gave the operator no reason the TVA wouldn't save.
  const errorText =
    state && !state.ok
      ? (("fieldErrors" in state && state.fieldErrors?.ratePercent) || state.message)
      : null;

  return (
    <form
      action={formAction}
      className="flex flex-col gap-1.5 rounded-[16px] border border-border bg-card px-4 py-2.5"
    >
      <div className="flex items-center gap-3">
        <input type="hidden" name="attributeValueId" value={value.valueId} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {value.label}
        </span>
        <div className="relative w-28 shrink-0">
          <input
            name="ratePercent"
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            value={pct}
            onChange={(e) => setPct(e.target.value)}
            placeholder="—"
            aria-label={`Taux de taxe pour ${value.label}`}
            className="h-10 w-full rounded-[12px] border-[1.5px] border-input bg-[#fbf9f8] pl-3 pr-7 text-sm tabular-nums text-foreground placeholder:text-muted-foreground/50 transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            %
          </span>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-[12px] border-[1.5px] border-input bg-card px-3.5 text-xs font-bold text-foreground transition hover:bg-surface disabled:opacity-60"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : flash === "ok" ? (
            <Check className="h-3.5 w-3.5 text-[#15803d]" />
          ) : flash === "err" ? (
            <X className="h-3.5 w-3.5 text-destructive" />
          ) : null}
          Enregistrer
        </button>
      </div>
      {errorText && (
        <p role="alert" className="text-[11px] font-medium text-destructive">
          {errorText}
        </p>
      )}
    </form>
  );
}
