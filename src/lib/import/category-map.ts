import { CATALOG_TREE, walkCatalogTree } from "@/lib/db/catalog-tree";

/**
 * Maps feed category breadcrumbs ("Smartphones / Apple")
 * onto the canonical CATALOG_TREE slugs.
 *
 * The alias map is built lazily once per process from two sources:
 *
 *   1. every tree node's normalized NAME → its slug — roots inserted FIRST
 *     and existing keys never overwritten, so an ambiguous name always maps to
 *     the top-level audience root rather than a same-named child;
 *   2. explicit aliases for the source store's wording ("Montres homme"
 *     vs the tree's "Homme", "Maroquinerie", "Divers"…).
 *
 * The runner also passes a per-run index of the store's LIVE categories
 * (`buildLiveCategoryIndex`), consulted FIRST for every segment — so a feed
 * path naming a category the admin created or renamed ("Montres connectées"),
 * or its exact slug, maps onto it. The static map stays the fallback; with a
 * live index it only counts when it points at a category that still exists.
 * Live lookups are PARENT-AWARE (see `resolveLiveSegment`): "Femme /
 * Automatiques" lands on Femme's « Automatiques », never on Homme's.
 *
 * Resolution scans the path LEFT→RIGHT and keeps the LAST segment that hits
 * the map (deepest match wins); unknown segments are simply skipped. When no
 * segment matches (empty path, "Nouveautés"…), a title-keyword fallback picks
 * the audience ROOT; `null` means truly unmappable — the runner records the
 * raw path in the job's `unmappedPaths`.
 */
export function resolveCategorySlug(
  path: string[],
  _title: string,
  live?: LiveCategoryIndex,
): string | null {
  const map = getAliasMap();

  let hit: string | null = null;
  for (const segment of path) {
    const key = normalizeAlias(segment);
    if (!key) continue;
    // right-most (deepest) match wins
    const slug: string | null | undefined = live
      ? resolveLiveSegment(key, hit, live, map)
      : map.get(key);
    if (slug) hit = slug;
  }
  if (hit) return hit;

  // No title-keyword fallback for the Tokyo high-tech taxonomy (unlike the old
  // watch store there is no clean title → universe heuristic). An unmapped path is
  // recorded in the job's unmappedPaths.
  return null;
}

/** The live-category fields the mapper reads (a `categories` row subset). */
export type LiveCategory = {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
};

/** Per-run lookup over the store's live categories (see `resolveCategorySlug`). */
export type LiveCategoryIndex = {
  /**
   * STORE-WIDE keys: every normalised slug → itself, plus a normalised NAME →
   * slug only when that name is unique across the live categories. An
   * ambiguous name ("Automatiques" under both Homme and Femme) gets no global
   * winner — it only resolves under its parent (`byParentKey`).
   */
  byKey: Map<string, string>;
  /** `${parentSlug}\u0000${normalised name | slug}` → the child's slug */
  byParentKey: Map<string, string>;
  /** every live slug (a static alias only counts when its target is in here) */
  slugs: Set<string>;
  /** live slug → the slug of its ROOT (itself for a root) */
  rootOf: Map<string, string>;
};

/**
 * Index the store's live categories for one import run (see `LiveCategoryIndex`).
 * Shallower categories are inserted first and the first writer wins, so a
 * sub-category reusing a root's slug never shadows the root (the runner's
 * `catBySlug` makes the same choice).
 */
