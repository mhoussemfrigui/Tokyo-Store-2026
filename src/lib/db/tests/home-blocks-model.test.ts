/**
 * Home block-composer MODEL — pure unit tests for parseHomeBlocks /
 * serializeHomeBlocks / parseBlockConfig (src/lib/pages/home-blocks.ts), the flagship
 * of the CMS → Page d'accueil composer. Guards the validation seam the save action and
 * the storefront reader both rely on: a crafted/garbled payload can never persist bad
 * data, every field is coerced to a safe default, and serialize→parse round-trips.
 *
 * Pure (no DB). Run:
 *   tsx --conditions=react-server src/lib/db/tests/home-blocks-model.test.ts
 */
import {
  parseHomeBlocks,
  serializeHomeBlocks,
  parseBlockConfig,
  sourceListingHref,
  heading,
  homeSeam,
  planSeams,
  HOME_BLOCK_SEED,
  HOME_BLOCK_TYPES,
} from "@/lib/pages/home-blocks";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const UUID = "01a0df76-2940-740f-9cf0-656be9f352f8";
const UUID2 = "01a0df76-2957-79d6-aea7-e2309b2cab3b";

// ── parseHomeBlocks: the whole-array parser ────────────────────────────────────
check("null / undefined / empty → []", parseHomeBlocks(null).length === 0 && parseHomeBlocks(undefined).length === 0 && parseHomeBlocks("").length === 0);
check("malformed JSON → [] (never throws)", parseHomeBlocks("{not json").length === 0);
check("non-array JSON → []", parseHomeBlocks('{"a":1}').length === 0);
check(
  "unknown block types are dropped",
  parseHomeBlocks(JSON.stringify([{ type: "nope", config: {} }, { type: "hero", config: {} }])).length === 1,
);
{
  // duplicate/missing ids get regenerated to unique, stable ids
  const blocks = parseHomeBlocks(JSON.stringify([
    { id: "dup", type: "hero", config: {} },
    { id: "dup", type: "rich_text", config: {} },
    { type: "faq", config: {} },
  ]));
  const ids = new Set(blocks.map((b) => b.id));
  check("duplicate/missing ids → unique ids", blocks.length === 3 && ids.size === 3);
}
{
  // 40-block ceiling
  const many = Array.from({ length: 60 }, () => ({ type: "hero", config: {} }));
  check("caps the list at 40 blocks", parseHomeBlocks(JSON.stringify(many)).length === 40);
}
check(
  "visible defaults true; explicit false honoured",
  parseHomeBlocks(JSON.stringify([{ type: "hero", config: {} }]))[0].visible === true &&
    parseHomeBlocks(JSON.stringify([{ type: "hero", visible: false, config: {} }]))[0].visible === false,
);

