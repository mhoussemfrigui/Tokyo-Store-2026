"use client";

import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";

import type { ProductVariant, ProductVariantOption } from "@/types/catalog";
import { variantInStock } from "@/types/catalog";
import { resolveVariant } from "@/lib/catalog/variant-match";
import { useMoney } from "@/components/money-provider";

/**
 * PDP variant selector. One pill group per axis (attribute); picking one value
 * per axis resolves the matching variant and reports it up via `onChange`.
 * Impossible combinations are greyed out — a value is selectable only if some
 * variant carries it alongside the other axes' current selections.
 */
export function VariantPicker({
  options,
  variants,
  onChange,
}: {
  options: ProductVariantOption[];
  variants: ProductVariant[];
  onChange: (variant: ProductVariant | null) => void;
}) {
  // Initial selection: the admin-chosen default variant wins, then the first
  // effectively-in-stock one, then the first overall — expanded per axis.
  const [selected, setSelected] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    const base =
      variants.find((v) => v.isDefault) ?? variants.find(variantInStock) ?? variants[0];
    if (base) {
      for (const opt of options) {
        const match = base.optionValueIds.find((id) => opt.values.some((v) => v.id === id));
        if (match) init[opt.attributeId] = match;
      }
    }
    return init;
  });

  // Resolve via the shared pure matcher: it compares only the value ids that
  // belong to a currently-displayed axis, so a variant carrying a STALE id for a
  // dropped axis (removed attribute) still resolves instead of nulling the
  // selection and blocking checkout. See lib/catalog/variant-match.ts.
  const resolved = useMemo(
    () => resolveVariant(options, variants, selected),
    [selected, options, variants],
  );

  useEffect(() => {
    onChange(resolved);
  }, [resolved, onChange]);

  // A value is available if some variant has it AND matches every OTHER axis's
  // current selection (so the shopper can't pick a non-existent combo).
  const isAvailable = (attributeId: string, valueId: string) =>
    variants.some(
      (v) =>
        v.optionValueIds.includes(valueId) &&
        options.every(
          (o) =>
            o.attributeId === attributeId ||
            !selected[o.attributeId] ||
            v.optionValueIds.includes(selected[o.attributeId]),
        ),
    );

  const labelFor = (id: string) => {
    for (const o of options) {
      const v = o.values.find((val) => val.id === id);
      if (v) return v.label;
    }
    return id;
  };

  return (
    <div className="space-y-5">
      {options.map((opt) => (
        <div key={opt.attributeId}>
          <p className="flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {opt.name}
            {selected[opt.attributeId] && (
              <span className="text-sm font-semibold normal-case tracking-normal text-foreground">
                {labelFor(selected[opt.attributeId])}
              </span>
            )}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {opt.values.map((val) => {
              const active = selected[opt.attributeId] === val.id;
              const available = isAvailable(opt.attributeId, val.id);
              return (
                <button
                  key={val.id}
                  type="button"
                  aria-pressed={active}
                  disabled={!available}
                  onClick={() =>
                    setSelected((s) => ({ ...s, [opt.attributeId]: val.id }))
                  }
                  className={`inline-flex min-h-10 items-center gap-1.5 rounded-xl border px-4 py-2 text-sm font-semibold transition-all duration-150 ${
                    active
                      ? "border-foreground bg-foreground text-background shadow-sm"
                      : available
                        ? "border-border bg-card text-foreground hover:-translate-y-0.5 hover:border-foreground/50 hover:shadow-sm"
                        : "cursor-not-allowed border-dashed border-border bg-surface/50 text-muted-foreground/40 line-through"
                  }`}
                >
                  {active && <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={3} />}
                  {val.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Flat variant selector for MANUAL variants (free-form, no attribute axes) and
 * any product that mixes manual with attribute variants. Each variant is a
 * direct-select pill labelled by its name + price; picking one reports it up
 * via `onChange`. Out-of-stock variants are disabled. Used whenever a product
 * has any axis-less variant — the axis picker can't represent those.
 */
export function ManualVariantPicker({
  variants,
  onChange,
}: {
  variants: ProductVariant[];
  onChange: (variant: ProductVariant | null) => void;
}) {
  const money = useMoney();
  const [selectedId, setSelectedId] = useState<string>(
    () =>
      (variants.find((v) => v.isDefault) ??
        variants.find(variantInStock) ??
        variants[0])?.id ?? "",
  );

  const resolved = useMemo(
    () => variants.find((v) => v.id === selectedId) ?? null,
    [variants, selectedId],
  );

  useEffect(() => {
    onChange(resolved);
  }, [resolved, onChange]);

  if (variants.length === 0) return null;

  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Variante
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {variants.map((v) => {
          const active = v.id === selectedId;
          const available = variantInStock(v);
          return (
            <button
              key={v.id}
              type="button"
              aria-pressed={active}
              disabled={!available}
              onClick={() => setSelectedId(v.id)}
              className={`inline-flex min-h-10 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition-all duration-150 ${
                active
                  ? "border-foreground bg-foreground text-background shadow-sm"
                  : available
                    ? "border-border bg-card text-foreground hover:-translate-y-0.5 hover:border-foreground/50 hover:shadow-sm"
                    : "cursor-not-allowed border-dashed border-border bg-surface/50 text-muted-foreground/40 line-through"
              }`}
            >
              {active && <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={3} />}
              <span>{v.label || "Variante"}</span>
              <span
                className={`text-xs font-normal ${
                  active ? "text-background/70" : "text-muted-foreground"
                }`}
              >
                {money.fromMinor(v.priceCents)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
