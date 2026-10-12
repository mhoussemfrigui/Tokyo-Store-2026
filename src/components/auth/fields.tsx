"use client";

import { useState } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";

/**
 * Form-field primitives shared by the login and register forms — one source
 * of truth for the icon-in-field shell, focus ring, error and hint styling
 * so the two auth pages can't drift apart.
 */

type EnterKeyHint = "enter" | "done" | "go" | "next" | "previous" | "search" | "send";

const LABEL_CLASS =
  "text-xs font-semibold uppercase tracking-wide text-muted-foreground";

function shellClass(error?: string): string {
  return `mt-1.5 flex h-12 items-center gap-3 rounded-2xl border bg-surface px-4 transition focus-within:border-primary/50 focus-within:bg-card focus-within:ring-2 focus-within:ring-primary/20 ${
    error ? "border-destructive/50" : "border-border"
  }`;
}

const INPUT_CLASS =
  "h-full min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none";

export function AuthField({
  icon: Icon,
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
  icon: React.ElementType;
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
      <div className={shellClass(error)}>
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={2} />
        <input
          id={id}
          name={name}
          type={type}
          autoComplete={autoComplete}
          enterKeyHint={enterKeyHint}
          placeholder={placeholder}
          required={required}
          minLength={minLength}
          className={INPUT_CLASS}
        />
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      {!error && hint && (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/** Password field with the show/hide toggle, same shell as `AuthField`. */
export function AuthPasswordField({
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
      <div className={shellClass(error)}>
        <Lock className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={2} />
        <input
          id={id}
          name={name}
          type={show ? "text" : "password"}
          autoComplete={autoComplete}
          enterKeyHint={enterKeyHint}
          placeholder={placeholder}
          required={required}
          minLength={minLength}
          className={INPUT_CLASS}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="shrink-0 text-muted-foreground transition hover:text-foreground"
          aria-label={show ? "Cacher le mot de passe" : "Afficher le mot de passe"}
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      {!error && hint && (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
