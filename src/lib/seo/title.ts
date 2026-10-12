/**
 * Pure title helpers (no server/DB deps → unit-testable).
 *
 * `stripBrandFromTitle` removes a baked-in brand/site-name PREFIX or SUFFIX from
 * a page title so the global title template (`%s · {siteName}`) never
 * double-applies it. The crawl found titles like
 * "Princess Peach… · Tokyo Store · Tokyo Store" and "Meta · Tokyo Store · Tokyo Store":
 * the cause is a stored/AI/imported `meta_title` that already carried the brand,
 * PLUS the template being applied on top. Stripping first (here) + emitting the
 * title as `absolute` (so Next's layout template doesn't re-apply) fixes it.
 *
 * Only strips a brand token that sits next to a separator (·, |, —, –, -) so a
 * legitimate hyphen inside a name ("Spider-Man") is never touched. Repeats to
 * collapse a doubled/tripled suffix. Never returns empty.
 */
const SEP = "[·|—–-]";

export function stripBrandFromTitle(title: string, siteName: string): string {
  const original = (title ?? "").trim();
  if (!original || !siteName?.trim()) return original;
  const esc = siteName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = new RegExp(`\\s*${SEP}\\s*${esc}\\s*$`, "i");
  const prefix = new RegExp(`^\\s*${esc}\\s*${SEP}\\s*`, "i");

  let t = original;
  let prev = "";
  // Collapse a doubled/tripled trailing brand suffix.
  while (t !== prev) {
    prev = t;
    t = t.replace(suffix, "").trim();
  }
  // Then a leading brand prefix ("Tokyo Store | …").
  prev = "";
  while (t !== prev) {
    prev = t;
    t = t.replace(prefix, "").trim();
  }
  return t || original;
}

/**
 * Compose the final <title>: strip any baked-in brand, then apply the template
 * once. Returns the ABSOLUTE title string (the caller passes it as
 * `title: { absolute }` so the layout template is not applied a second time).
 */
export function composeTitle(rawTitle: string, siteName: string, template: string): string {
  const cleaned = stripBrandFromTitle(rawTitle, siteName);
  return template.includes("%s") ? template.replace("%s", cleaned) : cleaned;
}
