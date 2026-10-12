/**
 * Pure unit tests for the robots.txt + llms.txt builders. NO DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/llms-robots.test.ts
 */
import { buildRobotsTxt, type RobotsInput } from "@/lib/seo/robots-txt";
import {
  buildLlmsTxt,
  buildCategoryForest,
  type LlmsInput,
  type LlmsCategoryRow,
} from "@/lib/seo/llms-txt";

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

const ORIGIN = "https://tokyostore.tn";

// ── robots.txt ──────────────────────────────────────────────────────────────
console.log("robots-txt:");

const baseRobots: RobotsInput = {
  origin: ORIGIN,
  siteName: "Tokyo Store",
  indexable: true,
  extraDisallow: [],
  feeds: {
    google: { enabled: false, path: "google-merchant.xml" },
    acp: { enabled: false, path: "agentic.json" },
  },
  markdownEnabled: false,
};

const rAll = buildRobotsTxt({
  ...baseRobots,
  extraDisallow: ["/preview"],
  feeds: {
    google: { enabled: true, path: "google-merchant.xml" },
    acp: { enabled: true, path: "agentic.json" },
  },
  markdownEnabled: true,
});
ok("has User-agent: * + Allow: /", rAll.includes("User-agent: *") && rAll.includes("Allow: /"));
ok("blocks private areas", rAll.includes("Disallow: /admin") && rAll.includes("Disallow: /account") && rAll.includes("Disallow: /panier"));
ok("appends admin extra disallow", rAll.includes("Disallow: /preview"));
ok("disallows /feeds enumeration", rAll.includes("Disallow: /feeds\n"));
ok("ALLOWS enabled google feed", rAll.includes("Allow: /feeds/google-merchant.xml"));
ok("ALLOWS enabled acp feed", rAll.includes("Allow: /feeds/agentic.json"));
ok("references both feeds (comments)", rAll.includes(`# Flux Google Merchant : ${ORIGIN}/feeds/google-merchant.xml`) && rAll.includes(`# Flux Agentic Commerce (ACP) : ${ORIGIN}/feeds/agentic.json`));
ok("disallows /md twins when markdown on", rAll.includes("Disallow: /md") && rAll.includes("Disallow: /*.md$"));
ok("sitemap pointer", rAll.includes(`Sitemap: ${ORIGIN}/sitemap.xml`));
ok("llms.txt pointer comment", rAll.includes(`# Plan lisible par IA (llms.txt) : ${ORIGIN}/llms.txt`));
ok("NO per-bot groups (single * group)", rAll.match(/User-agent:/g)?.length === 1);

const rOff = buildRobotsTxt({ ...baseRobots, indexable: false });
ok("kill-switch: Disallow: / for all", rOff.includes("User-agent: *") && rOff.includes("Disallow: /\n"));
ok("kill-switch: no Allow: /", !rOff.includes("Allow: /"));
ok("kill-switch still points sitemap", rOff.includes(`Sitemap: ${ORIGIN}/sitemap.xml`));

const rNoFeeds = buildRobotsTxt(baseRobots);
ok("no feeds enabled → no Allow /feeds", !rNoFeeds.includes("Allow: /feeds/"));
ok("no feeds enabled → still Disallow /feeds", rNoFeeds.includes("Disallow: /feeds"));
ok("markdown off → no /md disallow", !rNoFeeds.includes("Disallow: /md"));

const rGoogleOnly = buildRobotsTxt({ ...baseRobots, feeds: { google: { enabled: true, path: "merchant.xml" }, acp: { enabled: false, path: "agentic.json" } } });
ok("reactive: only google allowed when only google enabled", rGoogleOnly.includes("Allow: /feeds/merchant.xml") && !rGoogleOnly.includes("Allow: /feeds/agentic.json"));

// Store closed (site.mode maintenance / coming_soon) — wins over every other input.
const rClosed = buildRobotsTxt({
  ...baseRobots,
  siteClosed: true,
  feeds: { google: { enabled: true, path: "google-merchant.xml" }, acp: { enabled: true, path: "agentic.json" } },
  markdownEnabled: true,
});
ok("closed: single * group with Disallow: /", rClosed.match(/User-agent:/g)?.length === 1 && rClosed.includes("User-agent: *\nDisallow: /\n"));
ok("closed: no Allow line at all (feeds not carved out)", !rClosed.includes("Allow:"));
ok("closed: no sitemap / llms pointer advertised", !rClosed.includes("Sitemap:") && !rClosed.includes("llms.txt"));
ok("closed: no feed references", !rClosed.includes("/feeds/"));
ok("closed: ends with single trailing newline", rClosed.endsWith("\n") && !rClosed.endsWith("\n\n"));
ok("siteClosed:false → normal body", buildRobotsTxt({ ...baseRobots, siteClosed: false }) === buildRobotsTxt(baseRobots));

