/**
 * Permission registry — the SINGLE SOURCE OF TRUTH for what privileges exist.
 *
 * A permission is `<module>:<action>` where `module` is an admin-nav id (see
 * NAV_GROUPS in `src/app/admin/_components/admin-shell.tsx`) and `action` is one
 * of the small, shared vocabulary below. The DB stores only GRANTS
 * (`role_permissions.permission`) referencing these keys; the keys themselves
 * live here so adding a privilege is a one-line edit — no migration, no seed.
 *
 * Granularity is HYBRID: per-module AND per-action. A role may be granted:
 *   - "*"               → everything (super_admin)
 *   - "<module>:*"      → every action on one module ("full access to Catalogue
 *                          → Produits")
 *   - "<module>:<action>" → one action ("view Commandes")
 *
 * To extend:
 *   - new admin section  → add one PERMISSION_MODULES entry (id MUST match the
 *                          nav id so the role editor + nav-visibility line up)
 *   - new capability      → add a string to PERMISSION_ACTIONS, then list it in
 *                          the relevant modules' `actions`
 * super_admin's "*" grant means new keys are covered automatically.
 */

/** Shared action vocabulary. `manage` = section-specific power operations that
 *  aren't plain CRUD (status transitions, refunds, running jobs/imports,
 *  moderation, force-logout, balance adjustments, purges). `export` = downloading
 *  a bulk PII CSV — split off `view`/`manage` as its OWN grant (a bulk file
 *  exfiltration is a materially different surface than paging a UI), so a role can
 *  hold it independently and the operator picks exactly which fields leave. */
// `roles` + `policy` are higher-trust slices split OFF `manage` for the `users`
// module only (they appear solely in that module's action list). `roles` = the
// privilege-GRANTING power (assign roles to an account, author/edit/delete roles,
// set a per-user allow/deny overlay) — the capability that decides who-can-do-what,
// kept separate from routine account ops so "can grant access to others" is its
// own delegable grant. `policy` = the shop-wide SESSION policy (lifetime, cache).
export const PERMISSION_ACTIONS = ["view", "create", "update", "delete", "manage", "export", "roles", "policy"] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export type PermissionModule = {
  /** Must equal the admin-nav item id. */
  id: string;
  /** French label (mirrors the nav label) for the role editor. */
  label: string;
  /** Nav group label — lets the role editor render grouped checkboxes. */
  group: string;
  actions: readonly PermissionAction[];
};

const CRUD = ["view", "create", "update", "delete"] as const;
const VIEW_ONLY = ["view"] as const;
const VIEW_EDIT = ["view", "update"] as const;
const VIEW_MANAGE = ["view", "manage"] as const;