// ── parseBlockConfig: per-type coercion ────────────────────────────────────────
{
  // product source: mode enum, count clamp, windowDays clamp, productIds UUID-gated
  const c = parseBlockConfig("product_rail", {
    source: { mode: "BOGUS", ref: "  x  ", productIds: [UUID, "not-a-uuid", "12345", UUID, UUID2], windowDays: 9999, promoStrategy: "nope" },
    count: 999,
  });
  check("bad source.mode → 'new'", c.source!.mode === "new");
  check("windowDays clamped to 1..365", c.source!.windowDays === 365);
  check("promoStrategy bad → 'both'", c.source!.promoStrategy === "both");
  check(
    "productIds: non-UUID tokens dropped, valid deduped",
    c.source!.productIds.length === 2 && c.source!.productIds.includes(UUID) && c.source!.productIds.includes(UUID2),
  );
  check("count clamped (rail max 24)", c.count === 24);
}
{
  // media coercion: a bad media id → null; a valid one kept
  check("image with bad mediaId → null", parseBlockConfig("banner", { image: { mediaId: "nope" } }).image === null);
  const good = parseBlockConfig("banner", { image: { mediaId: UUID, alt: "x" } });
  check("image with valid mediaId → kept", good.image?.mediaId === UUID && good.image?.alt === "x");
}
{
  // safeHref sanitises a javascript: CTA to empty
  const c = parseBlockConfig("rich_text", { header: { ctaHref: "javascript:alert(1)", ctaLabel: "x" } });
  check("javascript: ctaHref sanitised (→ '#', not executable)", c.header!.ctaHref === "#" && !c.header!.ctaHref.startsWith("javascript"));
}
{
  // text length cap
  const long = "a".repeat(5000);
  const c = parseBlockConfig("rich_text", { header: { title: long }, body: long });
  check("text fields capped at 2000 chars", c.header!.title.length === 2000 && (c.body ?? "").length === 2000);
}
{
  // home presentation: ONE page ground + canonical width; the operator's rhythm/align kept
  const c = parseBlockConfig("product_grid", { presentation: { background: "bogus", padding: "spacious", width: "full", align: "center", divider: false } });
  check("home presentation: one ground + canonical width, rhythm/align kept", c.presentation!.background === "default" && c.presentation!.padding === "spacious" && c.presentation!.width === "default" && c.presentation!.align === "center" && c.presentation!.divider === false);
  const t = parseBlockConfig("brands", { presentation: { background: "olive", padding: "none", width: "full", divider: true } });
  check("non-bleed-capable: full width + padding none are normalised away", t.presentation!.background === "default" && t.presentation!.width === "default" && t.presentation!.divider === false && t.presentation!.padding === "default");
  // Full-bleed capable blocks (banner / cta_band / banner_duo) keep width:"full"...
  const fb = parseBlockConfig("banner", { presentation: { padding: "none", width: "full", divider: true } });
  check("bleed-capable: width full kept, padding none kept, divider off", fb.presentation!.width === "full" && fb.presentation!.padding === "none" && fb.presentation!.divider === false);
  // ...but padding "none" only survives WITH full width (otherwise it is meaningless).
  const fb2 = parseBlockConfig("banner", { presentation: { padding: "none", width: "default" } });
  check("bleed-capable but not full: padding none → default", fb2.presentation!.width === "default" && fb2.presentation!.padding === "default");
  // A bogus width on a bleed-capable block falls back to default (not "wide").
  const fb3 = parseBlockConfig("cta_band", { presentation: { width: "wide" } });
  check("bleed-capable: non-full width (wide) → default", fb3.presentation!.width === "default");
}
{
  // separator (seam with the block above)
  check("separator absent → omitted", !("separator" in parseBlockConfig("faq", {})));
  check("separator 'join' / 'rule' kept", parseBlockConfig("faq", { separator: "join" }).separator === "join" && parseBlockConfig("faq", { separator: "rule" }).separator === "rule");
  check("separator 'auto' / bogus → omitted", !("separator" in parseBlockConfig("faq", { separator: "auto" })) && !("separator" in parseBlockConfig("faq", { separator: "x" })));
  check("hero never carries a separator", !("separator" in parseBlockConfig("hero", { separator: "join" })));
}
{
  // homeSeam matrix
  const plain = { type: "faq" as const, mediaLed: false };
  check("after the hero → space (even with join)", homeSeam({ type: "hero", mediaLed: false }, { mediaLed: false, separator: "join" }) === "space");
  check("join → join (even beside media)", homeSeam(plain, { mediaLed: true, separator: "join" }) === "join");
  check("rule beside media → rule", homeSeam({ type: "cta_band", mediaLed: true }, { mediaLed: false, separator: "rule" }) === "rule");
  check("auto with a media neighbour → space", homeSeam({ type: "cta_band", mediaLed: true }, { mediaLed: false }) === "space" && homeSeam(plain, { mediaLed: true }) === "space");
  check("auto plain/plain → rule", homeSeam(plain, { mediaLed: false }) === "rule");
}
{
  // planSeams over the RENDERED sequence
  const seq = [
    { type: "hero" as const, mediaLed: false, renders: true },
    { type: "product_rail" as const, mediaLed: false, renders: true },
    { type: "faq" as const, mediaLed: false, renders: false }, // empty block
    { type: "brands" as const, mediaLed: false, renders: true },
    { type: "cta_band" as const, mediaLed: true, renders: true },
    { type: "editorial" as const, mediaLed: false, renders: true },
    { type: "rich_text" as const, mediaLed: false, separator: "join" as const, renders: true },
  ];
  const s = planSeams(seq);
  check("first rendered block has no seam", s[0] === null);
  check("nothing under the hero", s[1] === "space");
  check("a non-rendering block is skipped (no double rule)", s[2] === null && s[3] === "rule");
  check("no rule around a photo banner", s[4] === "space" && s[5] === "space");
  check("join honoured", s[6] === "join");
  check("join directly under the hero is ignored", planSeams([{ type: "hero", mediaLed: false, renders: true }, { type: "faq", mediaLed: false, separator: "join", renders: true }])[1] === "space");
}
{
  // banner_duo optional slot links
  const d = parseBlockConfig("banner_duo", { bannerId: UUID, bannerHref: "javascript:alert(1)", bannerHref2: "/homme" });
  check("banner_duo: unsafe link neutralised, safe link kept", d.bannerHref === "#" && d.bannerHref2 === "/homme");
  check("banner_duo: blank links stay off the shape", !("bannerHref" in parseBlockConfig("banner_duo", { bannerHref: "  " })));
}
check("seeded titles exist for the blocks that used to hard-code one", HOME_BLOCK_SEED.brands !== undefined && HOME_BLOCK_SEED.faq !== undefined);
{
  // banner_duo keeps the two média-id slots
  const c = parseBlockConfig("banner_duo", { bannerId: UUID, bannerId2: UUID2 });
  check("banner_duo keeps bannerId/bannerId2", c.bannerId === UUID && c.bannerId2 === UUID2);
  // single banner no longer parses a bannerId (removed dead field)
  check("single banner drops bannerId", parseBlockConfig("banner", { bannerId: UUID }).bannerId === undefined);
}
{
  // cards / steps / faq slicing + empty-drop
  const cards = Array.from({ length: 10 }, (_, i) => ({ title: `c${i}` }));
  check("fifty_fifty cards sliced to 3", (parseBlockConfig("fifty_fifty", { cards }).cards ?? []).length === 3);
  check("trust cards sliced to 6", (parseBlockConfig("trust", { cards }).cards ?? []).length === 6);
  const faq = [{ question: "q", answer: "a" }, { question: "", answer: "" }, { question: "q2", answer: "" }];
  check("faq drops items missing question/answer", (parseBlockConfig("faq", { faq }).faq ?? []).length === 1);
}

