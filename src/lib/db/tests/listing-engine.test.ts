/**
 * PURE unit test for the storefront listing engine helpers (@/lib/listing/*):
 * in-grid banner cadence + rotation, listing display pricing (cheapest variant,
 * compare-at normalisation, display-precision comparisons, card deal strength)
 * and the filter-panel facet availability. No DB, no server-only — runs in the
 * `test:pure` chain.
 *
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/listing-engine.test.ts
 *
 * WHY (gap-storefront-listing-engine-01/02/05/08/14/15):
 *   - banners: the block-number rotation `due[(blk-1) % due.length]` never showed
 *     the first of two equal-cadence banners (live: « Livraison offerte dès 250
 *     TND » never rendered); pagination mode never reached a banner slot;
 *   - price: the slider compared exact millimes while the label + card show the
 *     rounded price (« 179 TND » vanished at « Jusqu'à 179 TND »);
 *   - facets: promo / rating / out-of-stock / empty sub-categories / unassigned
 *     attribute values were always offered and could only produce an empty grid;
 *   - compare-at: the card struck a « was » price ≤ the price; /promotions tested
 *     the PARENT row while the card shows the cheapest variant.
 */
import {
  bannerBlockAfter,
  gridBannerSchedule,
  isBannerDueAtBlock,
} from "@/lib/listing/banner-rotation";
import {
  cardDealFraction,
  cheapestVariant,
  hasVisibleCompareAt,
  listingDisplayPricing,
  normalizeCompareAt,
  toDisplayMinor,
} from "@/lib/listing/display-pricing";
import {
  availabilityOf,
  belowMinPrice,
  deriveFacetAvailability,
  exceedsMaxPrice,
  filterAttributeValues,
  isPromoProduct,
  pruneSubcategoryTree,
  subcategoryFilterKey,
  type FacetProduct,
} from "@/lib/listing/facet-availability";

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

type GridPos = "top" | "after_load_more" | "after_rows";
type B = { name: string; afterLoadMoreCount: number; gridPosition: GridPos };
const banner = (name: string, n: number, gridPosition: GridPos = "after_rows"): B => ({
  name,
  afterLoadMoreCount: n,
  gridPosition,
});
const names = (s: (B | null)[]) => s.map((b) => b?.name ?? "-").join(",");
// Position-agnostic cadence check (the legacy `after_rows` rule).
const due = (n: number, block: number) =>
  isBannerDueAtBlock({ afterLoadMoreCount: n, gridPosition: "after_rows" }, block);