export const PERMISSION_MODULES = [
  // ── Tableau de bord
  // `dashboard:view` is the MASTER SWITCH for the /admin dashboard's data blocks.
  // /admin itself stays open to every staff user (post-login landing), but
  // without this grant it renders only a welcome card. With it, EACH block still
  // needs the view grant of the module it summarises (revenue → analytics,
  // recent orders / « À traiter » → orders, new customers → customers, low stock
  // → stock or products) — see src/lib/rbac/dashboard-access.ts.
  { id: "dashboard", label: "Tableau de bord", group: "Tableau de bord", actions: VIEW_ONLY },
  { id: "analytics", label: "Statistiques", group: "Tableau de bord", actions: VIEW_ONLY },

  // ── Catalogue (incl. the merged Médiathèque + its réglages)
  // "manage" = power ops beyond per-product CRUD (notably BULK AI content
  // generation across the catalogue/a category/a brand — a heavier, costlier op).
  { id: "products", label: "Produits", group: "Catalogue", actions: ["view", "create", "update", "delete", "manage"] },
  // Every stock write — per-location edits, evacuation, AND inter-location
  // TRANSFERS (create/accept/complete/cancel) — is gated on `stock:update`; a
  // transfer IS a stock write, so it shares the grant rather than a separate op.
  // (The reserved `stock:manage` was dropped in migration 0129 — it was never
  // wired, and its promise of a distinct transfers grant was misleading.)
  { id: "stock", label: "Stock", group: "Catalogue", actions: ["view", "update"] },
  { id: "categories", label: "Catégories", group: "Structure du catalogue", actions: CRUD },
  { id: "brands", label: "Marques", group: "Structure du catalogue", actions: CRUD },
  { id: "care", label: "Tokyo Care", group: "Structure du catalogue", actions: ["view", "create", "update", "delete", "manage"] },
  { id: "attributes", label: "Attributs", group: "Structure du catalogue", actions: CRUD },
  { id: "reviews", label: "Avis clients", group: "Catalogue", actions: ["view", "create", "update", "delete", "manage"] },
  { id: "media", label: "Médiathèque", group: "Catalogue", actions: CRUD },
  { id: "system_media", label: "Médiathèque — réglages", group: "Catalogue", actions: VIEW_EDIT },

  // ── Commandes (order processing + the commerce-config levers)
  { id: "orders", label: "Commandes", group: "Commandes", actions: ["view", "update", "manage"] },
  // « Nouvelle commande » — SAISIR a remote operator order (téléphone / réseaux /
  // marketplace) is its OWN grant + nav tab, split OFF orders:manage (which stays
  // the MANAGE grant over the existing Commandes list: edit / status / cancel).
  // `view` opens the tab + form; `create` PLACES the order. createManualOrderAction
  // accepts orders_new:create OR orders:manage, so an owner can grant "peut créer
  // une commande" without full order management (or the reverse). Migration 0109
  // back-fills orders_new:* to every role already holding orders:manage / orders:*.
  { id: "orders_new", label: "Nouvelle commande", group: "Commandes", actions: ["view", "create"] },
  // Paniers is a read-only diagnostic surface (no cart-mutation action exists).
  { id: "cart", label: "Paniers", group: "Commandes", actions: VIEW_ONLY },
  // `returns:manage` is enforced by the return actions (OR `orders:manage`),
  // so a scoped "returns agent" role is delegable — see src/lib/actions/returns.ts.
  { id: "returns", label: "Retours", group: "Commandes", actions: VIEW_MANAGE },
  // SAV / warranty: the read-only coverage lookup (search by order number / phone)
  // PLUS the warranty-CLAIM (RMA) console — open / track / resolve claims, and the
  // keyed /api/warranty-claims write scope (warranty:manage). Warranty DURATION is
  // still edited on the product/category forms (gated by `products`/`categories`).
  { id: "warranty", label: "Garanties", group: "Commandes", actions: VIEW_MANAGE },
  { id: "promotions", label: "Promotions & codes", group: "Marketing", actions: CRUD },
  { id: "system_payments", label: "Paiement & encaissement", group: "Vente & paiement", actions: VIEW_EDIT },
  { id: "system_express", label: "Achat express", group: "Vente & paiement", actions: VIEW_EDIT },
  { id: "system_delivery", label: "Livraison", group: "Vente & paiement", actions: CRUD },
  // Tax RULES are created/edited/removed through the ONE `system_tax:update`
  // grant (there are no separate create/delete gates), so the module is view+edit.
  { id: "system_tax", label: "Taxes", group: "Vente & paiement", actions: VIEW_EDIT },
  { id: "system_currency", label: "Devises", group: "Vente & paiement", actions: CRUD },
  { id: "checkout", label: "Tunnel de commande", group: "Vente & paiement", actions: VIEW_EDIT },

  // ── Clients (audience + the tools that engage it; admin USERS live in Système)
  // New customer accounts are minted via `users:create` (the invite flow), so
  // `customers` has no separate create gate — view/update/delete + manage (balance).
  { id: "customers", label: "Clients", group: "Clients", actions: ["view", "update", "delete", "manage", "export"] },
  // « Invités » (guest orders) is a read-only list + CSV export — `export` gates the
  // bulk PII download separately from `view` (which only pages the on-screen list).
  { id: "invites", label: "Invités", group: "Clients", actions: ["view", "export"] },
  { id: "favorites", label: "Favoris", group: "Clients", actions: ["view", "manage", "export"] },
  { id: "newsletter", label: "Newsletter", group: "Marketing", actions: ["view", "manage", "export"] },
  { id: "system_auth", label: "Connexion & comptes", group: "Système", actions: VIEW_EDIT },

  // ── Contenu & Design (storefront pages/merchandising + site identity)
  { id: "home", label: "Page d'accueil", group: "Contenu & Design", actions: VIEW_EDIT },
  { id: "pages", label: "Pages", group: "Contenu & Design", actions: CRUD },
  { id: "banners", label: "Bannières", group: "Contenu & Design", actions: CRUD },
  // Showcase pages are fixed slugs; only their pins/settings are edited (one
  // `showcase:update` gate) — there is no create/delete of a showcase.
  { id: "showcase", label: "Vitrines", group: "Contenu & Design", actions: VIEW_EDIT },
  { id: "trust_badges", label: "Badges de confiance", group: "Contenu & Design", actions: CRUD },
  { id: "reels", label: "Vidéos (Reels)", group: "Contenu & Design", actions: VIEW_EDIT },
  { id: "navigation", label: "Navigation", group: "Contenu & Design", actions: VIEW_EDIT },
  { id: "settings_theme", label: "Thème & design", group: "Contenu & Design", actions: VIEW_EDIT },
  { id: "settings_site", label: "Identité & contact", group: "Contenu & Design", actions: VIEW_EDIT },

  // ── Blog
  { id: "blog_posts", label: "Articles blog", group: "Blog", actions: CRUD },
  { id: "blog_cats", label: "Catégories blog", group: "Blog", actions: CRUD },
  { id: "blog_tags", label: "Tags blog", group: "Blog", actions: CRUD },
  { id: "blog_authors", label: "Auteurs", group: "Blog", actions: CRUD },
  { id: "blog_comments", label: "Commentaires", group: "Blog", actions: ["view", "update", "delete", "manage"] },

  // ── Système (platform admin + the AI / scheduled-job engines)
  // The user/role administration surface, split into delegable slices:
  //   view   — read the users list + a fiche.
  //   create — mint/invite an account (users:create).
  //   roles  — the GRANT power: assign roles to an account, author/edit/delete
  //            roles, set a per-user allow/deny overlay. The capability that
  //            decides who-can-do-what — held apart from routine account ops so
  //            only a role carrying `users:roles` can give access to others.
  //   policy — the shop-wide session policy (lifetime / renewal / cookie cache).
  //   manage — routine account ops (disable/enable/force-logout/verify/reset/
  //            set-password/set-email/2FA-reset). NO account-type to set anymore.
  { id: "users", label: "Utilisateurs & rôles", group: "Système", actions: ["view", "create", "roles", "policy", "manage"] },
  { id: "system_ai", label: "IA & Automation", group: "Système", actions: ["view", "update", "manage"] },
  // view: see tabs/logs · update: edit templates / toggle flows / settings ·
  // create: compose+send a campaign · manage: pin/delete/resend logs, run sends.
  { id: "system_mail", label: "Campagnes e-mail", group: "Marketing", actions: ["view", "create", "update", "manage"] },
  { id: "system_jobs", label: "Tâches planifiées", group: "Système", actions: VIEW_MANAGE },
  { id: "system_seo", label: "SEO & schéma", group: "Système", actions: VIEW_EDIT },
  { id: "system_redirects", label: "Redirections & 404", group: "Système", actions: VIEW_MANAGE },
  { id: "system_cookies", label: "Cookies & RGPD", group: "Système", actions: VIEW_EDIT },
  { id: "system_analytics", label: "Suivi & Analytics", group: "Système", actions: VIEW_EDIT },
  { id: "system_search", label: "Recherche", group: "Système", actions: VIEW_MANAGE },
  { id: "system_audit", label: "Journal d'audit", group: "Système", actions: VIEW_MANAGE },
  { id: "system_import", label: "Import catalogue", group: "Système", actions: VIEW_MANAGE },
  { id: "system_demo", label: "Importer la démo", group: "Système", actions: VIEW_MANAGE },

  // ── Infrastructure
  { id: "system_api", label: "API & Webhooks", group: "Infrastructure", actions: CRUD },
  // Base de données is view-only diagnostics (pool/index/lock gauges); no
  // mutating action is gated on it.
  { id: "system_database", label: "Base de données", group: "Infrastructure", actions: VIEW_ONLY },
  { id: "system_resources", label: "Ressources", group: "Infrastructure", actions: VIEW_ONLY },
  // "manage" gates the perf thresholds/alerts settings form (mirrors system_audit
  // / system_search). super_admin "*" already covers it; this just makes the
  // grant assignable to a scoped role.
  { id: "system_performance", label: "Performance", group: "Infrastructure", actions: VIEW_MANAGE },
  { id: "system_security", label: "Sécurité", group: "Infrastructure", actions: VIEW_ONLY },
] as const satisfies readonly PermissionModule[];

export type PermissionModuleId = (typeof PERMISSION_MODULES)[number]["id"];

/** Wildcard grant held by super_admin: matches every module:action. */
export const WILDCARD = "*";

const MODULE_BY_ID: Map<string, PermissionModule> = new Map(
  PERMISSION_MODULES.map((m) => [m.id, m]),
);

/** Every concrete `<module>:<action>` key the registry defines (no wildcards). */
export const ALL_PERMISSION_KEYS: readonly string[] = PERMISSION_MODULES.flatMap((m) =>
  m.actions.map((a) => `${m.id}:${a}`),
);

const VALID_KEY_SET = new Set<string>(ALL_PERMISSION_KEYS);

/**
 * Is `key` something a role may legitimately be granted? Accepts the global
 * wildcard, a per-module wildcard (`<module>:*` for a real module), and any
 * concrete registered key. Used by the Phase 3 role editor to reject typos /
 * stale keys before they land in `role_permissions`.
 */
export function isValidPermissionKey(key: string): boolean {
  if (key === WILDCARD) return true;
  if (VALID_KEY_SET.has(key)) return true;
  if (key.endsWith(":*")) return MODULE_BY_ID.has(key.slice(0, -2));
  return false;
}
