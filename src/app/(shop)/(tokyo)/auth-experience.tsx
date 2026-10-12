"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";

import { SocialAuthButtons } from "@/components/auth/social-buttons";
import { signinAction, signupAction } from "@/lib/actions/auth";
import type { ActionState } from "@/lib/actions/types";
import { track } from "@/lib/tracking/funnel";
import { cn } from "@/storefront/lib/utils";
import { AuthNotice } from "@/storefront/components/storefront/auth-shell";
import {
  AuthAside,
  AuthCheckbox,
  AuthField,
  AuthHeading,
  AuthScaffold,
  AuthSubmit,
  CRIMSON,
  MUTED,
  PasswordlessDisabled,
  PasswordStrength,
  PhonePrefix,
} from "@/storefront/components/storefront/auth-card";

export type AuthMode = "login" | "register";
type RegisterCopy = { title: string; footnote: string };
type SocialFlags = { google: boolean; facebook: boolean };

const emailValid = (v: string) => /.+@.+\..+/.test(v.trim());
const filled = (v: string) => v.trim().length >= 2;
const phoneValid = (v: string) => v.replace(/\D/g, "").length >= 8;

function urlFor(mode: AuthMode, from: string) {
  const base = mode === "register" ? "/register" : "/login";
  return from !== "/account" ? `${base}?from=${encodeURIComponent(from)}` : base;
}

/* ── Login panel ─────────────────────────────────────────────────────────── */
function LoginPanel({
  state,
  action,
  pending,
  from,
  verified,
  social,
  onSwitch,
}: {
  state: ActionState | null;
  action: (fd: FormData) => void;
  pending: boolean;
  from: string;
  verified: boolean;
  social: SocialFlags;
  onSwitch: () => void;
}) {
  const emailError = state && !state.ok ? state.fieldErrors?.email : undefined;
  const pwError = state && !state.ok ? state.fieldErrors?.password : undefined;
  const generalError = state && !state.ok && !state.fieldErrors ? state.message : undefined;

  return (
    <>
      <AuthHeading title="Content de vous revoir" subtitle="Connectez-vous à votre compte Tokyo Store." />

      {verified && <AuthNotice tone="success">Adresse e-mail vérifiée. Vous pouvez vous connecter.</AuthNotice>}
      {generalError && <AuthNotice tone="error">{generalError}</AuthNotice>}

      <form action={action} className="flex flex-col gap-[18px]">
        <input type="hidden" name="from" value={from} />
        <AuthField
          label="E-mail"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="nom@mail.tn"
          required
          validate={emailValid}
          error={emailError}
        />
        <AuthField
          label="Mot de passe"
          name="password"
          password
          autoComplete="current-password"
          required
          error={pwError}
          rightOfLabel={
            <Link href="/forgot-password" className="text-[14px] font-bold" style={{ color: CRIMSON }}>
              Mot de passe oublié ?
            </Link>
          }
        />
        <AuthCheckbox name="rememberMe">Rester connecté sur cet appareil</AuthCheckbox>
        <AuthSubmit pending={pending}>{pending ? "Connexion…" : "Se connecter"}</AuthSubmit>
      </form>

      <PasswordlessDisabled />

      <SocialAuthButtons google={social.google} facebook={social.facebook} callbackURL={from} label="login" />

      <p className="m-0 text-center text-[14px]" style={{ color: MUTED }}>
        Nouveau chez Tokyo Store ?{" "}
        <button type="button" onClick={onSwitch} className="font-bold underline-offset-2 hover:underline" style={{ color: CRIMSON }}>
          Créer un compte
        </button>
      </p>
    </>
  );
}

