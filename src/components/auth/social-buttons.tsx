"use client";

import { useState } from "react";

import { authClient } from "@/lib/auth/client";
import { oauthErrorCallbackURL } from "@/lib/auth/oauth-errors";

type SocialProvider = "google" | "facebook";

const PROVIDER_NAMES: Record<SocialProvider, string> = {
  google: "Google",
  facebook: "Facebook",
};

function unavailableMessage(provider: SocialProvider): string {
  return `Connexion via ${PROVIDER_NAMES[provider]} indisponible pour le moment.`;
}

/**
 * Allow-list a same-origin redirect path before handing it to the OAuth flow.
 * Callers (LoginForm/RegisterForm) already pass safe values, but validating
 * here too means a future misuse — passing a user-controlled `callbackURL` —
 * can't turn this component into an open redirect after login. Mirrors the
 * server-side `safeRedirectPath` in lib/actions/auth.ts (can't import it: that
 * module is server-only). Anything off-origin / protocol-relative falls back
 * to "/account".
 */
function safeCallback(value: string): string {
  if (!/^\/(?![/\\])/.test(value)) return "/account";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\s]/.test(value)) return "/account";
  return value;
}

/**
 * Social sign-in block, reused on /login, /register, /pro/login and the checkout
 * account-choice step (checkout-account.tsx) — one component, one behaviour. It is
 * rendered BELOW the preceding content (the credentials form on login/register/pro,
 * the account choices on checkout) and leads with the "ou continuer avec" divider,
 * which introduces the Google/Facebook buttons from above. When both providers are
 * disabled by the admin (Clients → Connexion & comptes) the whole block (divider
 * included) returns null and the surrounding UI takes over seamlessly.
 *
 * `authClient.signIn.social` starts the OAuth redirect; the buttons stay disabled
 * until the navigation happens (or an error surfaces in French). A callback that
 * FAILS (auto-link refused, account not linked, 2FA required, banned…) is sent back
 * to /login (`errorCallbackURL`, keeping the destination as `from`), which maps
 * `?error=<code>` to French copy — not Better Auth's English /api/auth/error.
 */
export function SocialAuthButtons({
  google,
  facebook,
  callbackURL,
  label,
}: {
  google: boolean;
  facebook: boolean;
  /** Same-origin path the OAuth flow lands on after success. */
  callbackURL: string;
  /** Picks the button copy: "Continuer avec…" (login) / "S'inscrire avec…" (register). */
  label: "login" | "register";
}) {
  const [pending, setPending] = useState<SocialProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!google && !facebook) return null;

  const verb = label === "register" ? "S'inscrire" : "Continuer";

  async function signInWith(provider: SocialProvider) {
    setError(null);
    setPending(provider);
    try {
      const callback = safeCallback(callbackURL);
      const { error: apiError } = await authClient.signIn.social({
        provider,
        callbackURL: callback,
        errorCallbackURL: oauthErrorCallbackURL(callback),
      });
      if (apiError) {
        setError(unavailableMessage(provider));
        setPending(null);
      }
      // On success better-auth navigates to the provider — keep the
      // buttons disabled until the browser leaves the page.
    } catch {
      setError(unavailableMessage(provider));
      setPending(null);
    }
  }

  return (
    <div className="mt-7 space-y-4">
      {/* Divider FIRST — it introduces the buttons below it. (Rendering it last
          left it stranded beneath the buttons, doubling up with the following
          mode-switch « ou » divider on /login, /register and /pro/login.) */}
      <div className="flex items-center gap-4">
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">ou continuer avec</span>
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>

      <div className="grid gap-3">
        {google && (
          <button
            type="button"
            onClick={() => void signInWith("google")}
            disabled={pending !== null}
            className="inline-flex h-12 w-full items-center justify-center gap-3 rounded-full border border-border bg-card text-sm font-semibold text-foreground shadow-soft transition hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
          >
            <GoogleMark className="h-5 w-5 shrink-0" />
            {pending === "google" ? "Redirection…" : `${verb} avec Google`}
          </button>
        )}
        {facebook && (
          <button
            type="button"
            onClick={() => void signInWith("facebook")}
            disabled={pending !== null}
            className="inline-flex h-12 w-full items-center justify-center gap-3 rounded-full border border-border bg-card text-sm font-semibold text-foreground shadow-soft transition hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
          >
            <FacebookMark className="h-5 w-5 shrink-0" />
            {pending === "facebook" ? "Redirection…" : `${verb} avec Facebook`}
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Standard four-colour Google "G" mark (brand colours are fixed, not themed). */
function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M23.52 12.273c0-.851-.076-1.67-.218-2.455H12v4.642h6.458a5.52 5.52 0 0 1-2.394 3.622v3.011h3.878c2.268-2.089 3.578-5.165 3.578-8.82Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.957-1.075 7.942-2.907l-3.878-3.011c-1.075.72-2.45 1.145-4.064 1.145-3.125 0-5.771-2.111-6.715-4.948H1.276v3.11A11.995 11.995 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.285 14.279A7.213 7.213 0 0 1 4.909 12c0-.79.136-1.56.376-2.279V6.61H1.276A11.995 11.995 0 0 0 0 12c0 1.936.464 3.768 1.276 5.389l4.009-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.773c1.762 0 3.344.605 4.587 1.794l3.442-3.442C17.953 1.19 15.236 0 12 0 7.31 0 3.253 2.69 1.276 6.611l4.009 3.11C6.229 6.884 8.875 4.773 12 4.773Z"
      />
    </svg>
  );
}

/** Facebook "f" roundel — official brand blue (#1877F2), fixed colour. */
function FacebookMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path
        fill="#1877F2"
        d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073c0 6.027 4.388 11.021 10.125 11.927v-8.437H7.078v-3.49h3.047V9.43c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.971h-1.513c-1.491 0-1.956.93-1.956 1.886v2.247h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073Z"
      />
    </svg>
  );
}
