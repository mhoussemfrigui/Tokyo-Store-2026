/**
 * Pure normalizers + config assembler for the product FEEDS (Google Merchant XML
 * + OpenAI Agentic Commerce Protocol JSON). Turns the raw `seo.feed_*` settings
 * map into a safe, validated `FeedConfig`. Dependency-light (only the shared bool
 * coercer) so it unit-tests without the server/DB chain — mirrors settings-normalize.ts.
 */
import { asBool } from "@/lib/cms/setting-coerce";

export type FeedConfig = {
  /** Google Merchant RSS-2.0 XML feed. */
  google: { enabled: boolean; path: string };
  /** OpenAI Agentic Commerce Protocol JSON feed (ChatGPT Shopping). */
  acp: { enabled: boolean; path: string };
  /** Seller display name (ACP seller_name / feed channel title). */
  sellerName: string;
  /** Seller storefront origin (absolute, no trailing slash). */
  sellerUrl: string;
  /** Store country, ISO 3166-1 alpha-2 (ACP store_country). */
  storeCountry: string;
  /** Markets the catalogue sells to, ISO-2 (ACP target_countries). */
  targetCountries: string[];
  /** Absolute HTTPS return-policy URL (ACP return_policy). */
  returnPolicyUrl: string;
  /** Absolute HTTPS privacy-policy URL (ACP seller_privacy_policy). */
  privacyUrl: string;
  /** Absolute HTTPS terms URL (ACP seller_tos). */
  tosUrl: string;
};

export const FEED_DEFAULTS = {
  googlePath: "google-merchant.xml",
  acpPath: "agentic.json",
  storeCountry: "TN",
} as const;

const MAX_TARGET_COUNTRIES = 50;

/**
 * A single safe path SEGMENT for `/feeds/<segment>` — keep [a-z0-9._-], lower-cased,
 * no slashes / traversal / spaces. Empty or unsafe → fallback. Editable filename.
 */
export function normalizeFeedPath(raw: string | null | undefined, fallback: string): string {
  const cleaned = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
  // Reject empty, dot-only, or leading-dot (hidden / traversal-ish) values.
  return cleaned && cleaned !== "." && cleaned !== ".." && !cleaned.startsWith(".")
    ? cleaned
    : fallback;
}

/** ISO 3166-1 alpha-2 (two letters), upper-cased; invalid → fallback. */
export function normalizeIsoCountry(raw: string | null | undefined, fallback: string): string {
  const t = (raw ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(t) ? t : fallback;
}

/** CSV/whitespace list of ISO-2 codes, upper-cased, deduped, capped; empty → fallback. */
export function normalizeIsoCountryList(
  raw: string | null | undefined,
  fallback: string[],
): string[] {
  if (!raw) return fallback;
  const seen = new Set<string>();
  for (const tok of raw.split(/[\s,;]+/)) {
    const c = tok.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(c)) seen.add(c);
    if (seen.size >= MAX_TARGET_COUNTRIES) break;
  }
  return seen.size > 0 ? [...seen] : fallback;
}

/** A valid HTTPS URL, else the fallback. Plain http is upgraded-or-dropped → fallback. */
export function normalizeHttpsUrl(raw: string | null | undefined, fallback: string): string {
  const t = (raw ?? "").trim();
  if (!t) return fallback;
  try {
    const u = new URL(t);
    return u.protocol === "https:" ? u.toString() : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Assemble the FeedConfig from the raw settings map + request-time context
 * (origin + store name). Defaults: feeds OFF (admin enables once identity is set);
 * legal URLs default to the store's standard pages. Pure.
 */
export function resolveFeedConfig(
  map: Record<string, string | null>,
  ctx: { origin: string; siteName: string },
): FeedConfig {
  const origin = ctx.origin.replace(/\/$/, "");
  return {
    google: {
      enabled: asBool(map["seo.feed_google_enabled"], false),
      path: normalizeFeedPath(map["seo.feed_google_path"], FEED_DEFAULTS.googlePath),
    },
    acp: {
      enabled: asBool(map["seo.feed_acp_enabled"], false),
      path: normalizeFeedPath(map["seo.feed_acp_path"], FEED_DEFAULTS.acpPath),
    },
    sellerName: (map["seo.feed_seller_name"]?.trim() || ctx.siteName || "Tokyo Store").slice(0, 70),
    sellerUrl: origin,
    storeCountry: normalizeIsoCountry(map["seo.feed_store_country"], FEED_DEFAULTS.storeCountry),
    targetCountries: normalizeIsoCountryList(map["seo.feed_target_countries"], [
      FEED_DEFAULTS.storeCountry,
    ]),
    returnPolicyUrl: normalizeHttpsUrl(map["seo.feed_return_policy_url"], `${origin}/cgv`),
    privacyUrl: normalizeHttpsUrl(map["seo.feed_privacy_url"], `${origin}/confidentialite`),
    tosUrl: normalizeHttpsUrl(map["seo.feed_tos_url"], `${origin}/cgu`),
  };
}
