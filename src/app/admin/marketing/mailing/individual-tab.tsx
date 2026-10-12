"use client";

import { useRef, useState, useTransition } from "react";
import { Info, Loader2, Send } from "lucide-react";

import { sendIndividualEmailAction } from "@/lib/actions/mailing";
import { type ActionState } from "@/lib/actions/types";
import { AdminNote, AdminCallout } from "@/components/admin/_components/filter-bar";

const inputCls =
  "mt-1 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[15px] focus:outline-none focus:border-foreground focus:bg-white";

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[13px] font-bold text-foreground">
      {children}
    </span>
  );
}

/**
 * Direct 1:1 send — « rédigez et envoyez » to a single address. A deliberate
 * manual message (category "account"): always delivered to the intended person
 * (NOT marketing-consent gated), but refused for a hard-suppressed address
 * (bounce / complaint). Routed through the central dispatch chokepoint, so it is
 * brand-wrapped and logged in the Journaux like every other send.
 */
export function IndividualTab({ canCreate }: { canCreate: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<ActionState | null>(null);
  const [sending, startSend] = useTransition();

  if (!canCreate) {
    return (
      <AdminCallout tone="info" icon={Info}>
        Vous avez un accès en lecture seule. L&apos;envoi d&apos;un email nécessite la permission
        « créer » (system_mail).
      </AdminCallout>
    );
  }

  return (
    <div className="space-y-5">
      <AdminNote>
        Rédigez un email et envoyez-le immédiatement à une seule adresse. Message direct (type
        transactionnel) : il est habillé du logo et du pied de page Tokyo Store, part tout de
        suite et est enregistré dans les Journaux. Il n&apos;est pas soumis au consentement marketing
        (c&apos;est un message 1-à-1), mais une adresse en liste de suppression (rebond / plainte) est
        refusée.
      </AdminNote>
      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          setState(null);
          startSend(async () => {
            const res = await sendIndividualEmailAction(null, fd);
            setState(res);
            if (res.ok) formRef.current?.reset();
          });
        }}
        className="space-y-4 rounded-[28px] border border-border bg-card p-5 sm:p-6"
      >
        <label className="block">
          <Label>Destinataire</Label>
          <input name="to" type="email" required placeholder="client@example.tn" className={inputCls} />
        </label>
        <label className="block">
          <Label>Objet</Label>
          <input name="subject" required placeholder="À propos de votre commande" className={inputCls} />
        </label>
        <div>
          <Label>Corps (HTML)</Label>
          <textarea
            name="body"
            rows={10}
            required
            spellCheck={false}
            placeholder="<p>Bonjour,</p><p>…</p>"
            className="mt-1 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] p-3 font-mono text-[12px] leading-relaxed focus:outline-none focus:border-foreground focus:bg-white"
          />
          <AdminNote className="mt-1">
            Votre HTML est habillé automatiquement du logo et du pied de page. Aucune variable
            personnalisée (prénom, etc.) n&apos;est disponible.
          </AdminNote>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={sending}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Envoyer
          </button>
          {state?.message && (
            <span
              className={`text-xs font-medium ${state.ok ? "text-[#15803d]" : "text-destructive"}`}
            >
              {state.message}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
