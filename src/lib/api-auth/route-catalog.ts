import type { ApiAction, ApiResource } from "./scopes";
import { scopeFor } from "./scopes";

/**
 * Single source of truth for the HTTP API surface under `src/app/api/**`.
 *
 * Three tiers, by who may call and how it is guarded:
 *   - "external"    — the public-facing data API. Key-required BY DEFAULT
 *                     (max-security posture); an admin may mark individual READ
 *                     routes public. Writes are NEVER public. Each carries a
 *                     concrete scope ("products:write", …). Enforced by
 *                     `enforceExternalApi()` (see ./enforce).
 *   - "first-party" — the storefront's own browser routes (search, funnel
 *                     tracking). Same-origin + IP rate-limited, no key.
 *   - "infra"       — auth catch-all, payment webhook, cron, admin-session
 *                     routes. Each keeps its own guard; not key-gated here.
 *
 * This catalog drives THREE things so they never drift:
 *   1. the route-inventory tab (segmented by `domain`),
 *   2. the settings tab (per-route public toggle on external reads),
 *   3. request enforcement (scope lookup by `id`).
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
export type RouteTier = "external" | "first-party" | "infra";

/** Segmentation bucket for the inventory tab. */
export type RouteDomain =
  | "products"
  | "categories"
  | "brands"
  | "attributes"
  | "stock"
  | "orders"
  | "customers"
  | "warranty"
  | "content"
  | "blog"
  | "reviews"
  | "search"
  | "tracking"
  | "webhooks"
  | "auth"
  | "admin"
  | "système";

export type ApiRoute = {
  /** Stable id; for external READ routes this is the public-toggle key. */
  id: string;
  method: HttpMethod;
  path: string;
  tier: RouteTier;
  domain: RouteDomain;
  /** External only — the resource/action and concrete scope this route needs. */
  resource?: ApiResource;
  action?: ApiAction;
  scope?: string;
  /** True only for external READ routes — writes can never be made public. */
  canBePublic: boolean;
  /** Documentary auth label shown for non-external tiers. */
  authLabel?: string;
  notes: string;
};

const ext = (
  id: string,
  method: HttpMethod,
  path: string,
  resource: ApiResource,
  action: ApiAction,
  notes: string,
  /**
   * Per-route override of the "read routes may be toggled public" default.
   * Pass `false` to keep a READ route key-only even though it's a read — used
   * for routes whose payload carries customer PII (orders), so an admin can
   * never accidentally expose it keyless via the API settings panel.
   */
  opts?: { canBePublic?: boolean },
): ApiRoute => ({
  id,
  method,
  path,
  tier: "external",
  domain: resource,
  resource,
  action,
  scope: scopeFor(resource, action),
  canBePublic: action === "read" && (opts?.canBePublic ?? true),
  notes,
});

/**
 * The key-gated external data API. Reads can be toggled public; writes always
 * require a scoped key. Write endpoints are thin wrappers over the SAME admin
 * workflows the dashboard uses (actor = the key's `created_by`).
 */
