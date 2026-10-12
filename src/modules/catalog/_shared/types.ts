/**
 * Catalog shared types.
 *
 * Types used across more than one catalog sub-module live here so that
 * sibling sub-modules (brand, category, product, attribute) don't have
 * to cross-import each other's schema files — which would violate the
 * sub-module isolation rule in `docs/modules.md`.
 */

/** Editorial value-prop card on a category or brand landing page. */
export type CategoryValueProp = {
  icon: string; // lucide icon name
  /** Optional custom médiathèque image id — wins over the lucide `icon` at render. */
  iconMediaId?: string | null;
  title: string;
  body: string;
};
