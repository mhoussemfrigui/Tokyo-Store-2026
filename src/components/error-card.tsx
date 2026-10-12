"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Copy,
  Database,
  Gauge,
  Network,
  RotateCw,
  ScrollText,
  Server,
  Timer,
} from "lucide-react";

import { formatErrorRef } from "@/lib/errors/error-ref";
import { cn } from "@/storefront/lib/utils";

/**
 * The ONE general error page — the crimson card shown by every error boundary
 * (root, admin, storefront) and by `global-error`. Self-scoped to `.tokyo` so it
 * renders identically crimson inside the admin (`.admin`) chrome, the storefront
 * (`.tokyo`/`.storefront`) chrome, or bare.
 *
 * The « Référence » is `formatErrorRef(error.digest)` — the SAME value the server
 * `onRequestError` hook writes to the audit log, so support / an operator can
 * trace the exact incident. In the admin variant the reference deep-links into
 * « Journal d'audit » filtered to that row.
 *
 * SECURITY: the raw message + stack are shown in DEVELOPMENT ONLY. In production
 * Next withholds them from the client anyway (only the digest crosses), so the
 * card shows the reference + the meta table + (admin) links to the logs, never
 * internals.
 */

type ErrorCardProps = {
  error: Error & { digest?: string };
  /** Next error-boundary recovery callback (`reset` in next 16.2). */
  reset?: () => void;
  /** "admin" adds the infra/log deep-links; "storefront" never links into /admin. */
  variant?: "admin" | "storefront";
  /** The « Retour » target + label. */
  homeHref?: string;
  homeLabel?: string;
  /** HTTP-ish code shown in the header chip. Render boundaries are 500-class. */
  code?: string;
  /** Full-viewport centering + beige bg (bare contexts: root + global-error). */
  fullScreen?: boolean;
};

const INFRA_LINKS: { label: string; href: string; icon: typeof Database }[] = [
  { label: "Tâches planifiées", href: "/admin/system/jobs", icon: Timer },
  { label: "Performance", href: "/admin/system/performance", icon: Gauge },
  { label: "Base de données", href: "/admin/system/database", icon: Database },
  { label: "Ressources", href: "/admin/system/resources", icon: Server },
  { label: "API & webhooks", href: "/admin/system/api", icon: Network },
];

