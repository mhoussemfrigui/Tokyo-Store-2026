"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { iconBtn } from "@/storefront/components/storefront/ui-classes";
import { cn } from "@/storefront/lib/utils";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Phone and tablet sheet, in the mobile menu's language: a floating 28px island
 * 12px off the screen edges (16px from sm), docked right as a 420px panel from
 * md. A real modal dialog — the shell behind it is inert and scroll-locked,
 * focus moves to the close button and stays inside, Escape closes, and focus
 * returns to the control that opened it. Mounted only while open. Shared by the
 * category & search listing filter / sort drawers.
 */
export function Sheet({
  titleId,
  title,
  onClose,
  children,
  headerAction,
  footer,
}: {
  titleId: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** A secondary action beside the close button (e.g. "Tout effacer"). */
  headerAction?: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector("main")?.parentElement;
    const chrome = shell ? (Array.from(shell.children) as HTMLElement[]) : [];
    const wasInert = chrome.map((el) => el.inert);
    chrome.forEach((el) => (el.inert = true));
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      const root = panelRef.current;
      if (e.key !== "Tab" || !root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = root.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onDesktop = () => desktop.matches && onCloseRef.current();
    desktop.addEventListener("change", onDesktop);

    return () => {
      document.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", onDesktop);
      chrome.forEach((el, i) => (el.inert = wasInert[i]));
      document.body.style.overflow = prevOverflow;
      trigger?.focus({ preventScroll: true });
    };
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    /* `tokyo` on the portal root: createPortal mounts under document.body, OUTSIDE
       the layout's `.tokyo` wrapper, so without it the crimson tokens fall back to
       the root olive `--primary` (same class of bug as the SelectField portal). */
    <div className="tokyo fixed inset-0 z-[110] lg:hidden">
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-sm animate-in fade-in duration-200"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute bottom-[calc(0.75rem+env(safe-area-inset-bottom))] left-(--gutter-l) right-(--gutter-r) flex max-h-[calc(100dvh-6rem)] flex-col overflow-hidden rounded-island border border-border bg-background shadow-overlay animate-in slide-in-from-bottom duration-[420ms] ease-soft landscape:max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] sm:bottom-[calc(1rem+env(safe-area-inset-bottom))] md:left-auto md:right-(--envelope-r) md:w-[420px]"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2">
          <h2 id={titleId} className="title-block text-foreground">
            {title}
          </h2>
          <div className="flex items-center gap-2">
            {headerAction}
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Fermer"
              className={cn(iconBtn.base, iconBtn.ghost, "-mr-2")}
            >
              <X aria-hidden className="size-5" />
            </button>
          </div>
        </div>
        {children}
        {footer}
      </div>
    </div>,
    document.body,
  );
}
