"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";

import { setOauthAutolinkAction } from "@/lib/actions/auth";

/**
 * Per-user OAuth auto-link toggle (Profil → security, next to 2FA).
 *
 * ON (default since migration 0157) = a Google sign-in whose verified email
 * matches this account may link to — and log you into — it. OFF = that Google
 * sign-in will NOT silently link onto your account; you must sign in with your
 * password. Either way, the `account.create.before` + `session.create.before`
 * gates in lib/auth/server.ts ALWAYS refuse the silent social link/sign-in for an
 * account with 2FA enabled (a second factor is never bypassed), so the ON default
 * is safe — 2FA is not guarded by this flag. Backed by `users.oauth_autolink`.
 */
export function OAuthAutolinkCard({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next); // optimistic
    setErr(null);
    startTransition(async () => {
      const res = await setOauthAutolinkAction(next).catch(() => null);
      if (!res?.ok) {
        setEnabled(!next); // revert on failure
        setErr("Échec de l'enregistrement. Réessayez.");
      }
    });
  };

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm text-foreground">Connexion Google automatique</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
          {enabled
            ? "Une connexion Google avec votre e-mail est autorisée à se lier à ce compte et à vous connecter."
            : "Par sécurité, une connexion Google avec votre e-mail ne se liera pas automatiquement à ce compte. Activez pour lier votre compte Google."}
        </p>
        {err && <p className="mt-1 text-[12px] text-destructive">{err}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Connexion Google automatique"
        disabled={pending}
        onClick={toggle}
        className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${
          enabled ? "bg-primary" : "bg-muted-foreground/30"
        }`}
      >
        <span
          className={`inline-flex h-5 w-5 items-center justify-center rounded-full bg-background shadow transition-transform ${
            enabled ? "translate-x-5" : "translate-x-0.5"
          }`}
        >
          {pending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </span>
      </button>
    </div>
  );
}
