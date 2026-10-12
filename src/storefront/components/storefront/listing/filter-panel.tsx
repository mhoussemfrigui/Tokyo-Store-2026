"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/storefront/lib/utils";
import type { ListingState } from "@/storefront/components/storefront/listing/use-listing";

/**
 * The Normal V1 filter accordion — shared by the category & search listing, in
 * the desktop sticky rail and the mobile drawer alike. Collapsible groups:
 * Prix (min/max inputs + preset chips), Marque (checkbox + live count), État
 * (segmented, only when the catalogue mixes conditions), Disponibilité (switch).
 *
 * Couleur is intentionally absent: the storefront snapshot carries no per-product
 * colour (it lives only in PDP variant axes), and the project rule is no faked
 * facet data. Everything here is backed by real snapshot fields.
 */

/** One collapsible section: a 56px header button + a grid-rows height animation. */
function Group({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-border/70">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-14 w-full items-center justify-between gap-3 text-left text-[15px] font-extrabold text-foreground"
      >
        <span>{title}</span>
        <ChevronDown
          aria-hidden
          className={cn("size-4 transition-transform duration-200", !open && "-rotate-90")}
          strokeWidth={2.2}
        />
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="pb-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

function PriceField({
  kind,
  value,
  placeholder,
  onChange,
}: {
  kind: "Min" | "Max";
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex h-[52px] flex-col justify-center gap-0.5 rounded-[16px] border border-border bg-surface-warm px-3.5">
      <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
        {kind}
      </span>
      <span className="flex items-center gap-1">
        <input
          type="text"
          inputMode="numeric"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`Prix ${kind.toLowerCase()}`}
          className="w-full min-w-0 border-none bg-transparent p-0 text-[15px] font-bold text-foreground outline-none placeholder:font-semibold placeholder:text-muted-foreground/70"
        />
        <span className="text-[12px] text-muted-foreground">TND</span>
      </span>
    </label>
  );
}

export function FilterGroups({ listing }: { listing: ListingState }) {
  const {
    brands,
    pricePresets,
    priceCeil,
    conditionOptions,
    inStockOnly,
    inStockCount,
    condition,
    pmin,
    pmax,
    selBrands,
    toggleBrand,
    setInStock,
    setCondition,
    setPmin,
    setPmax,
    applyPreset,
  } = listing;

  const [brandQuery, setBrandQuery] = useState("");
  const [showAllBrands, setShowAllBrands] = useState(false);
  const matched = brands.filter((b) => b.name.toLowerCase().includes(brandQuery.toLowerCase()));
  const visibleBrands = showAllBrands || brandQuery ? matched : matched.slice(0, 8);

  return (
    <div>
      {/* Prix */}
      <Group title="Prix">
        <div className="grid grid-cols-2 gap-2">
          <PriceField kind="Min" value={pmin} placeholder="0" onChange={setPmin} />
          <PriceField
            kind="Max"
            value={pmax}
            placeholder={priceCeil ? String(priceCeil) : "—"}
            onChange={setPmax}
          />
        </div>
        {pricePresets.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {pricePresets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => applyPreset(preset)}
                disabled={preset.count === 0 && !preset.active}
                aria-pressed={preset.active}
                className={cn(
                  "h-[34px] rounded-full border px-3 text-[13px] font-semibold transition-colors duration-200 disabled:pointer-events-none disabled:opacity-40",
                  preset.active
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-foreground hover:border-foreground/40",
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}
      </Group>

      {/* Marque */}
      {brands.length > 1 && (
        <Group title="Marque">
          {brands.length > 8 && (
            <input
              type="search"
              value={brandQuery}
              onChange={(e) => setBrandQuery(e.target.value)}
              placeholder="Rechercher une marque"
              aria-label="Rechercher une marque"
              className="mb-2.5 h-10 w-full rounded-[12px] border border-border bg-surface-warm px-3 text-[14px] text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/40"
            />
          )}
          <div className="flex flex-col gap-0.5">
            {visibleBrands.map((b) => {
              const active = selBrands.has(b.name);
              const dead = b.live === 0 && !active;
              return (
                <button
                  key={b.name}
                  type="button"
                  onClick={() => toggleBrand(b.name)}
                  disabled={dead}
                  aria-pressed={active}
                  className={cn(
                    "flex h-11 items-center gap-3 rounded-[12px] px-1 text-left text-[14px] font-semibold text-foreground transition-colors duration-150 hover:bg-surface-warm disabled:pointer-events-none",
                    dead && "opacity-40",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-[22px] shrink-0 place-items-center rounded-[7px] border-[1.5px] transition-colors duration-200",
                      active ? "border-primary bg-primary" : "border-muted-foreground/35 bg-background",
                    )}
                  >
                    {active && (
                      <Check aria-hidden className="size-3.5 text-primary-foreground" strokeWidth={3.2} />
                    )}
                  </span>
                  <span className="flex-1 truncate">{b.name}</span>
                  <span className="text-[12px] font-semibold tabular-nums text-muted-foreground">
                    {b.live}
                  </span>
                </button>
              );
            })}
          </div>
          {visibleBrands.length === 0 && (
            <p className="mt-1 text-[13px] text-muted-foreground">Aucune marque ne correspond.</p>
          )}
          {!brandQuery && matched.length > 8 && (
            <button
              type="button"
              onClick={() => setShowAllBrands((v) => !v)}
              className="mt-2 inline-flex h-9 items-center text-[13px] font-semibold text-primary-ink hover:underline"
            >
              {showAllBrands ? "Voir moins" : `Voir plus (${matched.length - 8})`}
            </button>
          )}
        </Group>
      )}

      {/* État — only once the catalogue mixes conditions. */}
      {conditionOptions.length > 1 && (
        <Group title="État">
          <div className="grid grid-cols-3 gap-1 rounded-full bg-secondary p-1">
            {(
              [
                ["all", "Tous"],
                ["new", "Neuf"],
                ["refurb", "Occasion"],
              ] as const
            ).map(([k, text]) => {
              const active = condition === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setCondition(k)}
                  aria-pressed={active}
                  className={cn(
                    "h-[38px] rounded-full text-[13px] font-bold text-foreground transition-colors duration-200",
                    active ? "bg-background shadow-island" : "hover:text-primary-ink",
                  )}
                >
                  {text}
                </button>
              );
            })}
          </div>
        </Group>
      )}

      {/* Disponibilité */}
      <Group title="Disponibilité">
        <button
          type="button"
          role="switch"
          aria-checked={inStockOnly}
          onClick={() => setInStock(!inStockOnly)}
          disabled={inStockCount === 0 && !inStockOnly}
          className="flex h-12 w-full items-center justify-between gap-3 text-left text-[14px] font-semibold text-foreground disabled:opacity-40"
        >
          <span>En stock uniquement</span>
          <span
            className={cn(
              "flex h-7 w-[46px] shrink-0 items-center rounded-full p-[3px] transition-colors duration-200",
              inStockOnly ? "bg-success" : "bg-muted-foreground/25",
            )}
          >
            <span
              className={cn(
                "size-[22px] rounded-full bg-background shadow transition-transform duration-200 ease-[cubic-bezier(.3,1.4,.5,1)]",
                inStockOnly && "translate-x-[18px]",
              )}
            />
          </span>
        </button>
      </Group>
    </div>
  );
}
