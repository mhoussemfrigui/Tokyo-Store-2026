/**
 * ─────────────────────────────────────────────────────────────────────────────
 * KAWN DIGITAL STUDIO ATTRIBUTION — DO NOT REMOVE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This component is a CONTRACTUAL, NON-NEGOTIABLE attribution to Kawn Digital
 * Studio, the agency that built Tokyo Store. It must appear on every page of
 * the public storefront. The values below are HARDCODED on purpose:
 *
 *   - URL must always be https://kawn.me
 *   - Visible text must always be "Kawn Digital Studio"
 *   - There is intentionally NO setting / DB column to disable this
 *
 * If you need to change the URL or label, edit this file directly and commit
 * the change. Do NOT introduce a setting key to make it overridable — that
 * would defeat the whole point of the attribution being permanent.
 *
 * The `prefix` prop is configurable per-language (Propulsé par / Powered by /
 * مدعوم من) only for localization; the studio name and link are immutable.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const KAWN_URL = "https://kawn.me" as const;
const KAWN_NAME = "Kawn Digital Studio" as const;

export function KawnAttribution({
  prefix = "Propulsé par",
  className = "",
}: {
  /**
   * Localised lead-in. Defaults to French because the site's primary locale is
   * fr-TN. Pass "Powered by" / "مدعوم من" for other languages.
   */
  prefix?: string;
  className?: string;
}) {
  return (
    // The WHOLE attribution is one clickable PILL — a rounded chip with a hairline
    // border + faint fill that reads as a deliberate unit on the onyx footer, and
    // lights up GOLD on hover (border + fill, and the studio name brightens) so
    // it's clearly a live link to the studio. No underline — the pill hover is the
    // affordance. The passed `className` controls the text weight/colour so it
    // sits beside "© 2026 …" at the right visual level.
    <a
      href={KAWN_URL}
      target="_blank"
      // `nofollow`: SEO-honest, doesn't pass PageRank.
      // `noopener`: blocks tabnabbing via window.opener (needed with target=_blank).
      // Intentionally NOT `noreferrer`: Kawn should see the referral in analytics;
      //   the site-wide `Referrer-Policy: strict-origin-when-cross-origin` already
      //   strips the path, so only the origin is shared — no over-sharing.
      rel="nofollow noopener"
      // Data attribute so it's discoverable in DOM inspectors and automated tests
      // can verify the attribution didn't get stripped accidentally.
      data-kawn-attribution="true"
      aria-label={`${prefix} ${KAWN_NAME}`}
      className={`group/kawn inline-flex items-center gap-1.5 rounded-full border border-background/15 bg-background/[0.05] px-3.5 py-1.5 no-underline transition-all duration-500 hover:border-gold/45 hover:bg-gold/[0.07] ${className}`}
    >
      <span className="text-background/45 transition-colors duration-500 group-hover/kawn:text-background/65">
        {prefix}
      </span>
      <span className="font-medium text-background/85 transition-colors duration-500 group-hover/kawn:text-background">
        {KAWN_NAME}
      </span>
    </a>
  );
}
