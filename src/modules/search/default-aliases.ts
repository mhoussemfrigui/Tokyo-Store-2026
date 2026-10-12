import type { SearchAlias } from "./aliases";

/**
 * Catalogue-derived DEFAULT alias rules for a HIGH-TECH store — seeded on demand by
 * the admin « Recharger les alias par défaut » button (searchService.seedDefaultAliases,
 * source='default', idempotent). NOT applied automatically: a fresh store has zero
 * aliases until an operator seeds/edits them.
 *
 * Every rule is DIRECTIONAL `term → expansion` and stored ALREADY-NORMALIZED
 * (lowercase, unaccented, single-spaced) so it matches the folded query — keep new
 * entries in that form (write "pc portable", not "PC Portable"). The goal is to
 * bridge EN ⇄ FR and abbreviation ⇄ full term so a shopper's wording still finds the
 * product whatever the catalogue's own copy uses (iPhone, smartphones, gaming,
 * audio, accessoires, cartes cadeaux …).
 *
 * Brand/product abbreviations depend on the ACTUAL catalogue — add them per store
 * (a few commented examples below); the mechanism ports, the exact tokens don't.
 */
export const DEFAULT_SEARCH_ALIASES: SearchAlias[] = [
  // ── Téléphonie (EN + abbrev → FR canonical) ──
  { term: "phone", expansion: "telephone" },
  { term: "cell phone", expansion: "telephone portable" },
  { term: "mobile", expansion: "telephone portable" },
  { term: "tablet", expansion: "tablette" },
  // ── Audio ──
  { term: "earbuds", expansion: "ecouteurs" },
  { term: "earphones", expansion: "ecouteurs" },
  { term: "headphones", expansion: "casque" },
  { term: "headset", expansion: "casque" },
  { term: "speaker", expansion: "enceinte" },
  { term: "microphone", expansion: "micro" },
  { term: "wireless", expansion: "sans fil" },
  // ── Accessoires ──
  { term: "charger", expansion: "chargeur" },
  { term: "power bank", expansion: "batterie externe" },
  { term: "powerbank", expansion: "batterie externe" },
  { term: "case", expansion: "coque" },
  { term: "cover", expansion: "coque" },
  { term: "screen protector", expansion: "protection ecran" },
  { term: "tempered glass", expansion: "verre trempe" },
  // ── Objets connectés ──
  { term: "smartwatch", expansion: "montre connectee" },
  { term: "smart watch", expansion: "montre connectee" },
  // ── Informatique ──
  { term: "laptop", expansion: "pc portable" },
  { term: "notebook", expansion: "pc portable" },
  { term: "keyboard", expansion: "clavier" },
  { term: "mouse", expansion: "souris" },
  { term: "monitor", expansion: "ecran" },
  // ── Gaming ──
  { term: "controller", expansion: "manette" },
  { term: "gamepad", expansion: "manette" },
  { term: "ps5", expansion: "playstation 5" },
  { term: "ps4", expansion: "playstation 4" },
  // ── Cartes cadeaux / recharges ──
  { term: "gift card", expansion: "carte cadeau" },
  { term: "giftcard", expansion: "carte cadeau" },
  { term: "voucher", expansion: "recharge" },
  // ── État / condition (EN → FR) ──
  { term: "refurbished", expansion: "reconditionne" },
  { term: "renewed", expansion: "reconditionne" },
  { term: "second hand", expansion: "occasion" },
  { term: "used", expansion: "occasion" },
  { term: "new", expansion: "neuf" },
  // ── Brand spelling / abbreviation variants — align with the REAL catalogue ──
  // { term: "iphone", expansion: "apple iphone" },
  // { term: "psn", expansion: "playstation network" },
];
