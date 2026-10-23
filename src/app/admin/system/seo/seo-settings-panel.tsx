"use client";

import { useActionState, useState } from "react";
import { Loader2, Save, ImageIcon, ExternalLink } from "lucide-react";

import {
  FieldSection,
  SelectField,
  TextField,
  ToggleField,
} from "@/components/admin/_components/setting-fields";
import { FormTabs, FormTab } from "@/components/admin/_components/form-tabs";
import { saveSeoSettingsAction } from "@/lib/actions/seo";
import { type ActionState } from "@/lib/actions/types";
import { MediaPicker } from "@/components/admin/media-picker";
import { ORG_TYPES, ORG_TYPE_LABELS } from "@/lib/seo/settings-normalize";

type Values = {
  /** Saved seo.site_url (may be empty). */
  siteUrl: string;
  /** Effective URL resolved by getSeoConfig (DB → env), used as the preview fallback. */
  resolvedSiteUrl: string;
  titleTemplate: string;
  defaultTitle: string;
  titleHome: string;
  /** `seo.description_home` — home meta description (empty → default description). */
  descriptionHome: string;
  defaultDescription: string;
  /** `seo.keywords` — site-wide meta keywords (comma / newline list). */
  keywords: string;
  ogImageUrl: string;
  ogImageMediaId: string;
  /** Absolute médiathèque OG URL resolved by getSeoConfig — seeds the live preview. */
  resolvedOgImageUrl: string;
  twitterHandle: string;
  facebook: string;
  instagram: string;
  x: string;
  linkedin: string;
  youtube: string;
  tiktok: string;
  knowsAbout: string;
  llmsTxt: string;
  robotsIndex: boolean;
  productSameAsEnabled: boolean;
  orgType: string;
  addressLocality: string;
  addressRegion: string;
  postalCode: string;
  geoLat: string;
  geoLng: string;
  priceRange: string;
  robotsExtraDisallow: string;
  sitemapExtraUrls: string;
  sitemapIncludeProducts: boolean;
  sitemapIncludeCategories: boolean;
  sitemapIncludeBrands: boolean;
  sitemapIncludeBlog: boolean;
  // Flux produits (Google Merchant + OpenAI ACP).
  feedGoogleEnabled: boolean;
  feedGooglePath: string;
  feedAcpEnabled: boolean;
  feedAcpPath: string;
  feedSellerName: string;
  feedStoreCountry: string;
  feedTargetCountries: string;
  feedReturnPolicyUrl: string;
  feedPrivacyUrl: string;
  feedTosUrl: string;
  /** Defaults resolved by getFeedConfig (origin-based) — shown as placeholders. */
  feedDefaults: { sellerName: string; returnPolicyUrl: string; privacyUrl: string; tosUrl: string };
  // Markdown for Agents.
  markdownAgentsEnabled: boolean;
};

const TABS = [
  { id: "general", label: "Général" },
  { id: "indexation", label: "Indexation & robots.txt" },
  { id: "sitemap", label: "Sitemap" },
  { id: "schema", label: "Données structurées" },
  { id: "feeds", label: "Flux produits" },
  { id: "agents", label: "Markdown agents" },
  { id: "llms", label: "llms.txt" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** Paths the storefront robots.txt always disallows (shown read-only). */
const BUILTIN_DISALLOW = ["/admin", "/api", "/account", "/favoris", "/panier"];

function Textarea({
  name,
  label,
  defaultValue,
  placeholder,
  rows = 3,
  helper,
  onChange,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  rows?: number;
  helper?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[13px] font-bold text-foreground">
        {label}
      </span>
      <textarea
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        rows={rows}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        className="w-full resize-y rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 py-3 text-[15px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]"
      />
      {helper && <p className="text-[11px] leading-relaxed text-muted-foreground">{helper}</p>}
    </label>
  );
}

/** A small "open the generated file" pill (robots.txt / sitemap.xml / llms.txt). */
function FileLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 py-1.5 text-xs font-bold text-foreground transition hover:bg-surface"
    >
      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" /> {label}
    </a>
  );
}

