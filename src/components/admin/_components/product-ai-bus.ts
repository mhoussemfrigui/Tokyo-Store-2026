/**
 * Tiny client-only event bus for the product editor's "Tout générer (IA)"
 * button. The per-field AI buttons (description, FAQ, SEO) each own
 * their own generation + apply logic and live in separate sub-components, so a
 * form-level "generate everything" button can't call them directly. Instead it
 * broadcasts ONE event and every subscribing field generates itself.
 *
 * `overwrite` carries the single upfront choice: true = replace existing
 * content, false = only fill empty fields (keep what's there). Fields apply WITHOUT
 * re-prompting in this mode (the choice was already made once).
 */

export const PRODUCT_AI_GENERATE_ALL_EVENT = "gz:product-ai-generate-all";

export type GenerateAllDetail = { overwrite: boolean };

export function emitProductGenerateAll(detail: GenerateAllDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PRODUCT_AI_GENERATE_ALL_EVENT, { detail }));
}

export function onProductGenerateAll(handler: (detail: GenerateAllDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const fn = (e: Event) => handler((e as CustomEvent<GenerateAllDetail>).detail);
  window.addEventListener(PRODUCT_AI_GENERATE_ALL_EVENT, fn);
  return () => window.removeEventListener(PRODUCT_AI_GENERATE_ALL_EVENT, fn);
}

/**
 * Reverse channel: each subscribing AI field reports its progress back UP during
 * a "Tout générer" run, so the form-level bar can render a live progress bar +
 * log. Fields emit `start` synchronously when the generate-all event fires (so
 * the bar learns the total in the same tick) and `done`/`error` when each call
 * settles. Only auto (generate-all) runs report — a lone manual field click keeps
 * its own inline spinner and is ignored by the bar.
 */
export const PRODUCT_AI_FIELD_PROGRESS_EVENT = "gz:product-ai-field-progress";

export type FieldProgressDetail = {
  field: string;
  status: "start" | "done" | "error";
  message?: string;
};

export function emitFieldProgress(detail: FieldProgressDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PRODUCT_AI_FIELD_PROGRESS_EVENT, { detail }));
}

export function onFieldProgress(handler: (detail: FieldProgressDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const fn = (e: Event) => handler((e as CustomEvent<FieldProgressDetail>).detail);
  window.addEventListener(PRODUCT_AI_FIELD_PROGRESS_EVENT, fn);
  return () => window.removeEventListener(PRODUCT_AI_FIELD_PROGRESS_EVENT, fn);
}