export const EXTERNAL_API_ROUTES: ApiRoute[] = [
  // Products
  ext("products.list", "GET", "/api/products", "products", "read", "Liste produits, OU recherche par référence (?sku=, ?gtin=, ?externalRef=) ; sinon category, limit, offset."),
  ext("products.get", "GET", "/api/products/[slug]", "products", "read", "Produit par slug."),
  ext("products.create", "POST", "/api/products", "products", "write", "Créer un produit."),
  ext("products.upsert", "PUT", "/api/products", "products", "write", "Créer-ou-modifier par référence (matchBy: externalRef | sku | gtin)."),
  ext("products.update", "PATCH", "/api/products", "products", "write", "Modifier un produit (productId dans le corps)."),
  ext("products.delete", "DELETE", "/api/products", "products", "write", "Archiver un produit (productId | externalRef | sku | gtin)."),
  ext("products.attributes.get", "GET", "/api/products/[slug]/attributes", "products", "read", "Valeurs d'attributs + scalaires (number/text) d'un produit (?by=slug|sku|gtin|externalRef|id)."),
  ext("products.attributes.set", "PUT", "/api/products/[slug]/attributes", "products", "write", "Remplacer les valeurs d'attributs et/ou définir les scalaires d'un produit (attributeValueIds, attributeScalars)."),
  // Categories
  ext("categories.list", "GET", "/api/categories", "categories", "read", "Liste des catégories (arbre), OU ?flat=1 (liste plate), OU recherche par référence (?externalRef=, ?slug=, ?id=)."),
  ext("categories.create", "POST", "/api/categories", "categories", "write", "Créer une catégorie."),
  ext("categories.upsert", "PUT", "/api/categories", "categories", "write", "Créer-ou-modifier par référence (matchBy: externalRef | slug)."),
  ext("categories.update", "PATCH", "/api/categories", "categories", "write", "Modifier une catégorie (categoryId dans le corps)."),
  ext("categories.delete", "DELETE", "/api/categories", "categories", "write", "Archiver une catégorie (categoryId | externalRef | slug, en requête ou corps)."),
  ext("categories.attributes.get", "GET", "/api/categories/[slug]/attributes", "categories", "read", "Attributs exposés comme filtres sur une catégorie (?by=slug|externalRef|id)."),
  ext("categories.attributes.set", "PUT", "/api/categories/[slug]/attributes", "categories", "write", "Remplacer l'ensemble des attributs-filtres d'une catégorie (attributeIds)."),
  // Brands
  ext("brands.list", "GET", "/api/brands", "brands", "read", "Liste des marques (search, limit, offset), OU recherche par référence (?externalRef=, ?slug=, ?id=)."),
  ext("brands.create", "POST", "/api/brands", "brands", "write", "Créer une marque."),
  ext("brands.upsert", "PUT", "/api/brands", "brands", "write", "Créer-ou-modifier par référence (matchBy: externalRef | slug)."),
  ext("brands.update", "PATCH", "/api/brands", "brands", "write", "Modifier une marque (brandId dans le corps)."),
  ext("brands.delete", "DELETE", "/api/brands", "brands", "write", "Archiver une marque (brandId | externalRef | slug, en requête ou corps)."),
  // Attributes (+ values)
  ext("attributes.list", "GET", "/api/attributes", "attributes", "read", "Attributs actifs et leurs valeurs."),
  ext("attributes.create", "POST", "/api/attributes", "attributes", "write", "Créer un attribut (+ valeurs initiales)."),
  ext("attributes.update", "PATCH", "/api/attributes", "attributes", "write", "Modifier un attribut (attributeId dans le corps)."),
  ext("attributes.delete", "DELETE", "/api/attributes", "attributes", "write", "Archiver un attribut (id en requête ou corps)."),
  ext("attributes.value.create", "POST", "/api/attributes/values", "attributes", "write", "Créer une valeur d'attribut."),
  ext("attributes.value.update", "PATCH", "/api/attributes/values", "attributes", "write", "Modifier une valeur (valueId dans le corps)."),
  ext("attributes.value.delete", "DELETE", "/api/attributes/values", "attributes", "write", "Supprimer une valeur (id en requête ou corps)."),
  // Stock (delegates to the product update workflow)
  ext("stock.get", "GET", "/api/stock", "stock", "read", "Stock d'un produit ou d'une variante (productId|externalRef|sku|gtin|variantId|variantSku)."),
  ext("stock.update", "PATCH", "/api/stock", "stock", "write", "Ajuster le stock : { ref, stockDelta: ±N } (ajout/retrait atomique) OU { ref, stockQty?, inStock? } (valeur absolue)."),
  ext("stock.movements", "GET", "/api/stock/movements", "stock", "read", "Journal des MOUVEMENTS de stock (réconciliation ERP) : keyset ?since=&sinceId= ; filtres productId|externalRef|sku|gtin, ?variantId, ?orderId, ?reason.", { canBePublic: false }),
  // Orders (ERP read + status push; creation stays admin-only). Order reads
  // expose customer PII (name, email, phone, address, payment ref) so they are
  // key-ONLY — never eligible for the public toggle (canBePublic: false).
  ext("orders.list", "GET", "/api/orders", "orders", "read", "Liste commandes pour synchro incrémentale : ?status=, ?since= (ISO) + ?sinceId= (curseur composite updated_at,id), ?limit, OU une commande par ?externalRef= / ?orderNumber=.", { canBePublic: false }),
  ext("orders.create", "POST", "/api/orders", "orders", "write", "Pousser une commande ERP/POS : lignes par référence produit (sku|gtin|externalRef|productId + variante) + client/adresse/livraison + canal de règlement (cash|bank_transfer|cod). Live-pricing, décrément stock atomique ; { externalRef? } lie la commande."),
  ext("orders.get", "GET", "/api/orders/[id]", "orders", "read", "Une commande complète (lignes incluses) par id — le segment [id] accepte l'UUID ou la référence externe (externalRef).", { canBePublic: false }),
  ext("orders.shipments", "GET", "/api/orders/[id]/shipments", "orders", "read", "Les expéditions (colis) d'une commande : quantités par ligne, tracking_ref, numéro de bon de livraison.", { canBePublic: false }),
  ext("orders.refunds", "GET", "/api/orders/[id]/refunds", "orders", "read", "Le journal des remboursements d'une commande (montant en millimes + motif).", { canBePublic: false }),
  ext("orders.history", "GET", "/api/orders/[id]/history", "orders", "read", "L'historique des changements de statut d'une commande (transitions from/to).", { canBePublic: false }),
  ext("orders.returns", "GET", "/api/orders/[id]/returns", "orders", "read", "Les retours (RMA) d'une commande avec leurs lignes.", { canBePublic: false }),
  // Fulfilment WRITES (ERP / WMS push) — thin wrappers over the same workflows
  // the dashboard uses (order lock + over-ship/over-return guards).
  ext("orders.create_shipment", "POST", "/api/orders/[id]/shipments", "orders", "write", "Créer une expédition (colis partiel) : { lines:[{orderItemId,quantity}], deliveryMethod?, deliveryAgentName?, trackingRef?, notes?, markShipped? }."),
  ext("orders.create_refund", "POST", "/api/orders/[id]/refunds", "orders", "write", "Enregistrer un remboursement : { amountCents, reason? } (validé contre le remboursable restant)."),
  ext("orders.create_return", "POST", "/api/orders/[id]/returns", "orders", "write", "Ouvrir un retour (RMA) : { items:[{orderItemId,quantity,conditionNote?}], reasonCode?, reason?, comment? }."),
  ext("orders.update_return", "PATCH", "/api/orders/[id]/returns", "orders", "write", "Faire avancer un retour : { returnId, action:'receive'|'reject' } (receive = restock + ledger)."),
  ext("orders.update_status", "PATCH", "/api/orders/[id]/status", "orders", "write", "Pousser un changement de statut + suivi : { status?, paymentReference?, notes?, externalRef? }."),
  ext("orders.delivery_outcome", "POST", "/api/orders/[id]/delivery-outcome", "orders", "write", "Signaler un échec de livraison (transporteur externe) : ouvre un « retour d'expédition » (RTO) sur les lignes expédiées — { reason?, reasonText?, carrier?, trackingRef?, attempts?, restockable?, lines? }. La réception du retour réintègre le stock + annule la commande."),
  // Warranty claims (SAV / RMA) — two-way sync with the ERP / repair shop. Carries
  // customer context → clé OBLIGATOIRE (canBePublic:false) on the reads.
  ext("warranty_claims.list", "GET", "/api/warranty-claims", "warranty", "read", "Liste des réclamations de garantie (SAV) : ?status= (open|in_repair|awaiting_parts|resolved|rejected), ?limit ; OU une par ?externalRef=.", { canBePublic: false }),
  ext("warranty_claims.get", "GET", "/api/warranty-claims/[id]", "warranty", "read", "Une réclamation par id (UUID) ou référence externe (externalRef).", { canBePublic: false }),
  ext("warranty_claims.create", "POST", "/api/warranty-claims", "warranty", "write", "Ouvrir une réclamation : { orderId, orderItemId, reasonCode?, reason?, comment?, externalRef? } (couverture figée à l'ouverture)."),
  ext("warranty_claims.update", "PATCH", "/api/warranty-claims/[id]", "warranty", "write", "Faire évoluer une réclamation : { status?:'in_repair'|'awaiting_parts', comment?, reasonCode?, externalRef? } OU la clôturer { resolution:'repaired'|'replaced'|'refunded'|'rejected', resolutionNote? }."),
  // Customers (ERP client sync). PII (nom/téléphone/adresse/email) → clé OBLIGATOIRE,
  // jamais publiable (canBePublic:false). `admin_notes` n'est JAMAIS sérialisé.
  ext("customers.list", "GET", "/api/customers", "customers", "read", "Liste clients pour synchro incrémentale (?since=&sinceId= sur updated_at,id, ?limit), OU un client par ?externalRef= / ?email= / ?phone=.", { canBePublic: false }),
  ext("customers.get", "GET", "/api/customers/[id]", "customers", "read", "Un client complet (adresses) par id (UUID) ou externalRef.", { canBePublic: false }),
  ext("customers.create", "POST", "/api/customers", "customers", "write", "Créer un client : { firstName, lastName, externalRef?, phone?, marketingOptIn?, birthday? }."),
  ext("customers.upsert", "PUT", "/api/customers", "customers", "write", "Créer-ou-modifier par référence (externalRef|id) : crée si absent, sinon met à jour les champs fournis."),
  ext("customers.update", "PATCH", "/api/customers", "customers", "write", "Modifier un client existant (par id ou externalRef ; échoue si introuvable)."),
  // Content (headless rendering — site chrome + settings, all read-only)
  ext("content.bundle", "GET", "/api/content", "content", "read", "Bundle de rendu headless : hero/header/footer banners, menus (header + footer), logo et réglages publics (identité, thème, SEO, livraison/copy)."),
  // Blog (published editorial — read-only)
  ext("blog.list", "GET", "/api/blog", "blog", "read", "Articles de blog publiés (?limit, ?cursor, ?category=slug) ; ?categories=1 renvoie la liste des catégories."),
  ext("blog.get", "GET", "/api/blog/[slug]", "blog", "read", "Un article de blog publié par slug (image, catégorie, tags)."),
  // Reviews (approved product reviews — read-only)
  ext("reviews.list", "GET", "/api/reviews", "reviews", "read", "Avis approuvés d'un produit (?product=slug|sku|gtin|externalRef|id, ?rating=1-5, ?limit) + résumé (count/average/distribution)."),
];

