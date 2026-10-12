/**
 * Built-in email template registry (the CODE source of truth).
 *
 * Every transactional email the app can send is declared here as a
 * `{{ variable }}`-placeholder HTML string (rendered by `./render`). A DB row
 * in `email_template_overrides` may override the subject/html or disable a
 * key, but the variable contract, layout, and trigger wiring stay in code so
 * the system can't be broken from the admin UI. `critical` (account-security)
 * templates can never be disabled, and only a super-admin may override them.
 *
 * Authoring constraints (email-client compatibility):
 *   - inline styles only (Outlook strips <style>)
 *   - table-based outer layout
 *   - web-SAFE fonts only — a system sans stack (SANS) that echoes Figtree
 *   - a single 600px white card on the warm-paper Tokyo background
 *
 * Brand identity is SETTINGS-DRIVEN: the shared `wrap()` layout's header +
 * footer are BRAND PLACEHOLDER tokens ({{ brand_logo }}, {{ brand_footer }},
 * {{ brand_socials }}) and subjects use {{ brand_name }}. Section labels, CTAs +
 * code boxes use {{ brand_primary }} (the storefront theme primary — crimson
 * #d40530), injected at send/preview time from `./brand` (getEmailBrand +
 * buildBrandVars) — never authored by an admin override.
 */

export type EmailTemplateVariable = {
  name: string;
  /** Sample value used for admin preview + test sends. */
  sample: string;
  description?: string;
  /** When true, the value is pre-built HTML (not escaped at dispatch). */
  isHtml?: boolean;
};

export type EmailTemplateCategory = "account" | "commerce" | "marketing";

export type EmailTemplateDef = {
  key: string;
  name: string;
  category: EmailTemplateCategory;
  description: string;
  /** Default subject (may contain {{vars}}). */
  subject: string;
  /** Default HTML body (wrapped, may contain {{vars}}). */
  html: string;
  variables: EmailTemplateVariable[];
  /**
   * Account-security template (carries a single-use token / confirmation code —
   * the same set dispatch redacts from the send log). It can never be DISABLED
   * (that would silently block sign-up verification / password recovery), and
   * its subject/body override is reserved to super-admins (`*`): a delegated
   * mailing operator could otherwise exfiltrate the token through an override
   * (e.g. `<img src="https://…/?t={{ reset_url }}">`) and take over any account.
   */
  critical?: true;
};

/** The closed set of registry template keys. (The source-of-truth list of
 *  template DEFINITIONS is `EMAIL_TEMPLATES` below; this union just keys them.) */
export type EmailTemplateKey =
  | "welcome"
  | "email_verification"
  | "email_change"
  | "password_reset"
  | "user_invitation"
  | "order_confirmation"
  | "order_confirmed"
  | "order_paid"
  | "order_preparing"
  | "newsletter_coupon"
  | "birthday_coupon"
  | "wishlist_campaign"
  | "promotion_announcement"
  | "wishlist_price_drop"
  | "order_shipped"
  | "order_delivered"
  | "order_cancelled"
  | "back_in_stock"
  | "review_request"
  | "purge_confirmation";

/* Tokyo email palette — FIXED structural colors (hex, email-client-safe), matching
 * the crimson storefront design. The brand PRIMARY (buttons, eyebrows, code borders,
 * footer rule) is the send-time {{ brand_primary }} token so it tracks the admin's
 * theme (crimson #d40530 by default — see ./brand). Emails can't embed web fonts, so
 * the type is a web-safe SANS that echoes the storefront's Figtree (not the old serif).
 * (The `BRAND_PRIMARY` constant from ./brand is used only by subscribers that build a
 * code block outside this file; templates here reference the {{ brand_primary }} token.) */
const INK = "#0e1218"; // ink — headings (.tokyo --foreground)
const BODY = "#3a4049"; // softened ink — paragraphs
const MUTED = "#6b7280"; // neutral gray — footnotes / secondary (on white/tint)
const FOOTER_MUTED = "#4b5563"; // darker gray for text ON the warm-paper shell (MUTED on #f6f2ed is only 4.34:1 — below AA; this is 6.78:1)
const PAGE = "#f6f2ed"; // warm paper — page background (.tokyo --surface-beige)
const CARD = "#ffffff"; // card surface
const BORDER = "#e7e1da"; // warm hairline — card + table rules
const TINT = "#fbf9f8"; // code-box / panel tint
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";

