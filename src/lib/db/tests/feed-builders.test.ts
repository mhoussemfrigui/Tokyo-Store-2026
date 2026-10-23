/**
 * Pure unit tests for the feed builders (Google Merchant XML + ACP JSON). NO DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/feed-builders.test.ts
 */
import { buildGoogleMerchantFeed } from "@/lib/seo/feeds/google-merchant";
import { buildAcpFeed, buildAcpProduct } from "@/lib/seo/feeds/acp-feed";
import type { FeedMeta, FeedProduct } from "@/lib/seo/feeds/types";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const META: FeedMeta = {
  feedTitle: "Tokyo Store — produits",
  feedLink: "https://tokyostore.tn/feeds/google-merchant.xml",
  feedDescription: "Flux Google Merchant",
  sellerName: "Tokyo Store",
  sellerUrl: "https://tokyostore.tn",
  currency: "TND",
  priceDecimals: 3,
  storeCountry: "TN",
  targetCountries: ["TN", "FR"],
  returnPolicyUrl: "https://tokyostore.tn/cgv",
  privacyUrl: "https://tokyostore.tn/privacy",
  tosUrl: "https://tokyostore.tn/cgu",
  builtAt: "Mon, 23 Jun 2026 04:05:00 GMT", // RFC-822, as Date.toUTCString() emits
};

const SIMPLE: FeedProduct = {
  id: "43",
  title: "Pikmin 1 + 2 - Jeu Nintendo Switch",
  description: "Acheter Pikmin 1 & 2 sur Switch. <b>HTML</b> already stripped by caller.",
  url: "https://tokyostore.tn/pikmin-1-2",
  imageUrl: "https://tokyostore.tn/img/pikmin.jpg",
  additionalImageUrls: ["https://tokyostore.tn/img/pikmin-2.jpg"],
  priceMinor: 169_000,
  availability: "out_of_stock",
  condition: "new",
  brand: "Nintendo",
  gtin: "0045496479718",
  mpn: "43",
  categoryPath: "Nintendo Switch > Jeux",
};

const NO_IDENT: FeedProduct = {
  id: "99",
  title: "Accessoire générique",
  description: "Sans marque ni code.",
  url: "https://tokyostore.tn/acc",
  imageUrl: "https://tokyostore.tn/img/acc.jpg",
  priceMinor: 25_000,
  salePriceMinor: 19_000,
  availability: "in_stock",
  condition: "new",
};

const VARIANT_ROW: FeedProduct = {
  id: "v-1",
  groupId: "p-1",
  title: "Manette - Bleu",
  description: "Manette sans fil.",
  url: "https://tokyostore.tn/manette-bleu",
  imageUrl: "https://tokyostore.tn/img/manette.jpg",
  priceMinor: 120_000,
  availability: "in_stock",
  condition: "new",
  brand: "Sony",
  variant: { Couleur: "Bleu", Taille: "M" },
  reviewCount: 12,
  starRating: 4.5,
};

console.log("feed-builders (Google Merchant):");
const xml = buildGoogleMerchantFeed([SIMPLE, NO_IDENT, VARIANT_ROW], META);
ok("declares rss 2.0 + g: namespace", xml.includes(`<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">`));
ok("channel title + lastBuildDate (RFC-822)", xml.includes("<title>Tokyo Store — produits</title>") && xml.includes("<lastBuildDate>Mon, 23 Jun 2026 04:05:00 GMT</lastBuildDate>"));
ok("g:id + g:title", xml.includes("<g:id>43</g:id>") && xml.includes("<g:title>Pikmin 1 + 2 - Jeu Nintendo Switch</g:title>"));
ok("g:price embeds currency + 3 decimals", xml.includes("<g:price>169.000 TND</g:price>"));
ok("g:availability out_of_stock", xml.includes("<g:availability>out_of_stock</g:availability>"));
ok("g:condition new", xml.includes("<g:condition>new</g:condition>"));
ok("description in CDATA", xml.includes("<g:description><![CDATA[Acheter Pikmin 1 & 2"));
ok("additional_image_link emitted", xml.includes("<g:additional_image_link>https://tokyostore.tn/img/pikmin-2.jpg</g:additional_image_link>"));
ok("identifier_exists=no when no brand/gtin/mpn", xml.includes("<g:identifier_exists>no</g:identifier_exists>"));
ok("sale_price emitted when <= price", xml.includes("<g:sale_price>19.000 TND</g:sale_price>"));
ok("item_group_id for variant", xml.includes("<g:item_group_id>p-1</g:item_group_id>"));
ok("no g:sale_price for SIMPLE (none set)", !xml.includes("<g:sale_price>169"));
// Variant axes → standard Google attributes (Couleur→g:color, Taille→g:size).
ok("g:color + g:size from variant axes", xml.includes("<g:color>Bleu</g:color>") && xml.includes("<g:size>M</g:size>"));
// g:product_type carries the FULL breadcrumb path, not just a single name (">" XML-escaped).
ok("g:product_type = full breadcrumb path", xml.includes("<g:product_type>Nintendo Switch &gt; Jeux</g:product_type>"));

// A pre-order (backorder) must survive to g:availability, never collapse to out_of_stock.
const BACKORDER: FeedProduct = {
  id: "bo-1",
  title: "Précommande Switch 2",
  description: "Lancement à venir.",
  url: "https://tokyostore.tn/switch-2",
  imageUrl: "https://tokyostore.tn/img/switch2.jpg",
  priceMinor: 999_000,
  availability: "backorder",
  condition: "new",
};
ok("g:availability backorder passes through", buildGoogleMerchantFeed([BACKORDER], META).includes("<g:availability>backorder</g:availability>"));

