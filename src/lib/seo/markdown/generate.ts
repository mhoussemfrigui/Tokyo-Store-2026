import "server-only";

import {
  getProductWithRowBySlug,
  listApiProductsByCategory,
  listApiProductsByBrand,
  listShowcaseProducts,
} from "@/lib/api/products";
import { getCategoryBySlug } from "@/lib/api/categories";
import { categoryQueries } from "@/modules/catalog/category";
import { categoryService } from "@/modules/catalog/category/service";
import { getBrandBySlug } from "@/modules/catalog/brand/queries";
import type { ProductRow } from "@/modules/catalog/product/schema";
import { withLivePromoPricing } from "@/lib/promotions/live-product-price";
import { getApiBlogPost, listApiBlogPosts, listApiBlogCategories } from "@/lib/api/blog";
import { getPageForRender, resolvePageBlocks, type ResolvedPage } from "@/lib/pages/page-blocks-data";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { CONTACT_CHANNEL_LABELS, mapUrlsFor, yearsSinceLabel, type PageBlock } from "@/lib/pages/page-blocks";
import {
  isCollectionSlug,
  getCollectionPageConfig,
  type CollectionSlug,
} from "@/lib/pages/collection-page-config";
import { COLLECTION_PAGE_LABELS } from "@/lib/pages/collection-slugs";
import type { Product } from "@/types/catalog";

import { productDoc, listingDoc, articleDoc, rawDoc, type MarkdownListItem } from "./docs";
import { resolveTwinCanonical } from "./canonical";
import {
  serializeMarkdown,
  estimateTokens,
  htmlToMarkdown,
  canonicalizeMarkdownPath,
  type MarkdownDoc,
} from "./render";

/**
 * THE central "Markdown for Agents" router. Every markdown request
 * (content-negotiated or `.md`) flows through `resolveMarkdownForPath`, which
 * mirrors the storefront `/[slug]` dispatch and builds the doc from the SAME data
 * layer the pages use (never scrapes HTML). Returns null for unknown / dynamic /
 * personalised paths (search, account, checkout) so the route 404s them.
 *
 * Visibility parity with the HTML pages: every product listing passes
 * `public: true` (the public catalogue read, like the storefront grids) and the
 * product twin applies the PDP's draft/noindex gate — so a twin never reveals a
 * product the HTML page hides.
 *
 * Extensible: add a new page-type branch here + a pure builder in docs.ts.
 */

export type MarkdownResult = {
  /** The normalized requested path (no `.md`). */
  canonicalPath: string;
  /** Absolute canonical URL of the HTML page this twin mirrors — the doc's
   *  frontmatter `url` (honours canonical_url overrides; flat `/${sub}` for a
   *  sub-category). The route's `Link: rel="canonical"` header uses THIS. */
  canonicalUrl: string;
  markdown: string;
  tokens: number;
};
export type GenerateCtx = {
  origin: string;
  currency: string;
  priceDecimals: number;
};

// Max items in any listing twin. Kept at the paged-loader hard clamp (100) so the
// category/brand branches return EXACTLY this many — never over-fetch + slice.
const LISTING_CAP = 100;

function productListItems(products: Product[], origin: string, currency: string, decimals: number): MarkdownListItem[] {
  return products.slice(0, LISTING_CAP).map((p) => ({
    title: p.name,
    url: `${origin}/${p.slug}`,
    summary: `${(p.priceCents / 1000).toFixed(decimals)} ${currency}`,
  }));
}

/** Flatten the section-based CMS page into a markdown body. */
/**
 * Serialise a composed page's BLOCKS to Markdown for the `/md` agent twin — the same
 * block list the HTML page renders (via getPageForRender, so a never-composed legacy page
 * is synthesised from its sections and a system slug falls back to its default HTML). Only
 * text-bearing blocks contribute; media-only (gallery) and dynamic catalogue blocks
 * (product/collections/categories/brands) emit at most their heading, since their live
 * listing already has its own markdown twin.
 */
/** The live data the HTML renderer reads (contact settings, pickup links, brand count) —
 *  passed in so the twin states the same values as the page. */
type LiveData = Pick<ResolvedPage, "site" | "pickups" | "brandCount">;