/* ── Reusable fragments ──────────────────────────────────────────────── */

/**
 * Shared branded layout — a warm-paper page with one centred white card, a crimson
 * top accent rule and a crimson hairline footer (the Tokyo crimson system). Header +
 * footer are BRAND PLACEHOLDER tokens ({{ brand_logo }}, {{ brand_footer }},
 * {{ brand_socials }}, {{ brand_name }}) resolved at send/preview time from `./brand`,
 * so every template inherits one settings-driven shell + logo. Email-client-safe:
 * inline styles, table layout, web-safe sans (no embedded web fonts).
 */
export const wrap = (inner: string) => `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light only">
  <title>{{ brand_name }}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};font-family:${SANS};color:${BODY};-webkit-text-size-adjust:100%;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAGE};padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">
        <tr><td align="center" style="padding:6px 8px 24px 8px;">
          {{ brand_logo }}
        </td></tr>
        <tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:14px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr><td style="height:3px;background:{{ brand_primary }};border-radius:14px 14px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
            <tr><td style="padding:40px 44px;">${inner}</td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:26px 20px 0 20px;">
          <div style="width:40px;height:2px;line-height:2px;font-size:0;background:{{ brand_primary }};border-radius:2px;margin:0 auto 16px auto;">&nbsp;</div>
          <div style="font-size:11px;color:${FOOTER_MUTED};line-height:1.8;">
            {{ brand_footer }}<br>
            Cet email a été envoyé automatiquement — merci de ne pas y répondre.
          </div>
          {{ brand_socials }}
          {{ unsubscribe_footer }}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

const heading = (t: string) =>
  `<h1 style="font-family:${SANS};font-size:25px;font-weight:800;color:${INK};margin:0 0 12px 0;line-height:1.25;letter-spacing:-0.02em;">${t}</h1>`;
// eyebrow + button + codeBox use the {{ brand_primary }} token (the storefront
// theme primary, resolved at send from theme.primary_color) so every template's
// section label, CTA + code match the CURRENT site design — crimson by default.
const eyebrow = (t: string) =>
  `<div style="font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:{{ brand_primary }};font-weight:800;margin:0 0 15px 0;">${t}</div>`;
const p = (t: string) =>
  `<p style="font-size:14.5px;line-height:1.75;color:${BODY};margin:0 0 16px 0;">${t}</p>`;
const footnote = (t: string) =>
  `<p style="font-size:12px;line-height:1.7;color:${MUTED};margin:22px 0 0 0;">${t}</p>`;
const button = (label: string, urlVar: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
    <tr><td style="background:{{ brand_primary }};border-radius:9999px;">
      <a href="{{ ${urlVar} }}" target="_blank" rel="noopener" style="display:block;padding:14px 34px;color:${CARD};text-decoration:none;font-size:12px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;line-height:1;">${label}</a>
    </td></tr>
  </table>`;
