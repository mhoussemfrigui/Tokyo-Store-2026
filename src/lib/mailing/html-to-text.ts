/**
 * Minimal HTML → plain-text for the multipart email fallback (the body is pre-rendered
 * HTML). Pure + dependency-free so it is unit-testable in isolation.
 *
 * Link targets are PRESERVED: `<a href="URL">text</a>` becomes `text (URL)`. A bare
 * tag-strip dropped them, so the text/plain alternative of every queued/campaign email
 * carried unclickable, context-less link labels with no URL — the CTA/tracking/unsubscribe
 * links were unreachable for any recipient reading the plain-text part.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(
      /<a\b[^>]*?\shref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, inner: string) => {
        const label = inner.replace(/<[^>]+>/g, "").trim();
        const url = href.trim();
        // Avoid "url (url)" when the visible label already IS the url.
        return label && label !== url ? `${label} (${url})` : url;
      },
    )
    .replace(/<\s*(br|\/p|\/div|\/tr|\/h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
