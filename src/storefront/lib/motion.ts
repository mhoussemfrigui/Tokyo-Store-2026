/** True when the user asked the OS for reduced motion. Safe on the server. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Scroll behaviour for scrollTo/scrollBy/scrollIntoView that honours reduced motion. */
export function smoothBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