// Coupon / verification code — a tinted panel with a crimson dashed border + the
// code in a letter-spaced monospace.
const codeBox = (codeVar: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:14px 0 4px 0;">
    <tr><td style="padding:18px 20px;background:${TINT};border:1px dashed {{ brand_primary }};border-radius:12px;text-align:center;font-family:'Courier New',Courier,monospace;font-size:19px;font-weight:700;letter-spacing:3px;color:{{ brand_primary }};">{{ ${codeVar} }}</td></tr>
  </table>`;

/* ── Templates ───────────────────────────────────────────────────────── */

export const EMAIL_TEMPLATES: EmailTemplateDef[] = [
  {
    key: "welcome",
    name: "Bienvenue",
    category: "account",
    description: "Envoyé à la création d'un compte client.",
    subject: `Bienvenue chez {{ brand_name }}, {{ first_name }} ⌚`,
    variables: [
      { name: "first_name", sample: "Mohamed" },
      { name: "shop_url", sample: "https://tokyostore.tn" },
    ],
    html: wrap(`
      ${eyebrow("Votre compte est prêt")}
      ${heading("Bienvenue chez {{ brand_name }}, {{ first_name }}.")}
      ${p("Merci d'avoir créé votre compte {{ brand_name }}. Vous pouvez désormais suivre vos commandes, gérer vos produits favoris et profiter de nos offres réservées aux membres.")}
      ${button("Découvrir la collection", "shop_url")}
      ${footnote("À très vite — l'équipe {{ brand_name }}.")}
    `),
  },
  {
    key: "email_verification",
    name: "Vérification d'email",
    category: "account",
    critical: true,
    description: "Confirmation d'adresse email à l'inscription.",
    subject: `Vérifiez votre adresse email`,
    variables: [
      { name: "first_name", sample: "Mohamed" },
      { name: "verify_url", sample: "https://tokyostore.tn/verify-email?token=…" },
      { name: "expires_hours", sample: "24" },
    ],
    html: wrap(`
      ${eyebrow("Sécurité du compte")}
      ${heading("Confirmez votre adresse email.")}
      ${p("Bonjour {{ first_name }}, confirmez votre adresse pour activer votre compte {{ brand_name }}.")}
      ${button("Vérifier mon email", "verify_url")}
      ${footnote("Ce lien expire dans {{ expires_hours }} heures. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.")}
    `),
  },
  {
    key: "email_change",
    name: "Changement d'adresse email",
    category: "account",
    critical: true,
    description: "Confirmation envoyée à l'adresse ACTUELLE pour approuver un changement d'email.",
    subject: `Confirmez le changement de votre adresse email`,
    variables: [
      { name: "first_name", sample: "Mohamed" },
      { name: "new_email", sample: "nouvelle@exemple.tn" },
      { name: "verify_url", sample: "https://tokyostore.tn/account?token=…" },
      { name: "expires_minutes", sample: "60" },
    ],
    html: wrap(`
      ${eyebrow("Sécurité du compte")}
      ${heading("Confirmez le changement d'email.")}
      ${p("Bonjour {{ first_name }}, une demande de changement d'adresse email vers <strong>{{ new_email }}</strong> a été faite sur votre compte {{ brand_name }}. Confirmez pour l'appliquer.")}
      ${button("Confirmer le changement", "verify_url")}
      ${footnote("Ce lien expire dans {{ expires_minutes }} minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email — votre adresse reste inchangée.")}
    `),
  },
  {
    key: "password_reset",
    name: "Réinitialisation de mot de passe",
    category: "account",
    critical: true,
    description: "Lien de réinitialisation du mot de passe.",
    subject: `Réinitialisez votre mot de passe`,
    variables: [
      { name: "first_name", sample: "Mohamed" },
      { name: "reset_url", sample: "https://tokyostore.tn/reset-password?token=…" },
      { name: "expires_minutes", sample: "60" },
    ],
    html: wrap(`
      ${eyebrow("Sécurité du compte")}
      ${heading("Réinitialiser votre mot de passe.")}
      ${p("Bonjour {{ first_name }}, nous avons reçu une demande de réinitialisation de votre mot de passe.")}
      ${button("Définir un nouveau mot de passe", "reset_url")}
      ${footnote("Ce lien expire dans {{ expires_minutes }} minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email — votre mot de passe reste inchangé.")}
    `),
  },
  {
    key: "purge_confirmation",
    name: "Confirmation de purge (démo)",
    category: "account",
    critical: true,
    description:
      "Code à usage unique pour confirmer la purge totale des données + relance de la démo (réservé super-admin).",
    subject: `Code de confirmation — réinitialisation des données {{ brand_name }}`,
    variables: [
      { name: "first_name", sample: "Mohamed" },
      { name: "confirm_code", sample: "428913" },
      { name: "expires_minutes", sample: "15" },
    ],
    html: wrap(`
      ${eyebrow("Action sensible — super-admin")}
      ${heading("Confirmez la réinitialisation totale.")}
      ${p("Bonjour {{ first_name }}, une réinitialisation complète a été demandée. Elle SUPPRIME définitivement tout le contenu, toutes les commandes et tous les clients, puis relance la démo. Saisissez ce code dans l'administration pour confirmer :")}
      ${codeBox("confirm_code")}
      ${footnote("Ce code expire dans {{ expires_minutes }} minutes et n'est utilisable qu'une seule fois. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email — aucune donnée n'est touchée tant que le code n'est pas saisi.")}
    `),
  },
  {
    key: "user_invitation",
    name: "Invitation",
    category: "account",
    critical: true,
    description: "Envoyé quand un admin invite un utilisateur ou un client.",
    subject: `Vous êtes invité·e à rejoindre {{ brand_name }}`,
    variables: [
      { name: "first_name", sample: "Mohamed" },
      { name: "invite_url", sample: "https://tokyostore.tn/reset-password?token=…" },
      { name: "expires_minutes", sample: "60" },
    ],
    html: wrap(`
      ${eyebrow("Invitation")}
      ${heading("Bienvenue chez {{ brand_name }}, {{ first_name }}.")}
      ${p("Un compte a été créé pour vous sur {{ brand_name }}. Choisissez votre mot de passe pour l'activer et accéder à votre espace.")}
      ${button("Choisir mon mot de passe", "invite_url")}
      ${footnote("Ce lien expire dans {{ expires_minutes }} minutes. Passé ce délai, demandez un nouveau lien via « Mot de passe oublié » sur la page de connexion.")}
    `),
  },
  {
    key: "order_confirmation",
    name: "Confirmation de commande",
    category: "commerce",
    // RECEIPT, not acceptance: it fires on `order.created` — before a COD order
    // is accepted by the shop (that's the separate `order_confirmed` mail) and
    // while an online order is still unpaid — so it says « enregistrée », never
    // « confirmée ». `order_state` / `payment_note` carry the pending-payment
    // wording for an online order awaiting its gateway payment.
    description: "Reçu envoyé à la création d'une commande.",
    subject: `Votre commande {{ order_number }} est {{ order_state }}`,
    variables: [
      { name: "customer_name", sample: "Mohamed" },
      { name: "order_number", sample: "CMD-7K9P2X" },
      {
        name: "order_state",
        sample: "enregistrée",
        description: "« enregistrée », ou « en attente de paiement » (paiement en ligne non encore reçu)",
      },
      {
        name: "payment_note",
        sample: "",
        description: "Phrase ajoutée pour une commande en ligne en attente de paiement (vide sinon)",
      },
      { name: "items_html", sample: '<tr><td style="padding:8px 0;">Casio G-SHOCK GA-2100 ×1</td><td style="padding:8px 0;text-align:right;">280 TND</td></tr>', isHtml: true },
      { name: "total", sample: "287 TND" },
      { name: "shipping", sample: "Offerte" },
      {
        name: "tax_note",
        sample: "",
        description: "« dont TVA … » quand la taxe est incluse dans le total (vide sinon)",
      },
      { name: "order_url", sample: "https://tokyostore.tn/order/…" },
    ],
    html: wrap(`
      ${eyebrow("Commande reçue")}
      ${heading("Merci {{ customer_name }} !")}
      ${p("Votre commande <strong>{{ order_number }}</strong> a bien été enregistrée. {{ payment_note }} Voici le récapitulatif :")}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 4px 0;font-size:14px;color:${BODY};">
        {{ items_html }}
        <tr><td style="padding:10px 0 4px 0;border-top:1px solid ${BORDER};color:${MUTED};">Livraison</td><td style="padding:10px 0 4px 0;border-top:1px solid ${BORDER};text-align:right;">{{ shipping }}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700;color:${INK};">Total</td><td style="padding:4px 0;text-align:right;font-weight:700;color:${INK};">{{ total }}</td></tr>
      </table>
      <div style="font-size:11px;color:${MUTED};text-align:right;margin:0 0 4px 0;">{{ tax_note }}</div>
      ${button("Voir ma commande", "order_url")}
      ${footnote("Nous vous préviendrons dès l'expédition. Merci de votre confiance.")}
    `),
  },
  {
    key: "newsletter_coupon",
    name: "Code de bienvenue (newsletter)",
    category: "marketing",
    description: "Code promo envoyé à l'inscription à la newsletter.",
    // `{{ discount }}` is the promo's BENEFIT label (describePromoDiscount):
    // « −10 % », « −5 TND », « Livraison offerte », « −10 % + livraison offerte »
    // — so the copy must read with any of them (no « … de réduction » suffix).
    subject: `Votre code {{ code }} — {{ discount }} sur votre 1ʳᵉ commande`,
    variables: [
      { name: "code", sample: "WELCOME10" },
      { name: "discount", sample: "−10 %", description: "Avantage : « −10 % », « −5 TND », « Livraison offerte »…" },
      { name: "shop_url", sample: "https://tokyostore.tn" },
    ],
    html: wrap(`
      ${eyebrow("Cadeau de bienvenue")}
      ${heading("{{ discount }} sur votre 1ʳᵉ commande.")}
      ${p("Merci de votre inscription ! Utilisez le code ci-dessous au paiement :")}
      ${codeBox("code")}
      ${button("J'en profite", "shop_url")}
      ${footnote("Code valable sur votre première commande. Non cumulable avec d'autres promotions.")}
    `),
  },
  {
    key: "birthday_coupon",
    name: "Anniversaire (cadeau)",
    category: "marketing",
    description: "Email d'anniversaire avec un code cadeau valable le jour J.",
    subject: `🎂 Joyeux anniversaire {{ first_name }} — un cadeau vous attend`,
    variables: [
      { name: "first_name", sample: "Sami" },
      { name: "code", sample: "ANNIV20" },
      { name: "discount", sample: "−20 %", description: "Avantage : « −20 % », « −5 TND », « Livraison offerte »…" },
      { name: "shop_url", sample: "https://tokyostore.tn" },
    ],
    html: wrap(`
      ${eyebrow("Joyeux anniversaire")}
      ${heading("Un cadeau rien que pour vous, {{ first_name }} 🎉")}
      ${p("Toute l'équipe {{ brand_name }} vous souhaite un excellent anniversaire ! Pour fêter ça, voici votre cadeau — <strong>{{ discount }}</strong> avec le code ci-dessous :")}
      ${codeBox("code")}
      ${button("J'en profite", "shop_url")}
      ${footnote("Cadeau valable uniquement le jour de votre anniversaire.")}
    `),
  },
  {
    key: "wishlist_campaign",
    name: "Campagne liste d'envies (personnalisée)",
    category: "marketing",
    description: "Code promo + les articles de la liste d'envies du client (campagne ciblée par segment).",
    subject: `{{ first_name }}, vos favoris vous attendent — {{ discount }} avec {{ code }}`,
    variables: [
      { name: "first_name", sample: "Sami" },
      { name: "code", sample: "FAVORIS20" },
      { name: "discount", sample: "−20 %", description: "Avantage : « −20 % », « −5 TND », « Livraison offerte »…" },
      { name: "wishlist_items", sample: "<ul><li>Festina Chrono</li></ul>", isHtml: true, description: "La liste des articles favoris du client (HTML)." },
      { name: "shop_url", sample: "https://tokyostore.tn" },
    ],
    html: wrap(`
      ${eyebrow("Rien que pour vous")}
      ${heading("Vos favoris vous attendent, {{ first_name }} ✨")}
      ${p("Nous avons pensé à vous : profitez de <strong>{{ discount }}</strong> sur votre sélection avec le code ci-dessous.")}
      ${p("Vos articles favoris :")}
      {{ wishlist_items }}
      ${codeBox("code")}
      ${button("Voir mes favoris", "shop_url")}
      ${footnote("Une attention personnalisée d'après votre liste d'envies.")}
    `),
  },
  {
    key: "promotion_announcement",
    name: "Annonce de promotion",
    category: "marketing",
    description: "Annonce une promotion à son audience (envoi de masse).",
    subject: `{{ promo_name }} — {{ discount }} chez {{ brand_name }}`,
    variables: [
      { name: "promo_name", sample: "Soldes d'été" },
      { name: "discount", sample: "−30 %", description: "Avantage : « −30 % », « −5 TND », « Livraison offerte »…" },
      { name: "code_block", sample: "", isHtml: true },
      { name: "valid_until", sample: "Jusqu'au 31 août" },
      { name: "cta_url", sample: "https://tokyostore.tn" },
    ],
    html: wrap(`
      ${eyebrow("Offre spéciale")}
      ${heading("{{ promo_name }}")}
      ${p("Votre avantage : <strong>{{ discount }}</strong>, dès maintenant sur {{ brand_name }}.")}
      {{ code_block }}
      ${button("J'en profite", "cta_url")}
      ${footnote("{{ valid_until }}")}
    `),
  },
  {
    key: "wishlist_price_drop",
    name: "Baisse de prix (favoris)",
    category: "marketing",
    description: "Alerte quand un produit des favoris baisse de prix.",
    subject: `💸 {{ product_name }} a baissé de prix`,
    variables: [
      { name: "product_name", sample: "Festina Chrono Bike" },
      { name: "old_price", sample: "120,000 TND" },
      { name: "new_price", sample: "89,000 TND" },
      { name: "percent_off", sample: "26%" },
      { name: "pdp_url", sample: "https://tokyostore.tn/produit/festina-chrono-bike" },
    ],
    html: wrap(`
      ${eyebrow("Bonne nouvelle")}
      ${heading("{{ product_name }} est à -{{ percent_off }}")}
      ${p(`Un produit de vos favoris vient de baisser de prix : <s style="color:${MUTED};">{{ old_price }}</s> &rarr; <strong style="color:{{ brand_primary }};">{{ new_price }}</strong>.`)}
      ${button("Voir le produit", "pdp_url")}
      ${footnote("Les prix et la disponibilité peuvent évoluer.")}
    `),
  },
  {
    key: "order_confirmed",
    name: "Commande confirmée",
    category: "commerce",
    description: "Notification quand une commande est confirmée (acceptée par la boutique).",
    subject: `Votre commande {{ order_number }} est confirmée ✅`,
    variables: [
      { name: "customer_name", sample: "Sami" },
      { name: "order_number", sample: "CMD-7K9P2X" },
      { name: "order_url", sample: "https://tokyostore.tn/order/abc" },
    ],
    html: wrap(`
      ${eyebrow("Confirmation")}
      ${heading("Merci, {{ customer_name }} !")}
      ${p("Votre commande <strong>{{ order_number }}</strong> est confirmée. Nous la préparons avec le plus grand soin.")}
      ${button("Suivre ma commande", "order_url")}
    `),
  },
  {
    key: "order_paid",
    name: "Paiement reçu",
    category: "commerce",
    description: "Notification quand le paiement en ligne d'une commande est confirmé.",
    subject: `Paiement reçu pour la commande {{ order_number }} 💳`,
    variables: [
      { name: "customer_name", sample: "Sami" },
      { name: "order_number", sample: "CMD-7K9P2X" },
      { name: "order_url", sample: "https://tokyostore.tn/order/abc" },
    ],
    html: wrap(`
      ${eyebrow("Paiement")}
      ${heading("Paiement confirmé, {{ customer_name }} !")}
      ${p("Nous avons bien reçu le paiement de votre commande <strong>{{ order_number }}</strong>. Elle entre en préparation.")}
      ${button("Suivre ma commande", "order_url")}
    `),
  },
  {
    key: "order_preparing",
    name: "Commande en préparation",
    category: "commerce",
    description: "Notification quand une commande passe au statut « en préparation ».",
    subject: `Votre commande {{ order_number }} est en préparation 📦`,
    variables: [
      { name: "customer_name", sample: "Sami" },
      { name: "order_number", sample: "CMD-7K9P2X" },
      { name: "order_url", sample: "https://tokyostore.tn/order/abc" },
    ],
    html: wrap(`
      ${eyebrow("Préparation")}
      ${heading("En cours, {{ customer_name }} !")}
      ${p("Votre commande <strong>{{ order_number }}</strong> est en préparation dans nos ateliers. Vous serez notifié dès son expédition.")}
      ${button("Suivre ma commande", "order_url")}
    `),
  },
  {
    key: "order_shipped",
    name: "Commande expédiée",
    category: "commerce",
    description: "Notification quand une commande passe au statut « expédiée ».",
    subject: `Votre commande {{ order_number }} est en route 🚚`,
    variables: [
      { name: "customer_name", sample: "Sami" },
      { name: "order_number", sample: "CMD-7K9P2X" },
      { name: "order_url", sample: "https://tokyostore.tn/order/abc" },
    ],
    html: wrap(`
      ${eyebrow("Expédition")}
      ${heading("C'est parti, {{ customer_name }} !")}
      ${p("Votre commande <strong>{{ order_number }}</strong> a été expédiée et arrive bientôt.")}
      ${button("Suivre ma commande", "order_url")}
    `),
  },
  {
    key: "order_delivered",
    name: "Commande livrée",
    category: "commerce",
    description: "Notification quand une commande passe au statut « livrée ».",
    subject: `Votre commande {{ order_number }} a été livrée ✅`,
    variables: [
      { name: "customer_name", sample: "Sami" },
      { name: "order_number", sample: "CMD-7K9P2X" },
      { name: "order_url", sample: "https://tokyostore.tn/order/abc" },
    ],
    html: wrap(`
      ${eyebrow("Livraison")}
      ${heading("Bonne nouvelle, {{ customer_name }} !")}
      ${p("Votre commande <strong>{{ order_number }}</strong> a bien été livrée. Belle découverte de votre produit ! 🎉")}
      ${button("Voir ma commande", "order_url")}
    `),
  },
  {
    key: "order_cancelled",
    name: "Commande annulée",
    category: "commerce",
    description: "Notification quand une commande est annulée.",
    subject: `Votre commande {{ order_number }} a été annulée`,
    variables: [
      { name: "customer_name", sample: "Sami" },
      { name: "order_number", sample: "CMD-7K9P2X" },
      { name: "order_url", sample: "https://tokyostore.tn/order/abc" },
    ],
    html: wrap(`
      ${eyebrow("Annulation")}
      ${heading("Commande annulée, {{ customer_name }}")}
      ${p("Votre commande <strong>{{ order_number }}</strong> a été annulée. Si un paiement a été effectué, le remboursement sera traité séparément. Pour toute question, répondez à cet email.")}
      ${button("Voir ma commande", "order_url")}
    `),
  },
  {
    key: "back_in_stock",
    name: "De retour en stock (favoris)",
    category: "marketing",
    description: "Alerte quand un produit des favoris est réapprovisionné.",
    subject: `🔔 {{ product_name }} est de retour en stock`,
    variables: [
      { name: "product_name", sample: "Festina Chrono Bike" },
      { name: "pdp_url", sample: "https://tokyostore.tn/produit/festina-chrono-bike" },
    ],
    html: wrap(`
      ${eyebrow("De retour")}
      ${heading("{{ product_name }} est de nouveau disponible")}
      ${p("Un produit de vos favoris vient d'être réapprovisionné — ne le manquez pas cette fois !")}
      ${button("Voir le produit", "pdp_url")}
    `),
  },
  {
    key: "review_request",
    // MARKETING, not account: the review-request run targets marketing-opted-in
    // customers and is a post-sale nudge, so it must be consent-gated + carry the
    // unsubscribe footer (and have its opt-out re-checked at drain time).
    name: "Demande d'avis",
    category: "marketing",
    description: "Invite le client à laisser un avis après livraison.",
    subject: `Votre avis compte, {{ first_name }} 🌟`,
    variables: [
      { name: "first_name", sample: "Sami" },
      { name: "order_number", sample: "CMD-7K9P2X" },
      { name: "order_url", sample: "https://tokyostore.tn/order/abc" },
    ],
    html: wrap(`
      ${eyebrow("Votre avis")}
      ${heading("Comment s'est passée votre commande ?")}
      ${p("Bonjour {{ first_name }}, votre commande <strong>{{ order_number }}</strong> a été livrée. Prenez un instant pour partager votre avis — ça aide toute la communauté {{ brand_name }}.")}
      ${button("Laisser un avis", "order_url")}
    `),
  },
];

// Module-local lookup behind `getEmailTemplate` — not part of the public surface.
const EMAIL_TEMPLATE_MAP: Map<string, EmailTemplateDef> = new Map(
  EMAIL_TEMPLATES.map((t) => [t.key, t]),
);

export function getEmailTemplate(key: string): EmailTemplateDef | undefined {
  return EMAIL_TEMPLATE_MAP.get(key);
}

/** Account-security template (see `EmailTemplateDef.critical`). */
export function isCriticalTemplate(key: string): boolean {
  return EMAIL_TEMPLATE_MAP.get(key)?.critical === true;
}
