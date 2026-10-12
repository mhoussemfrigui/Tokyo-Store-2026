/**
 * The canonical NAME list for the curated trust/reassurance icon set — kept in
 * its own module (no `lucide-react` import) so SERVER-ONLY code (the trust-badge
 * workflow's zod validation) can check an icon name against the allow-list
 * WITHOUT pulling every lucide component into the server bundle.
 *
 * `trust-icons.ts` imports this list to build the name→component map, so the two
 * can never drift: a name here with no component there (or vice-versa) is a
 * compile/seed error, not a silent fallback.
 */
export const TRUST_ICON_NAMES = [
  "Truck",
  "RotateCcw",
  "ShieldCheck",
  "Headphones",
  "Award",
  "Sparkles",
  "Zap",
  "CreditCard",
  "Clock",
  "Gift",
  "Heart",
  "Star",
  "BadgeCheck",
  "Wrench",
  "Package",
  "Globe2",
  "Percent",
  "Lock",
  "ThumbsUp",
  "Phone",
  "MapPin",
  "Tag",
] as const;

export type TrustIconName = (typeof TRUST_ICON_NAMES)[number];

/** Own-key membership test (prototype-safe) — a stored name like "constructor"
 *  or "__proto__" is NOT a valid icon. */
export function isTrustIconName(name: string | null | undefined): name is TrustIconName {
  return !!name && (TRUST_ICON_NAMES as readonly string[]).includes(name);
}