/** Non-external routes — documentary only (each keeps its own guard). */
export const OTHER_ROUTES: ApiRoute[] = [
  { id: "health", method: "GET", path: "/api/health", tier: "infra", domain: "système", canBePublic: false, authLabel: "PUBLIC", notes: "Sonde de vivacité (Coolify / monitoring)." },
  { id: "store.search", method: "GET", path: "/api/store/search", tier: "first-party", domain: "search", canBePublic: false, authLabel: "Même origine + IP", notes: "Recherche boutique (même origine, limité par IP)." },
  { id: "track", method: "POST", path: "/api/track", tier: "first-party", domain: "tracking", canBePublic: false, authLabel: "Même origine + IP", notes: "Miroir serveur des évènements funnel (consentement + IP)." },
  { id: "auth", method: "POST", path: "/api/auth/[...all]", tier: "infra", domain: "auth", canBePublic: false, authLabel: "Better Auth", notes: "Catch-all Better Auth (sessions, vérif. e-mail, reset)." },
  { id: "auth.get", method: "GET", path: "/api/auth/[...all]", tier: "infra", domain: "auth", canBePublic: false, authLabel: "Better Auth", notes: "Catch-all Better Auth (GET — liens de vérification e-mail, callbacks OAuth)." },
  { id: "webhooks.flouci", method: "POST", path: "/api/webhooks/flouci", tier: "infra", domain: "webhooks", canBePublic: false, authLabel: "Re-vérifié (Flouci)", notes: "Callback paiement Flouci (re-vérifié via l'API Flouci verify_payment)." },
  { id: "webhooks.flouci.get", method: "GET", path: "/api/webhooks/flouci", tier: "infra", domain: "webhooks", canBePublic: false, authLabel: "Re-vérifié (Flouci)", notes: "Redirection retour navigateur Flouci (GET, même handler re-vérifié que le POST)." },
  { id: "webhooks.clictopay", method: "POST", path: "/api/webhooks/clictopay", tier: "infra", domain: "webhooks", canBePublic: false, authLabel: "Re-vérifié (ClicToPay)", notes: "Callback paiement ClicToPay (re-vérifié via getOrderStatusExtended.do ; dynamicCallbackUrl)." },
  { id: "webhooks.clictopay.get", method: "GET", path: "/api/webhooks/clictopay", tier: "infra", domain: "webhooks", canBePublic: false, authLabel: "Re-vérifié (ClicToPay)", notes: "Redirection retour navigateur ClicToPay (GET, même handler re-vérifié que le POST)." },
  { id: "unsubscribe.one-click", method: "POST", path: "/api/unsubscribe/one-click", tier: "infra", domain: "système", canBePublic: false, authLabel: "Jeton signé (HMAC)", notes: "Désabonnement en un clic RFC 8058 (cible List-Unsubscribe des emails marketing, POSTée par la messagerie du destinataire) — même jeton que le lien du pied de mail." },
  { id: "unsubscribe.one-click.get", method: "GET", path: "/api/unsubscribe/one-click", tier: "infra", domain: "système", canBePublic: false, authLabel: "Jeton signé (HMAC)", notes: "Ouverture navigateur du lien List-Unsubscribe : redirection 303 vers la page de confirmation /se-desabonner (un GET ne désabonne jamais)." },
  { id: "cron.dispatch", method: "POST", path: "/api/cron/dispatch", tier: "infra", domain: "système", canBePublic: false, authLabel: "Bearer CRON_SECRET", notes: "LE battement de cœur unique : lit la cadence machine de chaque tâche (SCHEDULED_JOBS[].dispatch) et exécute celles DUES ce tick. Une seule tâche planifiée Coolify (*/2 * * * *) remplace les crons par tâche." },
  { id: "cron.retention", method: "POST", path: "/api/cron/retention", tier: "infra", domain: "système", canBePublic: false, authLabel: "Bearer CRON_SECRET", notes: "Purge planifiée des journaux PII." },
  { id: "cron.mailing", method: "POST", path: "/api/cron/mailing", tier: "infra", domain: "système", canBePublic: false, authLabel: "Bearer CRON_SECRET", notes: "Vidage de la file d'envoi d'emails (campagnes + automatisations)." },
  { id: "cron.birthday", method: "POST", path: "/api/cron/birthday", tier: "infra", domain: "système", canBePublic: false, authLabel: "Bearer CRON_SECRET", notes: "Emails d'anniversaire quotidiens." },
  { id: "cron.wishlist-campaign", method: "POST", path: "/api/cron/wishlist-campaign", tier: "infra", domain: "système", canBePublic: false, authLabel: "Bearer CRON_SECRET", notes: "Campagne personnalisée « liste d'envies » : code promo + articles favoris aux membres opt-in du segment configuré (p. ex. anniversaire à l'approche). Idempotent par mois." },
  { id: "cron.promotion-announce", method: "POST", path: "/api/cron/promotion-announce", tier: "infra", domain: "système", canBePublic: false, authLabel: "Bearer CRON_SECRET", notes: "Annonces de promotions programmées : envoie l'annonce email d'une promo à l'heure programmée (une fois chacune). Vérifié toutes les ~5 min." },
  { id: "cron.review-request", method: "POST", path: "/api/cron/review-request", tier: "infra", domain: "système", canBePublic: false, authLabel: "Bearer CRON_SECRET", notes: "Demandes d'avis post-livraison quotidiennes." },
  { id: "cron.payments", method: "POST", path: "/api/cron/payments", tier: "infra", domain: "système", canBePublic: false, authLabel: "Bearer CRON_SECRET", notes: "Réconciliation des paiements en ligne bloqués en attente (rescousse onglet fermé / crash)." },
  { id: "cron.abandoned-orders", method: "POST", path: "/api/cron/abandoned-orders", tier: "infra", domain: "système", canBePublic: false, authLabel: "Bearer CRON_SECRET", notes: "Annule les commandes abandonnées (en attente > 48 h) et restitue le stock réservé (COD + en ligne sans référence + au-delà de la fenêtre de réconciliation)." },
  { id: "cron.webhooks", method: "POST", path: "/api/cron/webhooks", tier: "infra", domain: "système", canBePublic: false, authLabel: "Bearer CRON_SECRET", notes: "Livre la file des webhooks SORTANTS (ERP) : POST JSON signé HMAC vers les endpoints abonnés, avec reprise + back-off." },
  { id: "cron.detourage", method: "POST", path: "/api/cron/detourage", tier: "infra", domain: "système", canBePublic: false, authLabel: "Bearer CRON_SECRET", notes: "Détourage planifié des images produits existantes (rattrapage). No-op si le détourage auto est désactivé ; idempotent (saute les images déjà en -nobg)." },
  { id: "admin.bootstrap", method: "POST", path: "/api/admin/bootstrap", tier: "infra", domain: "admin", canBePublic: false, authLabel: "Token", notes: "Promotion 1er admin (ADMIN_BOOTSTRAP_TOKEN, à usage unique)." },
  { id: "admin.metrics", method: "GET", path: "/api/admin/metrics", tier: "infra", domain: "admin", canBePublic: false, authLabel: "Session admin (system_performance:view)", notes: "Snapshot live Performance : compteurs d'évènements + métriques runtime (RAM/CPU/boucle d'évènements/latence DB, pool de connexions, uptime du process), propre à l'instance." },
  { id: "admin.media", method: "GET", path: "/api/admin/media", tier: "infra", domain: "admin", canBePublic: false, authLabel: "Session admin", notes: "Bibliothèque média (MediaPicker)." },
  { id: "admin.media.upload", method: "POST", path: "/api/admin/media/upload", tier: "infra", domain: "admin", canBePublic: false, authLabel: "Session admin", notes: "Upload image (multipart, même origine)." },
  { id: "admin.media.import-url", method: "POST", path: "/api/admin/media/import-url", tier: "infra", domain: "admin", canBePublic: false, authLabel: "Session admin", notes: "Import image depuis URL (anti-SSRF, même origine)." },
  { id: "admin.customers.export", method: "GET", path: "/api/admin/customers/export", tier: "infra", domain: "admin", canBePublic: false, authLabel: "Session admin (customers:export)", notes: "Export CSV des clients enregistrés." },
  { id: "admin.customers.guests.export", method: "GET", path: "/api/admin/customers/guests/export", tier: "infra", domain: "admin", canBePublic: false, authLabel: "Session admin (invites:export)", notes: "Export CSV des clients invités." },
  { id: "admin.customers.favorites.export", method: "GET", path: "/api/admin/customers/favorites/export", tier: "infra", domain: "admin", canBePublic: false, authLabel: "Session admin (favorites:export)", notes: "Export CSV du signal de demande Favoris (produits favoris filtrés)." },
  { id: "admin.segments.export", method: "GET", path: "/api/admin/segments/[id]/export", tier: "infra", domain: "admin", canBePublic: false, authLabel: "Session admin (customers:export)", notes: "Export CSV des membres d'un segment (dynamique via le compilateur SQL, manuel via les lignes de membres), colonnes ?fields=." },
  { id: "admin.newsletter.export", method: "GET", path: "/api/admin/newsletter/export", tier: "infra", domain: "admin", canBePublic: false, authLabel: "Session admin (newsletter:export)", notes: "Export CSV (streamé, complet) des inscrits newsletter, filtré par statut / recherche (?status=active|inactive|all&q=)." },
  { id: "admin.import.template", method: "GET", path: "/api/admin/import/template", tier: "infra", domain: "admin", canBePublic: false, authLabel: "Session admin", notes: "Modèle d'import (format=csv|xml)." },
  { id: "admin.system.demo", method: "POST", path: "/api/admin/system/demo", tier: "infra", domain: "admin", canBePublic: false, authLabel: "Session admin", notes: "Import / nettoyage (clear) des données de démo (même origine). La purge totale n'est PAS exposée en HTTP — réservée aux server actions (confirmation par code email)." },
];

