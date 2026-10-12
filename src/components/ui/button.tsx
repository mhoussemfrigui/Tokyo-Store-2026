import * as React from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The ONE button in the storefront + admin. Two surfaces off one source of truth:
 * this component AND the matching `.btn*` utilities in globals.css (for <Link>s,
 * server HTML and legacy call-sites). Geometry, sizes, motion, focus ring and
 * disabled/loading states are all defined ONCE in `.btn*`, so no call-site
 * re-specifies height/padding/tracking.
 *
 *   <Button variant="primary" size="lg" loading={pending}>Ajouter au panier</Button>
 *   <Button icon variant="ghost" aria-label="Supprimer"><Trash2 className="h-4 w-4" /></Button>
 *
 * For a Next <Link> / <a>, apply the class string instead and wrap the label:
 *   <Link href="/panier" className={buttonVariants({ variant: "secondary", size: "md" })}>
 *     <span className="btn__label">Voir le panier</span>
 *   </Link>
 */

export type ButtonVariant =
  | "primary"
  | "primary-onyx"
  | "secondary"
  | "ghost"
  | "link"
  | "destructive"
  | "destructive-ghost";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  "primary-onyx": "btn-primary-onyx",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
  link: "btn-link",
  destructive: "btn-destructive",
  "destructive-ghost": "btn-destructive-ghost",
};
const SIZE: Record<ButtonSize, string> = { sm: "btn-sm", md: "btn-md", lg: "btn-lg" };

export function buttonVariants({
  variant = "primary",
  size = "md",
  onDark = false,
  ink = false,
  icon = false,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  onDark?: boolean;
  ink?: boolean;
  icon?: boolean;
} = {}): string {
  return cn(
    "btn",
    SIZE[size],
    VARIANT[variant],
    icon && "btn-icon",
    onDark && "btn-on-dark",
    // Ink is a dark-fill accent; the glow itself is the shared ink-track engine.
    ink && "btn-ink ink-track ink-track-btn",
  );
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  onDark?: boolean;
  ink?: boolean;
  icon?: boolean;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, onDark, ink, icon, loading, disabled, leftIcon, rightIcon, children, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // Default to type="button" so a Button inside a form doesn't submit by accident.
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size, onDark, ink, icon }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      <span className="btn__label">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : leftIcon}
        {children}
        {!loading && rightIcon}
      </span>
    </button>
  );
});
