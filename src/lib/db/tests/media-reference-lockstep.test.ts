/**
 * Media reference-list LOCK-STEP guard (PURE — reads modules/media/queries.ts).
 *
 * Three hand-written SQL lists must cover the SAME media-reference sources, or
 * the "media is the single source of truth" guarantee breaks:
 *   - orphanCandidateWhere() + orphanBodyWhere() — the orphan anti-join, split into
 *                               a cheap index-backed prune + the expensive body/JSON
 *                               matchers (over-cover = safe);
 *   - listReferencedMediaIds()— the destructive-sweep guard (UNDER-cover = a
 *                               sweep hard-deletes an in-use image → data loss);
 *   - countMediaReferences()  — the delete-confirm in-use warning.
 * The first two share the inline-body helper bodyRefMatch(); countMediaReferences
 * inlines the same body columns. A developer adding a new `*_media_id` column (or
 * a new rich-HTML body column) to one list but not the others would ship a green
 * build and re-open the inline/orphan data-loss. This asserts the FROM-table sets
 * agree, so that drift fails CI instead — turning the "keep in lock-step" comment
 * into a forcing function.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/media-reference-lockstep.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const SRC = readFileSync(join(process.cwd(), "src", "modules", "media", "queries.ts"), "utf8");

/** Slice a function's body from `function <name>` to the next top-level `function `. */
function fnBody(name: string): string {
  const start = SRC.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`function ${name} not found in queries.ts`);
  const after = SRC.indexOf("\nfunction ", start + 1);
  const afterAsync = SRC.indexOf("\nexport async function ", start + 1);
  const candidates = [after, afterAsync].filter((n) => n > start);
  const end = candidates.length ? Math.min(...candidates) : SRC.length;
  return SRC.slice(start, end);
}

/**
 * Set-returning functions that appear in a `FROM` clause but are NOT reference
 * tables — they iterate a jsonb value (value_props / boutique trust cards), so
 * they must be excluded from the table-set comparison.
 */
const SRF_IGNORE = new Set(["jsonb_array_elements", "jsonb_array_elements_text"]);

/**
 * Tables that back a JSON-BLOB seam reached via a matcher HELPER in orphan/ref
 * but INLINED in countMediaReferences — so the raw FROM-set would see them in
 * count only (the helper hides the `FROM` from the delegating functions). They
 * are asserted in lock-step through the JSON_SEAMS marker check below instead of
 * the FROM-set diff, so exclude them here to avoid a false asymmetry. (Most JSON
 * seams ride on tables already present for `*_media_id` columns — site_settings /
 * pages / categories / … — and need no entry; `nav_items` is its own table.)
 */
const JSON_SEAM_ONLY_TABLES = new Set(["nav_items"]);

/** Every `FROM <table>` referenced in a slice (lowercased set), minus the
 *  `media` anchor, JSON set-returning functions, and helper-only JSON-seam tables. */
function fromTables(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(/\bFROM\s+([a-z_][a-z0-9_]*)/gi)) {
    const t = m[1].toLowerCase();
    if (t === "media" || SRF_IGNORE.has(t) || JSON_SEAM_ONLY_TABLES.has(t)) continue;
    out.add(t);
  }
  return out;
}

function eqSet(a: Set<string>, b: Set<string>): { ok: boolean; onlyA: string[]; onlyB: string[] } {
  const onlyA = [...a].filter((x) => !b.has(x));
  const onlyB = [...b].filter((x) => !a.has(x));
  return { ok: onlyA.length === 0 && onlyB.length === 0, onlyA, onlyB };
}

