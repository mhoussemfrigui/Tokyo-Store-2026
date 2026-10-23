/**
 * Safe-href sanitiser for any URL/path coming from the database (banner CTAs,
 * promo chip hrefs, nav items, settings.*, etc.).
 *
 * Admin can legitimately enter:
 *   - Same-origin paths:  /smartphones, /casques, /help
 *   - Anchors:            #section
 *   - Mailto:             mailto:support@tokyostore.tn
 *   - Tel:                tel:+21670000000
 *   - Absolute https:     https://partner.example.com
 *
 * Everything else (javascript:, data:, vbscript:, file:, protocol-relative
 * `//evil.com`, backslash-prefixed) is forced to `"#"` so a compromised admin
 * (or a future SSRF that writes settings) can't smuggle script execution
 * through a rendered `<a href={...}>` or `<Link href={...}>`.
 *
 * The function is intentionally permissive enough for normal CMS use and
 * strict enough that XSS-via-link-scheme is impossible.
 */

import { z } from "zod";

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * Zod schema for any URL-bearing form field (banner CTA, promo link href,
 * nav item href, page-section CTA, social URL, media url_override).
 *
 * Drizzle's z.string().url() ACCEPTS `javascript:alert(1)` because the
 * URL spec considers it a valid URL — that's a stored-XSS / open-redirect
 * footgun when the value is later rendered as an `<a href>`. Use this
 * schema instead.
 */
export const safeHrefSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => {
      if (v === "") return true;
      // Anchor link (same page).
      if (v.startsWith("#")) return true;
      // Same-origin path: must be `/` + non-slash + non-backslash to block
      // protocol-relative bypass `//evil.com`.
      // eslint-disable-next-line no-control-regex
      if (/^\/(?![/\\])/.test(v) && !/[\x00-\x1f\x7f]/.test(v)) return true;
      // Absolute URL — must parse + be in the allow-list.
      try {
        const u = new URL(v);
        return SAFE_PROTOCOLS.has(u.protocol);
      } catch {
        return false;
      }
    },
    "URL invalide (http(s)://, mailto:, tel:, chemin /relatif ou #ancre uniquement).",
  );

export function safeHref(input: string | null | undefined): string {
  if (!input) return "#";
  const trimmed = input.trim();
  if (!trimmed) return "#";

  // Reject control chars + whitespace within the URL. Block-list is intentional.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return "#";

  // Anchor link (same page).
  if (trimmed.startsWith("#")) return trimmed;

  // Same-origin path. Must start with exactly one slash followed by NOT
  // another slash and NOT a backslash — blocks protocol-relative bypasses
  // like `//evil.com` and `/\evil.com`.
  if (/^\/(?![/\\])/.test(trimmed)) return trimmed;

  // Absolute URL — must parse and have an allowed protocol.
  try {
    const u = new URL(trimmed);
    if (!SAFE_PROTOCOLS.has(u.protocol)) return "#";
    return u.toString();
  } catch {
    return "#";
  }
}
