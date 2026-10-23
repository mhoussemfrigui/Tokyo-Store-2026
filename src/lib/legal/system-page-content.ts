/**
 * Default PUBLIC content for the protected "system" pages (cgu, cgv, cookies,
 * privacy, mentions-legales, help). These pages MUST be populated + public out
 * of the box — they are legal/operational requirements, not optional marketing
 * pages, so a fresh deploy can never leave them blank.
 *
 * The DB still wins: if an admin composes + publishes the matching CMS page
 * (`/admin/cms/pages`, same slug), `getPageForRender` returns those blocks and
 * the renderer uses them instead. This map is the fallback the block pipeline
 * turns into a single rich_text block when no composed/published override
 * exists — so the pages are always live + sensible while remaining customisable.
 *
 * `html` is sanitised at render time via `sanitizeRichHtml` (same path as an
 * admin-authored rich_text block), so only the allow-listed prose tags survive.
 * Copy is generic-but-valid French for a Tunisian high-tech e-commerce ("Tokyo
 * Watch Store"); operators should refine store-specific identifiers (raison
 * sociale, matricule fiscal, adresse, hébergeur) from the CMS.
 */

export type SystemPageDefault = {
  /** Public H1. */
  title: string;
  /** Prose HTML (sanitised on render). */
  html: string;
};

export const SYSTEM_PAGE_SLUGS = [
  "cgv",
  "cgu",
  "cookies",
  "confidentialite",
  "mentions",
] as const;

export type SystemPageSlug = (typeof SYSTEM_PAGE_SLUGS)[number];