function main() {
  // The orphan anti-join is split across two functions — a cheap, index-backed
  // candidate prune (orphanCandidateWhere, the *_media_id FROM-tables) + the
  // expensive body/JSON matchers (orphanBodyWhere, the matcher-helper calls).
  // Concatenate both bodies so the FROM-table set AND the matcher-delegation
  // checks below see the whole predicate, exactly as the old single function did.
  const orphanWhereBody = `${fnBody("orphanCandidateWhere")}\n${fnBody("orphanBodyWhere")}`;
  const orphan = fromTables(orphanWhereBody);
  const referenced = fromTables(fnBody("listReferencedMediaIds"));
  const count = fromTables(fnBody("countMediaReferences"));
  const body = fromTables(fnBody("bodyRefMatch"));

  console.log(`orphan sources: ${[...orphan].sort().join(", ")}`);
  console.log(`body sources:   ${[...body].sort().join(", ")}`);

  check("bodyRefMatch is non-empty (inline rich-HTML columns are covered)", body.size > 0);
  check("orphan anti-join covers the *_media_id sources", orphan.size >= 10);

  // orphan and listReferencedMediaIds both call bodyRefMatch(), so their inline-body
  // coverage is identical by construction; the *_media_id FROM-tables must match.
  {
    const r = eqSet(orphan, referenced);
    check(
      `orphanMediaWhere ⇔ listReferencedMediaIds cover the same *_media_id tables${r.ok ? "" : ` (orphan-only: ${r.onlyA}; referenced-only: ${r.onlyB})`}`,
      r.ok,
    );
  }

  // countMediaReferences inlines BOTH the *_media_id sources AND the body columns,
  // so its FROM-table set must equal (orphan ∪ body).
  {
    const expected = new Set([...orphan, ...body]);
    const r = eqSet(expected, count);
    check(
      `countMediaReferences ⇔ (orphan ∪ body) tables${r.ok ? "" : ` (missing in count: ${r.onlyA}; extra in count: ${r.onlyB})`}`,
      r.ok,
    );
  }

  // Spot-check that the known reference tables are present (a coarse net so an
  // accidental wholesale deletion is caught even if all three drift together).
  const mustHave = [
    "product_media", "products", "product_variants", "brands", "categories",
    "banners", "pages", "hero_sections", "cta_sections",
    "blog_posts", "authors", "site_settings",
  ];
  const missing = mustHave.filter((t) => !orphan.has(t));
  check(`all known *_media_id source tables present in the anti-join${missing.length ? ` (missing: ${missing})` : ""}`, missing.length === 0);

  const bodyMustHave = [
    "blog_posts", "products",
    "categories", "brands", "text_sections",
  ];
  const bodyMissing = bodyMustHave.filter((t) => !body.has(t));
  check(`all rich-HTML body tables present in bodyRefMatch${bodyMissing.length ? ` (missing: ${bodyMissing})` : ""}`, bodyMissing.length === 0);

  // The JSON-BLOB media seams (home.blocks / pages.blocks / landing-trust / value-prop icons)
  // ride on tables (site_settings / pages / categories / brands) that are ALREADY
  // in the FROM-table sets for *_media_id columns — so the table-set comparison above CANNOT
  // catch one of these matchers being dropped from a single function (a silent data-loss
  // reopen). Assert each seam's marker appears in ALL THREE bodies so that drift also fails CI.
  // orphanMediaWhere + listReferencedMediaIds DELEGATE to the matcher helper (the call name);
  // countMediaReferences INLINES the SQL (a distinctive inline marker).
  const orphanBody = orphanWhereBody;
  const refBody = fnBody("listReferencedMediaIds");
  const countBody = fnBody("countMediaReferences");
  const JSON_SEAMS = [
    { name: "home.blocks", call: "homeBlocksMediaMatch()", countMarker: "key = 'home.blocks'" },
    { name: "pages.blocks", call: "pageBlocksMediaMatch()", countMarker: "blocks LIKE" },
    { name: "landing-trust icons", call: "landingTrustIconMatch()", countMarker: "LANDING_TRUST_KEYS_SQL" },
    { name: "value-prop icons", call: "valuePropIconMatch()", countMarker: "value_props" },
    { name: "nav_items.config (mega-menu)", call: "navItemsConfigMediaMatch()", countMarker: "FROM nav_items" },
  ];
  for (const s of JSON_SEAMS) {
    check(`${s.name}: present in orphanMediaWhere`, orphanBody.includes(s.call));
    check(`${s.name}: present in listReferencedMediaIds`, refBody.includes(s.call));
    check(`${s.name}: present in countMediaReferences`, countBody.includes(s.countMarker));
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
