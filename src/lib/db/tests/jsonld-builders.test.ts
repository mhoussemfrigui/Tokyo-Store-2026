/**
 * Pure unit tests for the listing/FAQ JSON-LD graph builders (schema.org). These
 * drive the category / subcategory / brand / boutique structured data, so a
 * regression (losing the ItemList gate, mis-linking @ids, emitting an empty
 * FAQPage) would silently ship broken markup. No DB — runs in the fast lane.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/jsonld-builders.test.ts
 */
import {
  buildBrandGraph,
  buildCmsPageGraph,
  buildCollectionGraph,
  buildFaqGraph,
  buildGlobalGraph,
  buildHomeProductListsGraph,
  buildOrganization,
  buildProductVideoLd,
  orgId,
  websiteId,
} from "@/lib/seo/jsonld";
import type { SeoConfig } from "@/lib/seo/config";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

// Minimal SeoConfig stub — the collection builder reads only siteUrl + siteName.
const SEO = { siteUrl: "https://shop.test", siteName: "Shop Test" } as unknown as SeoConfig;
const URL = "https://shop.test/montres";

type Node = Record<string, unknown>;
const nodes = (g: { "@graph": Node[] }) => g["@graph"];
const byType = (g: { "@graph": Node[] }, t: string) => nodes(g).find((n) => n["@type"] === t);

