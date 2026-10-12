/**
 * Info-pages registry — the shared chrome of the « pages d'information » (about,
 * recrutement, aide, livraison, garantie + the legal pages). It drives the hero
 * eyebrow (the page's GROUP), the grouped side-nav and the « legal » detection
 * (updated pill + Imprimer + Sommaire TOC). Mirrors the X-Pages mockup's
 * GROUPS / SHORT / LEGAL / UPDATED data, so a seeded system page with one of
 * these slugs renders inside the full designed shell.
 *
 * NOTE: the PAGE BODY is composed of editable blocks (pages.blocks) rendered by
 * `InfoBlocks`; this registry only owns the page-level navigation chrome around
 * them. A CMS page whose slug is NOT listed here renders its blocks plainly
 * (no side-nav / group hero) — custom operator pages stay clean.
 */

export type InfoGroupKey = "maison" | "aide" | "legal";

export type InfoPageEntry = {
  slug: string;
  group: InfoGroupKey;
  /** Side-nav label (short form for the legal pages). */
  navLabel: string;
};

/** Human group titles + order (matches the mockup side-nav). */
export const INFO_GROUPS: { key: InfoGroupKey; label: string }[] = [
  { key: "maison", label: "Tokyo Store" },
  { key: "aide", label: "Aide" },
  { key: "legal", label: "Légal" },
];

/** The ten info pages, in nav order, grouped. */
export const INFO_PAGES: InfoPageEntry[] = [
  { slug: "apropos", group: "maison", navLabel: "À propos" },
  { slug: "recrutement", group: "maison", navLabel: "Recrutement" },
  { slug: "aide", group: "aide", navLabel: "Aide & contact" },
  { slug: "livraison", group: "aide", navLabel: "Livraison & retours" },
  { slug: "garantie", group: "aide", navLabel: "Garantie & SAV" },
  { slug: "mentions", group: "legal", navLabel: "Mentions légales" },
  { slug: "cgv", group: "legal", navLabel: "CGV" },
  { slug: "cgu", group: "legal", navLabel: "CGU" },
  { slug: "confidentialite", group: "legal", navLabel: "Confidentialité" },
  { slug: "cookies", group: "legal", navLabel: "Cookies" },
];

const BY_SLUG = new Map(INFO_PAGES.map((p) => [p.slug, p]));

/** The date shown in the legal pages' « Mise à jour » pill. */
export const INFO_UPDATED = "11 octobre 2026";

export function infoPage(slug: string): InfoPageEntry | null {
  return BY_SLUG.get(slug) ?? null;
}
export function isInfoPage(slug: string): boolean {
  return BY_SLUG.has(slug);
}
export function isLegalInfoPage(slug: string): boolean {
  return BY_SLUG.get(slug)?.group === "legal";
}
export function infoGroupLabel(key: InfoGroupKey): string {
  return INFO_GROUPS.find((g) => g.key === key)?.label ?? "";
}

/** The side-nav model: groups, each with its live links + the current page flag. */
export function infoNavModel(currentSlug: string) {
  return INFO_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    items: INFO_PAGES.filter((p) => p.group === g.key).map((p) => ({
      slug: p.slug,
      href: `/${p.slug}`,
      label: p.navLabel,
      current: p.slug === currentSlug,
    })),
  }));
}
