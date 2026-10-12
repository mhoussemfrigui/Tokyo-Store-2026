/**
 * Page block-composer MODEL — pure unit tests for parsePageBlocks / serializePageBlocks /
 * parsePageBlockConfig (src/lib/pages/page-blocks.ts), the CMS Pages block builder. Guards
 * the validation seam the save action + the storefront reader rely on.
 *
 * Pure (no DB). Run:
 *   tsx --conditions=react-server src/lib/db/tests/page-blocks-model.test.ts
 */
import {
  parsePageBlocks,
  serializePageBlocks,
  parsePageBlockConfig,
  PAGE_BLOCK_TYPES,
  PAGE_BLOCK_LAYOUTS,
  MAX_HTML,
  realHref,
  coerceAnchor,
  isGoogleMapsEmbedUrl,
  yearsSinceLabel,
  mapUrlsFor,
  telHref,
  whatsappHref,
  normalizeFragment,
  cleanHref,
} from "@/lib/pages/page-blocks";
import { valuePropIcon, VALUE_PROP_ICON_MAP } from "@/lib/catalog/value-prop-icons";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const UUID = "01a0df76-2940-740f-9cf0-656be9f352f8";
const UUID2 = "01a0df76-2957-79d6-aea7-e2309b2cab3b";

// ── parsePageBlocks ────────────────────────────────────────────────────────────
check("null / malformed / non-array → []", parsePageBlocks(null).length === 0 && parsePageBlocks("{bad").length === 0 && parsePageBlocks('{"a":1}').length === 0);
check("unknown types dropped", parsePageBlocks(JSON.stringify([{ type: "nope", config: {} }, { type: "hero", config: {} }])).length === 1);
check("caps at 40", parsePageBlocks(JSON.stringify(Array.from({ length: 60 }, () => ({ type: "rich_text", config: {} })))).length === 40);
{
  const bs = parsePageBlocks(JSON.stringify([{ id: "d", type: "hero", config: {} }, { id: "d", type: "faq", config: {} }]));
  check("duplicate ids regenerated", bs.length === 2 && new Set(bs.map((b) => b.id)).size === 2);
}

// ── per-type config ────────────────────────────────────────────────────────────
{
  const c = parsePageBlockConfig("hero", { header: { title: "T", ctaHref: "javascript:x", ctaLabel: "go" }, image: { mediaId: UUID }, secondaryCtaHref: "javascript:y", secondaryCtaLabel: "s" });
  // An unsafe link is neutralised to "" (no link at all) — never a dead `href="#"` button.
  check("hero: image kept, primary + secondary CTA sanitised to no-link", c.image?.mediaId === UUID && c.header!.ctaHref === "" && c.secondaryCtaHref === "");
}
{
  const long = "<p>" + "a".repeat(MAX_HTML + 5000) + "</p>";
  const c = parsePageBlockConfig("rich_text", { body: long, alignment: "bogus" });
  check("rich_text: HTML body capped at MAX_HTML, alignment default", c.body!.length === MAX_HTML && c.alignment === "left");
}
{
  const c = parsePageBlockConfig("stats", { stats: [{ label: "a", value: "1" }, { label: "", value: "" }, ...Array.from({ length: 12 }, () => ({ label: "x", value: "y" }))], layout: "row" });
  check("stats: empty dropped + sliced to 8, layout kept", (c.stats ?? []).length === 8 && c.layout === "row");
}
{
  const c = parsePageBlockConfig("timeline", { timeline: [{ year: "1950", title: "F" }, { year: "", title: "" }] });
  check("timeline: empty dropped", (c.timeline ?? []).length === 1);
}
{
  const c = parsePageBlockConfig("gallery", { images: [{ mediaId: UUID }, { mediaId: "bad" }, { mediaId: UUID2 }] });
  check("gallery: bad media dropped, valid kept", (c.images ?? []).length === 2);
}
{
  const c = parsePageBlockConfig("editorial", { imageSide: "left", body: "x", image: { mediaId: UUID } });
  check("editorial: imageSide + body + image", c.imageSide === "left" && c.body === "x" && c.image?.mediaId === UUID);
}
{
  const c = parsePageBlockConfig("cta_band", { style: "brand" });
  check("cta_band: style enum", c.style === "brand");
  check("cta_band: bad style → dark", parsePageBlockConfig("cta_band", { style: "zzz" }).style === "dark");
}
{
  const c = parsePageBlockConfig("product_grid", { source: { mode: "manual", productIds: [UUID, "not-uuid", UUID] }, count: 999 });
  check("product_grid: manual ids UUID-gated + deduped, count clamped", c.source!.productIds.length === 1 && c.source!.productIds[0] === UUID && c.count === 24);
}
{
  const c = parsePageBlockConfig("product_grid", { presentation: { background: "bogus", width: "full", divider: false } });
  check("presentation coerced", c.presentation!.background === "default" && c.presentation!.width === "full" && c.presentation!.divider === false);
}

