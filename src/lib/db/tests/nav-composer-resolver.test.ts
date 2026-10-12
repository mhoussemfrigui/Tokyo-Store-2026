import "server-only";

/**
 * Nav composer RESOLVER (getComposedNavRoots) — the storefront header's sole nav
 * source. Guards the defects the re-analysis caught:
 *   - the menu is read by its uuid id, not its KEY (the key→uuid-column query
 *     threw and silently fell back to the hardcoded defaults → every admin edit
 *     was invisible);
 *   - a MATERIALIZED-but-all-hidden menu renders an EMPTY header (operator's
 *     choice), NOT the defaults;
 *   - hide-when-empty parity, incl. a products block that resolves to ZERO.
 *
 * Uses a throwaway menu key (getComposedNavRoots takes an optional key) so it
 * never touches the real `main` menu. Self-cleaning (zztest-navresolver prefix).
 * Run (isolated DB):
 *   pnpm exec tsx --conditions=react-server --env-file=.env.development.local \
 *     src/lib/db/tests/nav-composer-resolver.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { nav_menus, nav_items } from "@/modules/cms/navigation/schema";
import { getComposedNavRoots, type NavCatInput } from "@/lib/api/nav-composer";
import { serializeNavConfig } from "@/lib/cms/nav-composer-model";

const TAG = "zztest-navresolver";
const KEY = `${TAG}-menu`;
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

async function cleanup() {
  await db.execute(sql`DELETE FROM nav_items WHERE menu_id IN (SELECT id FROM nav_menus WHERE key = ${KEY})`);
  await db.execute(sql`DELETE FROM nav_menus WHERE key = ${KEY}`);
}

// The default universe slugs, each given a child so a `taxonomy` block resolves
// at least one section (keeps the universe from being hide-when-empty dropped).
const UNIVERSE_SLUGS = [
  "univers-apple", "telephonie", "console-gaming", "pc-gaming",
  "audiovisuel", "univers-tokyo-store", "objets-connectes", "cartes-cadeaux-et-abonnements",
];
const DEPS = {
  categories: [{ slug: "montres", name: "Montres" }] as NavCatInput[],
  // One active brand so a dynamic brands root survives hide-when-empty.
  brands: [{ slug: "rolex", name: "Rolex" }],
  taxonomyTree: UNIVERSE_SLUGS.map((s) => ({ slug: s, name: s, children: [{ slug: `${s}-sub`, name: "Sub" }] })),
};

async function main() {
  await cleanup();

  // Seed a throwaway menu with ONE visible root that has a categories dropdown
  // and ONE root whose only block is a products source that resolves to nothing.
  const [menu] = await db.insert(nav_menus).values({ key: KEY, name: "Test" } as never).returning({ id: nav_menus.id });

  const catConfig = serializeNavConfig({ mobileVisible: true, columns: [{ blocks: [{ type: "categories" }] }] });
  // Manual pins pointing at a non-existent product id → zero products resolve.
  const emptyProductsConfig = serializeNavConfig({
    mobileVisible: true,
    columns: [{ blocks: [{ type: "products", source: "pins", pins: ["00000000-0000-0000-0000-000000000000"], count: 4 }] }],
  });

  const [catRoot] = await db
    .insert(nav_items)
    .values({ menu_id: menu.id, label: "Boutique", href: "/boutique", display_order: 0, is_visible: true, config: catConfig } as never)
    .returning({ id: nav_items.id });
  await db
    .insert(nav_items)
    .values({ menu_id: menu.id, label: "Promos", href: "/promos", display_order: 1, is_visible: true, config: emptyProductsConfig } as never);

  console.log("materialized read (menu resolved by uuid id, not key):");
  const roots = await getComposedNavRoots(DEPS, KEY);
  check("returns the materialized roots (NOT the hardcoded defaults)", roots.some((r) => r.key === catRoot.id));
  check("root keys are the nav_item uuids (proves the id-resolution path)", roots.every((r) => /^[0-9a-f-]{36}$/.test(r.key)));
  const boutique = roots.find((r) => r.key === catRoot.id);
  check("the categories dropdown resolved its live category", !!boutique && boutique.columns.flatMap((c) => c.blocks).some((b) => b.type === "categories" && b.items.length === 1));

  console.log("hide-when-empty parity:");
  check("a products-only root that resolves to ZERO products is dropped", !roots.some((r) => r.label === "Promos"));

  console.log("materialized-but-all-hidden → EMPTY (not defaults):");
  await db.execute(sql`UPDATE nav_items SET is_visible = false WHERE menu_id = ${menu.id}::uuid`);
  const hidden = await getComposedNavRoots(DEPS, KEY);
  check("all roots hidden → empty header (resolver does NOT fall back to defaults)", hidden.length === 0);

  console.log("un-materialized key → defaults fallback:");
  const fresh = await getComposedNavRoots(DEPS, `${TAG}-absent`);
  // The defaults = 8 universes (mega) + 6 shortcuts + 3 service. Shortcuts/service
  // are plain links (kind=null) so they are never liveness-pruned; universes
  // depend on their category being live, so assert the slot shape (robust) + that
  // every root carries a default-slug key (not a DB uuid).
  check(
    "a missing menu falls back to the DEFAULT roots (non-uuid keys, slotted)",
    fresh.length >= 9 &&
      fresh.every((r) => !/^[0-9a-f-]{36}$/.test(r.key)) &&
      fresh.filter((r) => r.slot === "shortcut").length === 6 &&
      fresh.filter((r) => r.slot === "service").length === 3,
  );

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
