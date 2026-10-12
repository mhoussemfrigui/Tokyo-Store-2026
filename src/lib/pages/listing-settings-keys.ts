/**
 * The settings keys owned by the compact "Réglages des pages de liste" panel under the
 * home composer — the product-grid pagination mode + the « Besoin d'un conseil » help
 * CTA that render on every category / brand / collection listing page. Kept in a PLAIN
 * module (no "use server") so the server action (home.ts, which needs the labels for the
 * upsert) can import it without a `"use server"` file trying to export a non-function.
 * (The RSC loader hands the panel a pickSettings(["home.","storefront."]) slice.)
 */
export const LISTING_SETTINGS: ReadonlyArray<{ key: string; label: string }> = [
  // Product-grid pagination behaviour on every listing surface.
  { key: "storefront.listing_display_mode", label: "Pages listing — mode d'affichage (charger plus / défilement infini / pagination)" },
  // Listing pages (catégories / marques / collections) — "Besoin d'un conseil" help CTA.
  // Hide-when-unset: blank title OR button label hides the block.
  { key: "storefront.help_cta.eyebrow", label: "Pages listing — aide (eyebrow)" },
  { key: "storefront.help_cta.title", label: "Pages listing — aide (titre)" },
  { key: "storefront.help_cta.body", label: "Pages listing — aide (texte)" },
  { key: "storefront.help_cta.button_label", label: "Pages listing — aide (bouton)" },
  { key: "storefront.help_cta.button_href", label: "Pages listing — aide (lien)" },
  { key: "storefront.help_cta.secondary_label", label: "Pages listing — aide (bouton secondaire)" },
  { key: "storefront.help_cta.secondary_href", label: "Pages listing — aide (lien secondaire)" },
];
