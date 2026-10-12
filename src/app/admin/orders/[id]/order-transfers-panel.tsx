import Link from "next/link";
import { ArrowLeftRight, ArrowRight } from "lucide-react";

import type { TransferListItem } from "@/modules/stock-transfer";
import type { TransferStatus } from "@/modules/stock-transfer/schema";
import { TRANSFER_STATUS_META } from "@/modules/stock-transfer/status-meta";

/**
 * Read-only view of the stock TRANSFERS linked to an order (from the auto-request
 * on placement). Shows each transfer's ref, route + status; the operator manages
 * them from the Transferts tab (linked). Renders nothing when there are none —
 * so it's invisible for a single-pool store / order with no transfers.
 */
export function OrderTransfersPanel({ transfers }: { transfers: TransferListItem[] }) {
  if (transfers.length === 0) return null;
  return (
    <section className="rounded-[28px] border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border px-6 py-5">
        <ArrowLeftRight className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-[16px] font-black tracking-[-0.02em] text-foreground">Transferts liés</span>
        <span className="text-xs text-muted-foreground">· {transfers.length}</span>
      </div>
      <ul className="divide-y divide-border">
        {transfers.map((t) => {
          const s = TRANSFER_STATUS_META[t.status as TransferStatus] ?? TRANSFER_STATUS_META.requested;
          return (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-6 py-3.5 text-sm">
              <span className="font-mono text-xs font-semibold text-foreground">TR-{t.ref}</span>
              <span className="flex min-w-0 flex-1 items-center gap-2 text-foreground">
                <span className="truncate">{t.fromName ?? "—"}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{t.toName ?? "—"}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {t.itemCount} art. · {t.totalQty} u.
              </span>
              <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${s.cls}`}>
                {s.label}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-border px-6 py-3">
        <Link
          href="/admin/catalog/stock?tab=transferts"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          Gérer les transferts <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </section>
  );
}