{
  // accent — the gold-italic second title line (content-page title language)
  check("accent kept + capped at 160", parseBlockConfig("editorial", { accent: "x".repeat(400) }).accent?.length === 160);
  check("blank/absent accent → field omitted", !("accent" in parseBlockConfig("faq", { accent: "" })) && !("accent" in parseBlockConfig("faq", {})));
  check("hero / banner_duo never carry an accent", parseBlockConfig("hero", { accent: "a" }).accent === undefined && parseBlockConfig("banner_duo", { accent: "a" }).accent === undefined);
  check("non-string accent → omitted", parseBlockConfig("trust", { accent: 42 }).accent === undefined);
}

// ── sourceListingHref: a rail's « Voir tout » continuation ─────────────────────
{
  const none = new Set<string>();
  const src = (mode: string, ref = "") => ({ mode, ref, productIds: [], windowDays: 30, promoStrategy: "both" }) as never;
  check("new → /nouveautes", sourceListingHref(src("new"), none) === "/nouveautes");
  check("best_sellers → /top-ventes", sourceListingHref(src("best_sellers"), none) === "/top-ventes");
  check("on_promotion → /promotions", sourceListingHref(src("on_promotion"), none) === "/promotions");
  check("hidden showcase → '' (no link to a 404)", sourceListingHref(src("new"), new Set(["nouveautes"])) === "");
  check("category → /<slug> (encoded)", sourceListingHref(src("category", " homme "), none) === "/homme");
  check("brand → /<slug>", sourceListingHref(src("brand", "casio"), none) === "/casio");
  check("category without ref → ''", sourceListingHref(src("category", "  "), none) === "");
  check("manual pick → '' (no listing)", sourceListingHref(src("manual"), none) === "");
  check("undefined source → ''", sourceListingHref(undefined, none) === "");
}

