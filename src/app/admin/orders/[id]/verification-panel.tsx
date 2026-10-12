"use client";

import { useState, useTransition } from "react";
import { ClipboardCheck, Loader2 } from "lucide-react";

import { toggleOrderLinePickedAction } from "@/lib/actions/order";

export type VerificationLine = {
  orderItemId: string;
  productName: string;
  quantity: number;
  picked: boolean;
};

/**
 * Operator preparation panel — the per-line pick/pack checklist an operator
 * ticks off while getting an order ready to ship. Advisory only (it does not
 * gate the "shipped" transition). Shown while shipping is still ahead.
 *
 * The ticks are optimistic local state, RESEEDED from the server lines whenever
 * the line set changes (a line added / removed / re-quantified in the editor —
 * the tab stays mounted across that refresh). A refused toggle rolls its tick
 * back and says why instead of looking saved.
 */
export function VerificationPanel({
  orderId,
  lines: initial,
}: {
  orderId: string;
  lines: VerificationLine[];
}) {
  const [lines, setLines] = useState(initial);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  // Adjust-state-on-prop-change: reseed when the server's line set differs from
  // the one this state was seeded from (picks are owned by the optimistic state).
  const linesSig = initial.map((l) => `${l.orderItemId}:${l.quantity}`).join(",");
  const [seededSig, setSeededSig] = useState(linesSig);
  if (seededSig !== linesSig) {
    setSeededSig(linesSig);
    setLines(initial);
  }

  const pickedCount = lines.filter((l) => l.picked).length;

  const toggle = (line: VerificationLine) => {
    const next = !line.picked;
    setError(null);
    setPendingId(line.orderItemId);
    setLines((s) => s.map((l) => (l.orderItemId === line.orderItemId ? { ...l, picked: next } : l)));
    start(async () => {
      const res = await toggleOrderLinePickedAction(line.orderItemId, orderId, next).catch(() => null);
      if (!res?.ok) {
        // Roll the optimistic tick back — the stamp wasn't saved.
        setLines((s) =>
          s.map((l) => (l.orderItemId === line.orderItemId ? { ...l, picked: !next } : l)),
        );
        setError(res?.message ?? "Enregistrement impossible — réessayez.");
      }
      setPendingId(null);
    });
  };

  return (
    <section className="rounded-[28px] border border-border bg-card p-4">
      <h2 className="mb-3 inline-flex items-center gap-2 text-[18px] font-black tracking-[-0.02em] text-foreground">
        <ClipboardCheck className="h-4 w-4" /> Préparation
      </h2>

      <p className="mb-2 text-[12px] font-bold text-muted-foreground">
        Checklist de préparation ({pickedCount}/{lines.length})
      </p>
      <ul className="space-y-1.5">
        {lines.map((l) => (
          <li
            key={l.orderItemId}
            className="flex flex-wrap items-center gap-2 rounded-[14px] border border-input bg-[#fbf9f8] px-3 py-2"
          >
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <input
                type="checkbox"
                checked={l.picked}
                disabled={pendingId === l.orderItemId}
                onChange={() => toggle(l)}
                className="h-4 w-4 accent-[var(--primary)]"
              />
              <span className="min-w-0 truncate text-sm text-foreground">
                {l.productName} <span className="text-muted-foreground">× {l.quantity}</span>
              </span>
              {pendingId === l.orderItemId && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
            </label>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-2 text-[11px] text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