export function buildLiveCategoryIndex(categories: readonly LiveCategory[]): LiveCategoryIndex {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const parentOf = (c: LiveCategory): LiveCategory | undefined =>
    c.parent_id ? byId.get(c.parent_id) : undefined;
  /** ancestors nearest-first (cycle-safe) */
  const ancestorsOf = (c: LiveCategory): LiveCategory[] => {
    const chain: LiveCategory[] = [];
    const seen = new Set<string>([c.id]);
    let parent = parentOf(c);
    while (parent && !seen.has(parent.id)) {
      chain.push(parent);
      seen.add(parent.id);
      parent = parentOf(parent);
    }
    return chain;
  };
  const ordered = categories
    .map((c, index) => ({ c, ancestors: ancestorsOf(c), index }))
    .sort((a, b) => a.ancestors.length - b.ancestors.length || a.index - b.index);

  const nameCount = new Map<string, number>();
  for (const c of categories) {
    const key = normalizeAlias(c.name);
    if (key) nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
  }

  const byKey = new Map<string, string>();
  const byParentKey = new Map<string, string>();
  const rootOf = new Map<string, string>();
  const add = (map: Map<string, string>, key: string, slug: string): void => {
    if (key && !map.has(key)) map.set(key, slug);
  };
  for (const { c, ancestors } of ordered) {
    const nameKey = normalizeAlias(c.name);
    const slugKey = normalizeAlias(c.slug);
    if (nameCount.get(nameKey) === 1) add(byKey, nameKey, c.slug);
    const parent = ancestors[0];
    if (parent) {
      add(byParentKey, parentKey(parent.slug, nameKey), c.slug);
      add(byParentKey, parentKey(parent.slug, slugKey), c.slug);
    }
    add(rootOf, c.slug, (ancestors[ancestors.length - 1] ?? c).slug);
  }
  for (const { c } of ordered) add(byKey, normalizeAlias(c.slug), c.slug);

  return { byKey, byParentKey, slugs: new Set(categories.map((c) => c.slug)), rootOf };
}

function parentKey(parentSlug: string, key: string): string {
  return key ? `${parentSlug}\u0000${key}` : "";
}

/**
 * One path segment against the live index, given the slug the path resolved to
 * so far (`hit`):
 *
 *   1. a child of `hit` with that name / slug — disambiguates same-named
 *      sub-categories under different roots (Homme vs Femme « Automatiques »);
 *   2. a store-wide key (unique name or exact slug) — but once the path has
 *      resolved, only inside the SAME root branch as `hit`, unless the curated
 *      static alias agrees ("Homme / Bracelets" → bracelets). Otherwise "Femme /
 *      Automatiques" in a store with only Homme's « Automatiques » would file a
 *      women's watch under Homme; it stays on Femme instead;
 *   3. the static alias, when its target category still exists.
 */
function resolveLiveSegment(
  key: string,
  hit: string | null,
  live: LiveCategoryIndex,
  map: Map<string, string>,
): string | null {
  if (hit) {
    const child = live.byParentKey.get(parentKey(hit, key));
    if (child) return child;
  }
  const staticSlug = map.get(key);
  const flat = live.byKey.get(key);
  if (flat && (!hit || live.rootOf.get(flat) === live.rootOf.get(hit) || flat === staticSlug)) {
    return flat;
  }
  if (staticSlug && live.slugs.has(staticSlug)) return staticSlug;
  return null;
}

/** lowercase, strip diacritics (NFD), collapse non-alphanumerics to single spaces, trim. */
function normalizeAlias(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Source-store wording → target slug. Keys are normalized at insert time, so
 * they can be written here in natural casing. Entries NEVER overwrite a key
 * already claimed by the tree walk (and agree with it wherever they overlap).
 */
const EXPLICIT_ALIASES: ReadonlyArray<readonly [string, string]> = [
  // The Tokyo migration feed's `canonical_category_path` segment NAMES already
  // match the live category names (the tree was built from them), so the live
  // parent-aware index resolves every path. No source-store wording aliases are
  // needed; add one here only if a future feed names a category differently.
];

let aliasMap: Map<string, string> | null = null;

function getAliasMap(): Map<string, string> {
  if (aliasMap) return aliasMap;

  const map = new Map<string, string>();
  const add = (alias: string, slug: string): void => {
    const key = normalizeAlias(alias);
    // First writer wins — the collision rule that keeps an ambiguous name
    // (e.g. "accessoires") on the top-level root.
    if (key && !map.has(key)) map.set(key, slug);
  };

  // 1. Root names first (collision rule), then the depth-first walk — which
  //    itself visits every parent before its own children.
  for (const root of CATALOG_TREE) add(root.name, root.slug);
  walkCatalogTree(CATALOG_TREE, (node) => add(node.name, node.slug));

  // 2. Source-store aliases.
  for (const [alias, slug] of EXPLICIT_ALIASES) add(alias, slug);

  aliasMap = map;
  return map;
}
