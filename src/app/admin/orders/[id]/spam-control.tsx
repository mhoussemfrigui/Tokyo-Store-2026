"use client";

import { Loader2, ShieldAlert, ShieldCheck } from "lucide-react";

import { setOrderSpamAction } from "@/lib/actions/order";
import { useRefreshAction } from "@/hooks/use-refresh-action";

/**
 * Spam-triage control on the order detail. A flagged order shows a banner + a
 * « Retirer du spam » restore; an unflagged one shows a quiet « Marquer comme
 * spam » action. Flagging is non-destructive (it only hides the order from the
 * default list + the « À traiter » queue) — cancellation stays a separate step.
 */
export function SpamControl({ orderId, flaggedSpam }: { orderId: string; flaggedSpam: boolean }) {
  const { pending, run } = useRefreshAction();
  const toggle = (spam: boolean) =>
    run(async () => {
      const res = await setOrderSpamAction(orderId, spam);
      if (!res.ok) return false; // keep the page; the action revalidates on success
    });

  if (flaggedSpam) {
    return (
      <section className="rounded-[28px] border border-destructive/30 bg-destructive/5 p-4">
        <p className="inline-flex items-center gap-2 text-[13px] font-semibold text-destructive">
          <ShieldAlert className="h-4 w-4" /> Commande marquée comme spam
        </p>
        <p className="mt-1 mb-3 text-[11px] leading-relaxed text-muted-foreground">
          Elle est masquée de la liste des commandes et de la file « À traiter ». Vous pouvez la
          restaurer, ou l&apos;annuler depuis les actions ci-dessus.
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() => toggle(false)}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[11.5px] font-bold text-foreground transition hover:bg-surface disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          Retirer du spam
        </button>
      </section>
    );
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => toggle(true)}
      className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[11.5px] font-semibold text-muted-foreground transition hover:border-destructive/40 hover:text-destructive disabled:opacity-60"
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="h-3.5 w-3.5" />}
      Marquer comme spam
    </button>
  );
}
