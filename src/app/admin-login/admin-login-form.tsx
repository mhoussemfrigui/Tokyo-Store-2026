"use client";

import { useActionState } from "react";
import Image from "next/image";
import { Lock, Mail } from "lucide-react";

import logo from "@/assets/logo-black.png";
import { AuthField, AuthPasswordField } from "@/components/auth/fields";
import { signinAction } from "@/lib/actions/auth";
import { type ActionState } from "@/lib/actions/types";

/**
 * Staff/admin sign-in — modelled on the Medusa admin login: a narrow,
 * logo-led card centred on a neutral surface (logo → tagline → hairline →
 * minimal form → security note). Uses the SAME Better Auth sign-in action as
 * the customer login (one auth instance); the difference is the entry point +
 * the default `from` (/admin) so staff land in the panel. No registration /
 * social / "create account" affordances — this surface is for existing staff
 * only. The logo is médiathèque-driven (admin-configurable) with a bundled
 * fallback so the brand always shows.
 */
export function AdminLoginForm({
  from,
  logoUrl,
}: {
  from: string;
  logoUrl: string | null;
}) {
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    signinAction,
    null,
  );
  const emailError = !state?.ok ? state?.fieldErrors?.email : undefined;
  const passwordError = !state?.ok ? state?.fieldErrors?.password : undefined;

  return (
    <div className="admin grid min-h-screen place-items-center bg-surface px-4 py-12">
      <div className="flex w-full max-w-[320px] flex-col items-center">
        {/* Brand — médiathèque logo with bundled fallback. */}
        <Image
          src={logoUrl ?? logo}
          alt="Tokyo Store"
          width={200}
          height={80}
          className="h-16 w-auto select-none object-contain"
          draggable={false}
          priority
        />
        <p className="mt-3 text-[0.6rem] uppercase tracking-[0.3em] text-muted-foreground">
          Administration
        </p>
        <div className="mt-5 h-px w-full bg-border" />

        {state && !state.ok && !state.fieldErrors && (
          <div
            role="alert"
            className="mt-6 w-full rounded-[14px] border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            {state.message}
          </div>
        )}

        <form action={formAction} className="mt-6 flex w-full flex-col gap-y-5">
          <input type="hidden" name="from" value={from} />

          <AuthField
            icon={Mail}
            type="email"
            label="Email"
            placeholder="vous@exemple.com"
            name="email"
            autoComplete="email"
            enterKeyHint="next"
            required
            error={emailError}
          />

          <AuthPasswordField
            label="Mot de passe"
            placeholder="••••••••"
            name="password"
            autoComplete="current-password"
            enterKeyHint="go"
            required
            error={passwordError}
          />

          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" name="rememberMe" className="h-4 w-4 accent-[var(--primary)]" />
            Rester connecté
          </label>

          <button
            type="submit"
            disabled={isPending}
            className="mt-1 inline-flex h-11 w-full items-center justify-center rounded-[14px] bg-primary text-[14px] font-extrabold text-primary-foreground shadow-soft transition hover:bg-[#b8042a] disabled:opacity-60"
          >
            {isPending ? "Connexion…" : "Se connecter"}
          </button>
        </form>

        <p className="mt-6 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          <Lock className="h-3.5 w-3.5" /> Connexion chiffrée — accès tracé.
        </p>
        <p className="mt-3 text-[0.55rem] uppercase tracking-[0.3em] text-muted-foreground/70">
          High-Tech · Tunisie
        </p>
      </div>
    </div>
  );
}
