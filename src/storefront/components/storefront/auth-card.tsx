"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { ArrowRight, Check, Eye, EyeOff, Loader2, Mail, MessageCircle, ShieldCheck, Truck, Wallet } from "lucide-react";

import { cn } from "@/storefront/lib/utils";

/* Palette — the mockup's EXACT values (crimson Tokyo system). */
export const INK = "#0e1218";
export const CRIMSON = "var(--primary)";
export const PAPER = "#f6f2ed";
export const MUTED = "#5b5d62";
const FIELD_REST_BG = "#fbf9f8";

/**
 * Shared design primitives for the new Tokyo auth design (the "Login Register"
 * mockup): a white breadcrumb card beside a WHITE benefits aside. Fields match
 * the mockup exactly — resting #fbf9f8, INK focus border + soft ink ring (not
 * crimson), crimson error. The morphing login↔register experience lives in
 * `auth-experience.tsx`; these render REAL `<input name>` fields so the existing
 * signin/signup server actions stay wired.
 */

/* ── Layout: card (breadcrumb + form) + white benefits aside ─────────────── */
export function AuthScaffold({
  crumbLabel,
  children,
  aside,
}: {
  crumbLabel: string;
  children: ReactNode;
  aside: ReactNode;
}) {
  return (
    <div className="tokyo w-full" style={{ background: PAPER, color: INK }}>
      <div className="page-container flex w-full flex-col items-stretch gap-5 pt-3 lg:flex-row">
        {/* Card */}
        <section className="flex w-full min-w-0 flex-col rounded-[36px] bg-white p-[clamp(22px,4vw,48px)] lg:flex-[1.38_1_0]">
          <nav
            aria-label="Fil d'Ariane"
            className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap border-b border-[#efe9e3] pb-[18px] text-[13px]"
          >
            <Link href="/" style={{ color: MUTED }}>
              Accueil
            </Link>
            <ChevronMini />
            <Link href="/account" style={{ color: MUTED }}>
              Mon compte
            </Link>
            <ChevronMini />
            <span aria-current="page" className="font-bold" style={{ color: INK }}>
              {crumbLabel}
            </span>
          </nav>
          <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col justify-center gap-[26px] pt-7">
            {children}
          </div>
        </section>
        {aside}
      </div>
    </div>
  );
}

function ChevronMini() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#c9c2ba" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="flex-[0_0_13px]">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

const BENEFITS = [
  { Icon: Truck, text: "Livraison sous 24h à 72h partout en Tunisie" },
  { Icon: Wallet, text: "Paiement à la livraison ou par carte" },
  { Icon: ShieldCheck, text: "Garantie et facture officielle" },
];

/** The WHITE benefits panel: kicker + title + a toggle CTA (morphs the card to
 *  the other mode) + a brand banner block + benefits. Keyed by mode so it
 *  re-plays its entrance animation on switch. */
export function AuthAside({
  kicker,
  title,
  ctaLabel,
  onCta,
}: {
  kicker: string;
  title: string;
  ctaLabel: string;
  onCta: () => void;
}) {
  return (
    <aside className="flex w-full min-w-0 animate-in flex-col gap-6 overflow-hidden rounded-[36px] bg-white p-[clamp(22px,3vw,36px)] duration-500 fade-in slide-in-from-bottom-2 lg:flex-[1_1_0]">
      <div className="flex flex-col gap-3.5">
        <span className="text-[12px] font-extrabold uppercase tracking-[0.16em]" style={{ color: CRIMSON }}>
          {kicker}
        </span>
        <h2 className="m-0 text-[clamp(26px,2.4vw,34px)] font-black leading-[1.08] tracking-[-.03em] text-balance" style={{ color: INK }}>
          {title}
        </h2>
        <button
          type="button"
          onClick={onCta}
          className="flex h-[52px] w-fit items-center gap-2.5 rounded-full border-[1.5px] bg-white px-[22px] text-[15px] font-extrabold transition-colors hover:bg-[#0e1218] hover:text-white"
          style={{ borderColor: INK, color: INK }}
        >
          {ctaLabel}
          <ArrowRight size={16} />
        </button>
      </div>
      {/* Brand banner block (the mockup's portrait image-slot) — a crimson
          gradient, not a fabricated product photo. Desktop only. */}
      <div
        className="relative hidden min-h-[260px] flex-1 overflow-hidden rounded-[28px] lg:block"
        style={{ background: "linear-gradient(145deg,var(--primary) 0%,color-mix(in oklab, var(--primary) 60%, #0e1218) 55%,#0e1218 135%)" }}
      >
        <span className="absolute -right-12 -top-12 h-48 w-48 rounded-full bg-white/10" />
        <span className="absolute -bottom-10 -left-10 h-40 w-40 rounded-full bg-white/[0.06]" />
        <span className="absolute bottom-6 left-7 right-7 text-[22px] font-black leading-tight tracking-[-.02em] text-white">
          Votre expert tech de confiance en Tunisie.
        </span>
      </div>
      <div className="flex flex-col gap-3 pt-1">
        {BENEFITS.map((b) => (
          <span key={b.text} className="flex items-center gap-2.5 text-[14px] font-semibold" style={{ color: INK }}>
            <span className="flex h-8 w-8 flex-[0_0_32px] items-center justify-center rounded-[10px]" style={{ background: "color-mix(in oklab, var(--primary) 12%, transparent)" }}>
              <b.Icon size={15} style={{ color: CRIMSON }} />
            </span>
            {b.text}
          </span>
        ))}
      </div>
    </aside>
  );
}

/* ── Heading ─────────────────────────────────────────────────────────────── */
export function AuthHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="m-0 text-[clamp(30px,3.4vw,42px)] font-black leading-[1.05] tracking-[-.035em] text-balance">
        {title}
      </h1>
      <p className="m-0 text-[16px] leading-[1.55] text-pretty" style={{ color: MUTED }}>
        {subtitle}
      </p>
    </div>
  );
}

