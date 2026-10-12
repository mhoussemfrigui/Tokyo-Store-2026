"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { linkGuestOrderAction } from "@/lib/actions/order";

export type GuestLinkCandidate = {
  userId: string;
  name: string;
  email: string;
  profilePhone: string | null;
  /** The order's contact phone matches the account's profile phone — a
   *  confidence signal for the operator. */
  phoneMatches: boolean;
};

/**
 * « Lier à un client » on a GUEST order (`user_id IS NULL`) — one row per
 * candidate account. Calls `linkGuestOrderAction` directly and SHOWS its outcome:
 * a refusal (another operator or the customer's own sign-up claimed the order
 * first → « déjà rattachée », an invalid account…) used to be swallowed by a
 * void form adapter, so the click just did nothing visible. The buttons are
 * disabled while a link is in flight; on success the page refreshes into the
 * linked-customer card.
 */
export function GuestOrderLink({
  orderId,
  candidates,
}: {
  orderId: string;
  candidates: GuestLinkCandidate[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const link = (userId: string) => {
    setMsg(null);
    setLinkingId(userId);
    start(async () => {
      const res = await linkGuestOrderAction(orderId, userId).catch(() => null);
      setLinkingId(null);
      if (!res) {
        setMsg({ ok: false, text: "Liaison impossible — réessayez." });
        return;
      }
      setMsg({
        ok: res.ok,
        text: res.message ?? (res.ok ? "Commande rattachée au compte client." : "Erreur."),
      });
      if (res.ok) router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <p className="text-[13px] font-bold text-foreground">Lier à un client</p>
      {candidates.map((c) => (
        <div
          key={c.userId}
          className="flex items-center justify-between gap-2 rounded-[14px] border border-border bg-surface/40 p-2.5"
        >
          <div className="min-w-0">
            <p className="truncate text-[12px] font-medium text-foreground">{c.name}</p>
            <p className="truncate text-[11px] text-muted-foreground">{c.email}</p>
            {c.profilePhone && (
              <p className="text-[11px] text-muted-foreground">
                {c.profilePhone}
                {c.phoneMatches ? " · téléphone concordant" : ""}
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() => link(c.userId)}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-primary px-3 text-[11px] font-bold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
          >
            {linkingId === c.userId && <Loader2 className="h-3 w-3 animate-spin" />}
            Lier
          </button>
        </div>
      ))}
      {msg && (
        <p role="status" className={`text-[11px] ${msg.ok ? "text-primary" : "text-destructive"}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
