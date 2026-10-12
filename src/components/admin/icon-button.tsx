"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

/**
 * Consistent admin icon-button — use this for round icon-only buttons
 * instead of ad-hoc `h-7 w-7` / `h-9 w-9` / `h-10 w-10` one-offs, so the
 * sizing/tone language stays uniform across panels.
 *
 * Defaults to 40px (h-10 w-10) so it clears WCAG's 44px target margin
 * once the modal/page padding is counted. Three tones map to common
 * intents: `neutral` (most icon buttons), `danger` (delete), `primary`
 * (the main "open form" CTA next to a list).
 *
 * Shows a spinner instead of the icon when `pending` is true so the
 * caller doesn't have to repeat the same conditional everywhere.
 */
type Tone = "neutral" | "danger" | "primary";
type Size = "sm" | "md";

const TONE_CLS: Record<Tone, string> = {
  neutral:
    "bg-surface text-muted-foreground hover:bg-secondary hover:text-foreground",
  danger:
    "bg-surface text-muted-foreground hover:bg-[var(--accent)] hover:text-destructive",
  primary:
    "bg-primary text-primary-foreground hover:bg-[var(--admin-accent-strong)]",
};

const SIZE_CLS: Record<Size, string> = {
  sm: "h-9 w-9 rounded-[11px]",
  md: "h-11 w-11 rounded-[14px]",
};

const ICON_SIZE: Record<Size, string> = {
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
};

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ReactNode;
  /** Required accessibility label — there's no visible text. */
  "aria-label": string;
  tone?: Tone;
  size?: Size;
  pending?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { icon, tone = "neutral", size = "md", pending, className = "", disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={pending || disabled}
      className={`grid shrink-0 place-items-center transition disabled:opacity-50 disabled:cursor-not-allowed ${SIZE_CLS[size]} ${TONE_CLS[tone]} ${className}`}
      {...rest}
    >
      {pending ? <Loader2 className={`${ICON_SIZE[size]} animate-spin`} /> : icon}
    </button>
  );
});
