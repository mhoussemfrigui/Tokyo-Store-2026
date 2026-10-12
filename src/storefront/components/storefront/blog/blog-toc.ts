/**
 * Build the article's « Sommaire » from its (already-sanitized) body HTML: find
 * every <h2>, give it a stable slug `id` (so the TOC links + scroll-spy resolve),
 * and return the modified HTML + the ordered section list. Pure string work (runs
 * in the RSC render, no DOM). The body is TipTap output (simple <h2>Heading</h2>),
 * so a tolerant regex is sufficient.
 */

export type TocSection = { id: string; label: string };

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractToc(html: string): { html: string; sections: TocSection[] } {
  const sections: TocSection[] = [];
  const seen = new Set<string>();
  const out = html.replace(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi, (match, attrs: string, inner: string) => {
    const label = stripTags(inner);
    if (!label) return match;
    const existing = /\bid=["']([^"']+)["']/i.exec(attrs);
    let id = existing ? existing[1]! : slugify(label);
    if (!id) id = `section-${sections.length + 1}`;
    let unique = id;
    let n = 2;
    while (seen.has(unique)) unique = `${id}-${n++}`;
    seen.add(unique);
    sections.push({ id: unique, label });
    const attrsWithId = existing ? attrs : `${attrs} id="${unique}"`;
    return `<h2${attrsWithId}>${inner}</h2>`;
  });
  return { html: out, sections };
}