/** The /aide HTML route appends a settings-driven CONTACT + SHOWROOM section AFTER the composed
 *  blocks, read straight from the same `site.*` settings keys (each line only when set — never
 *  fabricated). Mirror it in the .md twin so the twin states the same contact values. */
function helpExtrasMarkdown(s: Record<string, string | null>): string {
  const g = (k: string) => (s[k] ?? "").trim();
  const phone = g("site.contact_phone"), email = g("site.contact_email"), whatsapp = g("site.whatsapp");
  const address = g("site.address"), hours = g("site.hours");
  const contact: string[] = [];
  if (phone) contact.push(`- **Par téléphone :** ${phone}${hours ? ` (${hours})` : ""}`);
  if (email) contact.push(`- **Par e-mail :** ${email}`);
  if (whatsapp) contact.push(`- **WhatsApp :** ${whatsapp}`);
  const out: string[] = [];
  if (contact.length) out.push(`## Toujours une question ?\n\n${contact.join("\n")}`);
  if (address) out.push(`## Showroom\n\n${address}${hours ? ` — ${hours}` : ""}`);
  return out.length ? `\n\n${out.join("\n\n")}` : "";
}

/** `<dl class="tk-facts">` → « **Durée :** … » paragraphs (htmlToMarkdown has no dl rule,
 *  so the term and its value used to run together). */
function definitionListsToParagraphs(html: string): string {
  return html
    .replace(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi, "<p><strong>$1 :</strong> $2</p>")
    .replace(/<\/?(dl|dt|dd)\b[^>]*>/gi, "");
}