// ── layouts (2026-10-01): default = previous look, valid kept, bogus → default ──
for (const [type, opts] of Object.entries(PAGE_BLOCK_LAYOUTS)) {
  const t = type as (typeof PAGE_BLOCK_TYPES)[number];
  const def = parsePageBlockConfig(t, {}).layout;
  const last = opts![opts!.length - 1].v;
  check(`${t}: absent layout → default « ${opts![0].v} »`, def === opts![0].v);
  check(`${t}: valid layout kept (${last})`, parsePageBlockConfig(t, { layout: last }).layout === last);
  check(`${t}: bogus layout → default`, parsePageBlockConfig(t, { layout: "zzz" }).layout === opts![0].v);
}
{
  const c = parsePageBlockConfig("hero", {
    layout: "statement",
    accent: "est un souvenir.",
    watermark: "1950-and-much-more",
    chips: [{ label: "A", href: "#heritage" }, { label: "", href: "/x" }, "plain", { label: "B", href: "javascript:alert(1)" }],
    imageFit: "nope",
  });
  check("hero: accent kept, watermark capped at 12", c.accent === "est un souvenir." && c.watermark!.length === 12);
  check(
    "hero: chips — empty dropped, string accepted, unsafe href → no link",
    c.chips!.length === 3 && c.chips![0].href === "#heritage" && c.chips![1].label === "plain" && c.chips![2].href === "",
  );
  check("hero: bogus imageFit → auto", c.imageFit === "auto");
}
check("anchor coerced to a slug", parsePageBlockConfig("faq", { anchor: " Après-Vente SAV! " }).anchor === "apres-vente-sav");
check("blank anchor omitted", parsePageBlockConfig("faq", { anchor: "  " }).anchor === undefined);
check(
  "presentation: absent divider → OFF (no hairline under seeded blocks)",
  parsePageBlockConfig("faq", { presentation: { background: "surface" } }).presentation!.divider === false,
);
check("presentation: explicit divider true kept", parsePageBlockConfig("faq", { presentation: { divider: true } }).presentation!.divider === true);
{
  const c = parsePageBlockConfig("stats", {
    stats: [
      { source: "years_since", since: "19x50", label: "ans" },
      { source: "brands", label: "maisons" },
      { source: "bogus", label: "x", value: "1" },
    ],
  });
  const st = c.stats!;
  check("stats: live sources kept (value-less)", st.length === 3 && st[0].source === "years_since" && st[1].source === "brands");
  check("stats: since keeps digits only", st[0].since === "1950");
  check("stats: bogus source → manual", st[2].source === "manual");
}
{
  const c = parsePageBlockConfig("steps", { accent: "étape par étape", steps: [{ title: "A", meta: "x".repeat(90) }] });
  check("steps: accent kept + meta capped", c.accent === "étape par étape" && c.steps![0].meta.length === 60);
}
{
  const c = parsePageBlockConfig("trust", {
    layout: "tiles",
    cards: Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, ctaHref: i === 0 ? "/suivi" : "" })),
  });
  check("trust: up to 8 cards, unset CTA → '' (not '#')", c.cards!.length === 8 && c.cards![0].ctaHref === "/suivi" && c.cards![1].ctaHref === "");
}
{
  const c = parsePageBlockConfig("quote", { body: "q".repeat(900), attribution: "La maison", image: { mediaId: UUID } });
  check("quote: body capped at 600, attribution + image kept", c.body!.length === 600 && c.attribution === "La maison" && c.image?.mediaId === UUID);
}
{
  const c = parsePageBlockConfig("stores", {
    stores: [
      {
        name: "Showroom",
        address: "Route Taniour",
        mapEmbedUrl: "https://evil.example/maps?output=embed",
        pickupLocationId: "not-a-uuid",
        hours: [{ label: "Lun", value: "9h" }, { label: "", value: "" }],
        services: ["a", "", "b"],
        image: { mediaId: UUID },
      },
      { name: "", address: "" },
      { name: "Linked", pickupLocationId: UUID2, mapEmbedUrl: "https://www.google.com/maps/embed?pb=abc" },
    ],
  });
  const st = c.stores!;
  check("stores: empty store dropped", st.length === 2);
  check("stores: non-Google map url rejected", st[0].mapEmbedUrl === "");
  check("stores: Google embed url kept", st[1].mapEmbedUrl.startsWith("https://www.google.com/maps/embed"));
  check("stores: pickup id UUID-gated", st[0].pickupLocationId === "" && st[1].pickupLocationId === UUID2);
  check(
    "stores: empty hours/services dropped, image kept",
    st[0].hours.length === 1 && st[0].services.length === 2 && st[0].image?.mediaId === UUID,
  );
  check("stores: showMap defaults on, layout atlas", c.showMap === true && c.layout === "atlas");
  const em = parsePageBlockConfig("stores", { stores: [{ name: "A", email: "boutique@tokyo.tn" }, { name: "B", email: "pas-un-email" }] }).stores!;
  check("stores: valid email kept, non-email blanked", em[0].email === "boutique@tokyo.tn" && em[1].email === "");
}
{
  const c = parsePageBlockConfig("jobs", {
    applyEmail: "not an email",
    jobs: [{ title: "Technicien", active: false }, { title: "" }, { title: "Conseiller" }],
  });
  check("jobs: invalid apply e-mail → '' (falls back to the site e-mail)", c.applyEmail === "");
  check(
    "jobs: untitled dropped, active defaults true, explicit false kept",
    c.jobs!.length === 2 && c.jobs![0].active === false && c.jobs![1].active === true,
  );
  check("jobs: valid apply e-mail kept", parsePageBlockConfig("jobs", { applyEmail: "rh@tokyo.tn" }).applyEmail === "rh@tokyo.tn");
  // Per-job application link (external posting / form / mailto) — a URL wins over the block e-mail.
  const jl = parsePageBlockConfig("jobs", { jobs: [{ title: "Technicien", applyHref: "https://jobs.example/technicien" }] });
  check("jobs: per-job applyHref kept", jl.jobs![0].applyHref === "https://jobs.example/technicien");
  check("jobs: applyHref defaults to '' when unset", parsePageBlockConfig("jobs", { jobs: [{ title: "X" }] }).jobs![0].applyHref === "");
}
{
  const def = parsePageBlockConfig("contact_channels", {}).channels!;
  check("contact_channels: never-configured → all 5 channels enabled", def.length === 5 && def.every((ch) => ch.enabled));
  const c = parsePageBlockConfig("contact_channels", {
    channels: [{ key: "email", enabled: false }, { key: "email" }, { key: "fax" }, { key: "stores", href: "javascript:x" }],
  }).channels!;
  check("contact_channels: duplicate + unknown keys dropped, order kept", c.length === 2 && c[0].key === "email" && c[1].key === "stores");
  check("contact_channels: disabled kept, unsafe href → ''", c[0].enabled === false && c[1].href === "");
}