/** Derive a human display host (no scheme) from a URL string. */
function displayHost(url: string): string {
  const t = url.trim();
  if (!t) return "votre-domaine.tn";
  try {
    const u = new URL(t);
    return u.host + (u.pathname && u.pathname !== "/" ? u.pathname : "");
  } catch {
    return t.replace(/^https?:\/\//, "");
  }
}

export function SeoSettingsPanel({
  values,
  canUpdate,
  canEditSiteUrl,
}: {
  values: Values;
  /** system_seo:update — without it the form is read-only and the save hidden. */
  canUpdate: boolean;
  /** Owner (`*`) only — `seo.site_url` also drives payments, emails, invites and
   *  QR codes, so a delegate sees it read-only (a disabled input isn't posted →
   *  the stored value is kept; saveSeoSettingsAction re-checks). */
  canEditSiteUrl: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveSeoSettingsAction,
    null,
  );

  // Live preview state — seeded from saved values, updated as the admin types.
  const [pUrl, setPUrl] = useState(values.siteUrl || values.resolvedSiteUrl);
  const [pTitle, setPTitle] = useState(values.defaultTitle);
  const [pDesc, setPDesc] = useState(values.defaultDescription);
  // Prefer the resolved médiathèque image (the one that actually ships) over the
  // raw fallback URL — matches the documented precedence so the preview isn't
  // empty when only a média image is set.
  const [pOg, setPOg] = useState(values.resolvedOgImageUrl || values.ogImageUrl);

  const host = displayHost(pUrl);

  return (
    <form action={formAction} className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="max-w-3xl text-[14px] leading-relaxed text-muted-foreground">
            Tous les réglages SEO, répartis par onglet : métadonnées, indexation &amp; robots.txt,
            sitemap, données structurées (JSON-LD) et llms.txt. Un seul bouton enregistre l&apos;ensemble.
          </p>
        </div>
      </header>

      {!canUpdate && (
        <p className="rounded-[16px] border border-[#f3e3bd] bg-[#fff4e0] px-4 py-3 text-xs font-semibold text-[#b45309]">
          Lecture seule — la permission «&nbsp;modifier&nbsp;» (SEO &amp; schéma) est requise pour
          enregistrer.
        </p>
      )}

      <FormTabs<TabId> tabs={TABS} defaultTab="general">
        {(active) => (
          // A disabled fieldset natively disables every nested control (incl. the
          // media picker trigger) for a view-only operator; it sits INSIDE the tab
          // body so the tab strip itself stays clickable. The action re-checks
          // system_seo:update server-side.
          <fieldset disabled={!canUpdate} className="m-0 min-w-0 border-0 p-0">
            {/* ── GÉNÉRAL ─────────────────────────────────────────────────── */}
            <FormTab id="general" active={active}>
              <FieldSection
                title="URL du site"
                description="Le domaine du site (https://, sans chemin). Il sert aux liens absolus SEO (sitemap, robots, balises canoniques, Open Graph, JSON-LD) mais AUSSI aux adresses de retour et de notification des paiements en ligne, à tous les liens des e-mails, aux liens d'invitation Pro et aux QR codes imprimés sur les documents de commande. Remplace la variable de build NEXT_PUBLIC_SITE_URL — modifiable sans redéploiement, par le super-administrateur uniquement."
              >
                <TextField
                  name="seo.site_url"
                  label="URL canonique"
                  type="url"
                  defaultValue={values.siteUrl}
                  placeholder="https://tokyostore.tn"
                  disabled={!canEditSiteUrl}
                  helper={
                    !canEditSiteUrl
                      ? "Réservé au super-administrateur : ce réglage pilote aussi les paiements, les e-mails et les QR codes."
                      : values.siteUrl
                        ? undefined
                        : `Actuellement : ${values.resolvedSiteUrl || "non défini"} (valeur de build). Renseignez votre domaine réel.`
                  }
                  onChange={setPUrl}
                />
              </FieldSection>

              <FieldSection
                title="Métadonnées par défaut"
                description="Le modèle de titre utilise %s pour le titre de chaque page. L'image OG est utilisée quand une page n'en définit pas. Si le titre ou la description par défaut sont laissés vides, le site utilise « Nom du site — Slogan » et la description du site (Réglages → Site)."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    name="seo.title_template"
                    label="Modèle de titre"
                    defaultValue={values.titleTemplate}
                    placeholder="%s · Tokyo Store"
                  />
                  <TextField
                    name="seo.default_title"
                    label="Titre par défaut"
                    defaultValue={values.defaultTitle}
                    placeholder="Tokyo Store — Produits high-tech pour le passionné de technologie"
                    onChange={setPTitle}
                  />
                </div>
                <TextField
                  name="seo.title_home"
                  label="Titre de la page d'accueil"
                  defaultValue={values.titleHome}
                  placeholder="Produits high-tech & high-tech d'exception"
                  helper="Titre de l'onglet spécifique à la page d'accueil. Laissé vide, le site utilise le titre par défaut ci-dessus."
                />
                <Textarea
                  name="seo.description_home"
                  label="Description de la page d'accueil"
                  defaultValue={values.descriptionHome}
                  rows={2}
                  helper="Meta description propre à la page d'accueil (~150 caractères). Laissée vide, le site utilise la description par défaut ci-dessous."
                />
                <Textarea
                  name="seo.default_description"
                  label="Description par défaut"
                  defaultValue={values.defaultDescription}
                  onChange={setPDesc}
                />
                <Textarea
                  name="seo.keywords"
                  label="Mots-clés du site"
                  defaultValue={values.keywords}
                  rows={2}
                  placeholder="smartphones, high-tech, accessoires, Tunisie"
                  helper="Balise meta « keywords » de tout le site — séparés par des virgules ou un par ligne. Laissé vide, une liste par défaut est utilisée."
                />
                <div>
                  <label className="flex flex-wrap items-center gap-2 text-[13px] font-bold text-foreground">
                    Image de partage (OG) par défaut — médiathèque
                  </label>
                  <div className="mt-2">
                    <MediaPicker
                      name="seo.og_image_media_id"
                      value={values.ogImageMediaId || null}
                      scope="cms"
                      emptyLabel="Choisir une image OG"
                    />
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    Recommandé : 1200×630. Optimisée (webp/avif) et servie via la
                    médiathèque. L&apos;URL ci-dessous sert de secours si aucune image
                    média n&apos;est choisie. Si rien n&apos;est défini ici, le site
                    utilise successivement l&apos;image OG du thème (Apparence) puis le
                    logo du site (Réglages → Site).
                  </p>
                </div>
                <TextField
                  name="seo.og_image_url"
                  label="Image de partage (OG) — URL de secours"
                  defaultValue={values.ogImageUrl}
                  placeholder="https://…/og.jpg"
                  onChange={setPOg}
                />
              </FieldSection>

              <FieldSection
                title="Aperçu"
                description="Comment votre site apparaît dans Google et lors d'un partage social. Mis à jour en direct."
              >
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-[22px] border border-border bg-card p-4">
                    <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8a857f]">
                      Résultat Google
                    </p>
                    <div className="flex items-center gap-2 text-xs text-foreground">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
                        G
                      </span>
                      <span className="truncate text-muted-foreground">{host}</span>
                    </div>
                    <p className="mt-1.5 truncate text-lg leading-snug text-[#1a0dab] dark:text-[#7c8694]">
                      {pTitle || "Titre de la page"}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                      {pDesc || "La description par défaut apparaîtra ici."}
                    </p>
                  </div>

                  <div className="overflow-hidden rounded-[22px] border border-border bg-card">
                    <p className="px-4 pt-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8a857f]">
                      Partage social (Open Graph)
                    </p>
                    <div className="mt-3 grid aspect-[1.91/1] w-full place-items-center overflow-hidden bg-surface">
                      {pOg ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={pOg} alt="Aperçu OG" className="h-full w-full object-cover" />
                      ) : (
                        <ImageIcon className="h-8 w-8 text-muted-foreground/40" strokeWidth={1.5} />
                      )}
                    </div>
                    <div className="p-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{host}</p>
                      <p className="truncate text-sm font-semibold text-foreground">
                        {pTitle || "Titre de la page"}
                      </p>
                      <p className="line-clamp-2 text-xs text-muted-foreground">{pDesc}</p>
                    </div>
                  </div>
                </div>
              </FieldSection>
            </FormTab>

            {/* ── INDEXATION & ROBOTS.TXT ─────────────────────────────────── */}
            <FormTab id="indexation" active={active}>
              <FieldSection
                title="Indexation"
                description="Le commutateur maître. Désactivé = robots.txt renvoie « Disallow: / » + balise noindex sur tout le site. Laissez activé en production."
              >
                <ToggleField
                  name="seo.robots_index"
                  label="Autoriser l'indexation par les moteurs"
                  description="Quand c'est désactivé, le site entier est masqué des moteurs — n'utilisez ce mode qu'en préproduction."
                  defaultChecked={values.robotsIndex}
                />
              </FieldSection>

              <FieldSection
                title="robots.txt"
                description="Le fichier /robots.txt est généré automatiquement à partir de ces réglages. Ces chemins sont déjà exclus par défaut ; ajoutez les vôtres ci-dessous (un chemin par ligne, commençant par « / »)."
              >
                <div className="flex flex-wrap gap-1.5">
                  {BUILTIN_DISALLOW.map((p) => (
                    <span
                      key={p}
                      className="rounded-full bg-surface px-2.5 py-1 font-mono text-[11px] text-muted-foreground"
                    >
                      Disallow: {p}
                    </span>
                  ))}
                </div>
                <Textarea
                  name="seo.robots_extra_disallow"
                  label="Chemins exclus supplémentaires (Disallow)"
                  defaultValue={values.robotsExtraDisallow}
                  rows={4}
                  placeholder={"/recherche\n/promo-temporaire"}
                  helper="Un chemin par ligne, commençant par « / ». Les entrées invalides (URL absolues, mots sans /) sont ignorées."
                />
                <FileLink href="/robots.txt" label="Voir le /robots.txt généré" />
              </FieldSection>
            </FormTab>

            {/* ── SITEMAP ─────────────────────────────────────────────────── */}
            <FormTab id="sitemap" active={active}>
              <FieldSection
                title="Sitemap"
                description="Le /sitemap.xml est généré automatiquement et se met à jour en direct à chaque changement : pages clés, catégories ET sous-catégories, marques, produits et articles de blog. Les pages noindex, les catégories vides et les pages applicatives (connexion, panier…) sont exclues. La date de modification (lastmod) reflète la vraie date de mise à jour de chaque élément."
              >
                <Textarea
                  name="seo.sitemap_extra_urls"
                  label="URL supplémentaires à inclure"
                  defaultValue={values.sitemapExtraUrls}
                  rows={4}
                  placeholder={"/landing-promo\nhttps://tokyostore.tn/evenement"}
                  helper="Pour des pages personnalisées qui ne sont pas dans le catalogue. Un lien par ligne : chemin (« /promo ») ou URL absolue. Les doublons et entrées invalides sont ignorés."
                />
                <FileLink href="/sitemap.xml" label="Voir le /sitemap.xml généré" />
              </FieldSection>

              <FieldSection
                title="Contenus inclus"
                description="Choisissez les types de contenu listés dans le sitemap. Tout est inclus par défaut ; désactivez un type pour le retirer entièrement du /sitemap.xml."
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <ToggleField name="seo.sitemap_include_products" label="Produits" defaultChecked={values.sitemapIncludeProducts} />
                  <ToggleField name="seo.sitemap_include_categories" label="Catégories & sous-catégories" defaultChecked={values.sitemapIncludeCategories} />
                  <ToggleField name="seo.sitemap_include_brands" label="Marques" defaultChecked={values.sitemapIncludeBrands} />
                  <ToggleField name="seo.sitemap_include_blog" label="Blog (articles + catégories)" defaultChecked={values.sitemapIncludeBlog} />
                </div>
              </FieldSection>
            </FormTab>

            {/* ── DONNÉES STRUCTURÉES (SCHEMA.ORG) ────────────────────────── */}
            <FormTab id="schema" active={active}>
              <FieldSection
                title="Entité Organization"
                description="Le JSON-LD (Organization, WebSite, fil d'Ariane, Produit, Marque, FAQ) est injecté automatiquement sur chaque page — rien à coller à la main. Choisissez le type qui décrit le mieux votre activité."
              >
                <SelectField
                  name="seo.org_type"
                  label="Type d'organisation (schema.org @type)"
                  defaultValue={values.orgType || "Organization"}
                  options={ORG_TYPES.map((t) => ({ value: t, label: ORG_TYPE_LABELS[t] }))}
                  helper="« Boutique en ligne » est recommandé pour un e-commerce. Le nom, le logo et les coordonnées proviennent de Réglages → Site."
                />
              </FieldSection>

              <FieldSection
                title="Magasin physique (LocalBusiness)"
                description="Pour une boutique avec pignon sur rue : adresse structurée, coordonnées GPS et fourchette de prix. Les coordonnées + la fourchette ne sont ajoutées au schéma que si le type ci-dessus est « Magasin physique (Store) » — elles débloquent le « pack local » Google. La rue vient de Réglages → Identité & contact ; complétez ici la ville, la région et le code postal."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    name="seo.address_locality"
                    label="Ville"
                    defaultValue={values.addressLocality}
                    placeholder="Tunis"
                  />
                  <TextField
                    name="seo.address_region"
                    label="Région / gouvernorat"
                    defaultValue={values.addressRegion}
                    placeholder="Tunis"
                  />
                  <TextField
                    name="seo.postal_code"
                    label="Code postal"
                    defaultValue={values.postalCode}
                    placeholder="1053"
                  />
                  <TextField
                    name="seo.price_range"
                    label="Fourchette de prix"
                    defaultValue={values.priceRange}
                    placeholder="200–50000 TND"
                    helper="Indicatif (ex. « €€€ » ou « 200–50000 TND »)."
                  />
                  <TextField
                    name="seo.geo_lat"
                    label="Latitude"
                    defaultValue={values.geoLat}
                    placeholder="34.7406"
                    helper="Décimal, ±90. Depuis Google Maps : clic droit sur le lieu."
                  />
                  <TextField
                    name="seo.geo_lng"
                    label="Longitude"
                    defaultValue={values.geoLng}
                    placeholder="10.7603"
                    helper="Décimal, ±180."
                  />
                </div>
              </FieldSection>

              <FieldSection
                title="Marque & réseaux (schema sameAs)"
                description="Vos profils officiels — alimentent l'entité Organization et le Knowledge Graph de Google."
              >
                <TextField
                  name="seo.twitter_handle"
                  label="Compte X (@handle)"
                  defaultValue={values.twitterHandle}
                  placeholder="@tokyostore"
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField name="seo.social_facebook" label="Facebook (URL)" defaultValue={values.facebook} />
                  <TextField name="seo.social_instagram" label="Instagram (URL)" defaultValue={values.instagram} />
                  <TextField name="seo.social_x" label="X (URL)" defaultValue={values.x} />
                  <TextField name="seo.social_linkedin" label="LinkedIn (URL)" defaultValue={values.linkedin} />
                  <TextField name="seo.social_youtube" label="YouTube (URL)" defaultValue={values.youtube} />
                  <TextField name="seo.social_tiktok" label="TikTok (URL)" defaultValue={values.tiktok} />
                </div>
                <Textarea
                  name="seo.knows_about"
                  label="Domaines d'expertise (knowsAbout)"
                  defaultValue={values.knowsAbout}
                  placeholder="Montres, High-tech, Appareils, Accessoires d'high-tech"
                />
              </FieldSection>

              <FieldSection
                title="Liens officiels des produits (Product.sameAs)"
                description="Permet d'ajouter, sur l'onglet SEO de chaque produit, des URL officielles (page constructeur, boutique officielle…) qui désignent le MÊME produit. Ces liens n'apparaissent dans les données structurées que lorsque cette option est activée."
              >
                <ToggleField
                  name="seo.product_sameas_enabled"
                  label="Activer le champ « liens officiels » par produit"
                  description="Désactivé par défaut. Une fois activé, renseignez les URL au cas par cas dans l'onglet SEO de chaque produit (facultatif)."
                  defaultChecked={values.productSameAsEnabled}
                />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Le <strong>SEO par page</strong> (noindex, URL canonique, titre/description, image OG,
                  liens officiels) se règle dans l&apos;onglet « SEO » de chaque fiche produit / catégorie / marque.
                </p>
              </FieldSection>
            </FormTab>

            {/* ── FLUX PRODUITS (Google Merchant + OpenAI ACP) ────────────── */}
            <FormTab id="feeds" active={active}>
              <FieldSection
                title="Flux Google Merchant (XML)"
                description="Flux produit RSS 2.0 ingéré par Google Merchant Center / Shopping. Désactivé par défaut. Exclu du sitemap + noindex (mis en cache 30 min)."
              >
                <ToggleField
                  name="seo.feed_google_enabled"
                  label="Activer le flux Google Merchant"
                  description="Une fois activé, le flux est servi à l'URL ci-dessous."
                  defaultChecked={values.feedGoogleEnabled}
                />
                <TextField
                  name="seo.feed_google_path"
                  label="Nom de fichier du flux"
                  defaultValue={values.feedGooglePath}
                  placeholder="google-merchant.xml"
                  helper="Servi sous /feeds/. Lettres, chiffres, point, tiret uniquement."
                />
                <FileLink
                  href={`/feeds/${values.feedGooglePath || "google-merchant.xml"}`}
                  label="Ouvrir le flux Google Merchant"
                />
              </FieldSection>

              <FieldSection
                title="Flux IA — OpenAI ACP (JSON)"
                description="Flux au format Agentic Commerce Protocol (la structure que ChatGPT Shopping ingère) : { products: [...] } avec les champs requis (titre, prix + devise, disponibilité, marque, image, politique de retour…). Désactivé par défaut."
              >
                <ToggleField
                  name="seo.feed_acp_enabled"
                  label="Activer le flux OpenAI ACP"
                  description="Servi en JSON à l'URL ci-dessous."
                  defaultChecked={values.feedAcpEnabled}
                />
                <TextField
                  name="seo.feed_acp_path"
                  label="Nom de fichier du flux"
                  defaultValue={values.feedAcpPath}
                  placeholder="agentic.json"
                  helper="Servi sous /feeds/."
                />
                <FileLink
                  href={`/feeds/${values.feedAcpPath || "agentic.json"}`}
                  label="Ouvrir le flux ACP"
                />
              </FieldSection>

              <FieldSection
                title="Identité vendeur (flux)"
                description="Champs partagés par les deux flux (nom du vendeur, pays, politiques). Les URL vides reprennent les pages standard de la boutique."
              >
                <TextField
                  name="seo.feed_seller_name"
                  label="Nom du vendeur"
                  defaultValue={values.feedSellerName}
                  placeholder={values.feedDefaults.sellerName}
                  helper="Max 70 caractères. Vide = nom du site."
                />
                <TextField
                  name="seo.feed_store_country"
                  label="Pays du magasin (ISO-2)"
                  defaultValue={values.feedStoreCountry}
                  placeholder="TN"
                  helper="Code pays à 2 lettres (ISO 3166-1 alpha-2)."
                />
                <TextField
                  name="seo.feed_target_countries"
                  label="Pays cibles (ISO-2, séparés par des virgules)"
                  defaultValue={values.feedTargetCountries}
                  placeholder="TN, FR"
                  helper="Marchés desservis. Vide = pays du magasin."
                />
                <TextField
                  name="seo.feed_return_policy_url"
                  label="URL de la politique de retour"
                  defaultValue={values.feedReturnPolicyUrl}
                  placeholder={values.feedDefaults.returnPolicyUrl}
                  helper="HTTPS. Vide = page CGV de la boutique."
                />
                <TextField
                  name="seo.feed_privacy_url"
                  label="URL de confidentialité"
                  defaultValue={values.feedPrivacyUrl}
                  placeholder={values.feedDefaults.privacyUrl}
                  helper="HTTPS. Vide = page Confidentialité."
                />
                <TextField
                  name="seo.feed_tos_url"
                  label="URL des CGU"
                  defaultValue={values.feedTosUrl}
                  placeholder={values.feedDefaults.tosUrl}
                  helper="HTTPS. Vide = page CGU."
                />
              </FieldSection>
            </FormTab>

            {/* ── MARKDOWN POUR AGENTS ───────────────────────────────────── */}
            <FormTab id="agents" active={active}>
              <FieldSection
                title="Markdown pour agents IA"
                description="Sert une version Markdown propre des pages aux agents IA, sans toucher aux pages HTML vues par les humains et sans créer de contenu indexable par Google. Déclenché uniquement par un signal explicite d'agent : l'en-tête « Accept: text/markdown » OU un suffixe « .md » sur l'URL (ex. /smartphones.md). Toujours servi avec X-Robots-Tag: noindex + un lien canonique vers la page HTML, et exclu du sitemap."
              >
                <ToggleField
                  name="seo.markdown_agents_enabled"
                  label="Activer le Markdown pour agents"
                  description="Activé par défaut. Aucun impact sur les visiteurs humains (Accept: text/html) ni sur Googlebot."
                  defaultChecked={values.markdownAgentsEnabled}
                />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Couvre les produits, catégories, marques, articles &amp; catégories de blog,
                  et pages de contenu. Le Markdown est
                  généré depuis la même couche de données que les pages (jamais par scraping du HTML).
                </p>
              </FieldSection>
            </FormTab>

            {/* ── LLMS.TXT ────────────────────────────────────────────────── */}
            <FormTab id="llms" active={active}>
              <FieldSection
                title="llms.txt"
                description="Guide pour les IA (ChatGPT, Perplexity, AI Overviews) servi sur /llms.txt. Laissez vide pour le générer automatiquement à partir de la boutique (pages clés + catégories + sitemap)."
              >
                <Textarea
                  name="seo.llms_txt"
                  label="Contenu personnalisé (optionnel)"
                  defaultValue={values.llmsTxt}
                  rows={10}
                />
                <FileLink href="/llms.txt" label="Voir le /llms.txt généré" />
              </FieldSection>
            </FormTab>
          </fieldset>
        )}
      </FormTabs>

      {state && !state.ok && <p className="text-sm font-semibold text-[#d40530]">{state.message}</p>}
      {state?.ok && <p className="text-sm font-semibold text-[#15803d]">{state.message}</p>}

      {canUpdate && (
        <div className="sticky bottom-4 z-10 flex justify-end">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground shadow-lift transition hover:bg-[#b8042a] disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Enregistrer les réglages SEO
          </button>
        </div>
      )}
    </form>
  );
}