export function ErrorCard({
  error,
  reset,
  variant = "storefront",
  homeHref = "/",
  homeLabel = "Retour à l'accueil",
  code = "500",
  fullScreen = false,
}: ErrorCardProps) {
  const pathname = usePathname();
  const isDev = process.env.NODE_ENV !== "production";

  // Dev-only console visibility. In production the server `onRequestError` hook
  // owns logging (with the matching reference) — the browser stays quiet so no
  // internals leak into the client console.
  useEffect(() => {
    if (isDev) console.error(error);
  }, [error, isDev]);
  const ref = formatErrorRef(error?.digest);
  const message = typeof error?.message === "string" ? error.message : "";
  const stack = typeof error?.stack === "string" ? error.stack : "";

  // Captured once, client-side, when the boundary first renders (= when the error
  // surfaced). Lazy init so it isn't recomputed on every state change.
  const [when] = useState(() =>
    new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" }),
  );
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);

  const buildSha = process.env.NEXT_PUBLIC_BUILD_SHA?.trim();
  const env = `${process.env.NODE_ENV ?? "development"}${buildSha ? ` · ${buildSha.slice(0, 7)}` : ""}`;

  const meta: { k: string; v: string }[] = [
    { k: "Référence", v: ref ?? "Indisponible (erreur client)" },
    { k: "Date", v: when },
    { k: "URL", v: pathname || "—" },
    { k: "Environnement", v: env },
  ];

  const auditHref =
    variant === "admin" && ref
      ? `/admin/system/audit?targetType=error&targetId=${encodeURIComponent(ref)}`
      : null;

  const copyDetails = async () => {
    const text = [
      ...(isDev && message ? [message, ""] : []),
      ...meta.map((m) => `${m.k} : ${m.v}`),
      ...(isDev && stack ? ["", stack] : []),
    ].join("\n");
    // Clipboard API is secure-context only + can reject (permission / not
    // focused). Only flip to "Copié" once the write actually resolves, so the
    // label never claims success on an HTTP origin or a denied grant.
    try {
      if (!navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard denied/unavailable — leave the label unchanged */
    }
  };

  const onRetry = () => {
    if (!reset) return;
    setRetrying(true);
    // Leave the spinner up briefly; `reset` re-renders the segment (which either
    // recovers or re-throws straight back into this boundary).
    setTimeout(() => {
      try {
        reset();
      } finally {
        setRetrying(false);
      }
    }, 150);
  };

  return (
    <div
      className={cn(
        "tokyo flex w-full items-center justify-center",
        fullScreen ? "min-h-dvh bg-surface-beige px-3 py-[clamp(12px,4vw,48px)]" : "px-4 py-12",
      )}
    >
      <main
        aria-labelledby="error-title"
        className="w-full max-w-[640px] overflow-hidden rounded-[24px] border border-border bg-surface text-foreground"
      >
        <div className="flex flex-col gap-5 p-[clamp(24px,4vw,36px)]">
          {/* Header: alert disc + code */}
          <div className="flex items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10">
              <AlertCircle aria-hidden className="size-5 text-primary" strokeWidth={2.2} />
            </span>
            <span className="text-[13px] font-bold tabular-nums text-muted-foreground">Erreur {code}</span>
          </div>

          {/* Title + subtitle */}
          <div className="flex flex-col gap-2">
            <h1 id="error-title" className="text-[clamp(24px,3vw,30px)] font-extrabold leading-[1.15] tracking-[-0.02em]">
              Une erreur est survenue
            </h1>
            <p className="text-[16px] leading-relaxed text-graphite text-pretty">
              Une erreur inattendue s&apos;est produite. Vous pouvez réessayer ou revenir en arrière.
            </p>
          </div>

          {/* Details box */}
          <div className="overflow-hidden rounded-[14px] border border-border">
            <div className="flex items-start gap-2.5 bg-background px-4 py-3.5">
              {isDev && message ? (
                <code className="min-w-0 flex-1 overflow-hidden font-mono text-[14px] leading-normal text-primary-ink [overflow-wrap:anywhere]">
                  {message}
                </code>
              ) : (
                <span className="min-w-0 flex-1 text-[13px] font-semibold text-muted-foreground">
                  Détails techniques
                </span>
              )}
              <button
                type="button"
                onClick={copyDetails}
                aria-label="Copier les détails"
                className="-my-1 -mr-1.5 flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[13px] font-bold text-foreground transition-colors hover:border-foreground"
              >
                {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
                {copied ? "Copié" : "Copier"}
              </button>
            </div>

            <dl className="grid grid-cols-[auto_minmax(0,1fr)] border-t border-border text-[13px]">
              {meta.map((m) => (
                <div key={m.k} className="contents">
                  <dt className="whitespace-nowrap border-b border-border/60 px-4 py-2.5 font-semibold text-muted-foreground">
                    {m.k}
                  </dt>
                  <dd className="border-b border-border/60 px-4 py-2.5 pl-0 font-mono text-[12.5px] text-foreground [overflow-wrap:anywhere]">
                    {m.v}
                  </dd>
                </div>
              ))}
            </dl>

            {isDev && stack && (
              <>
                <button
                  type="button"
                  onClick={() => setStackOpen((v) => !v)}
                  aria-expanded={stackOpen}
                  className="flex h-[42px] w-full items-center justify-between px-4 text-left text-[13px] font-bold text-foreground transition-colors hover:bg-background"
                >
                  Trace d&apos;appel
                  <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", stackOpen && "rotate-180")} strokeWidth={2.4} />
                </button>
                <div className={cn("grid transition-[grid-template-rows] duration-200", stackOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
                  <div className="min-h-0 overflow-hidden">
                    <pre className="m-0 overflow-x-auto whitespace-pre bg-foreground px-4 py-3.5 font-mono text-[12px] leading-[1.7] text-background/80">
                      {stack}
                    </pre>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2.5">
            {reset && (
              <button
                type="button"
                onClick={onRetry}
                disabled={retrying}
                className="flex h-12 flex-1 basis-[180px] items-center justify-center gap-2 rounded-full bg-foreground text-[15px] font-bold text-background transition-colors hover:bg-[#2a2e35] disabled:opacity-70"
              >
                <RotateCw aria-hidden className={cn("size-4", retrying && "animate-spin")} strokeWidth={2.4} />
                {retrying ? "Nouvelle tentative…" : "Réessayer"}
              </button>
            )}
            <Link
              href={homeHref}
              className="flex h-12 flex-1 basis-[180px] items-center justify-center rounded-full border-[1.5px] border-border bg-surface text-[15px] font-bold text-foreground transition-colors hover:border-foreground"
            >
              {homeLabel}
            </Link>
          </div>

          {/* Admin-only: trace in the logs + infrastructure tabs */}
          {variant === "admin" && (
            <div className="flex flex-col gap-2.5 rounded-[14px] border border-border bg-background p-3.5">
              {auditHref ? (
                <Link
                  href={auditHref}
                  className="flex h-10 items-center justify-between gap-3 rounded-[10px] bg-foreground px-3.5 text-[13px] font-bold text-background transition-[filter] hover:brightness-110"
                >
                  <span className="flex items-center gap-2">
                    <ScrollText aria-hidden className="size-4" strokeWidth={2.2} />
                    Voir cette erreur dans le journal
                  </span>
                  <span className="font-mono text-[12px] font-medium text-background/70">{ref}</span>
                </Link>
              ) : (
                <Link
                  href="/admin/system/audit?severity=error"
                  className="flex h-10 items-center gap-2 rounded-[10px] bg-foreground px-3.5 text-[13px] font-bold text-background transition-[filter] hover:brightness-110"
                >
                  <ScrollText aria-hidden className="size-4" strokeWidth={2.2} />
                  Journal d&apos;audit · erreurs
                </Link>
              )}
              <div className="flex flex-wrap gap-1.5">
                {INFRA_LINKS.map((l) => {
                  const Icon = l.icon;
                  return (
                    <Link
                      key={l.href}
                      href={l.href}
                      className="flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-[12px] font-semibold text-foreground transition-colors hover:border-foreground"
                    >
                      <Icon aria-hidden className="size-3.5 text-muted-foreground" strokeWidth={2} />
                      {l.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer: the support reference */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border bg-background px-[clamp(24px,4vw,36px)] py-3.5 text-[13px] text-muted-foreground">
          {ref ? (
            <span>
              Le problème persiste ? Transmettez la référence{" "}
              <strong className="font-mono font-medium text-foreground">{ref}</strong>{" "}
              {variant === "admin" ? "pour retrouver l'incident dans les journaux." : "au support technique."}
            </span>
          ) : (
            <span>
              Erreur côté navigateur — aucune référence serveur. Réessayez ; si le problème persiste, contactez le support.
            </span>
          )}
        </div>
      </main>
    </div>
  );
}
