"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useActionState } from "react";

import { resetPasswordAction } from "@/lib/actions/auth";
import type { ActionState } from "@/lib/actions/types";
import {
  AuthShell,
  AuthNotice,
} from "@/storefront/components/storefront/auth-shell";
import { btn, field, fieldLabel } from "@/storefront/components/storefront/ui-classes";
import { cn } from "@/storefront/lib/utils";

export function ResetPasswordForm({
  copy,
}: {
  copy: { title: string; subtitle: string; invalidTitle: string; invalidBody: string };
}) {
  const token = useSearchParams().get("token") ?? "";

  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    resetPasswordAction,
    null,
  );

  // No token in the URL → the link is malformed or was stripped.
  if (!token) {
    return (
      <AuthShell
        crumbLabel="Réinitialisation"
        title={copy.invalidTitle || "Lien invalide"}
        subtitle={copy.invalidBody}
        footer={
          <Link href="/forgot-password" className="font-semibold text-primary hover:underline">
            Demander un nouveau lien
          </Link>
        }
      >
        <p className="text-sm text-muted-foreground">
          Ce lien de réinitialisation est invalide ou incomplet.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      crumbLabel="Réinitialisation"
      title={copy.title || "Nouveau mot de passe"}
      subtitle={copy.subtitle || "Choisissez un nouveau mot de passe pour votre compte."}
      footer={
        <Link href="/login" className="font-semibold text-primary hover:underline">
          Retour à la connexion
        </Link>
      }
    >
      {state && !state.ok && <AuthNotice tone="error">{state.message}</AuthNotice>}
      {state?.ok ? (
        <AuthNotice tone="success">
          {state.message ?? "Mot de passe mis à jour."}{" "}
          <Link href="/login" className="font-semibold underline">
            Se connecter
          </Link>
        </AuthNotice>
      ) : (
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="token" value={token} />
          <div>
            <label htmlFor="newPassword" className={fieldLabel}>
              Nouveau mot de passe
            </label>
            <input
              id="newPassword"
              name="newPassword"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              placeholder="Min. 12 caractères"
              className={field}
            />
          </div>
          <button
            type="submit"
            disabled={pending}
            className={cn(btn.base, btn.lg, btn.primary, "w-full")}
          >
            {pending ? "Mise à jour…" : "Mettre à jour"}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
