/**
 * Email-automation FLOW registry — the CODE source of truth for which automations
 * exist, what fires them, their category, and their default on/off. A DB
 * `email_flows` row OPTIONALLY overrides `default_enabled` (admin Workflows tab).
 * PURE data (no imports, client-safe) like `src/lib/jobs/registry.ts`, so the
 * admin panel and the server resolver share one definition.
 *
 * `category` drives the consent gate: "marketing" flows are opt-in-gated and
 * carry an unsubscribe footer; "account"/"commerce" are transactional.
 */
export type EmailFlowCategory = "account" | "commerce" | "marketing";

export type EmailFlowDef = {
  key: string;
  label: string;
  description: string;
  /** Human description of what fires it (shown in the admin Workflows tab). */
  trigger: string;
  category: EmailFlowCategory;
  default_enabled: boolean;
};

export const EMAIL_FLOWS: readonly EmailFlowDef[] = [
  {
    key: "welcome",
    label: "Bienvenue",
    description: "Email de bienvenue à la création d'un compte.",
    trigger: "Inscription (user.created)",
    category: "account",
    default_enabled: true,
  },
  {
    key: "order_confirmation",
    label: "Confirmation de commande",
    description: "Reçu détaillé envoyé à la commande.",
    trigger: "Commande créée (order.created)",
    category: "commerce",
    default_enabled: true,
  },
  {
    key: "order_confirmed",
    label: "Commande confirmée",
    description: "Notification quand une commande est confirmée (acceptée par la boutique).",
    trigger: "Commande confirmée (order.confirmed)",
    category: "commerce",
    default_enabled: true,
  },
  {
    key: "order_paid",
    label: "Paiement reçu",
    description: "Notification quand le paiement en ligne d'une commande est confirmé.",
    trigger: "Statut commande → payée",
    category: "commerce",
    default_enabled: true,
  },
  {
    key: "order_preparing",
    label: "Commande en préparation",
    description: "Notification quand une commande passe au statut « en préparation ».",
    trigger: "Statut commande → en préparation",
    category: "commerce",
    default_enabled: true,
  },
  {
    key: "order_shipped",
    label: "Commande expédiée",
    description: "Notification quand une commande passe au statut « expédiée ».",
    trigger: "Statut commande → expédiée",
    category: "commerce",
    default_enabled: true,
  },
  {
    key: "order_delivered",
    label: "Commande livrée",
    description: "Notification quand une commande passe au statut « livrée ».",
    trigger: "Statut commande → livrée",
    category: "commerce",
    default_enabled: true,
  },
  {
    key: "order_cancelled",
    label: "Commande annulée",
    description: "Notification quand une commande est annulée.",
    trigger: "Statut commande → annulée",
    category: "commerce",
    default_enabled: true,
  },
  {
    key: "newsletter_coupon",
    label: "Coupon de bienvenue (newsletter)",
    description: "Code promo de bienvenue à l'inscription à la newsletter.",
    trigger: "Inscription newsletter",
    category: "marketing",
    default_enabled: true,
  },
  {
    key: "birthday_coupon",
    label: "Anniversaire",
    description: "Email d'anniversaire avec un code cadeau valable le jour J.",
    trigger: "Cron quotidien — anniversaire du jour",
    category: "marketing",
    default_enabled: true,
  },
  {
    key: "wishlist_campaign",
    label: "Campagne liste d'envies (personnalisée)",
    description:
      "Email personnalisé avec un code promo + les articles de la liste d'envies du client, envoyé aux membres d'un segment configuré (p. ex. anniversaire à l'approche).",
    trigger: "Cron quotidien — membres opt-in du segment configuré ayant une liste d'envies",
    category: "marketing",
    default_enabled: false,
  },
  {
    key: "promotion_announcement",
    label: "Annonce de promotion",
    description: "Annonce une promotion à son audience (ciblage ou clients opt-in).",
    // Emitters: the create form's « Annoncer par email » checkbox (immédiate), a
    // scheduled announce (« Annoncer par email le … » → cron sweep quand l'heure est
    // atteinte), et le bouton « Annoncer maintenant » sur la fiche promo. Le blast
    // n'envoie qu'une promo LIVE ; idempotent par (promo, destinataire).
    trigger: "Création d'une promo active, annonce programmée, ou « Annoncer maintenant »",
    category: "marketing",
    default_enabled: true,
  },
  {
    key: "wishlist_price_drop",
    label: "Baisse de prix (favoris)",
    description: "Alerte les clients quand un produit de leurs favoris baisse de prix.",
    trigger: "Prix d'un produit baissé",
    category: "marketing",
    default_enabled: true,
  },
  {
    key: "back_in_stock",
    label: "De retour en stock (favoris)",
    description: "Alerte les clients quand un produit favori est réapprovisionné.",
    trigger: "Réassort d'un produit (stock 0 → positif)",
    category: "marketing",
    default_enabled: true,
  },
  {
    key: "review_request",
    label: "Demande d'avis",
    description: "Invite le client à laisser un avis quelques jours après la livraison.",
    trigger: "Cron quotidien — N jours après livraison",
    // Marketing, NOT account: the review-request template is consent-gated +
    // carries an unsubscribe footer, and its runner pre-filters opted-in
    // customers. Keep this in sync with the template's `category` so the admin
    // Workflows tab classifies it correctly.
    category: "marketing",
    default_enabled: true,
  },
] as const;

const FLOW_MAP = new Map(EMAIL_FLOWS.map((f) => [f.key, f] as const));

export function getEmailFlow(key: string): EmailFlowDef | undefined {
  return FLOW_MAP.get(key);
}