// ── buildCategoryForest ─────────────────────────────────────────────────────
console.log("\nbuildCategoryForest:");

const cat = (id: string, name: string, parentId: string | null, order: number, extra: Partial<LlmsCategoryRow> = {}): LlmsCategoryRow => ({
  id, name, slug: name.toLowerCase().replace(/\s+/g, "-"), parentId, displayOrder: order,
  tagline: null, description: null, noindex: false, ...extra,
});

const forest = buildCategoryForest([
  cat("b", "PS4", null, 2, { tagline: "Best value" }),
  cat("a", "PS5", null, 1, { description: "Next-gen", tagline: "ignored when desc present" }),
  cat("a1", "Consoles PS5", "a", 2),
  cat("a2", "Jeux PS5", "a", 1),
  cat("hidden", "Secret", null, 3, { noindex: true }),
  cat("orphanChild", "Orphan", "ghost", 9),
]);
ok("roots sorted by displayOrder", forest[0].name === "PS5" && forest[1].name === "PS4");
ok("noindex root skipped", !forest.some((n) => n.name === "Secret"));
ok("orphan (missing parent) promoted to root", forest.some((n) => n.name === "Orphan"));
ok("children sorted by displayOrder", forest[0].children[0].name === "Jeux PS5" && forest[0].children[1].name === "Consoles PS5");
ok("summary prefers description over tagline", forest[0].summary === "Next-gen");
ok("summary falls back to tagline", forest[1].summary === "Best value");

const hiddenParent = buildCategoryForest([
  cat("p", "HiddenParent", null, 1, { noindex: true }),
  cat("c", "VisibleChild", "p", 1),
]);
ok("child of noindex parent promoted to root (page still valid)", hiddenParent.length === 1 && hiddenParent[0].name === "VisibleChild");

const deep = buildCategoryForest([cat("r", "Root", null, 1), cat("c", "Child", "r", 1), cat("g", "Grand", "c", 1)]);
ok("3-level tree rebuilt (grandchild nested)", deep[0].children[0].children[0]?.name === "Grand");

// depth-cap guard: a legit ≥9-level chain must truncate without throwing.
const chain: LlmsCategoryRow[] = [];
for (let i = 0; i < 12; i++) chain.push(cat(`n${i}`, `N${i}`, i === 0 ? null : `n${i - 1}`, 1));
let depthOk = true;
try {
  buildCategoryForest(chain);
} catch {
  depthOk = false;
}
ok("deep chain (12 levels) truncates without throwing (depth>8 guard)", depthOk);

// ── buildLlmsTxt ────────────────────────────────────────────────────────────
console.log("\nbuildLlmsTxt:");

const fullInput: LlmsInput = {
  siteName: "Tokyo Store",
  origin: ORIGIN,
  tagline: "N°1 du Gaming en Tunisie",
  description: "Boutique gaming de référence en Tunisie.",
  knowsAbout: ["Sony PlayStation", "Nintendo", "Xbox"],
  categories: forest,
  keyPages: [
    { name: "Nouveautés", path: "/nouveautes" },
    { name: "Toutes les marques", path: "/marques" },
  ],
  blogCategories: [{ name: "Consoles", path: "/blog/consoles" }],
  contact: { email: "contact@gz.tn", phone: "+216 54 000 000", address: "Ariana, Tunisie", whatsapp: "https://wa.me/21654000000", hours: "Lun-Sam 9h-19h" },
  social: ["https://facebook.com/gz", "https://instagram.com/gz"],
  shipping: { currency: "TND", feeMajor: "7", freeThresholdMajor: "250", freeEnabled: true, deliveryDays: "3 à 8 jours ouvrables" },
  warranty: { months: 12, label: "défauts de fabrication" },
  business: { legalName: "Tokyo Store SARL", taxId: "1234567A" },
  feeds: [{ name: "Flux Google Merchant", path: `${ORIGIN}/feeds/google-merchant.xml` }],
};
const full = buildLlmsTxt(fullInput);
ok("H1 with tagline", full.startsWith("# Tokyo Store — N°1 du Gaming en Tunisie"));
ok("summary blockquote", full.includes("> Boutique gaming de référence en Tunisie."));
ok("H2 per top-level category", full.includes("## PS5") && full.includes("## PS4"));
ok("category root link", full.includes(`- [PS5](${ORIGIN}/ps5)`));
ok("nested child bullet (indented) with summary", full.includes(`  - [Jeux PS5](${ORIGIN}/jeux-ps5)`));
ok("key pages section", full.includes(`- [Nouveautés](${ORIGIN}/nouveautes)`) && full.includes(`- [Toutes les marques](${ORIGIN}/marques)`));
ok("blog index + category", full.includes(`- [Blog](${ORIGIN}/blog)`) && full.includes(`- [Consoles](${ORIGIN}/blog/consoles)`));
ok("order: whatsapp + social + pickup", full.includes("WhatsApp : https://wa.me/21654000000") && full.includes("facebook.com/gz") && full.includes("Retrait en magasin : Ariana, Tunisie"));
ok("shipping: fee + free + days", full.includes("Frais de livraison : 7 TND.") && full.includes("Livraison offerte dès 250 TND") && full.includes("Délai estimé : 3 à 8 jours ouvrables."));
ok("warranty months + cgv", full.includes("Garantie : 12 mois — défauts de fabrication.") && full.includes(`Conditions générales de vente : ${ORIGIN}/cgv`));
ok("informations: email/phone/address/hours/legal", full.includes("Email : contact@gz.tn") && full.includes("Téléphone : +216 54 000 000") && full.includes("Horaires : Lun-Sam 9h-19h") && full.includes("Raison sociale : Tokyo Store SARL (Matricule fiscal : 1234567A)"));
ok("search action url uses ?q=", full.includes(`${ORIGIN}/recherche?q={search_term_string}`));
ok("ressources: sitemap + enabled feed", full.includes(`Plan du site (sitemap) : ${ORIGIN}/sitemap.xml`) && full.includes(`Flux Google Merchant : ${ORIGIN}/feeds/google-merchant.xml`));
ok("knowsAbout footer", full.includes("*Marques & expertise high-tech représentées : Sony PlayStation, Nintendo, Xbox.*"));
ok("ends with single trailing newline", full.endsWith("\n") && !full.endsWith("\n\n"));