function bannerTests() {
  console.log("banner cadence:");
  check("N=2 due at block 2 / 4, not 1 / 3", due(2, 2) && due(2, 4) && !due(2, 1) && !due(2, 3));
  check("N=1 due every block", [1, 2, 3, 7].every((b) => due(1, b)));
  check("N=0 / negative / NaN treated as 1", due(0, 5) && due(-3, 2) && due(Number.NaN, 3));
  check("block 0 is never a boundary", !due(1, 0));

  console.log("banner grid position:");
  check(
    "top banners never schedule (pinned above the grid)",
    !isBannerDueAtBlock(banner("t", 2, "top"), 2) && !isBannerDueAtBlock(banner("t", 1, "top"), 1),
  );
  check(
    "after_load_more is due ONLY at block 1 (ignores its N)",
    isBannerDueAtBlock(banner("a", 9, "after_load_more"), 1) &&
      !isBannerDueAtBlock(banner("a", 9, "after_load_more"), 2) &&
      !isBannerDueAtBlock(banner("a", 1, "after_load_more"), 3),
  );
  check(
    "a top banner is excluded from the schedule entirely",
    names(gridBannerSchedule([banner("top", 2, "top"), banner("b1", 2)], 4)) === "-,b1,-,b1",
  );
  check(
    "an after_load_more banner shows once at block 1",
    names(gridBannerSchedule([banner("alm", 9, "after_load_more")], 4)) === "alm,-,-,-",
  );

  console.log("banner rotation:");
  const [b1, b2, b3] = [banner("b1", 2), banner("b2", 2), banner("b3", 2)];
  // The live bug: two between-row banners at the default N=2 — the block-number
  // index `(blk-1) % 2` is always 1 at even blocks, so b1 NEVER showed.
  check("two at N=2 alternate b1,b2,b1,b2", names(gridBannerSchedule([b1, b2], 8)) === "-,b1,-,b2,-,b1,-,b2");
  check("three at N=2 cycle b1,b2,b3,b1", names(gridBannerSchedule([b1, b2, b3], 8)) === "-,b1,-,b2,-,b3,-,b1");
  // A plain running slot counter (`due[slot % due.length]`) still starves b1
  // here (odd blocks always pick c1, even blocks only reach indices 1/3).
  const mixed = gridBannerSchedule([b1, b2, banner("c1", 1), banner("c2", 1)], 16);
  check(
    "mixed cadences (N=2,2 + N=1,1) reach every banner",
    ["b1", "b2", "c1", "c2"].every((n) => mixed.some((b) => b?.name === n)),
  );
  const counts = new Map<string, number>();
  for (const b of mixed) if (b) counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
  check("mixed cadences share the slots evenly (4 each over 16 blocks)", [...counts.values()].every((c) => c === 4));
  check("N=3 alone only fills every third block", names(gridBannerSchedule([banner("x", 3)], 6)) === "-,-,x,-,-,x");
  check("no banners → every slot empty", gridBannerSchedule([], 4).every((b) => b === null));
  check("zero / negative block count → empty schedule", gridBannerSchedule([b1], 0).length === 0 && gridBannerSchedule([b1], -2).length === 0);

  console.log("banner slot positions (absolute index):");
  // load-more: 24 visible → slot after card 12 (block 1), none after the LAST visible card.
  check("load-more: slot after the 12th card", bannerBlockAfter(11, 12, 23) === 1);
  check("load-more: no slot after the last visible card", bannerBlockAfter(23, 12, 23) === null);
  check("load-more: no slot mid-block", bannerBlockAfter(5, 12, 23) === null);
  // pagination (30 items, page 2 = abs 12..23): the page's last card closes block 2.
  check("pagination: page 2 ends on block 2", bannerBlockAfter(12 + 11, 12, 29) === 2);
  check("pagination: page 1 ends on block 1", bannerBlockAfter(11, 12, 29) === 1);
  check("pagination: final (partial) page has no trailing slot", bannerBlockAfter(29, 12, 29) === null);
  check("pagination: a FULL final page has no trailing slot", bannerBlockAfter(23, 12, 23) === null);

  console.log("banner schedule × slot composition (the real category-client pairing):");
  // 50 products, PAGE_SIZE 12 → 4 full blocks. One after_rows N=2 banner is due at blocks
  // 2 & 4. Compose bannerBlockAfter (which card closes a block) with the schedule (which
  // block carries a banner) exactly as the listing grid does: a banner lands after the
  // 24th (idx 23 → block 2) and 48th (idx 47 → block 4) cards, never after the last card.
  {
    const PAGE = 12;
    const total = 50;
    const lastIndex = total - 1;
    const sched = gridBannerSchedule([banner("promo", 2)], Math.floor(total / PAGE));
    const hits: number[] = [];
    for (let i = 0; i < total; i++) {
      const blk = bannerBlockAfter(i, PAGE, lastIndex);
      if (blk != null && sched[blk - 1]) hits.push(i);
    }
    check("after_rows N=2: banner slots after the 24th + 48th cards only", hits.join(",") === "23,47");
  }
  {
    // A single `top` banner never enters the schedule, so NO between-row slot is filled —
    // the client pins it above the grid instead.
    const sched = gridBannerSchedule([banner("pinned", 2, "top")], 4);
    check("a lone 'top' banner fills no schedule slot", sched.every((b) => b === null));
  }
}

