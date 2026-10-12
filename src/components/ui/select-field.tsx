"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Shared styled single-select listbox — used on BOTH the storefront and the
 * admin. Replaces the native `<select>` (whose option list takes default OS
 * styling) with a rounded, themed popover that matches the app's design.
 *
 * ── Portaled popover (no clipping) ───────────────────────────────────────
 * The option list is rendered through a PORTAL to `document.body` and
 * positioned with `position: fixed` from the trigger's bounding rect. This
 * is what lets it escape `overflow: hidden` ancestors (e.g. the FormTabs
 * card's rounded-corner clip) — an in-flow absolute popover would get cut
 * off at the card edge. Position is recomputed on scroll + resize so it
 * stays flush against the trigger.
 *
 * ── Seamless open state ──────────────────────────────────────────────────
 * When closed it's a normal rounded pill. When open, the trigger flattens
 * its bottom corners and drops its bottom border while the popover sits
 * flush beneath it (no gap) with a flat top and no top border — so the two
 * read as ONE continuous rounded container instead of two stacked pills.
 *
 * Submission contract: renders a hidden `<input name>` carrying the value,
 * so server-action `FormData` reads it exactly like the native element.
 *
 * Keyboard: ↑/↓ move, Home/End jump, Enter/Space pick, Esc close. Click
 * outside closes; focus returns to the trigger after a pick.
 */
export type SelectFieldOption = {
  value: string;
  label: string;
  /** Optional secondary line shown muted under the label in the popover. */
  description?: string;
  /** Disabled options stay visible but cannot be picked. */
  disabled?: boolean;
  /** Extra terms the `searchable` filter matches on (besides label/value/description),
   *  e.g. a country's name + dial code so typing "france" or "33" finds « +33 ». */
  keywords?: string[];
};

type Size = "sm" | "md";

export function SelectField({
  name,
  label,
  ariaLabel,
  options,
  value,
  defaultValue,
  onChange,
  required,
  disabled,
  placeholder = "Sélectionner…",
  helper,
  error,
  size = "md",
  className,
  labelClassName,
  triggerClassName,
  searchable = false,
}: {
  name?: string;
  label?: string;
  /**
   * Accessible name for the trigger when there is no visible `label`
   * (e.g. compact toolbar selects). Applied as `aria-label` on the button.
   * Ignored visually; a visible `label` is preferred when available.
   */
  ariaLabel?: string;
  options: SelectFieldOption[];
  /** Controlled mode — caller owns the state. */
  value?: string;
  /** Uncontrolled mode — initial value, component manages state. */
  defaultValue?: string;
  onChange?: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  helper?: string;
  /** Field-level error — paints the trigger border + shows the message. */
  error?: string;
  /** `sm` = compact (storefront toolbars); `md` = form inputs. */
  size?: Size;
  className?: string;
  /**
   * Optional override for the visible `<label>` classes. Lets a caller align
   * this select's label typography/spacing with a sibling text input in the
   * SAME grid row (e.g. the checkout Ville/Gouvernorat pair). Defaults to the
   * canonical admin label styling, so every existing usage is unchanged.
   */
  labelClassName?: string;
  /**
   * Optional EXTRA classes merged onto the trigger button — e.g. a matching
   * `h-12` height or `border-*`/`bg-*` so the control lines up with a sibling
   * input. Appended last so it can override the height token. Defaults to
   * nothing (no behaviour change).
   *
   * ⚠️ Do NOT pass an all-corners `rounded-*` here. It wins over the seamless
   * open-state cornering (`rounded-t-2xl rounded-b-none`) via tailwind-merge, so
   * the trigger keeps rounded BOTTOM corners while open — leaving the popover's
   * flat/square top corners exposed at the sides (looks "sharp" at the top of
   * the list). The control's radius is owned by the component so the trigger +
   * popover read as one seamless container; only override height/border/bg here.
   */
  triggerClassName?: string;
  /**
   * Adds a filter box at the top of the popover that narrows the options as you
   * type (matches label / value / description / `keywords`). Off by default, so
   * every existing select is unchanged. Use for long lists (e.g. countries).
   */
  searchable?: boolean;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const isControlled = value !== undefined;
  const [internal, setInternal] = useState<string>(defaultValue ?? "");
  const current = isControlled ? value : internal;

  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const [activeIndex, setActiveIndex] = useState<number>(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === (value ?? defaultValue ?? "")),
    ),
  );

  // The popover is portaled to <body>, OUTSIDE the page's theme scope (`.tokyo`
  // on the storefront, `.admin` in the dashboard). Those scopes redefine
  // `--primary` (crimson) etc.; the ROOT default is olive green. Without this the
  // portaled list + its hover/selected highlight would inherit the ROOT green
  // instead of the scope's crimson. So on open we re-apply the trigger's nearest
  // theme-scope class (+ `dark`) to the portaled list, re-rooting the CSS vars.
  const [scopeClass, setScopeClass] = useState("");
  useEffect(() => {
    if (!open) return;
    const scoped = triggerRef.current?.closest<HTMLElement>(".tokyo, .admin");
    if (!scoped) {
      setScopeClass("");
      return;
    }
    const { classList } = scoped;
    setScopeClass(["tokyo", "admin", "dark"].filter((c) => classList.contains(c)).join(" "));
  }, [open]);

  const selectedOption = options.find((o) => o.value === current);

  // Live filter for `searchable`. When off (or the box is empty) this is the full
  // list, so non-searchable selects behave exactly as before. Keyboard nav + render
  // both index into `visibleOptions`.
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const visibleOptions = useMemo(() => {
    if (!searchable) return options;
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        (o.description?.toLowerCase().includes(q) ?? false) ||
        (o.keywords?.some((k) => k.toLowerCase().includes(q)) ?? false),
    );
  }, [searchable, query, options]);

  const commit = useCallback(
    (next: string) => {
      if (!isControlled) setInternal(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );

  // Position the portaled popover flush under the trigger. Recomputed on
  // open + every scroll/resize so it tracks the trigger even inside a
  // scrolling container.
  const updateCoords = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Cap the popover height to the space below the trigger (min 120px) so
    // it never spills past the viewport bottom; internal overflow-auto keeps
    // every option reachable. No flip-up needed, so the seamless top/bottom
    // rounding stays correct.
    const maxHeight = Math.max(
      120,
      Math.min(288, window.innerHeight - r.bottom - 12),
    );
    // Overlap the trigger's bottom edge by 1px so the popover covers the
    // trigger's (transparent) bottom border — no hairline seam between them.
    setCoords({ left: r.left, top: r.bottom - 1, width: r.width, maxHeight });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateCoords();
    // `true` (capture) catches scrolls in nested scroll containers, not
    // just the window.
    window.addEventListener("scroll", updateCoords, true);
    window.addEventListener("resize", updateCoords);
    return () => {
      window.removeEventListener("scroll", updateCoords, true);
      window.removeEventListener("resize", updateCoords);
    };
  }, [open, updateCoords]);

  // Click-outside closes the popover. The list is portaled (outside
  // `rootRef`), so check both the root AND the list node.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (!rootRef.current?.contains(t) && !listRef.current?.contains(t)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // On OPEN: reset the query, seed the active index to the current value, scroll it
  // into view, and focus the search box when searchable.
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const idx = visibleOptions.findIndex((o) => o.value === current);
    setActiveIndex(idx >= 0 ? idx : 0);
    queueMicrotask(() => {
      if (searchable) searchRef.current?.focus();
      listRef.current
        ?.querySelector<HTMLLIElement>(`[data-active="true"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
    // Only re-run when the popover opens/closes — not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // While filtering, keep the active row on the FIRST match so Enter picks something.
  useEffect(() => {
    if (open && searchable) setActiveIndex(0);
  }, [query, open, searchable]);

  const moveActive = (direction: 1 | -1) => {
    setActiveIndex((cur) => {
      const len = visibleOptions.length;
      if (len === 0) return cur;
      let next = cur;
      for (let i = 0; i < len; i++) {
        next = (next + direction + len) % len;
        if (!visibleOptions[next]?.disabled) return next;
      }
      return cur;
    });
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        break;
      case "Home": {
        e.preventDefault();
        const idx = visibleOptions.findIndex((o) => !o.disabled);
        if (idx >= 0) setActiveIndex(idx);
        break;
      }
      case "End": {
        e.preventDefault();
        for (let i = visibleOptions.length - 1; i >= 0; i--) {
          if (!visibleOptions[i].disabled) {
            setActiveIndex(i);
            break;
          }
        }
        break;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        const opt = visibleOptions[activeIndex];
        if (opt && !opt.disabled) {
          commit(opt.value);
          setOpen(false);
          triggerRef.current?.focus();
        }
        break;
      }
    }
  };

  // Keyboard handling for the search box: navigate the filtered list + pick. The
  // handled keys stopPropagation so they don't ALSO fire the list's onKeyDown
  // (which would double-move / double-select); plain characters bubble to type.
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (["Escape", "ArrowDown", "ArrowUp", "Enter"].includes(e.key)) e.stopPropagation();
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        break;
      case "Enter": {
        e.preventDefault();
        const opt = visibleOptions[activeIndex];
        if (opt && !opt.disabled) {
          commit(opt.value);
          setOpen(false);
          triggerRef.current?.focus();
        }
        break;
      }
    }
  };

  const triggerH = size === "sm" ? "h-10" : "h-11";
  const triggerPad = size === "sm" ? "px-3.5" : "px-4";
  const triggerText = size === "sm" ? "text-[13px]" : "text-sm";

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {label && (
        <label
          htmlFor={`${id}-trigger`}
          className={
            labelClassName ??
            "mb-2 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          }
        >
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </label>
      )}

      {/* Hidden input — drives FormData submission (native-select parity). */}
      {name && (
        <input
          type="hidden"
          name={name}
          value={current}
          data-required={required ? "true" : undefined}
        />
      )}

      <button
        ref={triggerRef}
        id={`${id}-trigger`}
        type="button"
        disabled={disabled}
        aria-label={!label ? ariaLabel : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          "flex w-full items-center justify-between gap-2 border bg-background text-left transition-colors duration-150 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          triggerH,
          triggerPad,
          triggerText,
          // Seamless: when open, flatten the bottom + drop the bottom border
          // so the popover continues the shape below.
          open
            ? "rounded-t-2xl rounded-b-none border-primary/60 border-b-transparent"
            : error
              ? "rounded-2xl border-destructive/60 focus-visible:ring-2 focus-visible:ring-destructive/15"
              : "rounded-2xl border-border hover:border-primary/40 focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/15",
          // Caller override (height/radius) — appended last so twMerge lets it
          // win over the size token, aligning the trigger with sibling inputs.
          triggerClassName,
        )}
      >
        <span
          className={cn(
            "truncate",
            selectedOption ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180 text-primary",
          )}
          strokeWidth={2}
        />
      </button>

      {open &&
        coords &&
        typeof document !== "undefined" &&
        createPortal(
        <ul
          ref={(el) => {
            listRef.current = el;
            // When searchable, focus the search box instead of the list (see effect).
            if (el && !searchable) el.focus();
          }}
          id={`${id}-listbox`}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={
            visibleOptions[activeIndex] ? `${id}-opt-${activeIndex}` : undefined
          }
          onKeyDown={onListKeyDown}
          // Portaled to <body> + fixed-positioned from the trigger rect so
          // it can never be clipped by an `overflow:hidden` ancestor.
          style={{
            left: coords.left,
            top: coords.top,
            width: coords.width,
            maxHeight: coords.maxHeight,
          }}
          className={cn(
            // Re-root the theme vars (see scopeClass above) so the portaled list
            // uses the SAME `--primary`/`--background`/… as the trigger's scope.
            scopeClass,
            // No inner padding: option rows run full-bleed and `overflow`
            // clips them to the rounded-b-2xl corners, so the highlight fills
            // cleanly into the corners (an inner inset would leave white gaps
            // there and break the seamless look). Same bg as the trigger.
            "fixed z-[60] overflow-auto",
            // Flat top (meets the trigger), rounded bottom, no top border so
            // the seam is invisible — trigger + list read as one container.
            "rounded-b-2xl border border-t-transparent border-primary/60 bg-background",
            "shadow-[0_18px_36px_-14px_rgb(0_0_0/0.28)]",
            "duration-150 animate-in fade-in-0 slide-in-from-top-1 focus:outline-none",
          )}
        >
          {searchable && (
            // Sticky filter box — a presentation row so the list still scrolls under it.
            <li role="presentation" className="sticky top-0 z-10 border-b border-border/40 bg-background p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" strokeWidth={1.8} />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onSearchKeyDown}
                  placeholder="Rechercher…"
                  autoComplete="off"
                  aria-label="Filtrer les options"
                  className="h-8 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus-visible:border-primary/60"
                />
              </div>
            </li>
          )}
          {visibleOptions.length === 0 && (
            <li className="px-4 py-2.5 text-xs text-muted-foreground">
              {searchable && query.trim() ? "Aucun résultat." : "Aucune option."}
            </li>
          )}
          {visibleOptions.map((opt, idx) => {
            const isSelected = opt.value === current;
            const isActive = idx === activeIndex;
            return (
              <li
                key={opt.value || `__empty_${idx}`}
                id={`${id}-opt-${idx}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={opt.disabled || undefined}
                data-active={isActive ? "true" : undefined}
                onMouseEnter={() => !opt.disabled && setActiveIndex(idx)}
                onClick={() => {
                  if (opt.disabled) return;
                  commit(opt.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className={cn(
                  // Full-bleed rows — the popover's `overflow` clips the first/
                  // last rows to its rounded corners, so the active highlight
                  // reaches the corners with no white gap.
                  // Warm SOFT highlight (matches the segmented tab pills) rather
                  // than a heavy dark fill: keyboard/hover-active = a light olive
                  // tint, the selected value = a fainter tint + olive label.
                  "flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-sm transition-colors",
                  opt.disabled
                    ? "cursor-not-allowed opacity-40"
                    : isActive
                      ? "bg-primary/[0.14] text-foreground"
                      : isSelected
                        ? "bg-primary/[0.06] text-primary"
                        : "text-foreground hover:bg-surface",
                )}
              >
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "truncate",
                      isSelected || isActive ? "font-semibold" : "font-medium",
                    )}
                  >
                    {opt.label}
                  </p>
                  {opt.description && (
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {opt.description}
                    </p>
                  )}
                </div>
                {isSelected && (
                  <Check className="h-4 w-4 shrink-0 text-primary" strokeWidth={2.5} />
                )}
              </li>
            );
          })}
        </ul>,
          document.body,
        )}

      {error ? (
        <p className="mt-2 text-[11px] leading-relaxed text-destructive">{error}</p>
      ) : helper ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {helper}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Server-friendly NATIVE select — a real `<select>` styled to match the
 * canonical {@link SelectField} pill (same height, radius, border, focus
 * ring and chevron). Use this in **no-JS GET forms** (server components /
 * forms that submit without client JS), e.g. the warranty search page, where
 * the interactive client `SelectField` would be overkill: the native control
 * works without hydration yet looks identical.
 *
 * The browser draws the option list with OS styling (acceptable for these
 * simple GET forms); only the closed trigger is themed. The native arrow is
 * suppressed (`appearance-none`) and a {@link ChevronDown} is overlaid to
 * match the canonical look exactly.
 *
 * Always pass either a wrapping `<label htmlFor>` or `ariaLabel` so the
 * control has an accessible name.
 */
export function NativeSelect({
  name,
  defaultValue,
  options,
  ariaLabel,
  id,
  required,
  disabled,
  size = "md",
  className,
}: {
  name?: string;
  defaultValue?: string;
  options: SelectFieldOption[];
  /** Accessible name when there is no associated visible `<label htmlFor>`. */
  ariaLabel?: string;
  /** Optional id so an external `<label htmlFor>` can target the control. */
  id?: string;
  required?: boolean;
  disabled?: boolean;
  /** `sm` = compact (toolbars); `md` = form inputs. Matches SelectField. */
  size?: Size;
  className?: string;
}) {
  const triggerH = size === "sm" ? "h-10" : "h-11";
  const triggerPad = size === "sm" ? "pl-3.5" : "pl-4";
  const triggerText = size === "sm" ? "text-[13px]" : "text-sm";

  return (
    <div className={cn("relative", className)}>
      <select
        id={id}
        name={name}
        defaultValue={defaultValue}
        required={required}
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn(
          // Mirror the SelectField trigger: same pill chrome + focus ring.
          "w-full cursor-pointer appearance-none truncate rounded-2xl border border-border bg-background text-left text-foreground transition-colors duration-150",
          "hover:border-primary/40 focus:outline-none focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/15",
          "disabled:cursor-not-allowed disabled:opacity-50",
          // Right padding leaves room for the overlaid chevron.
          "pr-10",
          triggerH,
          triggerPad,
          triggerText,
        )}
      >
        {options.map((opt) => (
          <option key={opt.value || "__empty"} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
      {/* Overlaid chevron — matches the SelectField trigger arrow. */}
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        strokeWidth={2}
      />
    </div>
  );
}