// ── pure render helpers ───────────────────────────────────────────────────────
check("realHref: blank / '#' → ''", realHref("") === "" && realHref("#") === "" && realHref(" /x ") === "/x" && realHref(null) === "");
check("coerceAnchor: accents + symbols", coerceAnchor("Étapes & SAV") === "etapes-sav");
check(
  "isGoogleMapsEmbedUrl",
  isGoogleMapsEmbedUrl("https://maps.google.com/maps?q=Sfax&output=embed") &&
    !isGoogleMapsEmbedUrl("http://www.google.com/maps/embed?pb=1") &&
    !isGoogleMapsEmbedUrl("https://www.google.com/search?q=x"),
);
check(
  "yearsSinceLabel",
  yearsSinceLabel("1950", new Date("2026-10-01")) === "76 ans" &&
    yearsSinceLabel("", new Date()) === null &&
    yearsSinceLabel("3000", new Date("2026-01-01")) === null,
);
{
  const m = mapUrlsFor("Route Taniour km 3", "Sfax");
  check(
    "mapUrlsFor: embed passes the guard + directions url",
    Boolean(m && isGoogleMapsEmbedUrl(m.embed) && m.directions.startsWith("https://www.google.com/maps/dir/?api=1&destination=")),
  );
  check("mapUrlsFor: empty → null", mapUrlsFor(" ", "") === null);
}
check(
  "telHref / whatsappHref",
  telHref("+216 54 666 006") === "tel:+21654666006" &&
    telHref("12") === "" &&
    whatsappHref("+216 54 666 006") === "https://wa.me/21654666006" &&
    whatsappHref("") === "",
);


