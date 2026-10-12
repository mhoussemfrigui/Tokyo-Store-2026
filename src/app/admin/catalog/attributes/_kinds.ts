import type { AttributeKind } from "@/modules/catalog/attribute/schema";

/**
 * Client-safe attribute-kind metadata shared by the create page, the listing
 * panel and the detail editor. Type-only import of `AttributeKind` is erased at
 * compile time, so this module carries NO runtime dependency on the Drizzle
 * schema and is safe to pull into a client bundle.
 */

/** Options for the kind picker, in the order they should appear. */
export const KIND_OPTIONS: { value: AttributeKind; label: string; description: string }[] = [
  { value: "multiselect", label: "Choix multiples", description: "Cases à cocher — plusieurs valeurs par produit." },
  { value: "select", label: "Choix unique", description: "Boutons radio — une seule valeur par produit." },
  { value: "color", label: "Couleur / pastille", description: "Valeurs avec une pastille de couleur." },
  { value: "boolean", label: "Booléen (Oui / Non)", description: "Présent ou absent sur le produit." },
  { value: "number", label: "Nombre / plage", description: "Valeur numérique saisie par produit." },
  { value: "text", label: "Texte libre", description: "Texte informatif saisi par produit." },
];

/** Short badge label for the listing. */
export const KIND_LABELS: Record<AttributeKind, string> = {
  multiselect: "Choix multiples",
  select: "Choix unique",
  color: "Couleur",
  boolean: "Booléen",
  number: "Nombre",
  text: "Texte",
};

/**
 * Kinds whose options live in `product_attribute_values` and are edited as a
 * list in the admin. `boolean` auto-manages a single value; `number`/`text`
 * carry per-product scalar data, so neither exposes an editable value list.
 */
export const VALUE_LIST_KINDS: readonly AttributeKind[] = ["select", "multiselect", "color"];

export function hasEditableValues(kind: AttributeKind): boolean {
  return VALUE_LIST_KINDS.includes(kind);
}

export function isColorKind(kind: AttributeKind): boolean {
  return kind === "color";
}
