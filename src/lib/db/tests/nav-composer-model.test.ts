/**
 * Nav composer MODEL (pure, no DB): the tolerant parse of a root's dropdown
 * `config` (columns + blocks), the legacy-shape upgrade, the serialize round-trip
 * (value-level), the média-id extraction, and the default roots' validity. Guards
 * the single contract the admin builder (edit), the storefront resolver (read)
 * and the boot seed all share.
 *
 * Run: pnpm exec tsx src/lib/db/tests/nav-composer-model.test.ts
 */
import {
  parseNavDropdown,
  parseNavRootConfig,
  serializeNavConfig,
  navDropdownMediaIds,
  dropdownBlocks,
  chunkColumns,
  taxonomySections,
  NAV_BLOCK_TYPES,
  MAX_NAV_COLUMNS,
  type NavDropdown,
} from "@/lib/cms/nav-composer-model";
import { defaultNavRoots } from "@/lib/cms/nav-defaults";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function main() {
  console.log("parse — empties:");
  check("null/empty/garbage → null", parseNavDropdown(null) === null && parseNavDropdown("") === null && parseNavDropdown("{bad json") === null);
  check("a dropdown with no columns → null", parseNavDropdown({ columns: [], mobileVisible: true }) === null);
  check("columns with only empty blocks → null", parseNavDropdown({ columns: [{ blocks: [] }], mobileVisible: true }) === null);

  console.log("parse — columns + blocks:");
  const full: NavDropdown = {
    mobileVisible: false,
    columns: [
      {
        blocks: [
          { type: "categories", limit: 8, maxPerColumn: 6 },
          { type: "brands", display: "logos", limit: 20 },
        ],
      },
      {
        blocks: [
          { type: "products", source: "best_sellers", count: 4 },
          { type: "products", source: "pins", pins: ["a", "b"], count: 2 },
          { type: "links", links: [{ label: "CGV", href: "/cgv" }, { label: "Rolex", kind: "brand", ref: "rolex" }] },
        ],
      },
      { blocks: [{ type: "image", mediaId: "m1", mediaMobileId: "m2", eyebrow: "E", title: "T", href: "/x", showOnMobile: false }] },
    ],
  };
  const parsed = parseNavDropdown({ dropdown: full });
  check("accepts { dropdown: {...} } wrapper", parsed !== null);
  check("mobileVisible kept + 3 columns", parsed?.mobileVisible === false && parsed?.columns.length === 3);
  check("accepts a bare dropdown object too", parseNavDropdown(full)?.columns.length === 3);

  const blocks = dropdownBlocks(parsed);
  check("all 6 valid blocks kept across columns", blocks.length === 6);
  const cats = blocks[0];
  check("categories limit + maxPerColumn parsed", cats.type === "categories" && cats.limit === 8 && cats.maxPerColumn === 6);
  const br = blocks[1];
  check("brands display/limit parsed", br.type === "brands" && br.display === "logos" && br.limit === 20);
  const p1 = blocks[2];
  const p2 = blocks[3];
  check("products pins kept only for source=pins", p1.type === "products" && p1.pins === undefined && p2.type === "products" && (p2.pins?.length ?? 0) === 2);
  const lnk = blocks[4];
  check("links with a label+target kept (both forms)", lnk.type === "links" && lnk.links.length === 2);
  const img = blocks[5];
  check("image média + copy parsed", img.type === "image" && img.mediaId === "m1" && img.mediaMobileId === "m2" && img.showOnMobile === false);

  console.log("block size scale (products / brands / image):");
  const sized = parseNavDropdown({
    mobileVisible: true,
    columns: [
      {
        blocks: [
          { type: "products", source: "new_arrivals", count: 3, size: "lg" },
          { type: "brands", display: "logos", size: "sm" },
          { type: "image", mediaId: "m9", size: "sm" },
        ],
      },
    ],
  });
  const sb = dropdownBlocks(sized);
  check("products size parsed", sb[0]?.type === "products" && (sb[0] as { size?: string }).size === "lg");
  check("brands size parsed", sb[1]?.type === "brands" && (sb[1] as { size?: string }).size === "sm");
  check("image size parsed", sb[2]?.type === "image" && (sb[2] as { size?: string }).size === "sm");
  // Unset / junk size → the documented default (md), never dropped.
  const defSize = dropdownBlocks(
    parseNavDropdown({ mobileVisible: true, columns: [{ blocks: [{ type: "products", source: "new_arrivals", size: "huge" }] }] }),
  );
  check("junk size → default md", defSize[0]?.type === "products" && (defSize[0] as { size?: string }).size === "md");

  console.log("column cap + tolerant drops:");
  const manyCols = parseNavDropdown({
    mobileVisible: true,
    columns: Array.from({ length: 9 }, () => ({ blocks: [{ type: "categories" }] })),
  });
  check("columns capped at MAX_NAV_COLUMNS", manyCols?.columns.length === MAX_NAV_COLUMNS);
  const dirty = parseNavDropdown({
    columns: [
      {
        blocks: [
          { type: "nope" }, // unknown → dropped
          { type: "links", links: [{ label: "", href: "/x" }, { label: "No target" }] }, // both invalid → block dropped
          { type: "brands", display: "fuchsia" }, // bad display → falls back to titles
          { type: "categories" },
        ],
      },
      { blocks: [{ type: "garbage" }] }, // whole column empties out → dropped
    ],
  });
  check("unknown block + empty links dropped; empty column dropped", dropdownBlocks(dirty).length === 2 && dirty?.columns.length === 1);
  check("bad brand display falls back to titles", dropdownBlocks(dirty)[0].type === "brands" && dropdownBlocks(dirty)[0].type === "brands" && (dropdownBlocks(dirty)[0] as { display: string }).display === "titles");

  console.log("legacy-shape upgrade ({ columns:number, blocks }):");
  const legacy = parseNavDropdown({
    columns: 2,
    mobileVisible: true,
    blocks: [
      { type: "categories" },
      { type: "image", mediaId: "legacy-img" },
    ],
  });
  check("legacy upgrades to columns[]", Array.isArray(legacy?.columns) && (legacy?.columns.length ?? 0) === 2);
  check("legacy: content → col 1, image → its own col", legacy?.columns[0].blocks[0].type === "categories" && legacy?.columns[1].blocks[0].type === "image");
  const legacyImagesOnly = parseNavDropdown({
    columns: 1,
    mobileVisible: true,
    blocks: [{ type: "image", mediaId: "a" }, { type: "image", mediaId: "b" }],
  });
  check("legacy with ONLY images → one column PER image, no content column", legacyImagesOnly?.columns.length === 2 && legacyImagesOnly.columns.every((c) => c.blocks[0].type === "image"));
  check("legacy with zero valid blocks → null", parseNavDropdown({ columns: 3, mobileVisible: true, blocks: [{ type: "nope" }] }) === null);

  console.log("image = sole-image column (render contract; heals mixed/2-image columns):");
  const mixed = parseNavDropdown({
    mobileVisible: true,
    columns: [
      { blocks: [{ type: "categories" }, { type: "image", mediaId: "i1" }, { type: "brands", display: "titles" }] },
      { blocks: [{ type: "image", mediaId: "i2" }, { type: "image", mediaId: "i3" }] },
    ],
  });
  // col1 (cat+image+brands) → [cat,brands] + [i1]; col2 (i2,i3) → [i2] + [i3] = 4 columns.
  check("a column mixing content + image splits (content kept together, image its own col)", mixed?.columns.length === 4);
  check("…content of a mixed column stays grouped (categories+brands in one col)", mixed?.columns[0].blocks.length === 2 && mixed.columns[0].blocks.every((b) => b.type !== "image"));
  check("…and each image becomes a sole-image column", mixed?.columns[1].blocks.length === 1 && mixed.columns[1].blocks[0].type === "image" && mixed.columns[2].blocks[0].type === "image" && mixed.columns[3].blocks[0].type === "image");
  check("SEPARATE content columns are NOT merged", parseNavDropdown({ mobileVisible: true, columns: [{ blocks: [{ type: "categories" }] }, { blocks: [{ type: "brands", display: "titles" }] }] })?.columns.length === 2);
  check("a media-less image block is dropped (no phantom empty column)", parseNavDropdown({ mobileVisible: true, columns: [{ blocks: [{ type: "image" }] }] }) === null);
  check("image showOnMobile defaults to FALSE when the field is absent", (() => {
    const b = dropdownBlocks(parseNavDropdown({ mobileVisible: true, columns: [{ blocks: [{ type: "image", mediaId: "x" }] }] }))[0];
    return b.type === "image" && b.showOnMobile === false;
  })());

  console.log("image aspect (format selector):");
  const asp = dropdownBlocks(parseNavDropdown({ mobileVisible: true, columns: [{ blocks: [{ type: "image", mediaId: "x", aspect: "longer" }] }] }))[0];
  check("a valid aspect parses + round-trips", asp.type === "image" && asp.aspect === "longer");
  const aspBad = dropdownBlocks(parseNavDropdown({ mobileVisible: true, columns: [{ blocks: [{ type: "image", mediaId: "x", aspect: "huge" }] }] }))[0];
  check("an invalid/absent aspect falls back to portrait", aspBad.type === "image" && aspBad.aspect === "portrait");

  console.log("optInt limit/maxPerColumn edges:");
  const zeroLimit = dropdownBlocks(parseNavDropdown({ mobileVisible: true, columns: [{ blocks: [{ type: "categories", limit: 0, maxPerColumn: -3 }] }] }))[0];
  check("limit:0 / negative maxPerColumn read as UNSET (not clamped up to 1)", zeroLimit.type === "categories" && zeroLimit.limit === undefined && zeroLimit.maxPerColumn === undefined);
  const hugeLimit = dropdownBlocks(parseNavDropdown({ mobileVisible: true, columns: [{ blocks: [{ type: "categories", limit: 999 }] }] }))[0];
  check("limit above the max clamps down", hugeLimit.type === "categories" && hugeLimit.limit === 24);

  console.log("chunkColumns (maxPerColumn wrap):");
  check("no size → single sub-column", chunkColumns([1, 2, 3]).length === 1);
  check("fits within size → single sub-column", chunkColumns([1, 2, 3], 5).length === 1);
  check("column-major wrap: 5 items / 2 → [[1,2],[3,4],[5]]", JSON.stringify(chunkColumns([1, 2, 3, 4, 5], 2)) === JSON.stringify([[1, 2], [3, 4], [5]]));
  check("size < 1 → single sub-column", chunkColumns([1, 2, 3], 0).length === 1);

  console.log("serialize round-trip (value-level):");
  const reparsed = parseNavDropdown(JSON.parse(JSON.stringify(serializeNavConfig(parsed))) as Record<string, unknown>);
  const rb = dropdownBlocks(reparsed);
  check("round-trip preserves block count + column count", rb.length === 6 && reparsed?.columns.length === 3);
  check(
    "round-trip preserves field VALUES (not just counts)",
    (() => {
      const c = rb[0];
      const i = rb[5];
      return (
        c.type === "categories" && c.limit === 8 && c.maxPerColumn === 6 &&
        reparsed?.mobileVisible === false &&
        i.type === "image" && i.mediaId === "m1" && i.mediaMobileId === "m2" && i.eyebrow === "E" && i.showOnMobile === false
      );
    })(),
  );
  check("serializeNavConfig(null) → { dropdown: null }", serializeNavConfig(null).dropdown === null);

  console.log("products count null-guard:");
  const nullCount = parseNavDropdown({ columns: [{ blocks: [{ type: "products", source: "new_arrivals", count: null }] }], mobileVisible: true });
  const pc = dropdownBlocks(nullCount)[0];
  check("count:null → the documented default 4 (not 1)", pc.type === "products" && pc.count === 4);

  console.log("média ids:");
  check("navDropdownMediaIds finds both image ids across columns", navDropdownMediaIds(parsed).sort().join() === "m1,m2");
  check("no images → []", navDropdownMediaIds(parseNavDropdown({ columns: [{ blocks: [{ type: "categories" }] }], mobileVisible: true })).length === 0);

  console.log("defaults:");
  const roots = defaultNavRoots({ label: (_k, f) => f });
  const megas = roots.filter((r) => r.slot === "mega");
  const shortcuts = roots.filter((r) => r.slot === "shortcut");
  const service = roots.filter((r) => r.slot === "service");
  check("8 universe (mega) roots", megas.length === 8);
  check("6 shortcut roots", shortcuts.length === 6);
  check("3 service roots", service.length === 3);
  check(
    "every universe is a category link with a taxonomy + products dropdown",
    megas.every(
      (r) =>
        r.kind === "category" &&
        r.ref === r.slug &&
        dropdownBlocks(r.dropdown).some((x) => x.type === "taxonomy") &&
        dropdownBlocks(r.dropdown).some((x) => x.type === "products"),
    ),
  );
  check("every universe carries a blurb", megas.every((r) => !!r.blurb));
  check("shortcuts + service are plain links (no dropdown)", [...shortcuts, ...service].every((r) => r.dropdown === null));
  check("exactly one accent shortcut (Bons plans)", shortcuts.filter((r) => r.accent).length === 1);
  check("all block types are enumerable", NAV_BLOCK_TYPES.length === 6);

  console.log("root config extras — serialize/parse round-trip:");
  check(
    "serialize omits default slot + blank extras",
    JSON.stringify(serializeNavConfig(null, { slot: "mega" })) === JSON.stringify({ dropdown: null }),
  );
  const cfg = parseNavRootConfig(serializeNavConfig(null, { slot: "shortcut", accent: true, blurb: "x" }));
  check("parse reads slot/accent/blurb back", cfg.slot === "shortcut" && cfg.accent === true && cfg.blurb === "x");
  check("legacy bare dropdown → mega slot", parseNavRootConfig({ columns: [{ blocks: [{ type: "categories" }] }], mobileVisible: true }).slot === "mega");

  console.log("taxonomy sections:");
  const secs = taxonomySections({
    slug: "u",
    name: "U",
    children: [
      { slug: "a", name: "A", children: [{ slug: "a1", name: "A1" }] },
      { slug: "leaf", name: "Leaf" },
    ],
  });
  check("titled section from a child-with-grandchildren", secs[0]?.title === "A" && secs[0]?.href === "/a" && secs[0]?.items[0]?.href === "/a1");
  check("trailing untitled leaf section", secs[1]?.title === undefined && secs[1]?.href === null && secs[1]?.items[0]?.href === "/leaf");

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