// ── serialize → parse round-trip is idempotent ─────────────────────────────────
{
  const src = JSON.stringify([
    { id: "a", type: "hero", visible: true, config: {} },
    { id: "b", type: "product_rail", visible: false, config: { source: { mode: "category", ref: "homme", productIds: [], windowDays: 30, promoStrategy: "both" }, count: 8 } },
    { id: "c", type: "banner_duo", visible: true, config: { bannerId: UUID, bannerId2: UUID2 } },
  ]);
  const once = parseHomeBlocks(src);
  const twice = parseHomeBlocks(serializeHomeBlocks(once));
  check("serialize(parse(x)) → parse gives identical structure", serializeHomeBlocks(once) === serializeHomeBlocks(twice));
}

// ── round-trip the 2026-10 features (accent/accentStyle, separator, full-bleed, new blocks) ──
{
  const rich = JSON.stringify([
    { id: "e", type: "editorial", visible: true, config: { header: { title: "Deux\nLignes", eyebrow: "É" }, accentStyle: "ink", separator: "rule" } },
    { id: "b", type: "banner", visible: true, config: { image: { mediaId: UUID, alt: "a" }, presentation: { width: "full", padding: "none", align: "center" } } },
    { id: "t", type: "testimonials", visible: true, config: { testimonials: [{ quote: "q", author: "a", meta: "m", image: { mediaId: UUID2, alt: "" } }] } },
    { id: "s", type: "stats", visible: true, config: { stats: [{ value: "1950", label: "An" }] } },
    { id: "sp", type: "spacer", visible: true, config: { spacerHeight: "lg", spacerOrnament: "mark" } },
  ]);
  const once = parseHomeBlocks(rich);
  const twice = parseHomeBlocks(serializeHomeBlocks(once));
  check("round-trip: accentStyle/separator/full-bleed/testimonials/stats/spacer idempotent", serializeHomeBlocks(once) === serializeHomeBlocks(twice));
  const ed = once.find((x) => x.type === "editorial");
  check("round-trip: ink accentStyle from a 2-line title persists", ed?.config.accentStyle === "ink" && ed?.config.separator === "rule");
  const ban = once.find((x) => x.type === "banner");
  check("round-trip: full-bleed banner keeps width:full + padding:none", ban?.config.presentation?.width === "full" && ban?.config.presentation?.padding === "none");
}

check("every catalog type parses without throwing", HOME_BLOCK_TYPES.every((t) => {
  try { parseBlockConfig(t, {}); return true; } catch { return false; }
}));

// ── per-type count clamp + card/step/faq slice bounds ──────────────────────────
{
  check("categories/brands count clamps to 40", parseBlockConfig("categories", { count: 999 }).count === 40 && parseBlockConfig("brands", { count: 999 }).count === 40);
  check("product_grid count clamps 2..24", parseBlockConfig("product_grid", { count: 999 }).count === 24 && parseBlockConfig("product_grid", { count: 0 }).count === 2);
  const many = Array.from({ length: 12 }, (_, i) => ({ title: `c${i}` }));
  check("fifty_fifty cards slice to 3", (parseBlockConfig("fifty_fifty", { cards: many }).cards ?? []).length === 3);
  check("feature_cards cards slice to 4", (parseBlockConfig("feature_cards", { cards: many }).cards ?? []).length === 4);
  check("trust cards slice to 6", (parseBlockConfig("trust", { cards: many }).cards ?? []).length === 6);
  const steps = Array.from({ length: 12 }, (_, i) => ({ title: `s${i}`, body: "" }));
  check("steps slice to 8 + drop empty", (parseBlockConfig("steps", { steps: [...steps, { title: "", body: "" }] }).steps ?? []).length === 8);
  check("faq drops items missing question/answer", (parseBlockConfig("faq", { faq: [{ question: "q", answer: "a" }, { question: "x", answer: "" }, { question: "", answer: "y" }] }).faq ?? []).length === 1);
}

