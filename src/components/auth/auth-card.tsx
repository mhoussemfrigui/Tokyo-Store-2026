"use client";

import { useState } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";

/**
 * Shared luxury auth shell — a centered-card design, wired for the
 * storefront (under the `.storefront` scope so Playfair/Montserrat, the olive
 * `--primary` and the `.btn-*` classes resolve). Replaces the old split-screen
 * brand panel on every customer auth page (login / register / forgot-password)
 * so they share ONE source of truth for the chrome:
 *
 *   logo header → entry-animated card (serif heading + subtitle) → footer links.
 *
 * Mode "transitions" are reproduced WITHOUT framer-motion: each page is its own
 * route, and the card fades/slides in via the storefront `tk-fade-in-up`
 * keyframe on navigation. Mode-switch buttons are `<Link>`s (login ↔ signup ↔
 * forgot) so every redirect / session behaviour of the underlying routes is
 * preserved. The form body + any alerts are passed in as `children`.
 */

type EnterKeyHint = "enter" | "done" | "go" | "next" | "previous" | "search" | "send";

/** Luxury field styling (the `labelClass` / `inputClass` spec). */
const LABEL_CLASS =
  "mb-1.5 block text-[0.6rem] font-medium uppercase tracking-[0.15em] text-muted-foreground/70";
function inputClass(error?: string): string {
  return `h-12 w-full rounded-xl border bg-transparent px-3.5 text-sm text-foreground transition placeholder:text-muted-foreground/50 focus:outline-none focus:ring-0 ${
    error ? "border-destructive/60 focus:border-destructive/60" : "border-border/40 focus:border-primary/50"
  }`;
}

export function AuthCard({
  title,
  subtitle,
  /** Consumer card is 420px; the business card overrides this to 820px. */
  maxWidthClass = "max-w-[420px]",
  children,
}: {
  title: string;
  subtitle?: string;
  maxWidthClass?: string;
  children: React.ReactNode;
}) {
  return (
    // Centre the card both axes within the viewport minus header/footer. The
    // min-height keeps short cards vertically centred; `justify-center` adds
    // the horizontal centring. Safe-area insets keep it clear of the iOS
    // notch / home indicator, and the responsive padding gives a comfortable
    // gutter at ~360px without ever overflowing.
    <div
      className="flex min-h-[calc(100svh-200px)] w-full flex-col items-center justify-center px-4 py-10 sm:px-6"
      style={{
        paddingLeft: "max(1rem, env(safe-area-inset-left))",
        paddingRight: "max(1rem, env(safe-area-inset-right))",
      }}
    >
      <div className={`tk-fade-in-up w-full ${maxWidthClass}`}>
        <div className="rounded-2xl border border-border/30 bg-card p-6 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.08)] sm:p-7 md:p-10">
          {/* Animated heading (re-keyed per route → re-runs the entry anim) */}
          <div key={title} className="tk-fade-in-up mb-8 text-center">
            <h1 className="mb-2 font-serif text-2xl text-foreground">{title}</h1>
            {subtitle && (
              <p className="text-xs text-muted-foreground/60">{subtitle}</p>
            )}
          </div>

          {children}
        </div>

        {/* Footer links — wrap + centre on narrow screens so they never
            overflow ~360px. */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
          <Link
            href="/"
            className="text-[0.6rem] tracking-wide text-muted-foreground/40 transition-colors hover:text-foreground/60"
          >
            Accueil
          </Link>
          <span aria-hidden className="h-1 w-1 rounded-full bg-border/50" />
          <Link
            href="/marques"
            className="text-[0.6rem] tracking-wide text-muted-foreground/40 transition-colors hover:text-foreground/60"
          >
            Boutique
          </Link>
          <span aria-hidden className="h-1 w-1 rounded-full bg-border/50" />
          <Link
            href="/help"
            className="text-[0.6rem] tracking-wide text-muted-foreground/40 transition-colors hover:text-foreground/60"
          >
            Aide
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Luxury text field — the shared `inputClass` styling. Same `name`/validation
 * contract as the old `AuthField` so server actions see identical FormData.
 */
export function AuthCardField({
  type,
  label,
  placeholder,
  name,
  autoComplete,
  enterKeyHint,
  required,
  minLength,
  error,
  hint,
}: {
  type: string;
  label: string;
  placeholder: string;
  name: string;
  autoComplete?: string;
  enterKeyHint?: EnterKeyHint;
  required?: boolean;
  minLength?: number;
  error?: string;
  hint?: string;
}) {
  const id = `field-${name}`;
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        enterKeyHint={enterKeyHint}
        placeholder={placeholder}
        required={required}
        minLength={minLength}
        className={inputClass(error)}
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      {!error && hint && (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">{hint}</p>
      )}
    </div>
  );
}

/** Luxury password field — the shared `inputClass` + the absolute-positioned eye toggle. */
export function AuthCardPasswordField({
  label,
  placeholder,
  name,
  autoComplete,
  enterKeyHint,
  required,
  minLength,
  error,
  hint,
}: {
  label: string;
  placeholder: string;
  name: string;
  autoComplete: "current-password" | "new-password";
  enterKeyHint?: EnterKeyHint;
  required?: boolean;
  minLength?: number;
  error?: string;
  hint?: string;
}) {
  const [show, setShow] = useState(false);
  const id = `field-${name}`;
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={name}
          type={show ? "text" : "password"}
          autoComplete={autoComplete}
          enterKeyHint={enterKeyHint}
          placeholder={placeholder}
          required={required}
          minLength={minLength}
          className={`${inputClass(error)} pr-12`}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute right-1 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center text-muted-foreground/40 transition-colors hover:text-foreground/60"
          tabIndex={-1}
          aria-label={show ? "Cacher le mot de passe" : "Afficher le mot de passe"}
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      {!error && hint && (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">{hint}</p>
      )}
    </div>
  );
}
