/**
 * Shared client-side helpers for the product editor's one-click AI generation.
 *
 * The AI buttons (description / FAQ / SEO / catégorisation / attributs /
 * variantes) build their model context from the LIVE product form at click
 * time, so generation always reflects the latest typed values without lifting
 * every field into React state. Kept in a standalone util (not in
 * `product-form.tsx`) so the variants editor can reuse them without a circular
 * import.
 */

/** Id of the MAIN product <form> (set on the form element in product-form). */
export const PRODUCT_FORM_ID = "gz-product-form";
/** Id of the category <form> (set on the form element in category-form). */
export const CATEGORY_FORM_ID = "gz-category-form";
/** Id of the brand <form> (set on the form element in brand-form). */
export const BRAND_FORM_ID = "gz-brand-form";
/** Id of the collection <form> (set on the form element in collection-form). */
export const COLLECTION_FORM_ID = "gz-collection-form";

/** Live value of a named field in a given form by id (client-only; "" off-DOM). */
export function readField(formId: string, name: string): string {
  if (typeof document === "undefined") return "";
  const form = document.getElementById(formId) as HTMLFormElement | null;
  const el = form?.elements.namedItem(name) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLSelectElement
    | null;
  const v = el && "value" in el ? el.value : "";
  return typeof v === "string" ? v.trim() : "";
}

/** Live value of a named field in the main product form. */
export function readProductField(name: string): string {
  return readField(PRODUCT_FORM_ID, name);
}

// JSON extraction + HTML→text come from the single pure source of truth
// (`@/lib/ai/parse`, client-safe — no server-only deps). Re-exported here so the
// form call sites keep importing them from this module. parse's `htmlToText`
// clamps to a sane default (keeps prompt context bounded) and `extractJson` is
// string-aware (survives brackets/quotes inside values).
export { extractJson, htmlToText } from "@/lib/ai/parse";
