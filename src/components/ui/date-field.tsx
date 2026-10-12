"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronLeft, ChevronRight, X } from "lucide-react";

import {
  MONTHS,
  MONTHS_SHORT,
  WEEKDAYS,
  daysInMonth,
  formatYmd,
  mondayIdx,
  parseYmd,
  toYmd,
  todayYmd,
} from "./calendar-core";

// Re-exported so existing `import { todayYmd } from "@/components/ui/date-field"` callers
// keep working now that the date math lives in the shared calendar-core module.
export { todayYmd };

/**
 * Designed date picker — a styled trigger + a calendar popover (no external
 * dependency), matching the SelectField look. Works controlled (`value`/`onChange`)
 * or as a form field (`name` renders a hidden input carrying the YYYY-MM-DD value).
 * Dates are plain 'YYYY-MM-DD' strings (no time/zone) — the same shape the birthday /
 * date columns store — so there's no TZ drift. `min`/`max` bound the selectable range.
 *
 * ── Three-tier navigation (fast year jumps) ──────────────────────────────
 * The header title is a button that ESCALATES the view: days → months → years.
 * The prev/next arrows then step by the current unit — one month in day view,
 * one year in month view, one decade in year view. So reaching a birth year is
 * two clicks (title → title) + a decade page or two, not dozens of month steps.
 * Picking a year drops to the month grid for that year; picking a month drops to
 * that month's days; picking a day commits. Opening always starts on the days view.
 *
 * ── Portaled popover (no clipping) ───────────────────────────────────────
 * The calendar is rendered through a PORTAL to `document.body` and positioned
 * with `position: fixed` from the trigger's bounding rect — the same escape
 * hatch SelectField uses. This matters because the app sets `overflow-x: clip`
 * on <body> (globals.css): an in-flow `absolute` popover 272px wide would get
 * clipped whenever the trigger sits in the right half of a narrow viewport
 * (e.g. the two-up admin Profil grid on mobile), making the rightmost day
 * columns unreachable. The fixed popover is CLAMPED to the viewport width and
 * flips above the trigger when there isn't room below.
 */

const POPOVER_WIDTH = 272; // w-[17rem]
const POPOVER_MAX_HEIGHT = 340; // day view ≈ tallest; used only for the flip decision

type View = "days" | "months" | "years";

