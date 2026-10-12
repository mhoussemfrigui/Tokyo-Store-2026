/**
 * Functional defaults for the home page, shared by the storefront loader
 * (`home-page-config.ts`, server-only) AND the admin "Page d'accueil" panel
 * (client) so the editable copy the admin sees can never drift from what the
 * storefront renders when a field is left blank. Isomorphic — NO server-only
 * imports here.
 *
 * These are the deliberately-kept defaults the operator explicitly asked to
 * keep editable in place (rail titles). Trust titles/subtitles + the repair
 * block carry no copy default (blank = hidden); only their per-slot icons
 * default.
 */
export const HOME_DEFAULTS = {
  rails: {
    // `label` = the small uppercase eyebrow above each rail title; `title` =
    // the rail heading. These seed the legacy-synthesis rails when no composer
    // layout is saved yet (see synthesizeLegacyHomeBlocks).
    // `promotions` is the « Meilleures Ventes » rail (it shows the top sellers;
    // the key keeps its historical name so stored `home.rail.promotions.*`
    // settings still apply).
    new: { label: "Sélection Exclusive", title: "Nouveautés" },
    promotions: { label: "Les Plus Convoitées", title: "Meilleures Ventes" },
  },
  trust: {
    shippingIcon: "Truck",
    returnsIcon: "RotateCcw",
    warrantyIcon: "ShieldCheck",
  },
  /**
   * Luxury editorial home blocks (replicated from "Tokyo Lovable 2" Index.tsx).
   * All copy defaults to "" so an un-configured field is hidden by the client;
   * only structural href fallbacks carry a functional default so a shown CTA is
   * never dead. Every fallback MUST be a route that exists on the storefront
   * (a showcase page or a (shop) route folder — guarded by
   * storefront-chrome.test.ts); they are also the admin field placeholders.
   * Images are stored as media-id strings (resolved in page.tsx) and therefore
   * have no copy default here.
   */
  fiftyfifty: {
    href: "/nouveautes",
  },
  appointment: {
    href: "/aide",
  },
  complications: {
    href: "/nouveautes",
  },
  heritage: {
    ctaHref: "/apropos",
  },
} as const;