/**
 * App-level metadata / PWA / SEO endpoints — real HTTP-reachable GETs that live
 * OUTSIDE src/app/api (Next file-convention routes + the llms.txt route handler),
 * so the /api disk-invariant doesn't cover them. Kept in their OWN array (not
 * ALL_ROUTES) so that invariant stays clean; surfaced to the admin inventory via
 * ALL_HTTP_ENDPOINTS below. `notes` carries the source file for the metadata test.
 */
export const APP_METADATA_ROUTES: ApiRoute[] = [
  { id: "meta.sitemap", method: "GET", path: "/sitemap.xml", tier: "infra", domain: "système", canBePublic: false, authLabel: "Public", notes: "Plan du site (src/app/sitemap.ts) — force-dynamic, filtre noindex + catalogue complet." },
  { id: "meta.robots", method: "GET", path: "/robots.txt", tier: "infra", domain: "système", canBePublic: false, authLabel: "Public", notes: "robots.txt (src/app/robots.txt/route.ts) — raw handler, force-dynamic : interrupteur d'indexation + Disallow admin + Allow réactif des flux activés + pointeur llms.txt." },
  { id: "meta.manifest", method: "GET", path: "/manifest.webmanifest", tier: "infra", domain: "système", canBePublic: false, authLabel: "Public", notes: "Manifeste PWA (src/app/manifest.ts)." },
  { id: "meta.icon", method: "GET", path: "/icon.png", tier: "infra", domain: "système", canBePublic: false, authLabel: "Public", notes: "Favicon/icône d'app — fichier statique src/app/icon.png servi par Next à /icon.png (le chemin /icon sans extension est réservé à une icône GÉNÉRÉE icon.tsx)." },
  { id: "meta.llms", method: "GET", path: "/llms.txt", tier: "infra", domain: "système", canBePublic: false, authLabel: "Public", notes: "Guide llms.txt pour les agents IA (src/app/llms.txt/route.ts) — raw handler, force-dynamic : carte AEO/GEO générée depuis le catalogue + réglages live (override complet via seo.llms_txt)." },
];

