/**
 * PURE Markdown doc builders, one per page-type shape. Each takes ALREADY-LOADED
 * data (the storefront DTOs) + request context and returns a `MarkdownDoc`
 * (frontmatter + body). The impure dispatch (generate.ts) loads the data via the
 * existing data layer and calls these. No DB / no server-only → unit-testable.
 */
import { htmlToText } from "@/lib/ai/parse";
import type { Product } from "@/types/catalog";
import { htmlToMarkdown, type MarkdownDoc } from "./render";

function amount(minor: number, decimals: number): string {
  return (minor / 1000).toFixed(Math.max(0, Math.min(4, decimals)));
}

export type MarkdownCtx = { url: string; currency: string; priceDecimals: number };

/** A row in a listing/index markdown page. */
export type MarkdownListItem = { title: string; url: string; summary?: string | null };

/** Product detail → frontmatter (title/description/price/currency/availability/sku) + body. */
export function productDoc(p: Product, ctx: MarkdownCtx): MarkdownDoc {
  const availability = p.inStock ? "in_stock" : "out_of_stock";
  const desc = (p.metaDescription?.trim() || htmlToText(p.shortDesc || p.description, 300)).trim();
  const fm = {
    type: "product",
    title: p.name,
    description: desc,
    url: ctx.url,
    price: amount(p.priceCents, ctx.priceDecimals),
    currency: ctx.currency,
    availability,
    sku: p.sku ?? undefined,
    brand: p.brand || undefined,
    gtin: p.gtin ?? undefined,
    condition: p.condition ?? undefined,
    // Social proof (real approved-review data only) — one of the highest-signal
    // fields AI answer engines cite when recommending a product (GEO/AEO).
    rating: p.reviews > 0 ? p.rating : undefined,
    reviewCount: p.reviews > 0 ? p.reviews : undefined,
  };

  const body: string[] = [`# ${p.name}`];
  if (p.shortDesc) {
    const sd = htmlToMarkdown(p.shortDesc);
    if (sd) body.push(sd);
  }
  const priceLine =
    p.oldPriceCents != null && p.oldPriceCents > p.priceCents
      ? `**Prix :** ${amount(p.priceCents, ctx.priceDecimals)} ${ctx.currency} (au lieu de ${amount(p.oldPriceCents, ctx.priceDecimals)} ${ctx.currency})`
      : `**Prix :** ${amount(p.priceCents, ctx.priceDecimals)} ${ctx.currency}`;
  body.push(priceLine);
  body.push(`**Disponibilité :** ${availability}`);
  if (p.brand) body.push(`**Marque :** ${p.brand}`);
  if (p.reviews > 0) body.push(`**Note :** ${p.rating}/5 (${p.reviews} avis)`);
  if (p.description) {
    const d = htmlToMarkdown(p.description);
    if (d) body.push(`## Description\n\n${d}`);
  }
  if (p.variants && p.variants.length > 0) {
    const rows = p.variants
      .map(
        (v) =>
          `- ${v.label} — ${amount(v.priceCents, ctx.priceDecimals)} ${ctx.currency}${v.inStock ? "" : " (rupture)"}`,
      )
      .join("\n");
    body.push(`## Variantes\n${rows}`);
  }
  return { frontmatter: fm, body: body.join("\n\n") };
}

/**
 * Listing/index (category, brand, smart collection, blog index, aide index) →
 * frontmatter + an intro + a bulleted list of linked items.
 */
export function listingDoc(input: {
  type: string;
  title: string;
  description?: string | null;
  url: string;
  intro?: string | null;
  items: MarkdownListItem[];
}): MarkdownDoc {
  const fm = {
    type: input.type,
    title: input.title,
    description: (input.description || `${input.title} — ${input.items.length} éléments.`).trim(),
    url: input.url,
    count: input.items.length,
  };
  const body: string[] = [`# ${input.title}`];
  if (input.intro) {
    const intro = htmlToMarkdown(input.intro);
    if (intro) body.push(intro);
  }
  if (input.items.length > 0) {
    body.push(
      input.items
        .map((i) => (i.summary ? `- [${i.title}](${i.url}) — ${i.summary}` : `- [${i.title}](${i.url})`))
        .join("\n"),
    );
  }
  return { frontmatter: fm, body: body.join("\n\n") };
}

/**
 * Editorial article (blog post, aide article, CMS page) → frontmatter +
 * HTML-converted body. `bodyHtml` parts are joined (aide articles have
 * intro/steps/outro). `publishedAt` is included when present.
 */
export function articleDoc(input: {
  type: string;
  title: string;
  description?: string | null;
  url: string;
  publishedAt?: string | null;
  bodyHtml: string;
}): MarkdownDoc {
  const fm = {
    type: input.type,
    title: input.title,
    description: (input.description || "").trim() || undefined,
    url: input.url,
    publishedAt: input.publishedAt || undefined,
  };
  const md = htmlToMarkdown(input.bodyHtml);
  const body = [`# ${input.title}`, md].filter(Boolean).join("\n\n");
  return { frontmatter: fm, body };
}

/**
 * Doc from an ALREADY-MARKDOWN body (no HTML conversion) — for content the caller
 * assembled itself, e.g. a section-based CMS page flattened to markdown.
 */
export function rawDoc(input: {
  type: string;
  title: string;
  description?: string | null;
  url: string;
  body: string;
}): MarkdownDoc {
  const fm = {
    type: input.type,
    title: input.title,
    description: (input.description || "").trim() || undefined,
    url: input.url,
  };
  const body = [`# ${input.title}`, input.body.trim()].filter(Boolean).join("\n\n");
  return { frontmatter: fm, body };
}
