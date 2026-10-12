/**
 * PURE llms.txt builders. No DB / no I/O — the route handler
 * (src/app/llms.txt/route.ts) gathers live data + settings and calls these.
 * Unit-testable.
 *
 * `buildCategoryForest` rebuilds the category TREE from the flat ApiCategory list
 * (the only loader exposing per-node description + displayOrder), skipping
 * noindex nodes. `buildLlmsTxt` renders the 2026 AEO/GEO-oriented Markdown map:
 * a `>` summary, topical H2 sections per top-level category (the structure LLMs
 * chunk best), then collections, blog, help, ordering, shipping, warranty, store
 * info + machine resources. Sections with no data are omitted (we never assert a
 * shipping/warranty/contact claim the operator hasn't configured).
 */

/** Flat category row (subset of ApiCategory) the forest builder needs. */
export type LlmsCategoryRow = {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  tagline: string | null;
  description: string | null;
  displayOrder: number;
  noindex: boolean;
};

/** A node in the rebuilt category tree. */
export type LlmsCatNode = {
  slug: string;
  name: string;
  summary: string | null;
  children: LlmsCatNode[];
};

/** Collapse a tagline/description to a single clean one-line summary. */
function oneLine(s: string | null | undefined, max = 200): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Escape Markdown control chars in admin-controlled FREE TEXT (category / blog
 * names, summaries, knowsAbout) before it lands in a link text, heading or
 * inline span. Without this a name containing `]` would close a link early and
 * inject/hijack a link, a leading `#` could forge a heading, and a backtick/`*`
 * could open a stray span. Newlines are already collapsed by `oneLine`/`mdInline`.
 */