/**
 * Other real HTTP route handlers that live UNDER src/app but OUTSIDE src/app/api
 * (so the /api disk-invariant doesn't see them) — admin CSV exports + the media
 * proxy. Each keeps its OWN guard (admin session / public). Kept in their own
 * array; surfaced via ALL_HTTP_ENDPOINTS so the inventory tab lists them, and
 * asserted against disk by route-invariants (the non-/api walk). `notes` carries
 * the source file for that existence check.
 */
export const APP_ROUTE_HANDLERS: ApiRoute[] = [
  { id: "admin.orders.export", method: "GET", path: "/admin/orders/export", tier: "infra", domain: "admin", canBePublic: false, authLabel: "Session admin (orders:view)", notes: "Export CSV des commandes (src/app/admin/orders/export/route.ts)." },
  { id: "admin.audit.export", method: "GET", path: "/admin/system/audit/export", tier: "infra", domain: "admin", canBePublic: false, authLabel: "Session admin (system_audit:view)", notes: "Export CSV du journal d'audit filtré (src/app/admin/system/audit/export/route.ts)." },
  { id: "cdn.proxy", method: "GET", path: "/cdn/[...path]", tier: "infra", domain: "système", canBePublic: false, authLabel: "Public (objets publics)", notes: "Proxy média même-origine S3 (src/app/cdn/[...path]/route.ts) — objets publics, anti-traversal, sans clé." },
  { id: "cdn.proxy.head", method: "HEAD", path: "/cdn/[...path]", tier: "infra", domain: "système", canBePublic: false, authLabel: "Public (objets publics)", notes: "HEAD du proxy média (même handler que le GET)." },
  { id: "feeds.products", method: "GET", path: "/feeds/[file]", tier: "infra", domain: "système", canBePublic: false, authLabel: "Public (selon réglage SEO → Flux)", notes: "Flux produits Google Merchant (XML) + OpenAI ACP (JSON), chemin éditable + activables (src/app/feeds/[file]/route.ts) — noindex, ISR 30 min, exclus du sitemap." },
  { id: "agents.markdown", method: "GET", path: "/md/[...path]", tier: "infra", domain: "système", canBePublic: false, authLabel: "Public (agents IA)", notes: "Markdown for Agents — cible de réécriture (src/app/md/[...path]/route.ts) depuis proxy.ts sur Accept: text/markdown ou suffixe .md ; noindex + canonical, exclus du sitemap." },
  { id: "promo.url", method: "GET", path: "/promo/[slug]", tier: "infra", domain: "tracking", canBePublic: false, authLabel: "Public (liens promo)", notes: "Lien de promotion « URL » (src/app/promo/[slug]/route.ts) — pose le cookie httpOnly gz.promo (id de la promo live) puis redirige vers / ; slug inconnu/expiré → / sans cookie. Honore d'abord les redirections admin." },
];

/** Every src/app/api route, for the inventory tab + enforcement. */
export const ALL_ROUTES: ApiRoute[] = [...EXTERNAL_API_ROUTES, ...OTHER_ROUTES];

/** Every HTTP endpoint (api routes + app-level metadata/SEO + other app handlers), for the admin UI. */
export const ALL_HTTP_ENDPOINTS: ApiRoute[] = [...ALL_ROUTES, ...APP_METADATA_ROUTES, ...APP_ROUTE_HANDLERS];

/** Lookup by id (used by enforcement). */
const BY_ID = new Map(ALL_ROUTES.map((r) => [r.id, r]));
export function routeById(id: string): ApiRoute | undefined {
  return BY_ID.get(id);
}

/** External READ routes an admin may toggle public (the settings surface). */
export const TOGGLEABLE_PUBLIC_ROUTES: ApiRoute[] = EXTERNAL_API_ROUTES.filter((r) => r.canBePublic);

/** The set of valid public-toggle ids, for validating persisted settings. */
export const TOGGLEABLE_PUBLIC_IDS: ReadonlySet<string> = new Set(
  TOGGLEABLE_PUBLIC_ROUTES.map((r) => r.id),
);
