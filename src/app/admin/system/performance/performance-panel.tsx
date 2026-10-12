"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

/** One event counter row (event name → count). */
export type CountRow = { name: string; count: number };

type SortKey = "name" | "count";
type SortDir = "asc" | "desc";

/**
 * Sortable in-memory event-counter table. Pure client-side sort over the
 * snapshot the server already computed — no refetching, no mutation. Defaults
 * to count-descending (the "what fires most" view).
 */
export function MetricsCountsTable({ rows }: { rows: CountRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("count");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      let cmp: number;
      if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else cmp = a.count - b.count;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function toggle(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Sensible default per column: names ascending, counts descending.
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-[16px] border border-dashed border-border bg-surface/40 p-4 text-center text-xs text-muted-foreground">
        Aucun événement compté depuis le dernier redémarrage.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-[22px] border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-[#fbf9f8] text-left">
            <Th label="Événement" active={sortKey === "name"} dir={sortDir} onClick={() => toggle("name")} />
            <Th
              label="Occurrences"
              align="right"
              active={sortKey === "count"}
              dir={sortDir}
              onClick={() => toggle("count")}
            />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((row) => (
            <tr key={row.name} className="transition hover:bg-[#fffbfb]">
              <td className="px-4 py-2.5 font-medium text-foreground">
                <span className="font-mono text-xs">{row.name}</span>
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
                {row.count.toLocaleString("fr-FR")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  label,
  align = "left",
  active,
  dir,
  onClick,
}: {
  label: string;
  align?: "left" | "right";
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <th
      className={`px-4 py-2.5 text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f] ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 transition hover:text-foreground ${
          active ? "text-foreground" : ""
        } ${align === "right" ? "flex-row-reverse" : ""}`}
      >
        {label}
        {active &&
          (dir === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          ))}
      </button>
    </th>
  );
}