/* ── Field ───────────────────────────────────────────────────────────────── */
export function AuthField({
  label,
  name,
  type = "text",
  autoComplete,
  inputMode,
  placeholder,
  error,
  hint,
  required,
  password,
  prefix,
  rightOfLabel,
  validate,
  onValueChange,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  inputMode?: "text" | "email" | "tel" | "numeric";
  placeholder?: string;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  password?: boolean;
  prefix?: ReactNode;
  rightOfLabel?: ReactNode;
  validate?: (v: string) => boolean;
  onValueChange?: (v: string) => void;
}) {
  const uid = useId();
  const id = `${uid}-${name}`;
  const [show, setShow] = useState(false);
  const [focused, setFocused] = useState(false);
  const [touched, setTouched] = useState(false);
  const [value, setValue] = useState("");
  // Mockup colours: error > focus(INK) > rest(#fbf9f8). Green check only when
  // filled + valid + not focused + not a password field.
  const border = error ? CRIMSON : focused ? INK : "#e6dfd7";
  const bg = error ? "color-mix(in oklab, var(--primary) 5%, white)" : focused ? "#fff" : FIELD_REST_BG;
  const ring = focused ? (error ? "0 0 0 4px color-mix(in oklab, var(--primary) 12%, transparent)" : "0 0 0 4px rgba(14,18,24,.07)") : "none";
  const ok = !error && touched && !focused && !!value.trim() && !password && (validate ? validate(value) : true);
  const inputType = password ? (show ? "text" : "password") : type;

  return (
    <label className="flex min-w-0 flex-col gap-2" htmlFor={id}>
      <span className="flex items-baseline justify-between gap-2.5 text-[14px] font-bold" style={{ color: INK }}>
        {label}
        {rightOfLabel}
      </span>
      <span
        className="relative flex h-[56px] items-center rounded-[16px] border-[1.5px] transition-[border-color,box-shadow,background-color] duration-200"
        style={{ borderColor: border, background: bg, boxShadow: ring }}
      >
        {prefix}
        <input
          id={id}
          name={name}
          type={inputType}
          required={required}
          autoComplete={autoComplete}
          inputMode={inputMode}
          placeholder={placeholder}
          aria-invalid={!!error}
          onChange={(e) => {
            setValue(e.target.value);
            onValueChange?.(e.target.value);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setTouched(true);
          }}
          className={cn("h-full min-w-0 flex-1 border-none bg-transparent text-[16px] outline-none", prefix ? "pl-2.5 pr-2" : "px-4")}
          style={{ color: INK }}
        />
        {ok && (
          <span className="mr-3.5 flex h-6 w-6 flex-[0_0_24px] items-center justify-center rounded-full" style={{ background: "#eaf7ee" }}>
            <Check size={14} style={{ color: "#15803d" }} strokeWidth={2.6} />
          </span>
        )}
        {password && (
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? "Masquer le mot de passe" : "Afficher le mot de passe"}
            className="mr-2 flex h-10 flex-[0_0_auto] items-center gap-1.5 rounded-xl px-3 text-[13px] font-bold"
            style={{ background: PAPER, color: INK }}
          >
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
            {show ? "Masquer" : "Afficher"}
          </button>
        )}
      </span>
      {error ? (
        <span className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: CRIMSON }}>
          <span className="flex h-4 w-4 items-center justify-center rounded-full text-[11px] font-black text-white" style={{ background: CRIMSON }}>
            !
          </span>
          {error}
        </span>
      ) : hint ? (
        <span className="text-[13px]" style={{ color: MUTED }}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

/** The +216 Tunisian phone prefix shown inside a phone field. */
export function PhonePrefix() {
  return (
    <span className="flex h-full flex-[0_0_auto] items-center gap-2 pl-4 pr-1 text-[16px] font-bold" style={{ color: INK }}>
      <span className="flex h-3.5 w-5 items-center justify-center rounded-[3px]" style={{ background: CRIMSON }}>
        <span className="h-[7px] w-[7px] rounded-full bg-white" />
      </span>
      +216
      <span className="ml-1.5 h-[22px] w-px" style={{ background: "#e6dfd7" }} />
    </span>
  );
}

/* ── Submit ──────────────────────────────────────────────────────────────── */
export function AuthSubmit({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex h-[58px] items-center justify-center gap-2.5 rounded-full text-[16px] font-extrabold text-white transition-[filter,transform] hover:brightness-95 active:scale-[0.98] disabled:opacity-70"
      style={{ background: CRIMSON, boxShadow: "0 12px 28px color-mix(in oklab, var(--primary) 22%, transparent)" }}
    >
      {pending && <Loader2 size={18} className="animate-spin" />}
      {children}
    </button>
  );
}

/* ── Custom checkbox (real native input, styled) ─────────────────────────── */
export function AuthCheckbox({
  name,
  required,
  defaultChecked,
  children,
}: {
  name: string;
  required?: boolean;
  defaultChecked?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-[14px] leading-[1.5] text-[#3d4046]">
      <input type="checkbox" name={name} required={required} defaultChecked={defaultChecked} className="peer sr-only" />
      <span className="mt-px flex h-[22px] w-[22px] flex-[0_0_22px] items-center justify-center rounded-[7px] border-[1.5px] border-[#c9c2ba] bg-white transition-colors peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary">
        <Check size={14} className="text-white" strokeWidth={3} />
      </span>
      <span>{children}</span>
    </label>
  );
}

/* ── Passwordless methods — present but disabled (no backend yet) ─────────── */
export function PasswordlessDisabled() {
  const item = (Icon: typeof Mail, title: string, sub: string) => (
    <div aria-disabled className="flex min-w-0 cursor-not-allowed items-center gap-3 rounded-[20px] border-[1.5px] border-[#ece6df] bg-white p-3.5 opacity-60">
      <span className="flex h-10 w-10 flex-[0_0_40px] items-center justify-center rounded-xl" style={{ background: PAPER }}>
        <Icon size={18} style={{ color: INK }} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[14px] font-extrabold">
          {title}
          <span className="rounded-full px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide" style={{ background: PAPER, color: MUTED }}>
            Bientôt
          </span>
        </span>
        <span className="text-[12px]" style={{ color: MUTED }}>
          {sub}
        </span>
      </span>
    </div>
  );
  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-[12px] font-extrabold uppercase tracking-[0.12em]" style={{ color: "#8a857f" }}>
        Sans mot de passe
      </span>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {item(Mail, "Lien par e-mail", "Un clic pour vous connecter")}
        {item(MessageCircle, "Code WhatsApp", "Reçu sur votre téléphone")}
      </div>
    </div>
  );
}

/* ── Password strength meter (register) — the mockup's exact scale ────────── */
// Semantic red→green scale (weak→strong). The "weak" red is a SIGNAL colour, not
// the brand accent, so it stays a literal #d40530 and is deliberately NOT routed
// to --primary (a blue brand must not paint a weak password blue).
const SC = ["#ece6df", "#d40530", "#f59e0b", "#84cc16", "#16a34a"];
const SL = ["", "Faible", "Moyen", "Bon", "Excellent"];
export function PasswordStrength({ value }: { value: string }) {
  const rules: [boolean, string][] = [
    [value.length >= 8, "8 caractères"],
    [/[A-Z]/.test(value) && /[a-z]/.test(value), "Majuscule et minuscule"],
    [/\d/.test(value), "Un chiffre"],
  ];
  const score = value ? rules.filter((r) => r[0]).length + (/[^A-Za-z0-9]/.test(value) ? 1 : 0) : 0;
  const bar = SC[score];
  const fg = bar === "#ece6df" ? "#8a857f" : bar === "#84cc16" ? "#4d7c0f" : bar === "#f59e0b" ? "#b45309" : bar;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="grid flex-1 grid-cols-4 gap-1">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="h-1.5 rounded-full transition-colors duration-300" style={{ background: i < score ? bar : "#ece6df" }} />
          ))}
        </div>
        <span className="flex-[0_0_76px] text-right text-[13px] font-bold" style={{ color: fg }}>
          {SL[score]}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1.5">
        {rules.map(([okRule, label]) => (
          <span key={label} className="flex items-center gap-1.5 text-[13px] transition-colors" style={{ color: okRule ? "#15803d" : "#8a857f" }}>
            <span className="flex h-4 w-4 items-center justify-center rounded-full transition-colors" style={{ background: okRule ? "#16a34a" : "#d8d1c9" }}>
              <Check size={10} className="text-white" strokeWidth={3.4} />
            </span>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
