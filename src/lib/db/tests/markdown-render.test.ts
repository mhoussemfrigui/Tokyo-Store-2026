/**
 * Pure unit tests for the Markdown-for-agents render + doc builders. NO database.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/markdown-render.test.ts
 */
import {
  estimateTokens,
  renderFrontmatter,
  htmlToMarkdown,
  serializeMarkdown,
  canonicalizeMarkdownPath,
} from "@/lib/seo/markdown/render";
import { productDoc, listingDoc, articleDoc, rawDoc } from "@/lib/seo/markdown/docs";
import { markdownEligible } from "@/lib/seo/markdown/eligible";
import { resolveTwinCanonical } from "@/lib/seo/markdown/canonical";
import { PRIVATE_AREAS } from "@/lib/seo/robots-txt";
import type { Product } from "@/types/catalog";

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

console.log("markdown-render:");

// ── estimateTokens
ok("empty → 0 tokens", estimateTokens("") === 0);
ok("~4 chars/token", estimateTokens("12345678") === 2);

// ── canonicalizeMarkdownPath
ok("strips .md suffix", canonicalizeMarkdownPath("/jeux-ps5.md") === "/jeux-ps5");
ok("adds leading slash + strips trailing", canonicalizeMarkdownPath("blog/foo/") === "/blog/foo");
ok("collapses double slashes", canonicalizeMarkdownPath("//blog///x") === "/blog/x");
ok("root stays /", canonicalizeMarkdownPath("/") === "/");

// ── renderFrontmatter
const fm = renderFrontmatter({ type: "product", title: 'A "quoted" name', price: 169, empty: null, tags: ["x", "y"] });
ok("frontmatter has --- fences", fm.startsWith("---\n") && fm.endsWith("\n---"));
ok("number unquoted", fm.includes("price: 169"));
ok("string quoted + escaped", fm.includes('title: "A \\"quoted\\" name"'));
ok("null dropped", !fm.includes("empty"));
ok("array inline", fm.includes('tags: ["x", "y"]'));

// ── htmlToMarkdown
ok("h2 → ##", htmlToMarkdown("<h2>Titre</h2>").includes("## Titre"));
ok("p → paragraph", htmlToMarkdown("<p>Bonjour</p>").trim() === "Bonjour");
ok("strong → **", htmlToMarkdown("<p><strong>x</strong></p>").includes("**x**"));
ok("em → *", htmlToMarkdown("<em>y</em>").includes("*y*"));
ok("li → - bullet", htmlToMarkdown("<ul><li>one</li><li>two</li></ul>").includes("- one") );
ok("link → [t](href)", htmlToMarkdown('<a href="https://x.tn">lien</a>') === "[lien](https://x.tn)");
ok("blockquote → >", htmlToMarkdown("<blockquote>cite</blockquote>").includes("> cite"));
ok("entities decoded", htmlToMarkdown("<p>a &amp; b</p>").includes("a & b"));
ok("script stripped", !htmlToMarkdown("<script>evil()</script><p>safe</p>").includes("evil"));
ok("unknown tags stripped to text", htmlToMarkdown("<span class='x'>plain</span>").trim() === "plain");

// ── productDoc
const PRODUCT = {
  slug: "pikmin",
  name: "Pikmin 1 + 2",
  brand: "Nintendo",
  category: "switch",
  priceCents: 169_000,
  oldPriceCents: 199_000,
  rating: 4.5,
  reviews: 10,
  image: "https://x/p.jpg",
  shortDesc: "<p>Stratégie mignonne.</p>",
  description: "<h2>À propos</h2><p>Un grand jeu.</p>",
  inStock: true,
  sku: "SKU43",
  gtin: "0045496479718",
  condition: "new",
  productType: "simple",
} as unknown as Product;

const pdoc = productDoc(PRODUCT, { url: "https://x/pikmin", currency: "TND", priceDecimals: 3 });
const pser = serializeMarkdown(pdoc);
ok("product frontmatter type", pdoc.frontmatter.type === "product");
ok("product price in frontmatter", pdoc.frontmatter.price === "169.000" && pdoc.frontmatter.currency === "TND");
ok("product availability in_stock", pdoc.frontmatter.availability === "in_stock");
ok("product sku in frontmatter", pdoc.frontmatter.sku === "SKU43");
ok("product body H1 + price + old price", pdoc.body.includes("# Pikmin 1 + 2") && pdoc.body.includes("169.000 TND (au lieu de 199.000 TND)"));
ok("product description rendered", pdoc.body.includes("## Description"));
ok("serialized = frontmatter + body", pser.startsWith("---\n") && pser.includes("\n---\n\n# Pikmin"));

