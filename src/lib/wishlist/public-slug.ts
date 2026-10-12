/**
 * Public-favorites vanity-slug validation (the `/u/<slug>` handle). Pure, no
 * DB/deps — usable on client + server. Rules (adapted from Tokyo's social
 * slugs): 3–30 chars, lowercase `[a-z0-9-]`, must START with a letter, no
 * leading/trailing or consecutive hyphens, and not a reserved word (so a handle
 * can never shadow a real route or look like an internal id).
 */
const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Routes / words a public handle must never be (collision + impersonation). */
const RESERVED = new Set([
  "u", "me", "new", "edit", "settings", "search", "recherche", "admin", "account",
  "compte", "auth", "login", "logout", "register", "api", "static", "public",
  "favoris", "favorites", "panier", "checkout", "order", "orders", "commande",
  "pro", "blog", "auteur", "help", "promo", "marques", "categorie", "produit",
  "null", "undefined", "true", "false", "support", "root", "tokyo", "tokyostore",
]);

export function validatePublicSlug(slug: string): { ok: true; slug: string } | { ok: false; message: string } {
  const s = slug.trim().toLowerCase();
  if (s.length < 3 || s.length > 30) {
    return { ok: false, message: "L'identifiant public doit comporter entre 3 et 30 caractères." };
  }
  if (!SLUG_RE.test(s)) {
    return { ok: false, message: "Lettres minuscules, chiffres et tirets uniquement ; commence par une lettre, pas de tiret en début/fin." };
  }
  if (RESERVED.has(s)) {
    return { ok: false, message: "Cet identifiant est réservé — choisissez-en un autre." };
  }
  return { ok: true, slug: s };
}
