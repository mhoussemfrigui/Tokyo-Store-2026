"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useActionState, useState } from "react";

import { verifyTwoFactorAction } from "@/lib/actions/auth";
import type { ActionState } from "@/lib/actions/types";
import {
  AuthShell,
  AuthNotice,
} from "@/storefront/components/storefront/auth-shell";
import { btn, field, fieldLabel } from "@/storefront/components/storefront/ui-classes";
import { cn } from "@/storefront/lib/utils";

export function TwoFactorForm() {
  const sp = useSearchParams();
  const from = sp.get("from") ?? "/account";
  const safeFrom = /^\/(?![/\\])/.test(from) ? from : "/account";

  const [backup, setBackup] = useState(false);
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    verifyTwoFactorAction,
    null,
  );
  const generalError = state && !state.ok ? state.message : undefined;

  return (
    <AuthShell
      crumbLabel="Vérification"
      title="Vérification en deux étapes"
      subtitle={
        backup
          ? "Saisissez l'un de vos codes de secours."
          : "Saisissez le code à 6 chiffres de votre application d'authentification."
      }
      footer={
        <Link href="/login" className="font-semibold text-primary hover:underline">
          Retour à la connexion
        </Link>
      }
    >
      {generalError && <AuthNotice tone="error">{generalError}</AuthNotice>}

      {/* key forces a fresh field (and clears the input) when switching modes. */}
      <form key={backup ? "backup" : "totp"} action={formAction} className="space-y-4">
        <input type="hidden" name="from" value={safeFrom} />
        <input type="hidden" name="mode" value={backup ? "backup" : "totp"} />
        <div>
          <label htmlFor="code" className={fieldLabel}>
            {backup ? "Code de secours" : "Code de vérification"}
          </label>
          <input
            id="code"
            name="code"
            type="text"
            inputMode={backup ? "text" : "numeric"}
            autoComplete="one-time-code"
            required
            autoFocus
            placeholder={backup ? "XXXX-XXXX" : "000000"}
            className={cn(field, "text-center text-lg tracking-[0.3em]")}
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className={cn(btn.base, btn.lg, btn.primary, "w-full")}
        >
          {pending ? "Vérification…" : "Vérifier"}
        </button>
      </form>

      <button
        type="button"
        onClick={() => setBackup((v) => !v)}
        className="mt-5 block w-full text-center text-[13px] font-medium text-primary hover:underline"
      >
        {backup
          ? "Utiliser mon application d'authentification"
          : "Utiliser un code de secours"}
      </button>
    </AuthShell>
  );
}