// ── new blocks: testimonials / stats / spacer ──────────────────────────────────
{
  const many = Array.from({ length: 10 }, (_, i) => ({ quote: `q${i}`, author: `a${i}`, meta: "", image: null }));
  check("testimonials slice to 6 + drop empty", (parseBlockConfig("testimonials", { testimonials: [...many, { quote: "", author: "", meta: "", image: null }] }).testimonials ?? []).length === 6);
  check("testimonial keeps an image-only entry", (parseBlockConfig("testimonials", { testimonials: [{ quote: "", author: "", meta: "", image: { mediaId: UUID, alt: "" } }] }).testimonials ?? []).length === 1);
  const stats = Array.from({ length: 8 }, (_, i) => ({ value: `${i}`, label: `l${i}` }));
  check("stats slice to 4 + drop empty", (parseBlockConfig("stats", { stats: [...stats, { value: "", label: "" }] }).stats ?? []).length === 4);
  const sp = parseBlockConfig("spacer", { spacerHeight: "xl", spacerOrnament: "mark" });
  check("spacer keeps height + ornament", sp.spacerHeight === "xl" && sp.spacerOrnament === "mark");
  const spd = parseBlockConfig("spacer", { spacerHeight: "nope", spacerOrnament: "nope" });
  check("spacer bad enums → defaults (md / none)", spd.spacerHeight === "md" && spd.spacerOrnament === "none");
}

// ── HOME_BLOCK_SEED — new blocks start with the title the renderer used to hardcode ─
{
  check("every seed key is a real block type", Object.keys(HOME_BLOCK_SEED).every((k) => (HOME_BLOCK_TYPES as readonly string[]).includes(k)));
  check("product_rail seed title", parseBlockConfig("product_rail", HOME_BLOCK_SEED.product_rail).header?.title === "Nouveautés");
  check("brands seed title", parseBlockConfig("brands", HOME_BLOCK_SEED.brands).header?.title === "Nos grandes marques");
  check("faq seed title", parseBlockConfig("faq", HOME_BLOCK_SEED.faq).header?.title === "Questions fréquentes");
}

// ── heading(): the two-tone title split (explicit accent vs implicit last line) ────
{
  check("explicit accent wins over the last line", JSON.stringify(heading("A\nB\nC", "Explicit")) === JSON.stringify({ text: "A B C", accent: "Explicit" }));
  check("multi-line title → last line is the accent", JSON.stringify(heading("A\nB\nC", "")) === JSON.stringify({ text: "A B", accent: "C" }));
  check("single-line title → no accent", JSON.stringify(heading("Solo", "")) === JSON.stringify({ text: "Solo", accent: "" }));
  check("empty → empty", JSON.stringify(heading("", "")) === JSON.stringify({ text: "", accent: "" }));
}

// ── accentStyle: gold default omitted, ink kept, only with an accent ────────────
{
  check("accentStyle default gold → omitted", !("accentStyle" in parseBlockConfig("editorial", { accent: "x", accentStyle: "gold" })));
  check("accentStyle ink kept (with an accent)", parseBlockConfig("editorial", { accent: "x", accentStyle: "ink" }).accentStyle === "ink");
  check("accentStyle dropped without an accent", !("accentStyle" in parseBlockConfig("editorial", { accentStyle: "ink" })));
  check("bogus accentStyle → omitted", !("accentStyle" in parseBlockConfig("editorial", { accent: "x", accentStyle: "neon" })));
  // The EFFECTIVE accent can come from a multi-line title (heading()): ink must survive even
  // with the explicit Accent field blank, else the composer preview disagrees with the page.
  check(
    "accentStyle ink kept when the accent is derived from a multi-line title",
    parseBlockConfig("editorial", { header: { title: "Ligne une\nLigne deux" }, accentStyle: "ink" }).accentStyle === "ink",
  );
  check(
    "accentStyle dropped for a single-line title with no explicit accent",
    !("accentStyle" in parseBlockConfig("editorial", { header: { title: "Une seule ligne" }, accentStyle: "ink" })),
  );
}

// ── planSeams: a leading non-rendering block is skipped (the first RENDERED block has
//    a null seam, never a hairline above it) ──────────────────────────────────────
{
  const s = planSeams([
    { type: "faq", mediaLed: false, renders: false },
    { type: "product_rail", mediaLed: false, renders: true },
    { type: "brands", mediaLed: false, renders: true },
  ]);
  check("leading non-render skipped → [null, null, 'rule']", s[0] === null && s[1] === null && s[2] === "rule");
}

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