function escapeMd(s: string): string {
  return s.replace(/([\\`*[\]])/g, "\\$1");
}

/** Collapse whitespace AND escape Markdown — for any interpolated free-text name. */
function mdInline(s: string): string {
  return escapeMd(s.replace(/\s+/g, " ").trim());
}

/**
 * Rebuild the category forest from the FLAT list. Roots = rows whose parent is
 * null OR points outside the visible set (an active child of a hidden parent is
 * promoted to a root rather than dropped). noindex rows are skipped entirely
 * (mirrors the sitemap). Siblings are ordered by displayOrder then name. A depth
 * cap guards against a corrupt parent cycle.
 */
export function buildCategoryForest(rows: LlmsCategoryRow[]): LlmsCatNode[] {
  const visible = rows.filter((r) => !r.noindex);
  const byId = new Map(visible.map((r) => [r.id, r]));
  const childrenOf = new Map<string | null, LlmsCategoryRow[]>();
  for (const r of visible) {
    // Treat a parent that isn't in the visible set as "no parent" (promote to root).
    const key = r.parentId && byId.has(r.parentId) ? r.parentId : null;
    const arr = childrenOf.get(key);
    if (arr) arr.push(r);
    else childrenOf.set(key, [r]);
  }

  const sortSiblings = (a: LlmsCategoryRow, b: LlmsCategoryRow) =>
    a.displayOrder - b.displayOrder || a.name.localeCompare(b.name, "fr");

  const build = (parentKey: string | null, depth: number): LlmsCatNode[] => {
    if (depth > 8) return []; // cycle / corruption guard (real tree ≤ 4 levels)
    const kids = (childrenOf.get(parentKey) ?? []).slice().sort(sortSiblings);
    return kids.map((r) => ({
      slug: r.slug,
      name: r.name,
      summary: oneLine(r.description ?? r.tagline),
      children: build(r.id, depth + 1),
    }));
  };

  return build(null, 0);
}

export type LlmsLink = { name: string; path: string };

export type LlmsInput = {
  siteName: string;
  /** Absolute origin, no trailing slash. */
  origin: string;
  tagline: string | null;
  /** The rich meta description → the `>` blockquote summary. */
  description: string;
  /** seo.knows_about — marques/expertise high-tech, rendered as a closing italic line. */
  knowsAbout: string[];
  categories: LlmsCatNode[];
  /** Smart collections + other key landing pages (label + site-root path). */
  keyPages: LlmsLink[];
  blogCategories: LlmsLink[];
  contact: {
    email: string | null;
    phone: string | null;
    address: string | null;
    whatsapp: string | null;
    hours: string | null;
  };
  social: string[];
  /** Pre-formatted shipping facts (caller formats money + days; null = unset). */
  shipping: {
    currency: string;
    feeMajor: string | null;
    freeThresholdMajor: string | null;
    freeEnabled: boolean;
    deliveryDays: string | null;
  } | null;
  warranty: { months: number; label: string | null };
  business: { legalName: string | null; taxId: string | null };
  /** Enabled machine feeds (label + absolute URL). */
  feeds: LlmsLink[];
};

function renderCatNode(node: LlmsCatNode, origin: string, depth: number): string[] {
  const indent = "  ".repeat(depth);
  const summary = node.summary ? ` — ${escapeMd(node.summary)}` : "";
  const out = [`${indent}- [${mdInline(node.name)}](${origin}/${node.slug})${summary}`];
  for (const c of node.children) out.push(...renderCatNode(c, origin, depth + 1));
  return out;
}

/** Build the full llms.txt body. */
export function buildLlmsTxt(input: LlmsInput): string {
  const { origin, siteName, tagline } = input;
  const blocks: string[] = [];

  // Header + summary blockquote (the llms.txt convention).
  blocks.push(tagline ? `# ${siteName} — ${tagline}` : `# ${siteName}`);
  blocks.push(`> ${oneLine(input.description, 600) ?? `Boutique en ligne ${siteName}.`}`);

  // Topical H2 per top-level category (best AEO chunking), descendants nested.
  for (const root of input.categories) {
    const section = [`## ${mdInline(root.name)}`];
    if (root.summary) section.push(escapeMd(root.summary));
    section.push(`- [${mdInline(root.name)}](${origin}/${root.slug})`);
    for (const c of root.children) section.push(...renderCatNode(c, origin, 1));
    blocks.push(section.join("\n"));
  }

  if (input.keyPages.length > 0) {
    blocks.push(
      ["## Sélections & pages clés", ...input.keyPages.map((p) => `- [${mdInline(p.name)}](${origin}${p.path})`)].join("\n"),
    );
  }

  const blog = ["## Blog", `- [Blog](${origin}/blog)`];
  for (const c of input.blogCategories) blog.push(`- [${mdInline(c.name)}](${origin}${c.path})`);
  blocks.push(blog.join("\n"));

  // How to order — only the channels that exist.
  const order = [
    "## Comment commander",
    `- Site web : commande en ligne sur ${origin} — ajout au panier, paiement, puis livraison ou retrait en magasin.`,
    "- Achat Express : indiquez prénom + téléphone sur la fiche produit, l'équipe rappelle pour confirmer et organiser la livraison.",
  ];
  if (input.contact.whatsapp) order.push(`- WhatsApp : ${input.contact.whatsapp}`);
  if (input.social.length > 0) order.push(`- Réseaux sociaux : ${input.social.join(" · ")}`);
  if (input.contact.address) order.push(`- Retrait en magasin : ${input.contact.address}`);
  blocks.push(order.join("\n"));

  // Shipping — only configured facts.
  if (input.shipping) {
    const s = input.shipping;
    const ship: string[] = [];
    if (s.feeMajor) ship.push(`- Frais de livraison : ${s.feeMajor} ${s.currency}.`);
    if (s.freeEnabled && s.freeThresholdMajor)
      ship.push(`- Livraison offerte dès ${s.freeThresholdMajor} ${s.currency} d'achat.`);
    if (s.deliveryDays) ship.push(`- Délai estimé : ${s.deliveryDays}.`);
    if (ship.length > 0) blocks.push(["## Livraison", ...ship].join("\n"));
  }

  // Warranty & after-sales — the policy page is always linkable.
  const sav = ["## Garantie & SAV"];
  if (input.warranty.months > 0)
    sav.push(
      `- Garantie : ${input.warranty.months} mois${input.warranty.label ? ` — ${input.warranty.label}` : ""}.`,
    );
  else if (input.warranty.label) sav.push(`- ${input.warranty.label}`);
  sav.push(`- Conditions générales de vente : ${origin}/cgv`);
  blocks.push(sav.join("\n"));

  // Store information.
  const info = ["## Informations", `- Site : ${origin}`];
  if (input.contact.email) info.push(`- Email : ${input.contact.email}`);
  if (input.contact.phone) info.push(`- Téléphone : ${input.contact.phone}`);
  if (input.contact.address) info.push(`- Adresse : ${input.contact.address}`);
  if (input.contact.hours) info.push(`- Horaires : ${input.contact.hours}`);
  if (input.business.legalName)
    info.push(
      `- Raison sociale : ${input.business.legalName}${input.business.taxId ? ` (Matricule fiscal : ${input.business.taxId})` : ""}`,
    );
  info.push(`- Recherche produit : ${origin}/recherche?q={search_term_string}`);
  blocks.push(info.join("\n"));

  // Machine resources for crawlers + agents.
  const res = ["## Ressources", `- Plan du site (sitemap) : ${origin}/sitemap.xml`];
  for (const f of input.feeds) res.push(`- ${f.name} : ${f.path}`);
  blocks.push(res.join("\n"));

  if (input.knowsAbout.length > 0) {
    blocks.push(`*Marques & expertise high-tech représentées : ${input.knowsAbout.map(mdInline).join(", ")}.*`);
  }

  return blocks.join("\n\n") + "\n";
}