export const SYSTEM_PAGE_DEFAULTS: Record<SystemPageSlug, SystemPageDefault> = {
  cgu: {
    title: "Conditions générales d'utilisation",
    html: `
      <p>Les présentes conditions générales d'utilisation (les « CGU ») encadrent
      l'accès et l'usage du site Tokyo Store. En naviguant sur le site, vous
      acceptez ces conditions.</p>

      <h2>Accès au site</h2>
      <p>Le site est accessible gratuitement à tout utilisateur disposant d'un
      accès à Internet. Les frais liés à l'accès (matériel, connexion) restent à
      votre charge. Nous nous efforçons de maintenir le site disponible en
      continu, sans garantie d'absence d'interruption (maintenance, incidents
      techniques, force majeure).</p>

      <h2>Compte client</h2>
      <p>La création d'un compte vous permet de passer commande, de suivre vos
      livraisons et de gérer vos favoris. Vous êtes responsable de la
      confidentialité de vos identifiants et de toute activité réalisée depuis
      votre compte. Toute information communiquée doit être exacte et tenue à
      jour.</p>

      <h2>Propriété intellectuelle</h2>
      <p>L'ensemble des contenus du site (textes, visuels, logos, marques, mise
      en page) est protégé. Toute reproduction ou réutilisation sans
      autorisation préalable est interdite. Les marques et visuels des produits
      restent la propriété de leurs détenteurs respectifs.</p>

      <h2>Comportement des utilisateurs</h2>
      <p>Vous vous engagez à ne pas perturber le fonctionnement du site, à ne pas
      tenter d'y accéder de manière frauduleuse et à ne pas publier de contenu
      illicite (notamment dans les avis produits, qui peuvent être modérés).</p>

      <h2>Responsabilité</h2>
      <p>Les informations produits sont fournies à titre indicatif et peuvent
      évoluer. Tokyo Store ne saurait être tenu responsable d'un usage non conforme
      des produits ou d'un dommage indirect lié à l'utilisation du site.</p>

      <h2>Évolution des CGU</h2>
      <p>Ces conditions peuvent être mises à jour à tout moment. La version
      applicable est celle en ligne au moment de votre visite.</p>
    `,
  },
  cgv: {
    title: "Conditions générales de vente",
    html: `
      <p>Les présentes conditions générales de vente (les « CGV ») régissent les
      ventes conclues sur le site Tokyo Store. Toute commande implique l'adhésion
      sans réserve à ces conditions.</p>

      <h2>Produits et prix</h2>
      <p>Les produits proposés sont décrits avec le plus grand soin. Les prix sont
      indiqués en dinars tunisiens (TND), toutes taxes comprises. Tokyo Store se
      réserve le droit de modifier ses prix à tout moment ; le prix applicable
      est celui affiché au moment de la validation de la commande.</p>

      <h2>Commande</h2>
      <p>Vous sélectionnez vos produits, validez votre panier, renseignez vos
      coordonnées de livraison et choisissez votre mode de paiement. La commande
      est définitive après confirmation. Un récapitulatif vous est adressé par
      e-mail.</p>

      <h2>Paiement</h2>
      <p>Le paiement s'effectue selon les moyens proposés lors du passage en
      caisse (paiement à la livraison, carte bancaire via une passerelle
      sécurisée, ou autre moyen indiqué). Les transactions par carte sont
      traitées par des prestataires de paiement sécurisés ; Tokyo Store ne stocke
      pas vos données bancaires.</p>

      <h2>Livraison</h2>
      <p>Les produits sont livrés à l'adresse indiquée lors de la commande, dans
      les délais communiqués au moment de l'achat. Les frais de livraison sont
      précisés avant la validation. Tout retard raisonnable lié au transporteur
      ne peut engager la responsabilité de Tokyo Store.</p>

      <h2>Droit de rétractation et retours</h2>
      <p>Vous disposez d'un délai pour demander le retour d'un produit non utilisé,
      complet avec son emballage, ses étiquettes et sa protection d'origine, dans les
      conditions précisées lors de la commande. Certains produits (appareils
      personnalisés ou gravés, articles dont la protection a été retirée) peuvent
      être exclus du retour. Pour toute demande de retour ou de remboursement,
      contactez notre service client.</p>

      <h2>Garantie</h2>
      <p>Les produits bénéficient de la garantie légale et, le cas échéant, d'une
      garantie constructeur dont la durée est indiquée sur la fiche produit. La
      garantie ne couvre pas l'usure normale ni les dommages résultant d'un usage
      non conforme.</p>

      <h2>Service client</h2>
      <p>Pour toute question relative à une commande, une livraison, un retour ou
      une garantie, notre équipe est joignable via la page Support &amp; contact.</p>
    `,
  },
  cookies: {
    title: "Politique de cookies",
    html: `
      <p>Cette politique explique comment Tokyo Store utilise les cookies et
      technologies similaires, et les choix dont vous disposez.</p>

      <h2>Qu'est-ce qu'un cookie ?</h2>
      <p>Un cookie est un petit fichier déposé sur votre appareil lors de la
      visite d'un site. Il permet de mémoriser des informations relatives à votre
      navigation (panier, préférences) ou de mesurer l'audience du site.</p>

      <h2>Cookies que nous utilisons</h2>
      <ul>
        <li><strong>Cookies essentiels</strong> — nécessaires au fonctionnement
        du site (session, panier, sécurité). Ils ne peuvent pas être désactivés.</li>
        <li><strong>Cookies de mesure d'audience</strong> — nous aident à
        comprendre l'usage du site afin de l'améliorer.</li>
        <li><strong>Cookies marketing</strong> — utilisés, le cas échéant, pour
        proposer des contenus pertinents.</li>
        <li><strong>Cookies de préférences</strong> — mémorisent vos choix
        d'affichage (par exemple le thème).</li>
      </ul>

      <h2>Votre consentement</h2>
      <p>Lors de votre première visite, une bannière vous permet d'accepter ou de
      refuser les cookies non essentiels. Vous pouvez modifier votre choix à tout
      moment via les paramètres de cookies du site. Les balises de suivi ne sont
      chargées qu'après votre accord.</p>

      <h2>Gestion via votre navigateur</h2>
      <p>Vous pouvez également configurer votre navigateur pour bloquer ou
      supprimer les cookies. Le blocage des cookies essentiels peut toutefois
      dégrader le fonctionnement du site.</p>
    `,
  },
  confidentialite: {
    title: "Politique de confidentialité",
    html: `
      <p>Tokyo Store accorde une grande importance à la protection de vos données
      personnelles. Cette politique décrit les données que nous collectons, leurs
      finalités, leur durée de conservation et vos droits.</p>

      <h2>Données collectées</h2>
      <ul>
        <li><strong>Identité et contact</strong> — nom, e-mail, téléphone,
        adresse de livraison, communiqués lors de la création de compte ou d'une
        commande.</li>
        <li><strong>Données de commande</strong> — produits achetés, montants,
        historique, nécessaires au traitement et au suivi.</li>
        <li><strong>Données de navigation</strong> — pages consultées, recherches,
        collectées via des cookies (voir la politique de cookies).</li>
      </ul>

      <h2>Finalités</h2>
      <p>Vos données sont utilisées pour traiter vos commandes, assurer la
      livraison et le service après-vente, gérer votre compte,
      sécuriser le site, et — avec votre consentement — vous adresser des
      communications commerciales.</p>

      <h2>Durée de conservation</h2>
      <p>Les données sont conservées le temps nécessaire aux finalités
      poursuivies puis archivées ou supprimées conformément aux obligations
      légales (notamment comptables pour les commandes).</p>

      <h2>Partage</h2>
      <p>Vos données ne sont jamais vendues. Elles peuvent être partagées avec nos
      prestataires (transporteurs, paiement, e-mailing) strictement pour
      l'exécution du service, dans le respect de la confidentialité.</p>

      <h2>Vos droits</h2>
      <p>Vous disposez d'un droit d'accès, de rectification, d'effacement,
      d'opposition et de portabilité de vos données. Vous pouvez aussi retirer
      votre consentement aux communications marketing à tout moment via le lien de
      désinscription ou votre profil. Pour exercer vos droits, contactez-nous via
      la page Support &amp; contact.</p>

      <h2>Sécurité</h2>
      <p>Nous mettons en œuvre des mesures techniques et organisationnelles pour
      protéger vos données contre tout accès non autorisé. Les paiements sont
      traités par des prestataires sécurisés et nous ne stockons pas vos données
      bancaires.</p>
    `,
  },
  mentions: {
    title: "Mentions légales",
    html: `
      <p>Conformément à la réglementation en vigueur, les présentes mentions
      légales précisent les informations relatives à l'éditeur et à l'hébergeur
      du site Tokyo Store.</p>

      <h2>Éditeur du site</h2>
      <p>Le site est édité par <strong>Tokyo Store</strong>, commerce électronique
      de produits high-tech en Tunisie. Les coordonnées de contact (téléphone,
      e-mail, adresse) sont disponibles sur la page Support &amp; contact. La
      raison sociale, l'adresse du siège et le matricule fiscal complets sont
      indiqués sur les documents commerciaux et peuvent être complétés ici depuis
      l'administration du site.</p>

      <h2>Directeur de la publication</h2>
      <p>Le directeur de la publication est le représentant légal de Tokyo Store.</p>

      <h2>Hébergement</h2>
      <p>Le site est hébergé sur une infrastructure cloud sécurisée. Les
      coordonnées de l'hébergeur peuvent être communiquées sur demande et
      complétées depuis l'administration.</p>

      <h2>Propriété intellectuelle</h2>
      <p>L'ensemble des éléments du site est protégé. Les marques et visuels des
      produits demeurent la propriété de leurs détenteurs respectifs.</p>

      <h2>Contact</h2>
      <p>Pour toute question, rendez-vous sur la page Support &amp; contact.</p>
    `,
  },
};

/** Default content for a system slug, or null if the slug isn't a system page. */
export function getSystemPageDefault(slug: string): SystemPageDefault | null {
  return (SYSTEM_PAGE_DEFAULTS as Record<string, SystemPageDefault>)[slug] ?? null;
}
