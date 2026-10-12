/**
 * PURE eligibility gate for "Markdown for Agents" content negotiation — decides
 * which (already `.md`-stripped) paths may be served as an agent Markdown twin.
 * Imported by the edge proxy (must stay DB-free) AND unit-tested. Excludes
 * private areas, machine endpoints, and any non-`.md` file-extension path.
 */

/** Private / non-content prefixes that must never be served as Markdown. */
export const MD_SKIP_PREFIXES = [
  "/admin",
  "/account",
  "/api",
  "/cdn",
  "/feeds",
  "/md",
  "/login",
  "/register",
  "/reset-password",
  "/verify-email",
  "/checkout",
  "/panier",
  "/order",
  // Order-receipt PII — also in robots.txt PRIVATE_AREAS; keep the two in sync so
  // a receipt path can never be content-negotiated into a Markdown twin.
  "/facture",
  "/favoris",
  "/recherche", // dynamic / query-driven, not a stable page
  "/_next",
] as const;

/** True when `cleanPath` (leading slash, no `.md` suffix) is a public content
 *  page eligible for a Markdown twin. */
export function markdownEligible(cleanPath: string): boolean {
  if (cleanPath === "/" || cleanPath === "") return false; // home is a nav hub
  for (const p of MD_SKIP_PREFIXES) {
    if (cleanPath === p || cleanPath.startsWith(`${p}/`)) return false;
  }
  const last = cleanPath.split("/").pop() ?? "";
  if (last.includes(".")) return false; // /sitemap.xml, /icon.svg, /llms.txt, …
  return true;
}
