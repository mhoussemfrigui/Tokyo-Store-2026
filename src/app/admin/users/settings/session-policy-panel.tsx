"use client";

import { useActionState } from "react";
import { Clock, Loader2, ShieldCheck } from "lucide-react";

import { saveSessionPolicyAction } from "@/lib/actions/session-policy";
import { SESSION_POLICY_BOUNDS } from "@/lib/auth/policy";
import { type ActionState } from "@/lib/actions/types";

type Current = {
  expiresDays: number;
  updateAgeDays: number;
  cookieCacheMinutes: number;
};

/**
 * Admin-tunable session policy (Utilisateurs → Réglages). Applies to
 * EVERY account — customers and staff/admins alike. The cookie-cache field is
 * the one the owner wanted raised (the 5-min default was too low); higher = fewer
 * DB reads, at the cost of a longer force-logout latency (a disable still cuts
 * access immediately, since the request gates re-fetch the user row live).
 */
export function SessionPolicyPanel({ current }: { current: Current }) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(
    saveSessionPolicyAction,
    null,
  );
  const B = SESSION_POLICY_BOUNDS;

  return (
    <section className="rounded-[28px] border border-border bg-card p-5 sm:p-6">
      <h2 className="inline-flex items-center gap-2 text-[18px] font-black text-foreground">
        <Clock className="h-4 w-4" /> Sessions &amp; sécurité
      </h2>
      <p className="mt-1 text-[14px] text-muted-foreground">
        Durée de connexion des comptes (clients comme staff/admin). S&apos;applique
        au prochain chargement, sans redéploiement.
      </p>

      {state?.ok && (
        <p
          role="status"
          className="mt-3 rounded-[14px] border border-primary/30 bg-primary/5 px-4 py-2.5 text-[14px] text-primary"
        >
          {state.message}
        </p>
      )}
      {state && !state.ok && (
        <p
          role="alert"
          className="mt-3 rounded-[14px] border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-[14px] text-destructive"
        >
          {state.message}
        </p>
      )}

      <form action={action} className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field
          name="expiresDays"
          label="Durée de vie (jours)"
          defaultValue={current.expiresDays}
          min={B.expiresDays.min}
          max={B.expiresDays.max}
          helper={`Déconnexion auto après inactivité. ${B.expiresDays.min}–${B.expiresDays.max} j (défaut ${B.expiresDays.def}).`}
        />
        <Field
          name="updateAgeDays"
          label="Renouvellement (jours)"
          defaultValue={current.updateAgeDays}
          min={B.updateAgeDays.min}
          max={B.updateAgeDays.max}
          helper={`Fréquence de prolongation de la session active. ${B.updateAgeDays.min}–${B.updateAgeDays.max} j (défaut ${B.updateAgeDays.def}).`}
        />
        <Field
          name="cookieCacheMinutes"
          label="Cache cookie (minutes)"
          defaultValue={current.cookieCacheMinutes}
          min={B.cookieCacheMinutes.min}
          max={B.cookieCacheMinutes.max}
          helper={`Moins de lectures DB ; 0 = désactivé. ${B.cookieCacheMinutes.min}–${B.cookieCacheMinutes.max} min (défaut ${B.cookieCacheMinutes.def}).`}
        />
        <div className="sm:col-span-3 flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Enregistrer
          </button>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Une désactivation/changement de rôle reste appliqué immédiatement ; le
            cache n&apos;affecte que le délai d&apos;une déconnexion forcée.
          </p>
        </div>
      </form>
    </section>
  );
}

function Field({
  name,
  label,
  defaultValue,
  min,
  max,
  helper,
}: {
  name: string;
  label: string;
  defaultValue: number;
  min: number;
  max: number;
  helper: string;
}) {
  const id = `session-${name}`;
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-2 block text-[13px] font-bold text-foreground"
      >
        {label}
      </label>
      <input
        id={id}
        name={name}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        defaultValue={defaultValue}
        autoComplete="off"
        className="h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] tabular-nums text-foreground focus:border-foreground focus:bg-white focus:outline-none"
      />
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{helper}</p>
    </div>
  );
}
