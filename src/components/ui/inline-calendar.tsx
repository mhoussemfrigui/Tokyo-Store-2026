"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import {
  MONTHS,
  WEEKDAYS,
  daysInMonth,
  monthGridCells,
  parseYmd,
  toYmd,
  todayYmd,
} from "./calendar-core";

/**
 * Always-visible month calendar (no popover) — the embedded "pick a day" panel
 * for the rendez-vous booking flow. Days-only (near-term booking never needs the
 * year/month jump views the popover `DateField` carries); prev/next step by month
 * and are bounded by `min`/`max`. Monday-first, French. Dates are 'YYYY-MM-DD'
 * strings (local frame) — shared math in ./calendar-core, no TZ drift.
 */
export function InlineCalendar({
  value,
  onChange,
  min,
  max,
  className,
}: {
  value: string;
  onChange: (ymd: string) => void;
  min?: string;
  max?: string;
  className?: string;
}) {
  const selected = parseYmd(value);
  const today = todayYmd();

  // The month in view: the selected date's month, else the min bound's, else today.
  const [view, setView] = useState(() => {
    const base = selected ?? parseYmd(min ?? "") ?? parseYmd(today)!;
    return { y: base.y, m: base.m };
  });

  const cells = useMemo(() => monthGridCells(view.y, view.m), [view]);

  const dayDisabled = (d: number) => {
    const ymd = toYmd(view.y, view.m, d);
    return (!!min && ymd < min) || (!!max && ymd > max);
  };

  // Disable paging into a month that lies entirely outside the [min, max] range.
  const prevMonth = view.m === 0 ? { y: view.y - 1, m: 11 } : { y: view.y, m: view.m - 1 };
  const nextMonth = view.m === 11 ? { y: view.y + 1, m: 0 } : { y: view.y, m: view.m + 1 };
  const prevDisabled =
    !!min && toYmd(prevMonth.y, prevMonth.m, daysInMonth(prevMonth.y, prevMonth.m)) < min;
  const nextDisabled = !!max && toYmd(nextMonth.y, nextMonth.m, 1) > max;

  const step = (dir: 1 | -1) => setView(dir === -1 ? prevMonth : nextMonth);

  return (
    <div className={`rounded-2xl border border-border bg-background p-3 sm:p-4 ${className ?? ""}`}>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={prevDisabled}
          aria-label="Mois précédent"
          className="grid h-8 w-8 place-items-center rounded-full text-foreground transition hover:bg-surface disabled:cursor-not-allowed disabled:opacity-30"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="font-serif text-sm font-medium capitalize text-foreground">
          {MONTHS[view.m]} {view.y}
        </span>
        <button
          type="button"
          onClick={() => step(1)}
          disabled={nextDisabled}
          aria-label="Mois suivant"
          className="grid h-8 w-8 place-items-center rounded-full text-foreground transition hover:bg-surface disabled:cursor-not-allowed disabled:opacity-30"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((w) => (
          <span key={w} className="py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {w}
          </span>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <span key={`b${i}`} aria-hidden />;
          const ymd = toYmd(view.y, view.m, d);
          const isSel = !!selected && selected.y === view.y && selected.m === view.m && selected.d === d;
          const isToday = ymd === today;
          const off = dayDisabled(d);
          return (
            <button
              key={ymd}
              type="button"
              disabled={off}
              aria-pressed={isSel}
              aria-label={`${d} ${MONTHS[view.m]} ${view.y}`}
              onClick={() => onChange(ymd)}
              className={`grid aspect-square place-items-center rounded-xl text-sm tabular-nums transition ${
                isSel
                  ? "bg-foreground font-semibold text-background"
                  : off
                    ? "cursor-not-allowed text-muted-foreground/30"
                    : isToday
                      ? "text-foreground ring-1 ring-inset ring-foreground/25 hover:bg-surface"
                      : "text-foreground hover:bg-surface"
              }`}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}
