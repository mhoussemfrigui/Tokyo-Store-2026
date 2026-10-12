"use client";

import { useState } from "react";
import { Loader2, ShieldCheck, ShieldOff } from "lucide-react";

import { authClient } from "@/lib/auth/client";
import { twoFactorQrAction } from "@/lib/actions/two-factor";

type Phase =
  | { step: "idle" }
  | { step: "askPasswordEnable" }
  | { step: "confirm"; qr: string | null; uri: string; backupCodes: string[] }
  | { step: "codes"; backupCodes: string[] }
  | { step: "askPasswordDisable" };

/**
 * Opt-in TOTP two-factor enrolment (default OFF). Available to every account
 * type. Enable → confirm a code from an authenticator → backup codes shown ONCE.
 * Disable + regenerate-codes both require the current password (enforced by the
 * Better Auth plugin). State is read live from the session.
 */
export function TwoFactorCard() {
  const { data: session, isPending: sessionLoading } = authClient.useSession();
  const enabled = Boolean((session?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled);

  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => {
    setPhase({ step: "idle" });
    setPassword("");
    setCode("");
    setErr(null);
    setBusy(false);
  };

  const beginEnable = async () => {
    setErr(null);
    setBusy(true);
    const res = await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (res.error || !res.data) {
      setErr("Mot de passe incorrect ou erreur. Réessayez.");
      return;
    }
    const uri = res.data.totpURI;
    const backupCodes = res.data.backupCodes ?? [];
    const qr = await twoFactorQrAction(uri).catch(() => null);
    setPassword("");
    setPhase({ step: "confirm", qr, uri, backupCodes });
  };

  const confirmEnable = async (backupCodes: string[]) => {
    setErr(null);
    setBusy(true);
    const res = await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (res.error) {
      setErr("Code invalide. Vérifiez l'heure de votre téléphone et réessayez.");
      return;
    }
    // Audited server-side (Better Auth after-hook in lib/auth/server.ts).
    setCode("");
    setPhase({ step: "codes", backupCodes });
  };

  const disable = async () => {
    setErr(null);
    setBusy(true);
    const res = await authClient.twoFactor.disable({ password });
    setBusy(false);
    if (res.error) {
      setErr("Mot de passe incorrect ou erreur.");
      return;
    }
    // Audited server-side (Better Auth after-hook in lib/auth/server.ts).
    reset();
  };

  if (sessionLoading) {
    return <p className="text-sm text-muted-foreground">Chargement…</p>;
  }

  // Already enabled → status + disable.
  if (enabled && phase.step !== "askPasswordDisable") {
    return (
      <div className="space-y-3">
        <p className="inline-flex items-center gap-2 text-sm font-medium text-olive">
          <ShieldCheck className="h-4 w-4" /> Authentification à deux facteurs active
        </p>
        <p className="text-[13px] text-muted-foreground">
          Un code de votre application d&apos;authentification est demandé à chaque connexion.
        </p>
        <button
          type="button"
          onClick={() => setPhase({ step: "askPasswordDisable" })}
          className="btn-ghost-luxury h-10 rounded-xl px-4 text-[0.65rem]"
        >
          <ShieldOff className="h-4 w-4" /> Désactiver
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {err && <p className="text-xs text-destructive">{err}</p>}

      {phase.step === "idle" && (
        <>
          <p className="text-[13px] text-muted-foreground">
            Ajoutez une couche de sécurité : un code temporaire de votre application
            (Google Authenticator, Authy…) sera demandé à la connexion.
          </p>
          <button
            type="button"
            onClick={() => setPhase({ step: "askPasswordEnable" })}
            className="btn-solid h-10 rounded-xl px-4 text-[0.65rem]"
          >
            <ShieldCheck className="h-4 w-4" /> Activer la 2FA
          </button>
        </>
      )}

      {(phase.step === "askPasswordEnable" || phase.step === "askPasswordDisable") && (
        <div className="space-y-2">
          <p className="text-[13px] text-muted-foreground">
            Confirmez votre mot de passe pour continuer.
          </p>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Mot de passe actuel"
            className="h-12 w-full max-w-sm rounded-xl border border-border/40 bg-transparent px-3.5 text-sm text-foreground transition placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-0"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || password.length < 1}
              onClick={phase.step === "askPasswordEnable" ? beginEnable : disable}
              className="btn-solid h-10 rounded-xl px-4 text-[0.65rem]"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Continuer
            </button>
            <button
              type="button"
              onClick={reset}
              className="btn-ghost-luxury h-10 rounded-xl px-4 text-[0.65rem]"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {phase.step === "confirm" && (
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground">
            Scannez ce QR dans votre application d&apos;authentification, puis saisissez
            le code à 6 chiffres pour confirmer.
          </p>
          {phase.qr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={phase.qr} alt="QR 2FA" width={180} height={180} className="rounded-xl bg-white p-3 ring-1 ring-border/30" />
          ) : (
            <code className="block max-w-sm break-all rounded-lg bg-surface px-3 py-2 text-[11px]">
              {phase.uri}
            </code>
          )}
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123 456"
            className="h-12 w-40 rounded-xl border border-border/40 bg-transparent px-4 text-center text-lg tracking-widest tabular-nums text-foreground transition focus:border-primary/50 focus:outline-none focus:ring-0"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || code.trim().length < 6}
              onClick={() => confirmEnable(phase.backupCodes)}
              className="btn-solid h-10 rounded-xl px-4 text-[0.65rem]"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Confirmer
            </button>
            <button
              type="button"
              onClick={reset}
              className="btn-ghost-luxury h-10 rounded-xl px-4 text-[0.65rem]"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {phase.step === "codes" && (
        <div className="space-y-3">
          <p className="inline-flex items-center gap-2 text-sm font-medium text-olive">
            <ShieldCheck className="h-4 w-4" /> 2FA activée
          </p>
          <p className="text-[13px] font-medium text-foreground">
            Conservez ces codes de secours — affichés UNE seule fois. Chacun
            permet une connexion si vous perdez votre téléphone.
          </p>
          <ul className="grid max-w-sm grid-cols-2 gap-1.5 rounded-xl border border-border/40 bg-surface/40 p-3 font-mono text-[13px]">
            {phase.backupCodes.map((c) => (
              <li key={c} className="select-all">{c}</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={reset}
            className="btn-solid h-10 rounded-xl px-4 text-[0.65rem]"
          >
            J&apos;ai sauvegardé mes codes
          </button>
        </div>
      )}
    </div>
  );
}
