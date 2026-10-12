"use client";

import { useState, useTransition } from "react";
import { Loader2, Megaphone } from "lucide-react";

import { announcePromotionNowAction } from "@/lib/actions/promotion";

/**
 * « Annoncer maintenant » — fires the promotion's email announcement on demand.
 * Confirms first (it emails customers). The per-recipient `mailing_sends` dedup means
 * anyone already emailed for this promo is skipped, so a second click is safe.
 * `alreadyAnnounced` just tweaks the label (« Annoncer à nouveau »).
 */
export function AnnounceNowButton({
  promotionId,
  alreadyAnnounced,
}: {
  promotionId: string;
  alreadyAnnounced: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (
            !window.confirm(
              alreadyAnnounced
                ? "Ré-annoncer cette promotion par email ? Les clients déjà notifiés ne seront pas recontactés."
                : "Annoncer cette promotion par email à son audience (clients opt-in / ciblés) ?",
            )
          )
            return;
          startTransition(async () => {
            setMsg(null);
            try {
              const res = await announcePromotionNowAction(promotionId);
              setMsg({ ok: res.ok, text: res.ok ? res.message ?? "Annonce lancée." : res.message });
            } catch {
              setMsg({ ok: false, text: "L'annonce n'a pas pu être lancée." });
            }
          });
        }}
        className="inline-flex h-11 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground transition hover:bg-surface disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Megaphone className="h-3.5 w-3.5" />}
        {alreadyAnnounced ? "Annoncer à nouveau" : "Annoncer maintenant"}
      </button>
      {msg && (
        <p className={`text-[11px] font-medium ${msg.ok ? "text-[#15803d]" : "text-destructive"}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