function pricingTests() {
  console.log("display precision:");
  check("179,100 @0dp → 179 TND", toDisplayMinor(179_100, 0) === 179_000);
  check("179,500 @0dp → 180 TND (half up, like toLocaleString)", toDisplayMinor(179_500, 0) === 180_000);
  check("459,500 @0dp → 460 TND", toDisplayMinor(459_500, 0) === 460_000);
  check("179,100 @3dp unchanged", toDisplayMinor(179_100, 3) === 179_100);
  check("179,150 @1dp → 179,2", toDisplayMinor(179_150, 1) === 179_200);
  check("decimals clamped to [0, 3]", toDisplayMinor(179_123, 7) === 179_123 && toDisplayMinor(179_600, -1) === 180_000);
  check("NaN decimals → 0dp", toDisplayMinor(179_600, Number.NaN) === 180_000);

  console.log("compare-at visibility + normalisation:");
  check("old > price at 3dp → struck", hasVisibleCompareAt({ priceCents: 179_900, oldPriceCents: 180_200 }, 3));
  check("same rounded value at 0dp (180 vs 180) → not struck", !hasVisibleCompareAt({ priceCents: 179_900, oldPriceCents: 180_200 }, 0));
  check("old == price → not struck", !hasVisibleCompareAt({ priceCents: 150_000, oldPriceCents: 150_000 }, 3));
  check("old < price (stale after a price increase) → not struck", !hasVisibleCompareAt({ priceCents: 179_000, oldPriceCents: 150_000 }, 0));
  check("no compare-at → not struck", !hasVisibleCompareAt({ priceCents: 1_000 }, 0) && !hasVisibleCompareAt({ priceCents: 1_000, oldPriceCents: null }, 0));
  check("normalizeCompareAt keeps a real markdown", normalizeCompareAt(100_000, 150_000) === 150_000);
  check("normalizeCompareAt drops old ≤ price / null", normalizeCompareAt(100_000, 100_000) === null && normalizeCompareAt(100_000, 90_000) === null && normalizeCompareAt(100_000, null) === null);

  console.log("variable-product listing price (cheapest variant):");
  const variants = [
    { priceCents: 300_000, oldPriceCents: 400_000 },
    { priceCents: 200_000, oldPriceCents: null },
    { priceCents: 200_000, oldPriceCents: 999_000 }, // tie: the FIRST cheapest wins
  ];
  check("cheapestVariant = first minimum in display order", cheapestVariant(variants) === variants[1]);
  check("cheapestVariant([]) → null", cheapestVariant([]) === null);
  // Parent row carries a compare-at, but the CARD shows the cheapest variant,
  // which has none → not a compare-at markdown (the /promotions test used the
  // parent row and listed a product whose card shows no discount).
  const parentOnly = listingDisplayPricing({ price_cents: 250_000, old_price_cents: 500_000 }, variants);
  check("variable: price = cheapest variant", parentOnly.priceCents === 200_000);
  check("variable: parent compare-at ignored when the cheapest variant has none", parentOnly.oldPriceCents === null);
  const variantMarkdown = listingDisplayPricing({ price_cents: 250_000, old_price_cents: null }, [
    { priceCents: 120_000, oldPriceCents: 160_000 },
    { priceCents: 130_000 },
  ]);
  check("variable: the cheapest variant's markdown is the card's", variantMarkdown.priceCents === 120_000 && variantMarkdown.oldPriceCents === 160_000);
  const simple = listingDisplayPricing({ price_cents: 100_000, old_price_cents: 125_000 });
  check("simple / no variants: the row's own pair", simple.priceCents === 100_000 && simple.oldPriceCents === 125_000);
  check("simple: stale compare-at normalised away", listingDisplayPricing({ price_cents: 100_000, old_price_cents: 90_000 }, []).oldPriceCents === null);

  console.log("card deal strength (what −X% shows):");
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  check("compare-at only: 1 − 75/100", near(cardDealFraction({ priceCents: 75_000, oldPriceCents: 100_000 }), 0.25));
  check("engine only: 1 − 80/100 (reference = pre-promo price)", near(cardDealFraction({ priceCents: 100_000, oldPriceCents: null }, 80_000), 0.2));
  check("compare-at + engine: against the compare-at", near(cardDealFraction({ priceCents: 100_000, oldPriceCents: 200_000 }, 80_000), 0.6));
  check("nothing struck → 0", cardDealFraction({ priceCents: 100_000, oldPriceCents: null }) === 0);
  check("a promo that doesn't lower the price → 0", cardDealFraction({ priceCents: 100_000, oldPriceCents: null }, 100_000) === 0);
}

const P = (over: Partial<FacetProduct> & { slug: string }): FacetProduct => ({
  priceCents: 100_000,
  rating: 0,
  inStock: true,
  category: "montres",
  ...over,
});