function blocksToMarkdown(blocks: PageBlock[], live?: LiveData): string {
  const parts: string[] = [];
  const heading = (t?: string) => t && t.trim() && parts.push(`## ${t.trim()}`);
  for (const b of blocks) {
    if (!b.visible) continue;
    const c = b.config;
    const h = c.header;
    switch (b.type) {
      case "hero":
        heading([h?.title, c.accent].filter(Boolean).join(" "));
        if (h?.subtitle) parts.push(h.subtitle);
        if (c.body) parts.push(c.body);
        break;
      case "rich_text": {
        heading([h?.title, c.accent].filter(Boolean).join(" "));
        const body = htmlToMarkdown(definitionListsToParagraphs(c.body ?? ""));
        if (body) parts.push(body);
        break;
      }
      case "editorial":
        heading([h?.title, c.accent].filter(Boolean).join(" "));
        if (c.body) parts.push(c.body);
        for (const pt of c.points ?? []) if (pt.title || pt.body) parts.push(`- **${pt.title}**${pt.body ? ` — ${pt.body}` : ""}`);
        break;
      case "cta_band":
      case "banner":
        heading([h?.title, c.accent].filter(Boolean).join(" "));
        if (h?.subtitle) parts.push(h.subtitle);
        break;
      case "stats": {
        heading(h?.title);
        const rows = (c.stats ?? [])
          // Same live values as the HTML stats (years since a date, active brand count),
          // falling back to the operator's value; an unresolved live figure is dropped.
          .map((i) => ({
            ...i,
            value:
              (i.source === "years_since" && yearsSinceLabel(i.since)) ||
              (i.source === "brands" && live?.brandCount ? String(live.brandCount) : "") ||
              i.value,
          }))
          .filter((i) => i.label && i.value)
          .map((i) => `- **${i.label} :** ${i.value}${i.caption ? ` (${i.caption})` : ""}`);
        if (rows.length) parts.push(rows.join("\n"));
        break;
      }
      case "timeline": {
        heading(h?.title);
        const rows = (c.timeline ?? [])
          .filter((i) => i.year || i.title)
          .map((i) => `- **${i.year} — ${i.title}**${i.description ? `: ${i.description}` : ""}`);
        if (rows.length) parts.push(rows.join("\n"));
        break;
      }
      case "fifty_fifty":
      case "feature_cards":
      case "trust": {
        heading(h?.title);
        for (const card of c.cards ?? []) {
          if (!card.title && !card.body) continue;
          if (card.title) parts.push(`### ${card.title}`);
          if (card.body) parts.push(card.body);
        }
        break;
      }
      case "steps": {
        heading([h?.title, c.accent].filter(Boolean).join(" "));
        const rows = (c.steps ?? [])
          .filter((s) => s.title || s.body)
          .map((s, i) => `${i + 1}. **${s.title}**${s.body ? ` — ${s.body}` : ""}`);
        if (rows.length) parts.push(rows.join("\n"));
        break;
      }
      case "faq": {
        heading(h?.title || "Questions fréquentes");
        for (const q of c.faq ?? []) {
          if (!q.question) continue;
          parts.push(`**${q.question}**`);
          if (q.answer) parts.push(q.answer);
        }
        break;
      }
      case "quote":
        if (c.body) parts.push(`> ${c.body}${c.attribution ? `\n>\n> — ${c.attribution}` : ""}`);
        break;
      case "contact_channels": {
        // The same LIVE « Identité & contact » values the page shows.
        heading([h?.title, c.accent].filter(Boolean).join(" "));
        if (h?.subtitle) parts.push(h.subtitle);
        const site = live?.site;
        const rows: string[] = [];
        for (const ch of c.channels ?? []) {
          if (!ch.enabled) continue;
          const label = ch.label || CONTACT_CHANNEL_LABELS[ch.key];
          if (ch.key === "phone" && site?.phone) rows.push(`- **${label} :** ${site.phone}${site.hours ? ` (${site.hours})` : ""}`);
          if (ch.key === "whatsapp" && site?.whatsapp) rows.push(`- **${label} :** ${site.whatsapp}`);
          if (ch.key === "email" && site?.email) rows.push(`- **${label} :** ${site.email}`);
          if (ch.key === "stores") rows.push(`- **${label} :** ${ch.note || "Adresses & horaires"} (${ch.href || "/apropos"})`);
          if (ch.key === "help") rows.push(`- **${label} :** ${ch.note || "Questions fréquentes"} (${ch.href || "/aide"})`);
        }
        if (rows.length) parts.push(rows.join("\n"));
        break;
      }
      case "stores": {
        heading([h?.title, c.accent].filter(Boolean).join(" "));
        for (const s of c.stores ?? []) {
          // A pickup-linked card takes the live row's values, exactly like the page.
          const pk = s.pickupLocationId ? live?.pickups.get(s.pickupLocationId) : undefined;
          const name = pk?.name || s.name;
          const address = pk?.address || s.address;
          const city = pk?.city || s.city;
          if (!name && !address) continue;
          if (name) parts.push(`### ${name}`);
          const phone = pk?.phone || s.phone || live?.site.phone || "";
          const hours = pk?.hours ? [`Horaires : ${pk.hours}`] : s.hours.map((x) => [x.label, x.value].filter(Boolean).join(" : "));
          const lines = [
            [address, city].filter(Boolean).join(", "),
            ...hours,
            phone ? `Téléphone : ${phone}` : "",
            s.services.length ? `Services : ${s.services.join(", ")}` : "",
            mapUrlsFor(address, city)?.directions ? `Itinéraire : ${mapUrlsFor(address, city)!.directions}` : "",
          ].filter(Boolean);
          if (lines.length) parts.push(lines.map((l) => `- ${l}`).join("\n"));
        }
        break;
      }
      case "jobs": {
        heading([h?.title, c.accent].filter(Boolean).join(" "));
        for (const j of (c.jobs ?? []).filter((x) => x.active)) {
          parts.push(`### ${j.title}`);
          const meta = [j.team, j.location, j.contract].filter(Boolean).join(" · ");
          if (meta) parts.push(meta);
          if (j.summary) parts.push(j.summary);
        }
        break;
      }
      default:
        // gallery (images only) + dynamic catalogue blocks: heading only, if any.
        heading(h?.title);
        break;
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

/**
 * The product twin, gated EXACTLY like the PDP body ((shop)/[slug]/page.tsx
 * renderProductView): a draft or admin-noindexed product gets no twin. The price
 * goes through the PDP's live auto-promotion resolution on a COPY of the cached
 * DTO, so the twin quotes the same effective price as the PDP / cart / listing twins.
 *
 * Exported as a testable seam: the slug resolver (`getProductWithRowBySlug`) is a
 * `'use cache'` read that can't run outside Next, so a DB test hands the pair in.
 */
export async function buildProductTwin(
  pair: { product: Product; row: ProductRow },
  ctx: GenerateCtx,
): Promise<MarkdownDoc | null> {
  const { product, row } = pair;
  if (!row.is_published || product.noindex) return null;
  const priced = await withLivePromoPricing(product, row);
  return productDoc(priced, {
    url: resolveTwinCanonical(product.canonicalUrl, ctx.origin, `/${product.slug}`),
    currency: ctx.currency,
    priceDecimals: ctx.priceDecimals,
  });
}

async function buildDoc(path: string, ctx: GenerateCtx): Promise<MarkdownDoc | null> {
  const { origin, currency, priceDecimals } = ctx;
  const url = (p: string) => `${origin}${p}`;
  const segs = path.split("/").filter(Boolean);
  // No home branch: markdownEligible() excludes "/" (the home is a nav hub), and the
  // required `[...path]` catch-all never matches a bare /md — so `segs` is always ≥1.

  // ── Blog ─────────────────────────────────────────────────────────────────
  if (segs[0] === "blog") {
    if (segs.length === 1) {
      const { items } = await listApiBlogPosts({ limit: LISTING_CAP });
      return listingDoc({
        type: "blog_index",
        title: "Blog",
        url: url("/blog"),
        items: items.map((b) => ({ title: b.title, url: url(`/blog/${b.slug}`), summary: b.excerpt })),
      });
    }
    // A blog category gets a /md twin ONLY when it is indexable on the storefront
    // (active, not noindex, ≥1 published post) — listApiBlogCategories already
    // applies exactly that filter, so a noindexed/empty category is kept out of
    // the markdown surface just like the collection/category twins below.
    const indexableBlogCategory = async (slug: string) =>
      (await listApiBlogCategories()).some((c) => c.slug === slug);

    // Legacy /blog/category/<slug> (still resolvable; canonical URL is now flat).
    if (segs[1] === "category" && segs[2]) {
      if (!(await indexableBlogCategory(segs[2]))) return null;
      const { items } = await listApiBlogPosts({ limit: LISTING_CAP, categorySlug: segs[2] });
      if (items.length === 0) return null;
      return listingDoc({
        type: "blog_category",
        title: items[0]?.category?.name || segs[2],
        url: url(`/blog/${segs[2]}`),
        items: items.map((b) => ({ title: b.title, url: url(`/blog/${b.slug}`), summary: b.excerpt })),
      });
    }
    if (segs.length === 2) {
      // Flat URL: a published POST wins, else fall back to a CATEGORY listing.
      const post = await getApiBlogPost(segs[1]);
      if (post) {
        return articleDoc({
          type: "blog_article",
          title: post.title,
          description: post.metaDescription || post.excerpt,
          url: url(`/blog/${post.slug}`),
          publishedAt: post.publishedAt,
          bodyHtml: post.body,
        });
      }
      if (!(await indexableBlogCategory(segs[1]))) return null;
      const { items } = await listApiBlogPosts({ limit: LISTING_CAP, categorySlug: segs[1] });
      if (items.length === 0) return null;
      return listingDoc({
        type: "blog_category",
        title: items[0]?.category?.name || segs[1],
        url: url(`/blog/${segs[1]}`),
        items: items.map((b) => ({ title: b.title, url: url(`/blog/${b.slug}`), summary: b.excerpt })),
      });
    }
    return null;
  }

  // ── Single slug: collection → category → product → brand → CMS page ────────
  if (segs.length === 1) {
    const slug = segs[0];
    if (isCollectionSlug(slug)) {
      const config = await getCollectionPageConfig(slug as CollectionSlug);
      // Mirror the storefront: a hidden collection 404s, a noindex one is kept
      // out of search — so it gets no markdown twin either.
      if (!config.visible || config.seo.noindex) return null;
      const products = await listShowcaseProducts(config);
      return listingDoc({
        type: "collection",
        title: COLLECTION_PAGE_LABELS[slug as CollectionSlug] ?? slug,
        url: url(`/${slug}`),
        items: productListItems(products, origin, currency, priceDecimals),
      });
    }
    const category = await getCategoryBySlug(slug);
    if (category && !category.noindex) {
      const [products, raw] = await Promise.all([
        // `public` ⇒ the public catalogue read (strips internal fields), like the HTML grid.
        listApiProductsByCategory(slug, { limit: LISTING_CAP, public: true }),
        // The canonical_url override lives on the raw row (not the storefront DTO).
        categoryQueries.getCategoryBySlug(slug).catch(() => null),
      ]);
      return listingDoc({
        type: "category",
        title: category.name,
        description: category.tagline,
        url: resolveTwinCanonical(raw?.canonical_url, origin, `/${slug}`),
        intro: category.tagline,
        items: productListItems(products, origin, currency, priceDecimals),
      });
    }
    const pair = await getProductWithRowBySlug(slug);
    // Drafts + admin-noindexed products fall through (no product twin), as before.
    if (pair && pair.row.is_published && !pair.product.noindex) {
      // Shares the PDP's draft/noindex gate (see buildProductTwin).
      return buildProductTwin(pair, ctx);
    }
    const brand = await getBrandBySlug(slug);
    if (brand && brand.is_active && !brand.noindex) {
      const products = await listApiProductsByBrand(slug, { limit: LISTING_CAP, public: true });
      return listingDoc({
        type: "brand",
        title: brand.name,
        url: resolveTwinCanonical(brand.canonical_url, origin, `/${slug}`),
        items: productListItems(products, origin, currency, priceDecimals),
      });
    }
    // CMS page — same block pipeline the HTML page renders, so a block-composed page
    // emits its real content (not the empty legacy-sections body). Skip a noindexed page
    // (parity with the product/brand/category twins) and honour a canonical override.
    const forRender = await getPageForRender(slug);
    if (forRender && !forRender.page.noindex) {
      // Resolve the same live data the HTML renderer reads (contact settings, pickups,
      // brand count) so the twin never states different values than the page.
      const resolved = await resolvePageBlocks(forRender).catch(() => null);
      let body = blocksToMarkdown(forRender.blocks, resolved ?? undefined);
      // /aide appends the live contact + showroom section the HTML route shows below the blocks
      // (read from the same site.* settings, independent of whether a contact block is present).
      if (slug === "help") {
        const s = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
        body += helpExtrasMarkdown(s);
      }
      if (body) {
        return rawDoc({
          type: "page",
          title: forRender.page.title,
          description: forRender.page.metaDescription,
          url: resolveTwinCanonical(forRender.page.canonicalUrl, origin, `/${slug}`),
          body,
        });
      }
    }
    return null;
  }

  // ── Subcategory /[parent]/[sub] ────────────────────────────────────────────
  if (segs.length === 2) {
    const [parent, sub] = segs;
    // Mirror the HTML [slug]/[sub] page: the parent must be an ACTIVE category
    // (any depth) and `sub` its ACTIVE direct child — otherwise 404, so a
    // `/<junk>/<category>.md` never answers 200.
    const parentRow = await categoryQueries.getCategoryBySlug(parent);
    if (!parentRow) return null;
    const child = await categoryService.findBySlug(sub, parentRow.id, { activeOnly: true });
    if (!child || child.noindex) return null;
    // `sub` is a globally-resolvable category slug (same row as `child`), so the
    // paged tree loader bounds enrichment to LISTING_CAP rows.
    const products = await listApiProductsByCategory(sub, { limit: LISTING_CAP, public: true });
    return listingDoc({
      type: "category",
      title: child.name,
      description: child.tagline,
      // The HTML sub-category page canonicalises to the FLAT `/${sub}` (a nested
      // self-canonical split the signal) unless a canonical_url override is set.
      url: resolveTwinCanonical(child.canonical_url, origin, `/${sub}`),
      intro: child.tagline,
      items: productListItems(products, origin, currency, priceDecimals),
    });
  }

  return null;
}

export async function resolveMarkdownForPath(
  rawPath: string,
  ctx: GenerateCtx,
): Promise<MarkdownResult | null> {
  const canonicalPath = canonicalizeMarkdownPath(rawPath);
  const doc = await buildDoc(canonicalPath, ctx);
  if (!doc) return null;
  const markdown = serializeMarkdown(doc);
  // Every builder sets frontmatter `url` to the page's canonical (override-aware,
  // flat for sub-categories); fall back to the request path defensively.
  const fmUrl = doc.frontmatter.url;
  const canonicalUrl =
    typeof fmUrl === "string" && fmUrl ? fmUrl : `${ctx.origin}${canonicalPath}`;
  return { canonicalPath, canonicalUrl, markdown, tokens: estimateTokens(markdown) };
}
