"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { resolveUserPermissions } from "@/lib/rbac/authorize";
import { WILDCARD } from "@/lib/rbac/registry";
import { type ActionState } from "@/lib/actions/types";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import {
  isSiteUrlChange,
  SITE_URL_KEY,
  siteUrlChangeRefused,
  validateSiteUrlInput,
} from "@/lib/seo/url-guards";

const TEXT_FIELDS: Array<{ key: string; label: string }> = [
  { key: "seo.site_url", label: "SEO — URL canonique du site" },
  { key: "seo.title_template", label: "SEO — modèle de titre" },
  { key: "seo.default_title", label: "SEO — titre par défaut" },
  { key: "seo.title_home", label: "SEO — titre de la page d'accueil" },
  { key: "seo.description_home", label: "SEO — description de la page d'accueil" },
  { key: "seo.default_description", label: "SEO — description par défaut" },
  { key: "seo.keywords", label: "SEO — mots-clés du site" },
  { key: "seo.og_image_media_id", label: "SEO — image OG (médiathèque)" },
  { key: "seo.og_image_url", label: "SEO — image OG (URL de secours)" },
  { key: "seo.twitter_handle", label: "SEO — compte X" },
  { key: "seo.social_facebook", label: "SEO — Facebook" },
  { key: "seo.social_instagram", label: "SEO — Instagram" },
  { key: "seo.social_x", label: "SEO — X" },
  { key: "seo.social_linkedin", label: "SEO — LinkedIn" },
  { key: "seo.social_youtube", label: "SEO — YouTube" },
  { key: "seo.social_tiktok", label: "SEO — TikTok" },
  { key: "seo.knows_about", label: "SEO — domaines d'expertise" },
  { key: "seo.llms_txt", label: "SEO — llms.txt (contenu)" },
  // Organization @type (select) + the editable robots.txt / sitemap lists. All
  // re-validated at read time in getSeoConfig (settings-normalize.ts), so an
  // out-of-range type or malformed path/URL is sanitized before it reaches
  // robots.ts / sitemap.ts / jsonld.ts.
  { key: "seo.org_type", label: "SEO — type d'organisation (schema)" },
  // « Magasin physique » (LocalBusiness) — structured address components + map
  // coordinates + price range. geo/price are emitted only when org_type = Store;
  // geo lat/lng are re-validated numeric (±90 / ±180) in getSeoConfig.
  { key: "seo.address_locality", label: "SEO — magasin : ville" },
  { key: "seo.address_region", label: "SEO — magasin : région / gouvernorat" },
  { key: "seo.postal_code", label: "SEO — magasin : code postal" },
  { key: "seo.geo_lat", label: "SEO — magasin : latitude" },
  { key: "seo.geo_lng", label: "SEO — magasin : longitude" },
  { key: "seo.price_range", label: "SEO — magasin : fourchette de prix" },
  { key: "seo.robots_extra_disallow", label: "SEO — robots.txt : chemins exclus" },
  { key: "seo.sitemap_extra_urls", label: "SEO — sitemap : URL supplémentaires" },
  // Flux produits (Google Merchant + OpenAI ACP). Paths + identity are
  // re-validated at read time in resolveFeedConfig (feeds/normalize.ts).
  { key: "seo.feed_google_path", label: "SEO — flux Google : nom de fichier" },
  { key: "seo.feed_acp_path", label: "SEO — flux ACP : nom de fichier" },
  { key: "seo.feed_seller_name", label: "SEO — flux : nom du vendeur" },
  { key: "seo.feed_store_country", label: "SEO — flux : pays du magasin (ISO-2)" },
  { key: "seo.feed_target_countries", label: "SEO — flux : pays cibles (ISO-2)" },
  { key: "seo.feed_return_policy_url", label: "SEO — flux : URL politique de retour" },
  { key: "seo.feed_privacy_url", label: "SEO — flux : URL confidentialité" },
  { key: "seo.feed_tos_url", label: "SEO — flux : URL CGU" },
];