function facetTests() {
  console.log("filter predicates:");
  const casio = P({ slug: "casio", priceCents: 179_100 });
  check("« 179 TND » card stays visible at « Jusqu'à 179 » (0dp)", !exceedsMaxPrice(casio, 179, 0));
  check("…but is excluded at 3dp (the label reads « 179,000 »)", exceedsMaxPrice(casio, 179, 3));
  check("459,500 reads « 460 » → excluded at « Jusqu'à 459 » (0dp)", exceedsMaxPrice(P({ slug: "x", priceCents: 459_500 }), 459, 0));
  check("« 179 TND » card stays visible at « De 179 » (0dp)", !belowMinPrice(casio, 179, 0));
  check("…but « 179 TND » is excluded at « De 180 »", belowMinPrice(casio, 180, 0));
  check("min===bounds.min (0) never excludes anything", !belowMinPrice(casio, 0, 0));
  check("a range keeps the mid, drops the ends (De 200 – à 500, 0dp)", !belowMinPrice(P({ slug: "m", priceCents: 300_000 }), 200, 0) && !exceedsMaxPrice(P({ slug: "m", priceCents: 300_000 }), 500, 0) && belowMinPrice(P({ slug: "lo", priceCents: 150_000 }), 200, 0) && exceedsMaxPrice(P({ slug: "hi", priceCents: 600_000 }), 500, 0));
  check("promo predicate = visible compare-at", isPromoProduct(P({ slug: "p", priceCents: 75_000, oldPriceCents: 100_000 }), 0) && !isPromoProduct(P({ slug: "q", priceCents: 179_900, oldPriceCents: 180_200 }), 0));
  check("availability value", availabilityOf(P({ slug: "a" })) === "En stock" && availabilityOf(P({ slug: "b", inStock: false })) === "Rupture de stock");
  check("tree key = sub-category, else the primary category", subcategoryFilterKey(P({ slug: "a", subcategory: "plongee" })) === "plongee" && subcategoryFilterKey(P({ slug: "b", subcategory: "" })) === "montres");

  console.log("facet availability:");
  type N = { slug: string; name: string; children?: N[] };
  const tree: N[] = [
    {
      slug: "homme",
      name: "Homme",
      children: [
        { slug: "plongee", name: "Plongée", children: [{ slug: "submariner", name: "Submariner" }] },
        { slug: "habillees", name: "Habillées" },
      ],
    },
    { slug: "bracelets", name: "Bracelets" },
    { slug: "femme", name: "Femme", children: [{ slug: "joaillerie", name: "Joaillerie" }] },
  ];
  const products = [
    P({ slug: "sub-1", category: "plongee", subcategory: "submariner" }),
    P({ slug: "femme-direct", category: "femme" }), // filed on the node itself (no sub)
    P({ slug: "promo", priceCents: 75_000, oldPriceCents: 100_000, category: "x", subcategory: "habillees" }),
  ];
  const valueIds = new Map<string, string[]>([["sub-1", ["v-acier"]], ["promo", ["v-or", "v-acier"]]]);
  const f = deriveFacetAvailability({ products, decimals: 0, subcategoryTree: tree, productValueIds: valueIds });
  check("promo offered when a product is on promotion", f.promo);
  check("rating hidden when no product is rated", !f.rating);
  check("all in stock → only « En stock » (a lone value; the panel hides it)", f.availability.join("|") === "En stock");
  const slugs = (ns: N[]): string => ns.map((n) => `${n.slug}${n.children && n.children.length ? `(${slugs(n.children)})` : ""}`).join(",");
  check("empty « Bracelets » + « Joaillerie » pruned, deep + direct-filed nodes kept", slugs(f.subcategoryTree) === "homme(plongee(submariner),habillees),femme");
  check("value ids = those carried by a product", [...f.valueIds].sort().join(",") === "v-acier,v-or");

  const none = deriveFacetAvailability({
    products: [P({ slug: "a", priceCents: 179_900, oldPriceCents: 180_200, rating: 4.5, inStock: false }), P({ slug: "b" })],
    decimals: 0,
    subcategoryTree: [],
    productValueIds: new Map(),
  });
  check("a compare-at invisible at display precision offers no promo facet", !none.promo);
  check("rating offered once a product is rated", none.rating);
  check("in + out of stock → both availability values", none.availability.join("|") === "En stock|Rupture de stock");
  check("empty tree stays empty", pruneSubcategoryTree([] as N[], products).length === 0);

  const attrs = [
    { id: "a1", kind: "multiselect", values: [{ id: "v-acier" }, { id: "v-titane" }] },
    { id: "a2", kind: "boolean", values: [{ id: "v-bool" }] },
    { id: "a3", kind: "number", values: [] as { id: string }[] },
  ];
  const kept = filterAttributeValues(attrs, new Set(["v-acier"]));
  check("unassigned attribute values dropped", kept[0].values.map((v) => v.id).join(",") === "v-acier");
  check("a boolean nobody carries loses its value (section hides)", kept[1].values.length === 0);
  check("number attributes pass through", kept[2] === attrs[2]);
}

function main() {
  bannerTests();
  pricingTests();
  facetTests();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
