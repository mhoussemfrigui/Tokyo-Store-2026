"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { toggleEmailFlowAction } from "@/lib/actions/mailing";
import { AdminNote } from "@/components/admin/_components/filter-bar";

export type FlowView = {
  key: string;
  label: string;
  description: string;
  trigger: string;
  category: "account" | "commerce" | "marketing";
  enabled: boolean;
};

const CATEGORY_LABEL: Record<FlowView["category"], string> = {
  account: "Compte",
  commerce: "Commerce",
  marketing: "Marketing",
};

export function WorkflowsTab({ flows, canUpdate }: { flows: FlowView[]; canUpdate: boolean }) {
  return (
    <div className="space-y-3">
      <AdminNote>
        Chaque automatisation peut être activée ou désactivée sans redéploiement. Les flux marketing
        respectent le consentement (opt-in) et incluent un lien de désabonnement ; les flux
        transactionnels sont toujours délivrés aux clients concernés.
      </AdminNote>
      {flows.map((f) => (
        <FlowRow key={f.key} flow={f} canUpdate={canUpdate} />
      ))}
    </div>
  );
}

function FlowRow({ flow, canUpdate }: { flow: FlowView; canUpdate: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card p-4 sm:p-5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-bold text-foreground">{flow.label}</p>
          <span className="rounded-full bg-[#f6f2ed] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-[#5b5d62]">
            {CATEGORY_LABEL[flow.category]}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{flow.description}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground/80">Déclencheur : {flow.trigger}</p>
        {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
      </div>
      <button
        type="button"
        disabled={pending || !canUpdate}
        title={canUpdate ? undefined : "Lecture seule — permission « modifier » requise"}
        onClick={() => {
          if (!canUpdate) return;
          setError(null);
          startTransition(async () => {
            const res = await toggleEmailFlowAction({ flowKey: flow.key, enabled: !flow.enabled });
            if (res.ok) router.refresh();
            else setError(res.message);
          });
        }}
        className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11px] font-bold disabled:opacity-60 ${
          flow.enabled
            ? "bg-[#eaf7ee] text-[#15803d]"
            : "bg-[#f6f2ed] text-[#5b5d62]"
        }`}
      >
        {pending && <Loader2 className="h-3 w-3 animate-spin" />}
        {flow.enabled ? "Activé" : "Désactivé"}
      </button>
    </div>
  );
}
