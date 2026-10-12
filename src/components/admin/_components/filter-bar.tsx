"use client";

import type { ReactNode } from "react";
import { Search as SearchIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Shared admin toolbar primitives — the ADMIN UI mockup's list-page "bar": one
 * row holding a search field, a SEGMENTED filter track (options packed inside a
 * single soft pill-bar, each with a count, the active one a raised white pill),
 * and the primary action. Plus the mockup's note/callout chrome for the
 * descriptions / explanations that sit above or inside a panel.
 *
 *   <AdminToolbar>
 *     <AdminSearch value={q} onChange={…} placeholder="Rechercher…" className="flex-1" />
 *     <SegmentedFilter value={f} onChange={setF} options={[
 *       { value: "all", label: "Tous", count: 128 },
 *       { value: "on",  label: "En ligne", count: 96 },
 *     ]} />
 *     <button className="…crimson pill…">Ajouter</button>
 *   </AdminToolbar>
 */

/** A flex row that wraps a search + filter track + actions with consistent gaps. */
export function AdminToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-2.5", className)}>{children}</div>;
}

export type SegOption<T extends string = string> = {
  value: T;
  label: string;
  /** Optional trailing count (number or preformatted string). */
  count?: number | string;
  /** Optional leading icon. */
  icon?: React.ElementType;
};

/**
 * The mockup's segmented filter bar — all options live INSIDE one soft #f6f2ed
 * track; the active option is a raised white pill. Use for the "Tous / En stock /
 * En rupture …" quick-filters (counts optional). Horizontally scrollable when it
 * overflows. Controlled: pass `value` + `onChange`.
 */
export function SegmentedFilter<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className,
  ariaLabel,
}: {
  options: ReadonlyArray<SegOption<T>>;
  value: T;
  onChange: (next: T) => void;
  size?: "sm" | "md";
  className?: string;
  ariaLabel?: string;
}) {
  const h = size === "sm" ? "h-8" : "h-9";
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-[14px] bg-[var(--background)] p-1 [scrollbar-width:none]",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] px-3 text-[13px] transition",
              h,
              active
                ? "bg-card font-extrabold text-foreground shadow-[0_2px_8px_rgba(14,18,24,0.08)]"
                : "font-semibold text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className="h-4 w-4 shrink-0" strokeWidth={1.9} />}
            {o.label}
            {o.count != null && o.count !== "" && (
              <span className={cn("text-[11px] font-bold tabular-nums", active ? "text-primary" : "text-[#8a857f]")}>
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The mockup's search input — a 44px field, soft #fbf9f8 fill, 1.5px warm border,
 * leading magnifier, INK focus (border + ring), matching every other admin field.
 * Pass it `value`+`onChange` (controlled) or `defaultValue`+`onChange` (uncontrolled).
 */
export function AdminSearch({
  value,
  defaultValue,
  onChange,
  onKeyDown,
  placeholder = "Rechercher…",
  name,
  className,
  "aria-label": ariaLabel,
}: {
  value?: string;
  defaultValue?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  name?: string;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <label
      className={cn(
        "flex h-11 min-w-0 items-center gap-2.5 rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3.5 transition focus-within:border-foreground focus-within:bg-white focus-within:ring-[3px] focus-within:ring-[rgba(14,18,24,0.07)]",
        className,
      )}
    >
      <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={2} />
      <input
        type="search"
        name={name}
        value={value}
        defaultValue={defaultValue}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className="min-w-0 flex-1 border-none bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground/60"
      />
    </label>
  );
}

/**
 * A caption / note line — the quiet muted explanation that sits under a title,
 * field, or section. One consistent style for every "description / note" in the
 * admin instead of a dozen ad-hoc sizes.
 */
export function AdminNote({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-[13px] leading-relaxed text-muted-foreground", className)}>{children}</p>;
}

/**
 * A tonal callout — the mockup's inline explanation/alert block (rounded-16,
 * tinted by tone, optional leading icon). Use for "why" notes, read-only
 * warnings, and status explanations instead of bare bordered boxes.
 */
export function AdminCallout({
  tone = "info",
  icon: Icon,
  title,
  children,
  className,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  icon?: React.ElementType;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const tones: Record<string, string> = {
    info: "border-[#efe9e3] bg-[#fbf9f8] text-[#5b5d62]",
    success: "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]",
    warning: "border-[#f3e3bd] bg-[#fff4e0] text-[#b45309]",
    danger: "border-[#f6d3dc] bg-[#fdecef] text-[#d40530]",
  };
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-[16px] border px-4 py-3 text-[13px] leading-relaxed",
        tones[tone],
        className,
      )}
    >
      {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />}
      <div className="min-w-0 flex-1">
        {title && <p className="font-bold text-foreground">{title}</p>}
        {children}
      </div>
    </div>
  );
}