// ── review fixes (2026-10-01) ─────────────────────────────────────────────────
{
  const bs = parsePageBlocks(JSON.stringify([
    { type: "faq", config: { anchor: "sav" } },
    { type: "faq", config: { anchor: "SAV" } },
    { type: "faq", config: { anchor: "garantie" } },
  ]));
  check("duplicate anchors: only the first block keeps the id", bs[0].config.anchor === "sav" && bs[1].config.anchor === undefined && bs[2].config.anchor === "garantie");
  // Dedup is over VISIBLE blocks only: a HIDDEN block must not reserve/steal an anchor from a
  // later visible block (the hidden one emits no id, so the visible #link would resolve to nothing).
  const vis = parsePageBlocks(JSON.stringify([
    { type: "faq", visible: false, config: { anchor: "sav" } },
    { type: "faq", visible: true, config: { anchor: "sav" } },
  ]));
  check("anchor dedup ignores hidden blocks → the visible block keeps the anchor", vis[0].config.anchor === "sav" && vis[1].config.anchor === "sav");
}
check("normalizeFragment: internal #fragment slugged like anchors", normalizeFragment("#Après-Vente") === "#apres-vente" && normalizeFragment("/service-client#SAV") === "/service-client#sav");
check("normalizeFragment: bare # dropped, external untouched", normalizeFragment("#") === "" && normalizeFragment("https://x.tn/a#B") === "https://x.tn/a#B");
check("cleanHref: blank / '#' → ''", cleanHref("") === "" && cleanHref("#") === "" && cleanHref("/a") === "/a");
check("header CTA #fragment normalised at parse", parsePageBlockConfig("steps", { header: { ctaLabel: "x", ctaHref: "#Contact" } }).header!.ctaHref === "#contact");
check("chip #fragment normalised at parse", parsePageBlockConfig("hero", { chips: [{ label: "a", href: "#Héritage" }] }).chips![0].href === "#heritage");
check("valuePropIcon: prototype keys fall back (no crash)", valuePropIcon("constructor") === valuePropIcon("Sparkles") && valuePropIcon("__proto__") === valuePropIcon("") && valuePropIcon("Wrench") === VALUE_PROP_ICON_MAP.Wrench);
{
  const j = parsePageBlockConfig("jobs", {});
  check("jobs: spontaneous panel on by default, copy blank (→ defaults)", j.spontaneousEnabled === true && j.spontaneousTitle === "" && j.spontaneousCtaLabel === "");
  check("jobs: spontaneous panel can be switched off", parsePageBlockConfig("jobs", { spontaneousEnabled: false }).spontaneousEnabled === false);
  check("contact_channels: showMeta defaults on", parsePageBlockConfig("contact_channels", {}).showMeta === true);
}

// ── round-trip ──────────────────────────────────────────────────────────────────
{
  const src = JSON.stringify([
    { id: "a", type: "hero", visible: true, config: { header: { title: "Hi" }, image: { mediaId: UUID, alt: "" } } },
    { id: "b", type: "rich_text", visible: false, config: { body: "<p>x</p>" } },
    { id: "c", type: "stats", visible: true, config: { stats: [{ label: "L", value: "V", caption: "" }] } },
    { id: "d", type: "stores", visible: true, config: { layout: "salons", stores: [{ name: "S", hours: [{ label: "L", value: "9h" }] }] } },
    { id: "e", type: "jobs", visible: true, config: { jobs: [{ title: "J", team: "Atelier" }] } },
    { id: "f", type: "contact_channels", visible: true, config: { layout: "strip", channels: [{ key: "phone" }] } },
    { id: "g", type: "quote", visible: true, config: { body: "Q", attribution: "A" } },
  ]);
  const once = parsePageBlocks(src);
  const twice = parsePageBlocks(serializePageBlocks(once));
  check("serialize→parse idempotent", serializePageBlocks(once) === serializePageBlocks(twice));
}
check("every catalog type parses without throwing", PAGE_BLOCK_TYPES.every((t) => {
  try { parsePageBlockConfig(t, {}); return true; } catch { return false; }
}));

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
