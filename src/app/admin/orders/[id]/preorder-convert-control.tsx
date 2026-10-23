"use client";

import { useState } from "react";
import { CalendarClock, Loader2, PackageCheck } from "lucide-react";

import { convertPreorderOrderAction } from "@/lib/actions/order";
import { useRefreshAction } from "@/hooks/use-refresh-action";

/**
 * Précommande conversion control on the order detail. A preorder order claimed no
 * stock at placement — it RESERVED units. This button is the release step: it
 * consumes those reservations and decrements the real stock for the whole order,
 * then marks it converted (the control disappears once `converted` is true). The
 * two-click confirm guards against an accidental decrement. See
 * `convertPreorderOrderAction`.
 */
export function PreorderConvertControl({
  orderId,
  releasesAt,
}: {
  orderId: string;
  releasesAt: Date | string | null;
}) {
  const { pending, run } = useRefreshAction();
  const [armed, setArmed] = useState(false);

  const release =
    releasesAt == null ? null : typeof releasesAt === "string" ? new Date(releasesAt) : releasesAt;
  const releaseLabel =
    release && !Number.isNaN(release.getTime())
      ? release.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" })
      : null;

  const convert = () =>
    run(async () => {
      const res = await convertPreorderOrderAction(orderId);
      if (!res.ok) {
        setArmed(false);
        return false; // keep the page; a failed convert leaves the order untouched
      }
    });

  return (
    <section className="rounded-[28px] border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="inline-flex items-center gap-2 text-[13px] font-semibold text-amber-700 dark:text-amber-400">
        <CalendarClock className="h-4 w-4" /> Précommande en attente de conversion
      </p>
      <p className="mt-1 mb-3 text-[11px] leading-relaxed text-muted-foreground">
        Aucun stock n&apos;a été décrémenté à la commande : les unités sont réservées.
        {releaseLabel ? ` Sortie prévue le ${releaseLabel}.` : ""} La conversion décrémente le
        stock réel et clôt la précommande.
      </p>
      {armed ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={convert}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-amber-600 bg-amber-600 px-3 text-[11.5px] font-bold text-white transition hover:bg-amber-700 disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}
            Confirmer la conversion
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setArmed(false)}
            className="inline-flex h-9 items-center rounded-full border-[1.5px] border-input bg-card px-3 text-[11.5px] font-semibold text-muted-foreground transition hover:bg-surface disabled:opacity-60"
          >
            Annuler
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => setArmed(true)}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-amber-600/50 bg-card px-3 text-[11.5px] font-bold text-amber-700 transition hover:bg-amber-500/10 disabled:opacity-60 dark:text-amber-400"
        >
          <PackageCheck className="h-3.5 w-3.5" />
          Convertir la précommande
        </button>
      )}
    </section>
  );
}