export function DateField({
  name,
  value,
  defaultValue,
  onChange,
  min,
  max,
  ariaLabel,
  placeholder = "Choisir une date",
  disabled,
  className,
  triggerClassName,
}: {
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  min?: string;
  max?: string;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
}) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState(defaultValue ?? "");
  const current = controlled ? (value ?? "") : inner;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("days");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const id = useId();

  // The month/year the calendar is showing (defaults to the selected value, else today).
  const initialView = parseYmd(current);
  const [view0, setView0] = useState(() => {
    const now = new Date();
    return initialView ? { y: initialView.y, m: initialView.m } : { y: now.getFullYear(), m: now.getMonth() };
  });

  // Fixed-position coords for the portaled popover, clamped to the viewport.
  const [coords, setCoords] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const updateCoords = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    let left = r.left;
    if (left + POPOVER_WIDTH > window.innerWidth - margin) left = window.innerWidth - margin - POPOVER_WIDTH;
    if (left < margin) left = margin;
    const belowSpace = window.innerHeight - r.bottom;
    const above = belowSpace < POPOVER_MAX_HEIGHT && r.top > belowSpace;
    const top = above ? r.top - 6 : r.bottom + 6;
    setCoords({ left, top, above });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateCoords();
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (!rootRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", updateCoords, true);
    window.addEventListener("resize", updateCoords);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", updateCoords, true);
      window.removeEventListener("resize", updateCoords);
    };
  }, [open, updateCoords]);

  const set = (v: string) => {
    if (!controlled) setInner(v);
    onChange?.(v);
    setOpen(false);
  };

  const openCalendar = () => {
    if (disabled) return;
    const p = parseYmd(current);
    const now = new Date();
    setView0(p ? { y: p.y, m: p.m } : { y: now.getFullYear(), m: now.getMonth() });
    setView("days"); // always land on the day grid
    setOpen((o) => !o);
  };

  const grid = useMemo(() => {
    const first = new Date(Date.UTC(view0.y, view0.m, 1));
    const lead = mondayIdx(first.getUTCDay());
    const dim = daysInMonth(view0.y, view0.m);
    const cells: Array<number | null> = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= dim; d++) cells.push(d);
    return cells;
  }, [view0]);

  const selected = parseYmd(current);

  // ── Range gating per unit ──
  const dayDisabled = (d: number) => {
    const ymd = toYmd(view0.y, view0.m, d);
    return (!!min && ymd < min) || (!!max && ymd > max);
  };
  const monthDisabled = (m: number) => {
    const first = toYmd(view0.y, m, 1);
    const last = toYmd(view0.y, m, daysInMonth(view0.y, m));
    return (!!min && last < min) || (!!max && first > max);
  };
  const yearDisabled = (y: number) => {
    return (!!min && `${y}-12-31` < min) || (!!max && `${y}-01-01` > max);
  };

  // Year grid: a 12-year page framing the current year's decade.
  const decadeStart = Math.floor(view0.y / 10) * 10;
  const years = useMemo(
    () => Array.from({ length: 12 }, (_, i) => decadeStart - 1 + i),
    [decadeStart],
  );

  // ── Prev/Next step by the active unit ──
  const step = (dir: 1 | -1) => {
    if (view === "days") {
      setView0((v) => {
        const m = v.m + dir;
        if (m < 0) return { y: v.y - 1, m: 11 };
        if (m > 11) return { y: v.y + 1, m: 0 };
        return { y: v.y, m };
      });
    } else if (view === "months") {
      setView0((v) => ({ ...v, y: v.y + dir }));
    } else {
      setView0((v) => ({ ...v, y: v.y + dir * 10 }));
    }
  };

  const headerLabel =
    view === "days"
      ? `${MONTHS[view0.m]} ${view0.y}`
      : view === "months"
        ? `${view0.y}`
        : `${decadeStart}–${decadeStart + 9}`;
  const prevLabel = view === "days" ? "Mois précédent" : view === "months" ? "Année précédente" : "Décennie précédente";
  const nextLabel = view === "days" ? "Mois suivant" : view === "months" ? "Année suivante" : "Décennie suivante";

  const cellBtn = "h-8 rounded-lg text-[12px] tabular-nums transition";

  return (
    <div ref={rootRef} className={`relative ${className ?? ""}`}>
      {name && <input type="hidden" name={name} value={current} />}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openCalendar}
        className={
          triggerClassName ??
          "flex h-10 w-full items-center gap-2 rounded-xl border border-border bg-background px-3 text-left text-sm text-foreground transition focus:outline-none focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/15 disabled:opacity-60"
        }
      >
        <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className={`flex-1 truncate ${current ? "" : "text-muted-foreground"}`}>
          {current ? formatYmd(current) : placeholder}
        </span>
        {current && !disabled && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="Effacer la date"
            onClick={(e) => {
              e.stopPropagation();
              set("");
            }}
            className="grid h-5 w-5 place-items-center rounded-full text-muted-foreground hover:bg-surface hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        )}
      </button>

      {open &&
        coords &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label={ariaLabel ?? "Calendrier"}
            style={{
              left: coords.left,
              top: coords.top,
              width: POPOVER_WIDTH,
              transform: coords.above ? "translateY(-100%)" : undefined,
            }}
            className="fixed z-[60] rounded-2xl border border-border bg-card p-3 shadow-lg"
          >
            <div className="mb-2 flex items-center justify-between">
              <button type="button" onClick={() => step(-1)} aria-label={prevLabel} className="grid h-7 w-7 place-items-center rounded-full hover:bg-surface">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setView((v) => (v === "days" ? "months" : "years"))}
                aria-label="Changer de vue (mois / année)"
                className="rounded-lg px-2 py-1 text-[13px] font-semibold capitalize text-foreground hover:bg-surface"
              >
                {headerLabel}
              </button>
              <button type="button" onClick={() => step(1)} aria-label={nextLabel} className="grid h-7 w-7 place-items-center rounded-full hover:bg-surface">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            {view === "days" && (
              <div className="grid grid-cols-7 gap-0.5 text-center">
                {WEEKDAYS.map((w) => (
                  <span key={w} className="py-1 text-[10px] font-semibold uppercase text-muted-foreground">{w}</span>
                ))}
                {grid.map((d, i) => {
                  if (d === null) return <span key={`${id}-b${i}`} />;
                  const isSel = !!selected && selected.y === view0.y && selected.m === view0.m && selected.d === d;
                  const off = dayDisabled(d);
                  return (
                    <button
                      key={`${id}-d${d}`}
                      type="button"
                      disabled={off}
                      onClick={() => set(toYmd(view0.y, view0.m, d))}
                      className={`${cellBtn} ${
                        isSel
                          ? "bg-foreground font-semibold text-background"
                          : off
                            ? "cursor-not-allowed text-muted-foreground/40"
                            : "text-foreground hover:bg-surface"
                      }`}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            )}

            {view === "months" && (
              <div className="grid grid-cols-3 gap-1 text-center">
                {MONTHS_SHORT.map((label, m) => {
                  const isSel = !!selected && selected.y === view0.y && selected.m === m;
                  const off = monthDisabled(m);
                  return (
                    <button
                      key={`${id}-m${m}`}
                      type="button"
                      disabled={off}
                      onClick={() => {
                        setView0((v) => ({ ...v, m }));
                        setView("days");
                      }}
                      className={`h-10 rounded-lg text-[12px] capitalize transition ${
                        isSel
                          ? "bg-foreground font-semibold text-background"
                          : off
                            ? "cursor-not-allowed text-muted-foreground/40"
                            : "text-foreground hover:bg-surface"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}

            {view === "years" && (
              <div className="grid grid-cols-3 gap-1 text-center">
                {years.map((y) => {
                  const isSel = !!selected && selected.y === y;
                  const off = yearDisabled(y);
                  const outside = y < decadeStart || y > decadeStart + 9;
                  return (
                    <button
                      key={`${id}-y${y}`}
                      type="button"
                      disabled={off}
                      onClick={() => {
                        setView0((v) => ({ ...v, y }));
                        setView("months");
                      }}
                      className={`h-10 rounded-lg text-[12px] tabular-nums transition ${
                        isSel
                          ? "bg-foreground font-semibold text-background"
                          : off
                            ? "cursor-not-allowed text-muted-foreground/40"
                            : outside
                              ? "text-muted-foreground/50 hover:bg-surface"
                              : "text-foreground hover:bg-surface"
                      }`}
                    >
                      {y}
                    </button>
                  );
                })}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