// ── productDoc out_of_stock
const oos = productDoc({ ...PRODUCT, inStock: false } as Product, { url: "u", currency: "TND", priceDecimals: 2 });
ok("out_of_stock when not in stock", oos.frontmatter.availability === "out_of_stock");

// ── listingDoc
const ldoc = listingDoc({
  type: "category",
  title: "Jeux PS5",
  description: "Catalogue PS5",
  url: "https://x/jeux-ps5",
  items: [
    { title: "Jeu A", url: "https://x/a", summary: "100 TND" },
    { title: "Jeu B", url: "https://x/b" },
  ],
});
ok("listing count in frontmatter", ldoc.frontmatter.count === 2);
ok("listing items as links", ldoc.body.includes("- [Jeu A](https://x/a) — 100 TND") && ldoc.body.includes("- [Jeu B](https://x/b)"));

// ── articleDoc
const adoc = articleDoc({
  type: "blog_article",
  title: "Mon article",
  description: "extrait",
  url: "https://x/blog/a",
  publishedAt: "2026-06-01T00:00:00Z",
  bodyHtml: "<p>Para 1.</p><h2>Section</h2><p>Para 2.</p>",
});
ok("article frontmatter publishedAt", adoc.frontmatter.publishedAt === "2026-06-01T00:00:00Z");
ok("article body converted from HTML", adoc.body.includes("# Mon article") && adoc.body.includes("## Section") && adoc.body.includes("Para 2."));

// ── rawDoc
const rdoc = rawDoc({ type: "page", title: "À propos", url: "https://x/about", body: "## Notre histoire\n\nTexte." });
ok("rawDoc keeps markdown body verbatim", rdoc.body.includes("# À propos") && rdoc.body.includes("## Notre histoire"));

// ── markdownEligible (which paths get a markdown twin)
ok("content slug eligible", markdownEligible("/jeux-ps5"));
ok("product/sub eligible", markdownEligible("/jeux-ps5/fifa"));
ok("blog article eligible", markdownEligible("/blog/mon-article"));
ok("home NOT eligible", !markdownEligible("/"));
ok("admin excluded", !markdownEligible("/admin/orders"));
ok("account excluded", !markdownEligible("/account"));
ok("api excluded", !markdownEligible("/api/products"));
ok("feeds excluded", !markdownEligible("/feeds/google-merchant.xml"));
ok("md excluded (no recursion)", !markdownEligible("/md/jeux-ps5"));
ok("checkout/cart excluded", !markdownEligible("/checkout") && !markdownEligible("/panier"));
ok("recherche excluded (dynamic)", !markdownEligible("/recherche"));
ok("file-extension path excluded", !markdownEligible("/sitemap.xml") && !markdownEligible("/icon.svg"));
ok("prefix-collision NOT excluded (/accountancy ok)", markdownEligible("/accountant-tools"));
ok("facture (order-receipt PII) excluded", !markdownEligible("/facture/abc-123"));
// Parity guard: every robots.txt PRIVATE_AREAS prefix must also be markdown-skipped
// (a receipt/private path must never be content-negotiated into a Markdown twin).
ok(
  "every robots PRIVATE_AREAS prefix is markdown-skipped",
  PRIVATE_AREAS.every((p) => !markdownEligible(p) && !markdownEligible(`${p}/x`)),
);

// ── resolveTwinCanonical (twin canonical == HTML page canonical)
const O = "https://x";
ok("no override → flat path", resolveTwinCanonical(null, O, "/montres") === "https://x/montres");
ok("blank override → flat path", resolveTwinCanonical("   ", O, "/montres") === "https://x/montres");
ok("absolute override wins", resolveTwinCanonical(" https://y.tn/master ", O, "/a") === "https://y.tn/master");
ok("root-relative override → origin-prefixed", resolveTwinCanonical("/master", O, "/a") === "https://x/master");
ok("protocol-relative override rejected", resolveTwinCanonical("//evil.tld/x", O, "/a") === "https://x/a");
ok("bare relative override rejected", resolveTwinCanonical("master", O, "/a") === "https://x/a");
ok("non-http scheme rejected", resolveTwinCanonical("javascript:alert(1)", O, "/a") === "https://x/a");
ok("header-injection (CRLF) rejected", resolveTwinCanonical("https://y.tn/a\r\nSet-Cookie: x=1", O, "/a") === "https://x/a");
ok("angle bracket rejected (Link header break)", resolveTwinCanonical("https://y.tn/a>; rel=x", O, "/a") === "https://x/a");
ok("non-ASCII rejected (non-ByteString header)", resolveTwinCanonical("https://y.tn/montré", O, "/a") === "https://x/a");

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
