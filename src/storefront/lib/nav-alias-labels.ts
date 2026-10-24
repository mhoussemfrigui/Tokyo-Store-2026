/**
 * Client-safe display labels for the nav aliases (/bons-plans, /notre-selection,
 * /gift-cards, /precommande). The server-only RESOLVER (which fetches the live product
 * sets) lives in `navAliases.ts`; these labels are shared with client components
 * (category-view, categorySeo) that only need the alias spelling, never the data —
 * so they must not pull the server-only catalogue readers into the client bundle.
 */
export const NAV_ALIAS_LABELS: Record<string, string> = {
  "bons-plans": "Bons plans",
  "notre-selection": "Notre sélection",
  "gift-cards": "Gift Cards",
  precommande: "Précommande",
};

/** The alias's display label, or undefined when the slug is a real category. */
export function navAliasLabel(slug: string): string | undefined {
  return NAV_ALIAS_LABELS[slug];
}

/** Reverse lookup: the alias slug whose label matches (aliases resolve before
 *  categories in the [slug] route, so a label uniquely identifies its alias). */
export function aliasSlugByLabel(label: string): string | undefined {
  return Object.keys(NAV_ALIAS_LABELS).find((s) => NAV_ALIAS_LABELS[s] === label);
}
