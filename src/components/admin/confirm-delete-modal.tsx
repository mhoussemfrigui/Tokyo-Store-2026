"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, Loader2, Trash2, X, type LucideIcon } from "lucide-react";

/**
 * Shared confirm-delete modal — the admin-wide replacement for native
 * browser `confirm()` dialogs.
 *
 * Usage:
 *   const [pending, setConfirming] = useState<Item | null>(null);
 *   ...
 *   <button onClick={() => setConfirming(item)}>Trash</button>
 *   {pending && (
 *     <ConfirmDeleteModal
 *       title="Supprimer ce produit ?"
 *       description={pending.name}
 *       onCancel={() => setConfirming(null)}
 *       onConfirm={async () => {
 *         const res = await deleteProductAction(pending.id);
 *         return res.ok ? null : (res.message ?? "Erreur");
 *       }}
 *     />
 *   )}
 *
 * Why a modal instead of `confirm()`:
 *   - Native confirm() is unstyleable, can't show a preview, and reads as
 *     "this is an alert" rather than "this is part of the dashboard".
 *   - We can render the item being deleted (filename, image, title) so
 *     accidental-delete is much less likely on a busy list page.
 *   - Loading state, error inline, ESC-to-cancel, click-outside-cancel.
 *
 * Variants:
 *   - "destructive" (DEFAULT): red icon chip + red confirm button + trash
 *     icon. The original behaviour — every existing delete/disable call site
 *     keeps it by omitting `variant`.
 *   - "neutral": muted icon chip + primary confirm button + a check icon (or a
 *     caller-supplied `icon`). Use for confirmations that aren't deletions —
 *     e.g. "send password reset", "mark email verified" — so they don't read
 *     as an irreversible DELETE.
 *
 * Accessibility:
 *   - Focus trap is not implemented (overkill for an admin tool that
 *     already requires auth + role). ESC + click-outside cover the
 *     usability path. Reading order: title → description → preview →
 *     [Cancel] [Confirm].
 */
export function ConfirmDeleteModal({
  title,
  description,
  preview,
  confirmLabel = "Supprimer",
  cancelLabel = "Annuler",
  variant = "destructive",
  icon: IconOverride,
  onCancel,
  onConfirm,
}: {
  title: string;
  /** Subtle copy under the title — explain the consequence. */
  description?: string;
  /** Optional richer preview (thumbnail + filename, etc.). Renders above the buttons. */
  preview?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * Visual tone. "destructive" (default) keeps the original red trash styling;
   * "neutral" uses a muted icon chip + primary confirm button for
   * non-deletion confirmations.
   */
  variant?: "destructive" | "neutral";
  /** Override the header icon (defaults: Trash2 for destructive, Check for neutral). */
  icon?: LucideIcon;
  onCancel: () => void;
  /**
   * Async confirm handler. Return `null` on success (modal closes via
   * onCancel), or an error message string to show inline.
   */
  onConfirm: () => Promise<string | null>;
}) {
  const isDestructive = variant === "destructive";
  const HeaderIcon = IconOverride ?? (isDestructive ? Trash2 : Check);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, pending]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 grid place-items-center bg-foreground/40 p-4 backdrop-blur-sm"
      onClick={(e) => {
        // Click-outside dismiss (only on the backdrop, not the dialog).
        if (e.target === e.currentTarget && !pending) onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-[28px] border border-border bg-card p-6 shadow-[0_30px_80px_rgba(14,18,24,0.25)]">
        <div className="mb-3 flex items-start gap-3">
          <span
            className={`grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[16px] ${
              isDestructive ? "bg-[var(--accent)] text-destructive" : "bg-[var(--accent)] text-primary"
            }`}
          >
            <HeaderIcon className="h-[22px] w-[22px]" strokeWidth={2.2} />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <h3 className="text-[20px] font-black tracking-[-0.02em] text-foreground">{title}</h3>
            {description && (
              <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            aria-label="Fermer"
            className="grid h-8 w-8 place-items-center rounded-[10px] text-muted-foreground transition hover:bg-surface disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {preview && <div className="mt-1">{preview}</div>}

        {err && (
          <p className="mt-3 rounded-[14px] border border-destructive/30 bg-[var(--accent)] px-3 py-2 text-[13px] text-destructive">
            {err}
          </p>
        )}

        <div className="mt-5 grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="inline-flex h-12 items-center justify-center rounded-full border-[1.5px] border-input bg-card px-4 text-[15px] font-bold text-foreground transition hover:bg-surface disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setErr(null);
                const result = await onConfirm();
                if (result) setErr(result);
                else onCancel();
              })
            }
            className={`inline-flex h-12 items-center justify-center gap-2 rounded-full px-4 text-[15px] font-extrabold transition hover:brightness-110 disabled:opacity-60 ${
              isDestructive
                ? "bg-destructive text-destructive-foreground"
                : "bg-primary text-primary-foreground"
            }`}
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <HeaderIcon className="h-4 w-4" />
            )}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
