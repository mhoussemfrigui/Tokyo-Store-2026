import DOMPurify from "isomorphic-dompurify";

/**
 * Single sanitizer for ALL admin-authored rich-text HTML (blog / aid / product
 * / CMS bodies). Two guarantees:
 *   1. DOMPurify with the standard html profile strips scripts/handlers (XSS).
 *   2. No element may fetch an OFF-ORIGIN resource: the src/srcset/poster of any
 *      <img>/<video>/<audio>/<source>, and any inline `style` containing a
 *      url(...), are stripped unless the src points at our own `/cdn/` proxy. So
 *      every displayed asset flows through processImage → webp/avif → /cdn, and
 *      pasted external/tracking URLs (IP/UA/Referer leak) can't survive.
 *
 * Isomorphic (isomorphic-dompurify) so the server render and the admin client
 * preview share one recipe — they can never drift.
 */

const MEDIA_SRC_TAGS = new Set(["IMG", "SOURCE", "VIDEO", "AUDIO"]);
const isCdn = (v: string) => /^\/cdn\//i.test(v);

/**
 * Enforce the /cdn/-only resource rule on the PARSED DOM node. Reading decoded
 * attributes is robust against an embedded `>` inside a title/alt value (e.g.
 * `<img title=">" src="https://evil/x.png">`), which defeated the previous
 * tag-text regex post-pass. Covers EVERY remote-fetching surface DOMPurify's
 * html profile permits — not just <img> — so the same tracking-pixel / IP-leak
 * can't sneak in via <video src/poster>, <source>, <audio>, or style=url().
 */
function cdnOnlyResourceHook(node: Element): void {
  if (MEDIA_SRC_TAGS.has(node.nodeName)) {
    const src = node.getAttribute("src") ?? "";
    if (src && !isCdn(src)) node.removeAttribute("src");
    if (node.hasAttribute("srcset")) node.removeAttribute("srcset");
  }
  if (node.nodeName === "VIDEO") {
    const poster = node.getAttribute("poster") ?? "";
    if (poster && !isCdn(poster)) node.removeAttribute("poster");
  }
  // Inline style with a url(...) (e.g. background:url(https://evil/p.gif)) fetches
  // a remote resource too — drop the whole style attribute when it carries one.
  const style = node.getAttribute("style");
  if (style && /url\s*\(/i.test(style)) node.removeAttribute("style");
}

export function sanitizeRichHtml(html: string): string {
  // Register the resource hook only for this call and remove it immediately
  // after. The whole add → sanitize → remove sequence is SYNCHRONOUS (DOMPurify
  // is sync; no await between), so under Node's single-threaded model concurrent
  // server renders can never interleave it — safe where a persistent global hook
  // would have raced. The finally{} also guarantees removal if sanitize throws.
  DOMPurify.addHook("afterSanitizeAttributes", cdnOnlyResourceHook as never);
  try {
    const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    // Downgrade any admin-authored <h1> to <h2> so the HOST PAGE's own <h1>
    // (category/brand/PDP title) stays the sole H1 and the heading outline
    // isn't broken. The rich-text editors already declare the intended set as
    // h2–h4, but the field is a raw-HTML textarea so a hand-typed <h1> reaches
    // here. DOMPurify has already encoded any literal '<' inside text/attribute
    // values as &lt;, so this tag-name rewrite can only match real <h1>
    // element tags. Downgrading (not stripping) preserves the outline.
    return clean.replace(/<(\/?)h1(\s|>|\/)/gi, "<$1h2$2");
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes");
  }
}
