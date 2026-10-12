"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldOff } from "lucide-react";

import { disableUserTwoFactorAction } from "@/lib/actions/two-factor";

/**
 * Admin 2FA lockout-recovery — clears a user's 2FA enrolment (the admin can only
 * CLEAR, never read the secret/codes). Shown on the admin user / customer-360
 * pages when the account has 2FA active and the actor holds users:manage.
 */
export function ResetTwoFactorButton({ userId }: { userId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!window.confirm("Réinitialiser la 2FA de ce compte ? L'utilisateur devra la réactiver.")) return;
          start(async () => {
            const res = await disableUserTwoFactorAction(userId);
            setMsg(res.message ?? (res.ok ? "OK" : "Erreur"));
            if (res.ok) router.refresh();
          });
        }}
        className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-card px-4 text-xs font-semibold text-foreground hover:bg-surface disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
        Réinitialiser la 2FA
      </button>
      {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
    </div>
  );
}
