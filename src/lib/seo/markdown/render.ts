/**
 * PURE rendering primitives for "Markdown for Agents": YAML frontmatter,
 * a lightweight HTML→Markdown converter (for the TipTap-sanitised bodies of
 * blog/CMS content), a token estimate, and the doc serializer. No DB / no
 * server-only → unit-tested in db/tests/markdown-render.test.ts.
 */

export type FrontmatterValue = string | number | boolean | string[] | null | undefined;
export type Frontmatter = Record<string, FrontmatterValue>;

export type MarkdownDoc = {
  frontmatter: Frontmatter;
  /** Markdown body (already converted from HTML / assembled). */
  body: string;
};

/** ~4 chars/token heuristic — drives the `x-markdown-tokens` response header. */
export function estimateTokens(text: string): number {
  const n = text.trim().length;
  return n === 0 ? 0 : Math.ceil(n / 4);
}

/** Quote a YAML scalar only when needed (contains :,#,quotes,leading special). */
function yamlScalar(v: string): string {
  if (v === "") return '""';
  // Always double-quote to be safe with colons/hashes/unicode; escape backslash + quote.
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

/** Render a YAML frontmatter block. Null/undefined keys are dropped; arrays
 *  become inline `[a, b]`. */
export function renderFrontmatter(fm: Frontmatter): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}: [${value.map((v) => yamlScalar(String(v))).join(", ")}]`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${yamlScalar(String(value))}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * Lightweight HTML→Markdown for the constrained, sanitised TipTap HTML the
 * editorial bodies store (headings, paragraphs, lists, bold/italic, links,
 * blockquotes, br, hr). Not a full parser — but the input is already a known,
 * narrow tag set. Anything unrecognised is stripped to text. Pure + testable.
 */
export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return "";
  let s = html;
  // Drop script/style entirely.
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Headings → #..######
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, inner: string) => {
    return `\n\n${"#".repeat(Number(lvl))} ${inner.trim()}\n\n`;
  });
  // Inline emphasis + links BEFORE stripping (so the markers survive).
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `**${inner.trim()}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `*${inner.trim()}*`);
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = inner.trim();
    return href ? `[${text}](${href})` : text;
  });
  // List items → "- " (ordered + unordered both bulleted; agents don't need numbering).
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${inner.trim()}`);
  // Blockquote → "> "
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => `\n\n> ${inner.trim()}\n\n`);
  // Block separators
  s = s.replace(/<\/(p|div|ul|ol|tr|h[1-6])>/gi, "\n\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
  // Strip any remaining tags, decode entities.
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  // Collapse excessive blank lines + trailing spaces.
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}

/** Serialize a doc → frontmatter + body, with a single trailing newline. */
export function serializeMarkdown(doc: MarkdownDoc): string {
  return `${renderFrontmatter(doc.frontmatter)}\n\n${doc.body.trim()}\n`;
}

/**
 * Canonicalise a requested path: single leading slash, collapse `//`, drop a
 * trailing slash + any `.md` suffix. The route's `Link: rel=canonical` header is
 * built from this, and the dispatch matches on it. Pure.
 */
export function canonicalizeMarkdownPath(raw: string): string {
  let p = `/${raw}`.replace(/\/+/g, "/").replace(/\.md$/i, "");
  if (p.length > 1) p = p.replace(/\/$/, "");
  return p || "/";
}
