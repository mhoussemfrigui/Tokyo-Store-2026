"use client";

import Link from "next/link";
import { useActionState } from "react";

import { requestPasswordResetAction } from "@/lib/actions/auth";
import type { ActionState } from "@/lib/actions/types";
import {
  AuthShell,
  AuthNotice,
} from "@/storefront/components/storefront/auth-shell";
import { btn, field, fieldLabel } from "@/storefront/components/storefront/ui-classes";
import { cn } from "@/storefront/lib/utils";

export function ForgotPasswordForm({
  copy,
}: {
  copy: { title: string; subtitle: string };
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    requestPasswordResetAction,
    null,
  );

  return (
    <AuthShell
      crumbLabel="Mot de passe oublié"
      title={copy.title || "Mot de passe oublié"}
      subtitle={copy.subtitle || "Recevez un lien pour réinitialiser votre mot de passe."}
      footer={
        <>
          Vous vous souvenez de votre mot de passe ?{" "}
          <Link href="/login" className="font-semibold text-primary hover:underline">
            Se connecter
          </Link>
        </>
      }
    >
      {/* Enumeration-safe: the action always returns the same success message. */}
      {state?.ok && <AuthNotice tone="success">{state.message}</AuthNotice>}

      <form action={formAction} className="space-y-4">
        <div>
          <label htmlFor="email" className={fieldLabel}>
            E-mail
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className={field}
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className={cn(btn.base, btn.lg, btn.primary, "w-full")}
        >
          {pending ? "Envoi…" : "Envoyer le lien"}
        </button>
      </form>
    </AuthShell>
  );
}
