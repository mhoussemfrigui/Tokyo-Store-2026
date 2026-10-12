"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, KeyRound, Loader2, Lock, X } from "lucide-react";

import { setUserPasswordAction } from "@/lib/actions/rbac";

/**
 * Icon button + dialog to set a user's password DIRECTLY (admin-chosen),
 * distinct from the email-reset-link button. On success all of the user's
 * sessions are revoked (server-side) so the new secret takes hold everywhere.
 */
export function SetPasswordButton({
  userId,
  name,
  email,
}: {
  userId: string;
  name: string;
  email: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A valid submission needs the policy length AND a matching confirmation.
  const valid = password.length >= 12 && password === confirm;
  const mismatch = confirm.length > 0 && password !== confirm;

  const close = () => {
    setOpen(false);
    setPassword("");
    setConfirm("");
    setShow(false);
    setError(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) close();
    };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pending]);

  const submit = () => {
    if (!valid) return;
    setError(null);
    startTransition(async () => {
      const res = await setUserPasswordAction({ userId, newPassword: password });
      if (res.ok) {
        close();
        router.refresh();
      } else {
        setError(res.fieldErrors?.newPassword ?? res.message);
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="grid h-9 w-9 place-items-center rounded-[11px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        aria-label="Définir le mot de passe"
        title="Définir le mot de passe directement"
      >
        <Lock className="h-4 w-4" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Définir le mot de passe"
          className="fixed inset-0 z-50 grid place-items-center bg-foreground/40 p-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget && !pending) close();
          }}
        >
          <div className="w-full max-w-md rounded-[28px] border border-border bg-card p-5 shadow-soft sm:p-6">
            <div className="mb-3 flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[14px] bg-[var(--accent)] text-primary">
                <KeyRound className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[18px] font-black text-foreground">
                  Définir le mot de passe
                </h3>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {name || email} — les sessions actives seront révoquées.
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                disabled={pending}
                aria-label="Fermer"
                className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition hover:bg-secondary disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="space-y-2">
              <div className="relative">
                <input
                  type={show ? "text" : "password"}
                  value={password}
                  autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Nouveau mot de passe (12 caractères min.)"
                  className="h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 pr-11 text-[15px] text-foreground placeholder:text-muted-foreground focus:border-foreground focus:bg-white focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                  className="absolute right-3 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <input
                type={show ? "text" : "password"}
                value={confirm}
                autoComplete="new-password"
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && valid && !pending) submit();
                }}
                placeholder="Confirmer le mot de passe"
                className="h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] text-foreground placeholder:text-muted-foreground focus:border-foreground focus:bg-white focus:outline-none"
              />
              {mismatch && (
                <p className="text-[11px] text-destructive">
                  Les mots de passe ne correspondent pas.
                </p>
              )}
            </div>

            {error && (
              <p className="mt-3 rounded-[12px] border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={pending}
                className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground transition hover:bg-surface disabled:opacity-50"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={pending || !valid}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
              >
                {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                Définir
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
