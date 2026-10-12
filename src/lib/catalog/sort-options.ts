/**
 * Shared sort options for the storefront catalogue (category / collection pages).
 *
 * Stable `value`s decouple the sort STATE (and any future URL/query persistence)
 * from the visible French `label`s. Consumers that historically keyed their sort
 * state off the LABEL (e.g. the category page's `sorted` switch) keep working by
 * mapping value ↔ label via the helpers below — so the labels and ordering here
 * MUST stay byte-identical to what those surfaces render today.
 */
export const SORT_OPTIONS = [
  // "En vedette" (featured) is the default: it falls through the category page's
  // sort switch to the curated/natural order (`default: return res`).
  { value: "featured", label: "En vedette" },
  { value: "newest", label: "Nouveautés" },
  { value: "price_asc", label: "Prix croissant" },
  { value: "price_desc", label: "Prix décroissant" },
  { value: "name", label: "Nom A-Z" },
] as const;

export type SortValue = (typeof SORT_OPTIONS)[number]["value"];
export type SortLabel = (typeof SORT_OPTIONS)[number]["label"];

/** value → visible French label (e.g. "price_asc" → "Prix croissant"). */
export function sortLabel(value: string): SortLabel {
  return (SORT_OPTIONS.find((o) => o.value === value) ?? SORT_OPTIONS[0]).label;
}

/** visible French label → stable value (e.g. "Prix croissant" → "price_asc"). */
export function sortValue(label: string): SortValue {
  return (SORT_OPTIONS.find((o) => o.label === label) ?? SORT_OPTIONS[0]).value;
}
