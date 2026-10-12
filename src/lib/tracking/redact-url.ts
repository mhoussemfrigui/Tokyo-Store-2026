/**
 * PURE (no window / no server-only / no next import) — scrubs bearer
 * credentials out of the URLs the storefront hands to third-party tags
 * (GA4 `page_location`, the GTM dataLayer, Meta Pixel PageView decisions).
 *
 * WHY: some storefront URLs ARE the credential. An order id (UUID v7 — ~74
 * random bits + a ms timestamp: unguessable, but a bearer capability) opens the
 * order summary, the guest receipt and the guest cancel; `?token=` carries a
 * live password-reset / staff-invite / e-mail-verify token or the unsubscribe
 * token (which embeds the address). GA4 / GTM / Meta read `location.href` by default, so without this
 * every one of them lands in the vendor's reports. The `no-referrer` metadata on
 * those pages only governs the Referer header — not what a tag reads.
 *
 * Two layers use this:
 *  - TAG_FREE_PATHS: the token-landing routes load NO third-party tag at all
 *    (TrackingScripts returns null, the owner's custom snippets are skipped).
 *  - redactTrackedUrl(): everywhere else, the URL a tag receives has the bearer
 *    path segments replaced (`/order/<uuid>` → `/order/:id`) and token-like
 *    query params dropped — including inside a nested `from=` / callback path.
 */

/** Routes whose URL carries a live token — no third-party tag loads there.
 *  Each base also covers its sub-paths. */
export const TAG_FREE_PATHS = [
  "/reset-password",
  "/verify-email",
  "/se-desabonner",
] as const;

/** Query params that carry a credential (reset / invite / verify / unsubscribe
 *  tokens, signed-link keys) — dropped outright. Matched case-insensitively. */
const TOKEN_PARAMS = new Set(["token", "t", "k"]);

/** Bearer path segments → a stable placeholder (the route stays reportable,
 *  the credential doesn't). Order matters: `/order/verify/<id>` before `/order/<id>`. */
const BEARER_PATH_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/order\/verify\/[^/]+/, "/order/verify/:id"],
  [/^\/order\/(?!verify(?:\/|$))[^/]+/, "/order/:id"],
  [/^\/facture\/[^/]+/, "/facture/:id"],
  // Owner-gated, but it is the SAME order UUID as /order/<id> (summary) and the
  // guest /facture — leaking it from the account view is the same leak.
  [/^\/account\/orders\/[^/]+/, "/account/orders/:id"],
];

/** Parse base for relative inputs — never emitted (relative in ⇒ relative out). */
const PARSE_BASE = "http://redact.invalid";

/** Is `pathname` one of the {@link TAG_FREE_PATHS} (exact base or a sub-path on
 *  a segment boundary — `/reset-passwordX` does NOT match; trailing slashes
 *  ignored)? */
export function isTagFreePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const p = pathname.replace(/\/+$/, "") || "/";
  return TAG_FREE_PATHS.some((base) => p === base || p.startsWith(`${base}/`));
}

function redactPath(pathname: string): { path: string; changed: boolean } {
  for (const [re, placeholder] of BEARER_PATH_RULES) {
    if (re.test(pathname)) return { path: pathname.replace(re, placeholder), changed: true };
  }
  return { path: pathname, changed: false };
}

/** A same-site path (`/x`, not `//host`) or an absolute http(s) URL — the shape
 *  of a `from=` / callback value worth scrubbing recursively. */
function looksLikeNestedUrl(value: string): boolean {
  return /^\/(?![/\\])/.test(value) || /^https?:\/\//i.test(value);
}

function redact(href: string, nested: boolean): { url: string; changed: boolean } {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(href);
  let parsed: URL;
  try {
    parsed = new URL(href, PARSE_BASE);
  } catch {
    // Unparseable — keep only the (scrubbed) path; never pass a raw query on.
    const rawPath = href.split(/[?#]/, 1)[0] ?? "";
    const { path } = redactPath(rawPath);
    return { url: path, changed: true };
  }

  const { path, changed: pathChanged } = redactPath(parsed.pathname);
  let changed = pathChanged;

  const kept: Array<[string, string]> = [];
  let queryChanged = false;
  for (const [key, value] of parsed.searchParams) {
    if (TOKEN_PARAMS.has(key.toLowerCase())) {
      queryChanged = true;
      continue;
    }
    if (nested && looksLikeNestedUrl(value)) {
      // One level only (a `from=` inside a `from=` is not a real flow).
      const inner = redact(value, false);
      if (inner.changed) queryChanged = true;
      kept.push([key, inner.url]);
      continue;
    }
    kept.push([key, value]);
  }
  if (queryChanged) changed = true;
  // Re-serialise only when something was removed/rewritten, so an untouched URL
  // keeps its exact original encoding. The #fragment is always dropped.
  const search = queryChanged
    ? kept.length > 0
      ? `?${new URLSearchParams(kept).toString()}`
      : ""
    : parsed.search;

  const origin = absolute ? `${parsed.protocol}//${parsed.host}` : "";
  return { url: `${origin}${path}${search}`, changed };
}

/**
 * The URL a third-party tag may see: bearer path segments replaced with a
 * placeholder, token-like query params dropped (also inside a nested same-site
 * `from=` / callback URL), the #fragment removed. Absolute in ⇒ absolute out;
 * relative in ⇒ relative out. Never throws.
 *
 *   https://shop.tn/order/0190…-…?fresh=1   → https://shop.tn/order/:id?fresh=1
 *   /login?from=%2Ffacture%2F0190…          → /login?from=%2Ffacture%2F%3Aid
 *   /se-desabonner?token=abc.def            → /se-desabonner
 */
export function redactTrackedUrl(href: string): string {
  return redact(href, true).url;
}

/**
 * Does `href` carry a bearer credential — a {@link TAG_FREE_PATHS} route, a
 * bearer path segment, or a token-like / nested-bearer query param? Used for
 * the tags that can't be handed a scrubbed URL (the Meta Pixel always reports
 * the real `location.href`), which therefore skip their PageView there.
 */
export function isSensitiveTrackedUrl(href: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(href, PARSE_BASE).pathname;
  } catch {
    return true;
  }
  if (isTagFreePath(pathname)) return true;
  return redact(href, true).changed;
}