function main() {
  console.log("buildCollectionGraph — with products:");
  const withItems = buildCollectionGraph(SEO, {
    url: URL,
    name: "Montres",
    description: "Nos montres",
    breadcrumb: [
      { name: "Accueil", url: SEO.siteUrl },
      { name: "Montres", url: URL },
    ],
    productUrls: [`${URL}/a`, `${URL}/b`],
    totalItems: 42,
  });
  const cp = byType(withItems, "CollectionPage") as Node | undefined;
  const bc = byType(withItems, "BreadcrumbList") as Node | undefined;
  const il = byType(withItems, "ItemList") as Node | undefined;
  check("CollectionPage @id is <url>#webpage", cp?.["@id"] === `${URL}#webpage`);
  check("CollectionPage url === url", cp?.url === URL);
  check("CollectionPage description passed through", cp?.description === "Nos montres");
  check(
    "isPartOf.@id === websiteId(siteUrl)",
    (cp?.isPartOf as Node | undefined)?.["@id"] === websiteId(SEO.siteUrl),
  );
  check(
    "mainEntity references the ItemList when products exist",
    (cp?.mainEntity as Node | undefined)?.["@id"] === `${URL}#itemlist`,
  );
  check("ItemList node present when products exist", !!il);
  check("ItemList numberOfItems === totalItems (not the capped window)", il?.numberOfItems === 42);
  check(
    "ItemList enumerates the passed productUrls with 1-based positions",
    Array.isArray(il?.itemListElement) &&
      (il!.itemListElement as Node[]).length === 2 &&
      (il!.itemListElement as Node[])[0].position === 1 &&
      (il!.itemListElement as Node[])[1].position === 2 &&
      (il!.itemListElement as Node[])[1].url === `${URL}/b`,
  );
  check(
    "breadcrumb positions are 1..n in order",
    Array.isArray(bc?.itemListElement) &&
      (bc!.itemListElement as Node[]).map((x) => x.position).join(",") === "1,2",
  );

  console.log("buildCollectionGraph — empty product set (indexable but no visible items):");
  const empty = buildCollectionGraph(SEO, {
    url: URL,
    name: "Montres",
    breadcrumb: [{ name: "Accueil", url: SEO.siteUrl }],
    productUrls: [],
  });
  const cpE = byType(empty, "CollectionPage") as Node | undefined;
  check("CollectionPage still emitted with no products", !!cpE);
  check("BreadcrumbList still emitted with no products", !!byType(empty, "BreadcrumbList"));
  check("no ItemList node when productUrls is empty", !byType(empty, "ItemList"));
  check("no mainEntity ref when productUrls is empty", cpE?.mainEntity === undefined);
  check("description omitted when not provided", cpE?.description === undefined);

  console.log("buildCollectionGraph — totalItems defaults to enumerated length:");
  const noTotal = buildCollectionGraph(SEO, {
    url: URL,
    name: "M",
    breadcrumb: [],
    productUrls: [`${URL}/x`],
  });
  check(
    "numberOfItems defaults to productUrls.length when totalItems omitted",
    (byType(noTotal, "ItemList") as Node | undefined)?.numberOfItems === 1,
  );

  console.log("buildFaqGraph:");
  check("returns null for an empty list", buildFaqGraph(URL, []) === null);
  check(
    "returns null when every entry is whitespace-only",
    buildFaqGraph(URL, [{ question: "  ", answer: "\n" }]) === null,
  );
  const faq = buildFaqGraph(URL, [
    { question: "Q1", answer: "A1" },
    { question: "  ", answer: "blank q dropped" },
    { question: "Q3", answer: "   " }, // blank answer dropped
    { question: "Q4", answer: "A4" },
  ]);
  check("non-empty FAQ returns a graph", faq !== null);
  const fp = faq ? (byType(faq, "FAQPage") as Node | undefined) : undefined;
  check("FAQPage @id is <url>#faq", fp?.["@id"] === `${URL}#faq`);
  check("mainEntityOfPage links the CollectionPage #webpage node", (fp?.mainEntityOfPage as Node | undefined)?.["@id"] === `${URL}#webpage`);
  check(
    "blank question/answer entries are filtered out (2 of 4 kept)",
    Array.isArray(fp?.mainEntity) && (fp!.mainEntity as Node[]).length === 2,
  );
  check(
    "kept questions are trimmed and in order (Q1, Q4)",
    Array.isArray(fp?.mainEntity) &&
      (fp!.mainEntity as Node[])[0].name === "Q1" &&
      (fp!.mainEntity as Node[])[1].name === "Q4",
  );
  check(
    "answer text lands under acceptedAnswer.text",
    Array.isArray(fp?.mainEntity) &&
      ((fp!.mainEntity as Node[])[0].acceptedAnswer as Node).text === "A1",
  );

  console.log("buildBrandGraph:");
  const BURL = "https://shop.test/rolex";
  const brandFull = buildBrandGraph({ url: BURL, name: "Rolex", description: "Depuis 1905", logoUrl: `${BURL}/logo.png` });
  const bnode = brandFull["@graph"][0] as Node;
  check("Brand @type", bnode["@type"] === "Brand");
  check("Brand @id is <url>#brand", bnode["@id"] === `${BURL}#brand`);
  check("Brand url + name passthrough", bnode.url === BURL && bnode.name === "Rolex");
  check("Brand description present when set", bnode.description === "Depuis 1905");
  check("Brand logo present when set", bnode.logo === `${BURL}/logo.png`);
  const brandBare = buildBrandGraph({ url: BURL, name: "Rolex" });
  const bbare = brandBare["@graph"][0] as Node;
  check("description omitted when not provided", bbare.description === undefined);
  check("logo omitted when not provided", bbare.logo === undefined);
  check("logo omitted when null", (buildBrandGraph({ url: BURL, name: "R", logoUrl: null })["@graph"][0] as Node).logo === undefined);
  // Brand @id uses the stable idUrl (so a PDP reference folds into one entity even
  // when the page carries a canonical_url override).
  check(
    "Brand @id uses idUrl when given",
    (buildBrandGraph({ url: "https://shop.test/canon", idUrl: BURL, name: "Rolex" })["@graph"][0] as Node)["@id"] ===
      `${BURL}#brand`,
  );

  console.log("buildCollectionGraph — graph linking (breadcrumb @id + edges):");
  const linked = buildCollectionGraph(SEO, {
    url: URL,
    name: "Rolex",
    breadcrumb: [
      { name: "Accueil", url: SEO.siteUrl },
      { name: "Rolex", url: URL },
    ],
    productUrls: [`${URL}/a`],
    aboutId: `${URL}#brand`,
    imageUrl: `${URL}/hero.jpg`,
  });
  const lcp = byType(linked, "CollectionPage") as Node;
  const lbc = byType(linked, "BreadcrumbList") as Node;
  check("CollectionPage carries inLanguage fr-TN", lcp?.inLanguage === "fr-TN");
  check("CollectionPage breadcrumb edge → #breadcrumb", (lcp?.breadcrumb as Node)?.["@id"] === `${URL}#breadcrumb`);
  check("CollectionPage about → the Brand @id (no orphan)", (lcp?.about as Node)?.["@id"] === `${URL}#brand`);
  check("CollectionPage primaryImageOfPage from imageUrl", (lcp?.primaryImageOfPage as Node)?.url === `${URL}/hero.jpg`);
  check("BreadcrumbList has @id #breadcrumb", lbc?.["@id"] === `${URL}#breadcrumb`);
  check(
    "BreadcrumbList ListItems carry per-position @id",
    (lbc?.itemListElement as Node[])?.[0]?.["@id"] === `${URL}#breadcrumb-1`,
  );

  console.log("buildOrganization — enrichment:");
  const orgSeo = {
    siteUrl: "https://shop.test",
    siteName: "Shop Test",
    orgType: "OnlineStore",
    legalName: "Tokyo SARL",
    taxId: "1234567A",
    contactPhone: "+216 71 000 000",
    contactEmail: "contact@shop.test",
    address: "12 Rue X, Tunis",
    sameAs: ["https://facebook.com/x"],
    knowsAbout: [],
    logoResolvedUrl: "https://shop.test/logo.png",
    ogImageResolvedUrl: "https://shop.test/og.jpg",
    ogImageUrl: null,
  } as unknown as SeoConfig;
  const org = buildOrganization(orgSeo);
  check("Org @type uses the admin orgType", org["@type"] === "OnlineStore");
  check("Org legalName emitted", org.legalName === "Tokyo SARL");
  check("Org taxID emitted", org.taxID === "1234567A");
  check("Org areaServed = Country Tunisie", (org.areaServed as Node)?.name === "Tunisie");
  check("Org logo = the logo mark (not the OG card)", (org.logo as Node)?.url === "https://shop.test/logo.png");
  check("Org image = the OG card", org.image === "https://shop.test/og.jpg");
  check("Org top-level telephone emitted", org.telephone === "+216 71 000 000");
  // Logo falls back to the OG card only when no dedicated logo is set.
  const orgNoLogo = buildOrganization({ ...orgSeo, logoResolvedUrl: null } as SeoConfig);
  check("Org logo falls back to OG image when no logo mark", (orgNoLogo.logo as Node)?.url === "https://shop.test/og.jpg");

  console.log("buildCmsPageGraph:");
  const CMSU = `${SEO.siteUrl}/notre-histoire`;
  const cms = buildCmsPageGraph(SEO, { url: CMSU, name: "Notre Histoire", description: "Depuis 1950." });
  const cwp = byType(cms, "WebPage") as Node;
  const cbc = byType(cms, "BreadcrumbList") as Node;
  check("CMS WebPage @id is <url>#webpage", cwp?.["@id"] === `${CMSU}#webpage`);
  check("CMS WebPage inLanguage fr-TN", cwp?.inLanguage === "fr-TN");
  check("CMS WebPage isPartOf → websiteId", (cwp?.isPartOf as Node)?.["@id"] === websiteId(SEO.siteUrl));
  check("CMS WebPage breadcrumb edge → #breadcrumb", (cwp?.breadcrumb as Node)?.["@id"] === `${CMSU}#breadcrumb`);
  check("CMS WebPage description passed through", cwp?.description === "Depuis 1950.");
  check(
    "CMS default trail = Accueil(home) → page (2 items)",
    Array.isArray(cbc?.itemListElement) &&
      (cbc!.itemListElement as Node[]).length === 2 &&
      (cbc!.itemListElement as Node[])[0].name === "Accueil" &&
      (cbc!.itemListElement as Node[])[0].item === SEO.siteUrl &&
      (cbc!.itemListElement as Node[])[1].item === CMSU,
  );
  const cmsBare = buildCmsPageGraph(SEO, { url: `${SEO.siteUrl}/cgv`, name: "CGV" });
  check("CMS description omitted when not provided", (byType(cmsBare, "WebPage") as Node).description === undefined);
  check("CMS no hasPart when hasFaq falsy", (byType(cmsBare, "WebPage") as Node).hasPart === undefined);
  check("CMS no primaryImageOfPage when imageUrl absent", (byType(cmsBare, "WebPage") as Node).primaryImageOfPage === undefined);
  const cmsRich = buildCmsPageGraph(SEO, { url: `${SEO.siteUrl}/cgv`, name: "CGV", hasFaq: true, imageUrl: `${SEO.siteUrl}/hero.jpg` });
  check("CMS hasPart → #faq when hasFaq", ((byType(cmsRich, "WebPage") as Node).hasPart as Node)?.["@id"] === `${SEO.siteUrl}/cgv#faq`);
  check("CMS primaryImageOfPage from imageUrl", ((byType(cmsRich, "WebPage") as Node).primaryImageOfPage as Node)?.url === `${SEO.siteUrl}/hero.jpg`);

  console.log("buildGlobalGraph — home WebPage + nav + itemlist refs:");
  // Base on orgSeo (has sameAs/knowsAbout/etc. that buildOrganization reads) + the
  // home-page fields buildHomeWebPage needs. siteUrl matches SEO ("https://shop.test").
  const homeSeo = {
    ...orgSeo,
    homeTitle: "Produits high-tech",
    homeDescription: "desc",
    defaultDescription: "d",
    ogImageResolvedUrl: null,
    ogImageUrl: null,
  } as unknown as SeoConfig;
  const homeG = buildGlobalGraph(homeSeo, {
    itemListCount: 2,
    navItems: [
      { name: "Boutique", url: "/boutique" },
      { name: "", url: "/blank-name-dropped" },
    ],
  });
  const hwp = byType(homeG, "WebPage") as Node;
  const hnav = byType(homeG, "SiteNavigationElement") as Node;
  check(
    "home graph carries the org (by @id) + WebSite + WebPage + SiteNav",
    !!nodes(homeG).find((n) => n["@id"] === orgId(SEO.siteUrl)) &&
      ["WebSite", "WebPage", "SiteNavigationElement"].every((t) => !!byType(homeG, t)),
  );
  check("home WebPage @id is <site>/#webpage", hwp?.["@id"] === `${SEO.siteUrl}/#webpage`);
  check(
    "home WebPage about → org, isPartOf → website",
    (hwp?.about as Node)?.["@id"] === orgId(SEO.siteUrl) && (hwp?.isPartOf as Node)?.["@id"] === websiteId(SEO.siteUrl),
  );
  check(
    "home WebPage mainEntity = N itemlist @id refs",
    Array.isArray(hwp?.mainEntity) &&
      (hwp!.mainEntity as Node[]).length === 2 &&
      (hwp!.mainEntity as Node[])[1]["@id"] === `${SEO.siteUrl}/#itemlist-2`,
  );
  check("home WebPage hasPart → the sitenav @id", (hwp?.hasPart as Node)?.["@id"] === hnav?.["@id"]);
  check(
    "SiteNav drops blank-name items + absolutizes the href",
    Array.isArray(hnav?.hasPart) &&
      (hnav!.hasPart as Node[]).length === 1 &&
      (hnav!.hasPart as Node[])[0].url === `${SEO.siteUrl}/boutique` &&
      (hnav!.hasPart as Node[])[0].position === 1,
  );
  const homeNoNav = buildGlobalGraph(homeSeo, { itemListCount: 0 });
  check("no SiteNav node when no navItems", !byType(homeNoNav, "SiteNavigationElement"));
  check("home WebPage has no mainEntity when itemListCount 0", (byType(homeNoNav, "WebPage") as Node).mainEntity === undefined);
  check("home WebPage has no hasPart when no nav", (byType(homeNoNav, "WebPage") as Node).hasPart === undefined);

  console.log("buildHomeProductListsGraph:");
  check("null when every rail is empty", buildHomeProductListsGraph(SEO.siteUrl, [{ name: "X", items: [] }]) === null);
  const pll = buildHomeProductListsGraph(SEO.siteUrl, [
    { name: "Nouveautés", items: [{ url: "/a", name: "A" }, { url: "/b" }] },
    { name: "Empty", items: [] },
    { name: "Promos", items: [{ url: "https://shop.test/c", name: "C" }] },
  ])!;
  const plNodes = pll["@graph"];
  check("empty rails dropped (2 of 3 kept)", plNodes.length === 2);
  check(
    "list @ids are #itemlist-1, #itemlist-2 (reindexed after the empty drop)",
    plNodes[0]["@id"] === `${SEO.siteUrl}/#itemlist-1` && plNodes[1]["@id"] === `${SEO.siteUrl}/#itemlist-2`,
  );
  check(
    "rail numberOfItems + absolutized relative item url",
    (plNodes[0] as Node).numberOfItems === 2 &&
      ((plNodes[0] as Node).itemListElement as Node[])[0].url === `${SEO.siteUrl}/a`,
  );
  check("already-absolute item url kept as-is", ((plNodes[1] as Node).itemListElement as Node[])[0].url === "https://shop.test/c");
  check("ListItem name omitted when absent", ((plNodes[0] as Node).itemListElement as Node[])[1].name === undefined);

  console.log("buildProductVideoLd:");
  check("null when no url", buildProductVideoLd({ url: "", productName: "P", uploadDate: "2026-01-01", thumbnailUrl: "t" }) === null);
  check(
    "null when no thumbnail (Google requires thumbnailUrl)",
    buildProductVideoLd({ url: "https://youtu.be/abcDEF12345", productName: "P", uploadDate: "2026-01-01" }) === null,
  );
  const vEmbed = buildProductVideoLd({
    id: "x#video",
    url: "https://www.youtube.com/watch?v=abcDEF12345",
    productName: "P",
    uploadDate: "2026-01-01",
    thumbnailUrl: "https://t/t.jpg",
  })!;
  check(
    "YouTube watch URL → PLAYER embedUrl (/embed/<id>, not the watch URL)",
    vEmbed.embedUrl === "https://www.youtube.com/embed/abcDEF12345" && vEmbed.contentUrl === undefined,
  );
  check("video @id + uploadDate + thumbnail", vEmbed["@id"] === "x#video" && vEmbed.uploadDate === "2026-01-01" && vEmbed.thumbnailUrl === "https://t/t.jpg");
  check("name falls back to 'Vidéo — <product>'", vEmbed.name === "Vidéo — P");
  check("description falls back to the name", vEmbed.description === "Vidéo — P");
  check(
    "youtu.be short URL → player embedUrl",
    (buildProductVideoLd({ url: "https://youtu.be/abcDEF12345", productName: "P", uploadDate: "d", thumbnailUrl: "t" }) as Node).embedUrl ===
      "https://www.youtube.com/embed/abcDEF12345",
  );
  check(
    "Vimeo page URL → player.vimeo embedUrl",
    (buildProductVideoLd({ url: "https://vimeo.com/123456789", productName: "P", uploadDate: "d", thumbnailUrl: "t" }) as Node).embedUrl ===
      "https://player.vimeo.com/video/123456789",
  );
  const vFile = buildProductVideoLd({
    url: "https://cdn.test/clip.mp4",
    productName: "P",
    uploadDate: "2026-01-01",
    title: "Regardez",
    description: "Un clip",
    thumbnailUrl: "https://t/t.jpg",
  })!;
  check("hosted file URL → contentUrl (never embedUrl)", vFile.contentUrl === "https://cdn.test/clip.mp4" && vFile.embedUrl === undefined);
  check("explicit title + description used", vFile.name === "Regardez" && vFile.description === "Un clip");

  console.log("buildOrganization — LocalBusiness (Store) gating:");
  const storeSeo = {
    ...orgSeo,
    orgType: "Store",
    geoLat: 34.74,
    geoLng: 10.76,
    priceRange: "200-50000 TND",
    addressLocality: "Sfax",
    addressRegion: "Sfax",
    postalCode: "3000",
  } as unknown as SeoConfig;
  const store = buildOrganization(storeSeo);
  check("Store @type", store["@type"] === "Store");
  check("Store geo = GeoCoordinates (numeric lat/lng)", (store.geo as Node)?.latitude === 34.74 && (store.geo as Node)?.longitude === 10.76);
  check("Store priceRange emitted", store.priceRange === "200-50000 TND");
  check(
    "Store PostalAddress enriched (street + locality + region + postal)",
    (store.address as Node)?.streetAddress === "12 Rue X, Tunis" &&
      (store.address as Node)?.addressLocality === "Sfax" &&
      (store.address as Node)?.addressRegion === "Sfax" &&
      (store.address as Node)?.postalCode === "3000",
  );
  const onlineStore = buildOrganization({ ...storeSeo, orgType: "OnlineStore" } as SeoConfig);
  check("geo omitted on OnlineStore (not a LocalBusiness)", onlineStore.geo === undefined);
  check("priceRange omitted on OnlineStore", onlineStore.priceRange === undefined);
  check("PostalAddress still enriched on OnlineStore", (onlineStore.address as Node)?.addressLocality === "Sfax");
  const storeNoGeo = buildOrganization({ ...storeSeo, geoLat: null, geoLng: null } as SeoConfig);
  check("no geo node when coords are missing (never a half GeoCoordinates)", storeNoGeo.geo === undefined);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
