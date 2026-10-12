import type { ReactNode } from "react";

import { PageTop } from "@/storefront/components/storefront/page-top";
import { card, rhythm } from "@/storefront/components/storefront/ui-classes";
import { cn } from "@/storefront/lib/utils";

/**
 * Shared layout for the storefront auth pages (login, register, password reset,
 * 2FA) — the Tokyo design: a PageTop crumb/title over a centred card. Forms drop
 * their fields in as `children`; `footer` is the muted link row under the card.
 */
export function AuthShell({
  crumbLabel,
  title,
  subtitle,
  children,
  footer,
}: {
  crumbLabel: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <>
      <PageTop crumbs={[{ label: "Accueil", to: "/" }, { label: crumbLabel }]} title={title} />
      <div className={cn("page-container", rhythm.island)}>
        <div className="mx-auto w-full max-w-md pb-8">
          <div className={cn(card, "p-6 lg:p-8")}>
            {subtitle ? <p className="mb-6 text-sm text-muted-foreground">{subtitle}</p> : null}
            {children}
          </div>
          {footer ? <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div> : null}
        </div>
      </div>
    </>
  );
}

/** Field error line, Tokyo style. */
export function FieldError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 pl-1 text-[12px] font-medium text-destructive">
      {message}
    </p>
  );
}

/** A general (non-field) alert banner for an action's error/success message. */
export function AuthNotice({ tone, children }: { tone: "error" | "success"; children: ReactNode }) {
  return (
    <p
      role="alert"
      className={cn(
        "mb-5 rounded-inner px-4 py-3 text-[13px] font-medium",
        tone === "error"
          ? "bg-destructive/10 text-destructive"
          : "bg-success/10 text-success",
      )}
    >
      {children}
    </p>
  );
}