// A dated PRÉCOMMANDE maps to g:availability=preorder + g:availability_date (the
// release instant) — Google separates it from backorder (released-but-OOS).
const PREORDER: FeedProduct = {
  id: "po-1",
  title: "iPhone 18 Pro — Précommande",
  description: "Sortie prochaine.",
  url: "https://tokyostore.tn/iphone-18-pro-precommande",
  imageUrl: "https://tokyostore.tn/img/iphone18.jpg",
  priceMinor: 4_999_000,
  availability: "preorder",
  availabilityDate: "2026-10-28T16:30:25Z",
  condition: "new",
  brand: "Apple",
};
const preorderXml = buildGoogleMerchantFeed([PREORDER], META);
ok("g:availability preorder", preorderXml.includes("<g:availability>preorder</g:availability>"));
ok("g:availability_date = release instant", preorderXml.includes("<g:availability_date>2026-10-28T16:30:25Z</g:availability_date>"));
const preorderAcp = buildAcpProduct(PREORDER, META);
ok("ACP availability preorder + availability_date", preorderAcp.availability === "preorder" && preorderAcp.availability_date === "2026-10-28T16:30:25Z");

// matière/capacité axes + a scheduled sale window.
const MAT_CAP: FeedProduct = {
  id: "mc-1",
  groupId: "mc",
  title: "Sac - Cuir 20L",
  description: "Sac à dos.",
  url: "https://tokyostore.tn/sac",
  imageUrl: "https://tokyostore.tn/img/sac.jpg",
  priceMinor: 300_000,
  salePriceMinor: 240_000,
  availability: "in_stock",
  condition: "new",
  variant: { "Matière": "Cuir", "Capacité": "20L" },
  salePriceEffective: { start: "2026-06-20T00:00:00Z", end: "2026-06-30T23:59:00Z" },
};
const matCapXml = buildGoogleMerchantFeed([MAT_CAP], META);
ok("g:material + g:capacity from accented axes", matCapXml.includes("<g:material>Cuir</g:material>") && matCapXml.includes("<g:capacity>20L</g:capacity>"));
ok("g:sale_price_effective_date from promo window", matCapXml.includes("<g:sale_price_effective_date>2026-06-20T00:00:00Z/2026-06-30T23:59:00Z</g:sale_price_effective_date>"));

console.log("\nfeed-builders (ACP JSON):");
const json = buildAcpFeed([SIMPLE, NO_IDENT, VARIANT_ROW], META);
let parsed: { products: Array<Record<string, unknown>> } | null = null;
try {
  parsed = JSON.parse(json);
} catch {
  /* leave null */
}
ok("valid JSON with products array of 3", Boolean(parsed) && Array.isArray(parsed!.products) && parsed!.products.length === 3);

const a0 = buildAcpProduct(SIMPLE, META);
ok("booleans are lower-case STRINGS", a0.is_eligible_search === "true" && a0.is_eligible_checkout === "false");
ok("15 required fields present", [
  "is_eligible_search", "is_eligible_checkout", "item_id", "title", "description", "url",
  "brand", "image_url", "price", "availability", "seller_name", "seller_url",
  "return_policy", "target_countries", "store_country",
].every((k) => a0[k] !== undefined));
ok("price embeds ISO-4217 currency", a0.price === "169.000 TND");
ok("availability out_of_stock", a0.availability === "out_of_stock");
ok("target_countries is an array of ISO-2", Array.isArray(a0.target_countries) && (a0.target_countries as string[]).join(",") === "TN,FR");
ok("store_country ISO-2", a0.store_country === "TN");
ok("seller privacy + tos always included", a0.seller_privacy_policy === "https://tokyostore.tn/privacy" && a0.seller_tos === "https://tokyostore.tn/cgu");
ok("gtin + mpn + product_category included when present", a0.gtin === "0045496479718" && a0.mpn === "43" && a0.product_category === "Nintendo Switch > Jeux");

const a1 = buildAcpProduct(NO_IDENT, META);
ok("brand falls back to seller_name when missing", a1.brand === "Tokyo Store");
ok("sale_price emitted + <= price", a1.sale_price === "19.000 TND");

const a2 = buildAcpProduct(VARIANT_ROW, META);
ok("variant availability in_stock", a2.availability === "in_stock");
ok("variant_dict + extracted color/size", JSON.stringify(a2.variant_dict) === JSON.stringify({ Couleur: "Bleu", Taille: "M" }) && a2.color === "Bleu" && a2.size === "M");
ok("group_id for variant", a2.group_id === "p-1");
ok("review_count + star_rating when reviews exist", a2.review_count === 12 && a2.star_rating === 4.5);

// sale_price must NEVER exceed price (rule 6): a bad input is dropped, not emitted.
const badSale = buildAcpProduct({ ...NO_IDENT, salePriceMinor: 999_000 }, META);
ok("sale_price > price is DROPPED", badSale.sale_price === undefined);

// item_id capped at 100 chars.
const longId = buildAcpProduct({ ...SIMPLE, id: "x".repeat(150) }, META);
ok("item_id capped at 100", (longId.item_id as string).length === 100);

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