export async function saveSeoSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission('system_seo', 'update');

  // `seo.site_url` is not just SEO metadata: it is the origin of the payment
  // return / callback URLs, every email link and the printed
  // order QR codes (resolvePublicOrigin). Owner-only (`*`, like the tracking
  // scripts / mail transport): a delegate's form renders it disabled (not posted
  // → the stored value is kept); a crafted post of a different value is refused.
  // A CHANGE must be a bare https origin (http only for localhost).
  const isOwner = (await resolveUserPermissions(session.user.id)).has(WILDCARD);
  const storedSiteUrl =
    (await getSettingsMap().catch(() => ({}) as Record<string, string | null>))[SITE_URL_KEY] ?? "";
  const postedSiteUrl = formData.has(SITE_URL_KEY) ? String(formData.get(SITE_URL_KEY) ?? "") : null;
  if (siteUrlChangeRefused(isOwner, postedSiteUrl, storedSiteUrl)) {
    return {
      ok: false,
      error: "forbidden",
      message:
        "Seul un super-administrateur peut modifier l'URL du site : elle pilote aussi les retours de paiement, les liens des e-mails, les invitations et les QR codes imprimés.",
      fieldErrors: { [SITE_URL_KEY]: "Réservé au super-administrateur." },
    };
  }
  let siteUrlValue: string | null = null; // null = unchanged → keep the stored value
  if (isSiteUrlChange(postedSiteUrl, storedSiteUrl)) {
    const checked = validateSiteUrlInput(postedSiteUrl);
    if (!checked.ok) {
      return {
        ok: false,
        error: "validation",
        message: checked.message,
        fieldErrors: { [SITE_URL_KEY]: checked.message },
      };
    }
    siteUrlValue = checked.value;
  }

  for (const f of TEXT_FIELDS) {
    let value: string;
    if (f.key === SITE_URL_KEY) {
      if (siteUrlValue === null) continue;
      value = siteUrlValue;
    } else {
      value = String(formData.get(f.key) ?? "").trim();
    }
    const res = await workflows.cms.upsertSetting(
      {
        key: f.key,
        value,
        type: "text" as never,
        groupKey: "seo",
        label: f.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  // Boolean toggles — checkboxes submit "on" when checked, absent otherwise.
  const BOOL_FIELDS: Array<{ key: string; label: string; fallback: boolean }> = [
    { key: "seo.robots_index", label: "SEO — autoriser l'indexation", fallback: true },
    {
      key: "seo.product_sameas_enabled",
      label: "SEO — liens officiels produits (sameAs)",
      fallback: false,
    },
    // Sitemap content-type inclusion (default ON).
    { key: "seo.sitemap_include_products", label: "Sitemap — produits", fallback: true },
    { key: "seo.sitemap_include_categories", label: "Sitemap — catégories", fallback: true },
    { key: "seo.sitemap_include_brands", label: "Sitemap — marques", fallback: true },
    { key: "seo.sitemap_include_blog", label: "Sitemap — blog", fallback: true },
    // Feeds (default OFF — admin enables once identity is set).
    { key: "seo.feed_google_enabled", label: "SEO — flux Google Merchant activé", fallback: false },
    { key: "seo.feed_acp_enabled", label: "SEO — flux OpenAI ACP activé", fallback: false },
    // Markdown for Agents (default ON — only triggers on an explicit agent signal).
    { key: "seo.markdown_agents_enabled", label: "SEO — Markdown pour agents activé", fallback: true },
  ];
  for (const f of BOOL_FIELDS) {
    const checked = formData.get(f.key) === "on";
    const res = await workflows.cms.upsertSetting(
      {
        key: f.key,
        value: checked ? "true" : "false",
        type: "boolean" as never,
        groupKey: "seo",
        label: f.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  revalidatePath("/admin/system/seo");
  revalidatePath("/", "layout");
  return { ok: true, message: "Réglages SEO enregistrés." };
}