// Minimal input — unconfigured store: optional sections omitted, never fabricated.
const minimal = buildLlmsTxt({
  siteName: "Shop", origin: ORIGIN, tagline: null, description: "Une boutique.", knowsAbout: [],
  categories: [], keyPages: [], blogCategories: [],
  contact: { email: null, phone: null, address: null, whatsapp: null, hours: null },
  social: [], shipping: null, warranty: { months: 0, label: null }, business: { legalName: null, taxId: null },
  feeds: [],
});
ok("minimal: H1 without tagline", minimal.startsWith("# Shop\n"));
ok("minimal: NO Livraison section", !minimal.includes("## Livraison"));
ok("minimal: NO whatsapp/social lines", !minimal.includes("WhatsApp") && !minimal.includes("Réseaux sociaux"));
ok("minimal: garantie still links cgv", minimal.includes(`Conditions générales de vente : ${ORIGIN}/cgv`) && !minimal.includes("Garantie :"));
ok("minimal: still has sitemap + search", minimal.includes("/sitemap.xml") && minimal.includes("/recherche?q="));
ok("minimal: no knowsAbout footer", !minimal.includes("Marques & expertise high-tech"));

// Partial shipping: fee cleared but threshold set → only the free-shipping line.
const partialShip = buildLlmsTxt({
  ...fullInput,
  shipping: { currency: "TND", feeMajor: null, freeThresholdMajor: "200", freeEnabled: true, deliveryDays: null },
});
ok("partial shipping: free line only, no fee/days", partialShip.includes("Livraison offerte dès 200 TND") && !partialShip.includes("Frais de livraison :") && !partialShip.includes("Délai estimé :"));

// Free disabled → no free-shipping line even if threshold present.
const freeOff = buildLlmsTxt({ ...fullInput, shipping: { currency: "TND", feeMajor: "7", freeThresholdMajor: "250", freeEnabled: false, deliveryDays: null } });
ok("free disabled → no free line", freeOff.includes("Frais de livraison : 7 TND.") && !freeOff.includes("Livraison offerte"));

// Grandchild renders at a 4-space indent (depth 2 under the root section's depth-1 children).
const deepBody = buildLlmsTxt({ ...fullInput, categories: deep });
ok("grandchild rendered at 4-space indent", deepBody.includes(`    - [Grand](${ORIGIN}/grand)`));

// Markdown injection: a name/description/knowsAbout with control chars must be escaped,
// never breaking the list structure or injecting a link.
const evil = buildLlmsTxt({
  ...fullInput,
  categories: buildCategoryForest([cat("x", "Manettes ] [hack", null, 1, { description: "desc ] and more" })]),
  knowsAbout: ["A*B"],
  blogCategories: [{ name: "Bad]Name", path: "/blog/x" }],
});
ok("category name ] and [ escaped in heading", evil.includes("## Manettes \\] \\[hack"));
ok("category name ] and [ escaped in link text", evil.includes("[Manettes \\] \\[hack]"));
ok("summary ] escaped", evil.includes("desc \\] and more"));
ok("blog name ] escaped in link text", evil.includes("[Bad\\]Name]"));
ok("knowsAbout * escaped", evil.includes("A\\*B"));
ok("no UNescaped injected link survives (raw '] [hack](' absent)", !evil.includes("] [hack]("));

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