/* ── Register panel ──────────────────────────────────────────────────────── */
function RegisterPanel({
  state,
  action,
  pending,
  copy,
  from,
  social,
  pw,
  setPw,
  onSwitch,
  siteName = "Tokyo Store",
}: {
  state: ActionState | null;
  action: (fd: FormData) => void;
  pending: boolean;
  copy: RegisterCopy;
  from: string;
  social: SocialFlags;
  pw: string;
  setPw: (v: string) => void;
  onSwitch: () => void;
  siteName?: string;
}) {
  const err = (key: string) => (state && !state.ok ? state.fieldErrors?.[key] : undefined);
  const generalError = state && !state.ok && !state.fieldErrors ? state.message : undefined;

  return (
    <>
      <AuthHeading title={copy.title || "Créer un compte"} subtitle="Rejoignez Tokyo Store en quelques instants." />

      {state?.ok && (
        <AuthNotice tone="success">{state.message ?? "Compte créé. Vérifiez votre e-mail pour l'activer."}</AuthNotice>
      )}
      {generalError && <AuthNotice tone="error">{generalError}</AuthNotice>}

      <form action={action} className="flex flex-col gap-[18px]">
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <AuthField label="Prénom" name="firstName" autoComplete="given-name" placeholder="Flen" required validate={filled} error={err("firstName")} />
          <AuthField label="Nom" name="lastName" autoComplete="family-name" placeholder="Ben Foulen" required validate={filled} error={err("lastName")} />
        </div>

        <AuthField
          label="Téléphone mobile"
          name="phone"
          type="tel"
          autoComplete="tel-national"
          inputMode="numeric"
          placeholder="22 345 678"
          prefix={<PhonePrefix />}
          validate={phoneValid}
          error={err("phone")}
          hint="Pour vous connecter et pour le livreur. Si vous avez déjà commandé en invité avec ce numéro, vos achats y seront rattachés."
        />

        <AuthField
          label="E-mail"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="nom@mail.tn"
          required
          validate={emailValid}
          error={err("email")}
          hint="Pour recevoir vos factures et le suivi de commande."
        />

        <div className="flex flex-col gap-2.5">
          <AuthField
            label="Mot de passe"
            name="password"
            password
            autoComplete="new-password"
            required
            validate={(v) => v.length >= 12}
            error={err("password")}
            onValueChange={setPw}
          />
          <PasswordStrength value={pw} />
        </div>

        <div className="flex flex-col gap-3 rounded-[20px] border border-[#efe9e3] bg-[#fbf9f8] p-4">
          <AuthCheckbox name="terms" required>
            J&apos;accepte les{" "}
            <Link href="/cgu" className="font-bold text-foreground underline underline-offset-2">
              conditions générales de vente
            </Link>{" "}
            et la{" "}
            <Link href="/confidentialite" className="font-bold text-foreground underline underline-offset-2">
              politique de confidentialité
            </Link>
            .
          </AuthCheckbox>
          {err("terms") && (
            <span className="pl-[34px] text-[13px] font-semibold" style={{ color: CRIMSON }}>
              Veuillez accepter les conditions pour continuer.
            </span>
          )}
          <AuthCheckbox name="marketingOptIn">
            Recevoir les bons plans et les baisses de prix {siteName} par SMS ou e-mail.
          </AuthCheckbox>
        </div>

        <AuthSubmit pending={pending}>{pending ? "Création…" : "Créer mon compte"}</AuthSubmit>
      </form>

      <SocialAuthButtons google={social.google} facebook={social.facebook} callbackURL={from} label="register" />

      <p className="m-0 text-center text-[14px]" style={{ color: MUTED }}>
        Déjà client ?{" "}
        <button type="button" onClick={onSwitch} className="font-bold underline-offset-2 hover:underline" style={{ color: CRIMSON }}>
          Se connecter
        </button>
      </p>

      {copy.footnote && (
        <p className="m-0 text-center text-[12px] leading-relaxed" style={{ color: MUTED }}>
          {copy.footnote}
        </p>
      )}
    </>
  );
}

/* ── Orchestrator: one component, both modes, the login↔register morph ────── */
export function AuthExperience({
  initialMode,
  social = { google: false, facebook: false },
  registerCopy,
}: {
  initialMode: AuthMode;
  social?: SocialFlags;
  registerCopy: RegisterCopy;
}) {
  const sp = useSearchParams();
  const rawFrom = sp.get("from") ?? "/account";
  const from = /^\/(?![/\\])/.test(rawFrom) ? rawFrom : "/account";
  const verified = sp.get("verified") === "1";

  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [anim, setAnim] = useState<"in" | "out">("in");
  const [pw, setPw] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [loginState, loginAction, loginPending] = useActionState<ActionState | null, FormData>(signinAction, null);
  const [regState, regAction, regPending] = useActionState<ActionState | null, FormData>(signupAction, null);

  // GA4 sign_up — fire once on a successful registration (no PII).
  useEffect(() => {
    if (regState?.ok) track("sign_up", { meta: { method: "password" } });
  }, [regState?.ok]);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const switchMode = (target: AuthMode) => {
    if (target === mode || anim === "out") return;
    // Reflect the new mode in the URL immediately (shareable + back button),
    // without a navigation that would unmount and lose the morph.
    try {
      window.history.replaceState(null, "", urlFor(target, from));
    } catch {
      /* no-op */
    }
    setAnim("out");
    timer.current = setTimeout(() => {
      setMode(target);
      setPw("");
      setAnim("in");
    }, 190);
  };

  const isLogin = mode === "login";
  const morph = cn(
    "flex flex-col gap-[26px] motion-reduce:transition-none motion-reduce:animate-none",
    anim === "out"
      ? "translate-y-2 opacity-0 transition-all duration-200 ease-in"
      : "animate-in fade-in slide-in-from-bottom-3 duration-500 ease-out",
  );

  return (
    <AuthScaffold
      crumbLabel={isLogin ? "Connexion" : "Créer un compte"}
      aside={
        <AuthAside
          key={mode}
          kicker={isLogin ? "Nouveau chez Tokyo Store ?" : "Déjà client ?"}
          title={isLogin ? "Créez votre compte en moins d'une minute." : "Retrouvez vos commandes et vos favoris."}
          ctaLabel={isLogin ? "Créer un compte" : "Se connecter"}
          onCta={() => switchMode(isLogin ? "register" : "login")}
        />
      }
    >
      <div key={mode} className={morph}>
        {isLogin ? (
          <LoginPanel
            state={loginState}
            action={loginAction}
            pending={loginPending}
            from={from}
            verified={verified}
            social={social}
            onSwitch={() => switchMode("register")}
          />
        ) : (
          <RegisterPanel
            state={regState}
            action={regAction}
            pending={regPending}
            copy={registerCopy}
            from={from}
            social={social}
            pw={pw}
            setPw={setPw}
            onSwitch={() => switchMode("login")}
          />
        )}
      </div>
    </AuthScaffold>
  );
}
