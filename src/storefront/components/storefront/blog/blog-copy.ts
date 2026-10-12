/**
 * Default editorial copy for the blog list surfaces (the mockup's lede + « À
 * propos du blog »). A category uses its own `description` when set; otherwise it
 * falls back to the generic copy below. Kept out of the DB so a fresh deploy
 * reads exactly like the mockup.
 */

export const BLOG_ALL_TITLE = "Tous les articles";
export const BLOG_ALL_LEDE =
  "Guides, comparatifs et astuces de nos conseillers pour bien choisir, utiliser et entretenir votre matériel tech.";
export const BLOG_ABOUT_TITLE = "Des conseils d'experts, pas de la publicité.";
export const BLOG_ABOUT_TEXT =
  "Nos articles sont écrits par les conseillers et techniciens de nos boutiques Mall Lac 2, La Marsa et Menzah 5. Nous testons les produits dont nous parlons et indiquons toujours les prix pratiqués en Tunisie au moment de la publication.";

/** Lede + about copy for a category surface (its description, or the generic). */
export function categoryCopy(description: string | null | undefined): {
  lede: string;
  aboutTitle: string;
  aboutText: string;
} {
  const d = (description ?? "").trim();
  return {
    lede: d || BLOG_ALL_LEDE,
    aboutTitle: BLOG_ABOUT_TITLE,
    aboutText: d || BLOG_ABOUT_TEXT,
  };
}
