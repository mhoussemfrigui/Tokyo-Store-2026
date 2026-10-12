import "server-only";

/**
 * CMS admin invariants (A–Z audit 2026-09-23, phase 4 — CMS admin):
 *   - mega-menu featured panels (`nav_*`): `workflows.cms.setNavFeatured`
 *     validates (nav_* placement only, uuid image, safe link, non-blank title),
 *     upserts the singleton (a create seeds its name from the root label),
 *     writes + reports only REAL changes (an identical re-save emits nothing),
 *     clears eyebrow / link / image, leaves absent fields untouched and emits
 *     banner.created / banner.updated with the actor. A `nav_*` row saved
 *     through the generic updateBanner WITHOUT a placement (what the locked
 *     edit form posts) succeeds, while posting the placement still fails;
 *   - footer columns: heading = menu name (legacy "Footer — " prefix dropped,
 *     blank → built-in title); a rename emits nav.menu.updated and reaches
 *     listFooterColumns; a blank name is refused; a duplicate key create is a
 *     conflict (tolerated by the one-click « Créer les colonnes du footer »);
 *   - « Explorer la maison » index (`maison-explore`): missing menu → built-in
 *     defaults; the boot seed fills a NEW menu only (never refills an emptied
 *     one); item sub-title (nav_items.description) round-trips to the reader's
 *     hint, an update without it keeps it, null clears it; menu name /
 *     description drive the title / eyebrow; hidden links are dropped;
 *   - « Nettoyer › Navigation » keeps the system menus (main + footer-* +
 *     maison-explore), emptied, and deletes every other menu;
 *   - trust badges: `preorder` is refused as a NEW visibility (create, or an
 *     update of a non-preorder row) but a legacy preorder row still saves.
 * Self-restoring: the nav tables are snapshotted and put back verbatim, parked
 * nav_* banners are un-parked, `zztest-cmsadm` badges + the synthetic actor's
 * audit rows are dropped. Run against the isolated test DB:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/cms-admin.test.ts
 */
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus, type EventEnvelope } from "@/events/bus";
import { getMaisonExploreNav, listFooterColumns } from "@/lib/api/cms";
import { ensureSystemNavMenus } from "@/lib/bootstrap/system-nav-menus";
import {
  FOOTER_COLUMNS,
  MAISON_EXPLORE_DEFAULTS,
  MAISON_EXPLORE_MENU_KEY,
  SYSTEM_NAV_MENU_KEYS,
  footerColumnTitle,
} from "@/lib/cms/nav-menus";
import { emptyDataJobResult } from "@/modules/import";
import { bannerService } from "@/modules/cms/banner/service";
import { navigationService } from "@/modules/cms/navigation/service";
import {
  nav_items,
  nav_menus,
  type NavItemRow,
  type NavMenuRow,
} from "@/modules/cms/navigation/schema";
import { trustBadgeService } from "@/modules/cms/trust_badge/service";
import { cleanNavigation } from "@/workflows/data/segments";
import { workflows } from "@/workflows";

const TAG = "zztest-cmsadm";
const ACTOR = "__cmsadm-admin";
const PLACEMENT = "nav_maison";

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

type Row = Record<string, unknown>;
function rowsOf(res: unknown): Row[] {
  const r = res as { rows?: Row[] };
  return r.rows ?? (res as Row[]);
}

// ── restore state ────────────────────────────────────────────────────────────
let navSnapshot: { menus: NavMenuRow[]; items: NavItemRow[] } | null = null;
let parkedBannerIds: string[] = [];
const createdBannerIds: string[] = [];

async function restoreNav() {
  if (!navSnapshot) return;
  const { menus, items } = navSnapshot;
  await db.transaction(async (tx) => {
    await tx.delete(nav_items);
    await tx.delete(nav_menus);
    if (menus.length) await tx.insert(nav_menus).values(menus);
    // Parents before children (parent_id references a sibling item).
    const ordered = [...items.filter((i) => !i.parent_id), ...items.filter((i) => i.parent_id)];
    if (ordered.length) await tx.insert(nav_items).values(ordered);
  });
  navSnapshot = null;
}

async function cleanup() {
  await restoreNav();
  for (const id of createdBannerIds.splice(0)) {
    await db.execute(sql`delete from banners where id = ${id}`);
  }
  for (const id of parkedBannerIds.splice(0)) {
    await db.execute(sql`update banners set deleted_at = null where id = ${id}`);
  }
  await db.execute(sql`delete from trust_badges where label like ${`${TAG}%`}`);
  await db.execute(sql`delete from audit_log where actor_user_id = ${ACTOR}`);
}

async function main() {
  await cleanup();
  const ctx = { actorUserId: ACTOR };

  const bannerEvents: EventEnvelope[] = [];
  const onBanner = (env: EventEnvelope) => {
    if ((env.payload as { placement?: string }).placement === PLACEMENT) bannerEvents.push(env);
  };
  bus.on("banner.created", onBanner);
  bus.on("banner.updated", onBanner);
  const navEvents: EventEnvelope[] = [];
  bus.on("nav.menu.updated", (env) => {
    if (env.actorUserId === ACTOR) navEvents.push(env as EventEnvelope);
  });

  // ── 1. mega-menu featured panel (nav_* singleton) ─────────────────────────
  console.log("nav featured panel:");
  // Park the placement's existing rows so the create path runs; un-parked at the end.
  parkedBannerIds = rowsOf(
    await db.execute(
      sql`update banners set deleted_at = now()
          where placement = ${PLACEMENT} and deleted_at is null returning id`,
    ),
  ).map((r) => String(r.id));

  const bad = [
    await workflows.cms.setNavFeatured({ placement: "home_hero" as never, title: "x" }, ctx),
    await workflows.cms.setNavFeatured({ placement: "constructor" as never, title: "x" }, ctx),
  ];
  check("a non-nav placement is refused", bad.every((r) => !r.ok && r.error === "validation"));
  const xss = await workflows.cms.setNavFeatured(
    { placement: PLACEMENT, title: "x", ctaHref: "javascript:alert(1)" },
    ctx,
  );
  check("a javascript: link is refused on the link field", !xss.ok && Boolean(xss.fieldErrors?.ctaHref));
  const blank = await workflows.cms.setNavFeatured({ placement: PLACEMENT, title: "" }, ctx);
  check("a blank title is refused on the title field", !blank.ok && Boolean(blank.fieldErrors?.title));
  const badImg = await workflows.cms.setNavFeatured(
    { placement: PLACEMENT, imageMediaId: "not-a-uuid" },
    ctx,
  );
  check("a non-uuid image id is refused", !badImg.ok);
  check("refused saves emit nothing", bannerEvents.length === 0);

  const img1 = randomUUID();
  const created = await workflows.cms.setNavFeatured(
    {
      placement: PLACEMENT,
      imageMediaId: img1,
      eyebrow: "Depuis 1950",
      title: "Notre Maison",
      ctaHref: "/apropos",
    },
    ctx,
  );
  check("first save creates the singleton", created.ok === true);
  if (!created.ok) throw new Error(created.message);
  createdBannerIds.push(created.data.id);
  let row = await bannerService.findById(created.data.id);
  check("created on the nav placement", row?.placement === PLACEMENT);
  check("name seeded from the root label", row?.name === "Image vedette — Maison");
  check(
    "eyebrow / title / link / image persisted",
    row?.eyebrow === "Depuis 1950" &&
      row?.title === "Notre Maison" &&
      row?.cta_href === "/apropos" &&
      row?.image_media_id === img1,
  );
  check("created active", row?.is_active === true);
  check(
    "banner.created emitted once with the actor",
    bannerEvents.length === 1 &&
      bannerEvents[0].name === "banner.created" &&
      bannerEvents[0].actorUserId === ACTOR,
  );

  const same = await workflows.cms.setNavFeatured(
    {
      placement: PLACEMENT,
      imageMediaId: img1,
      eyebrow: "Depuis 1950",
      title: "Notre Maison",
      ctaHref: "/apropos",
    },
    ctx,
  );
  check("identical re-save ok on the same row", same.ok && same.data.id === created.data.id);
  check("identical re-save emits nothing", bannerEvents.length === 1);

  await workflows.cms.setNavFeatured({ placement: PLACEMENT, title: "La Maison Tokyo" }, ctx);
  row = await bannerService.findById(created.data.id);
  const upd = bannerEvents[1]?.payload as { changedFields?: string[] } | undefined;
  check("title-only change emits banner.updated", bannerEvents[1]?.name === "banner.updated");
  check(
    "changedFields lists only the title",
    JSON.stringify(upd?.changedFields) === JSON.stringify(["title"]),
  );
  check("absent fields left untouched", row?.eyebrow === "Depuis 1950" && row?.image_media_id === img1);

  await workflows.cms.setNavFeatured(
    { placement: PLACEMENT, eyebrow: "", ctaHref: "", imageMediaId: null },
    ctx,
  );
  row = await bannerService.findById(created.data.id);
  check(
    "blank eyebrow / link + null image clear the columns",
    row?.eyebrow === null && row?.cta_href === null && row?.image_media_id === null,
  );
  check("the clear is one update event", bannerEvents.length === 3);

  // The generic Bannières edit form now omits a locked placement → saves.
  const viaGeneric = await workflows.cms.updateBanner(
    { id: created.data.id, title: "Via Bannières" },
    ctx,
  );
  row = await bannerService.findById(created.data.id);
  check(
    "generic update without a placement saves a nav_* row",
    viaGeneric.ok && row?.title === "Via Bannières" && row?.placement === PLACEMENT,
  );
  const withPlacement = await workflows.cms.updateBanner(
    { id: created.data.id, placement: PLACEMENT as never, title: "x" },
    ctx,
  );
  check("…while posting the nav_* placement is still refused", !withPlacement.ok);

  // ── 2. footer columns ─────────────────────────────────────────────────────
  console.log("footer columns:");
  check("legacy « Footer — » prefix dropped", footerColumnTitle("Footer — Boutique", "Boutique") === "Boutique");
  check("hyphen variant dropped too", footerColumnTitle("footer - Aide", "Support") === "Aide");
  check("a custom name is kept", footerColumnTitle("Nos services", "Support") === "Nos services");
  check("blank name → built-in title", footerColumnTitle("  ", "Société") === "Société");
  check("a bare « Footer » is a name, not a prefix", footerColumnTitle("Footer", "X") === "Footer");
  check(
    "system keys = main + the three columns + the maison index",
    SYSTEM_NAV_MENU_KEYS.length === 5 &&
      SYSTEM_NAV_MENU_KEYS.includes("main") &&
      SYSTEM_NAV_MENU_KEYS.includes(MAISON_EXPLORE_MENU_KEY) &&
      FOOTER_COLUMNS.every((c) => SYSTEM_NAV_MENU_KEYS.includes(c.key)),
  );

  navSnapshot = {
    menus: await db.select().from(nav_menus),
    items: await db.select().from(nav_items),
  };
  // Start the support column from scratch (the snapshot puts it back).
  const prior = await navigationService.findMenuByKey("footer-support");
  if (prior) {
    await navigationService.deleteItemsByMenuIds([prior.id]);
    await navigationService.deleteMenusByIds([prior.id]);
  }
  const col = await workflows.cms.createNavMenu(
    { key: "footer-support", name: "Footer — Support" },
    ctx,
  );
  check("footer column created", col.ok === true);
  if (!col.ok) throw new Error(col.message);
  const dup = await workflows.cms.createNavMenu({ key: "footer-support", name: "Support" }, ctx);
  check("duplicate column key → conflict", !dup.ok && dup.error === "conflict");
  await workflows.cms.createNavItem(
    { menuId: col.data.id, label: `${TAG} contact`, href: "/aide" },
    ctx,
  );
  let cols = await listFooterColumns();
  check(
    "legacy-named column renders its built-in heading",
    cols.some((c) => c.title === "Support" && c.links.some((l) => l.label === `${TAG} contact`)),
  );
  const renamed = await workflows.cms.updateNavMenu({ id: col.data.id, name: "Aide & contact" }, ctx);
  check("rename ok", renamed.ok === true);
  check("rename emits nav.menu.updated with the actor", navEvents.length === 1);
  cols = await listFooterColumns();
  check("renamed heading reaches the storefront reader", cols.some((c) => c.title === "Aide & contact"));
  const blankName = await workflows.cms.updateNavMenu({ id: col.data.id, name: "" }, ctx);
  check("a blank column name is refused", !blankName.ok);

  // ── 2b. « Explorer la maison » index (maison-explore) ─────────────────────
  console.log("maison index:");
  const defaultHrefs = MAISON_EXPLORE_DEFAULTS.items.map((i) => i.href).join(",");
  const priorExplore = await navigationService.findMenuByKey(MAISON_EXPLORE_MENU_KEY);
  if (priorExplore) {
    await navigationService.deleteItemsByMenuIds([priorExplore.id]);
    await navigationService.deleteMenusByIds([priorExplore.id]);
  }
  let explore = await getMaisonExploreNav();
  check(
    "missing menu → built-in defaults (eyebrow, title, 8 links + hints)",
    explore.title === MAISON_EXPLORE_DEFAULTS.name &&
      explore.eyebrow === MAISON_EXPLORE_DEFAULTS.description &&
      explore.links.length === 8 &&
      explore.links.map((l) => l.href).join(",") === defaultHrefs &&
      explore.links.every((l) => Boolean(l.hint)),
  );
  await ensureSystemNavMenus();
  explore = await getMaisonExploreNav();
  check(
    "boot seed creates the menu with the default links, in order, with hints",
    explore.links.map((l) => l.href).join(",") === defaultHrefs &&
      explore.links[0]?.hint === MAISON_EXPLORE_DEFAULTS.items[0].hint,
  );
  const exploreMenu = await navigationService.findMenuByKey(MAISON_EXPLORE_MENU_KEY);
  check("boot seed sets the menu eyebrow", exploreMenu?.description === MAISON_EXPLORE_DEFAULTS.description);
  if (!exploreMenu) throw new Error("maison-explore menu missing after the boot seed");
  await ensureSystemNavMenus();
  check(
    "re-running the boot seed adds nothing",
    (await navigationService.listAllItemsForMenu(exploreMenu.id)).length === 8,
  );
  await navigationService.deleteItemsByMenuIds([exploreMenu.id]);
  await ensureSystemNavMenus();
  check(
    "the boot seed never refills a menu an admin emptied",
    (await getMaisonExploreNav()).links.length === 0,
  );
  const idx = await workflows.cms.createNavItem(
    { menuId: exploreMenu.id, label: `${TAG} idx`, href: "/cgv", description: "  Sous-titre  " },
    ctx,
  );
  check("item created with a sub-title", idx.ok === true);
  if (!idx.ok) throw new Error(idx.message);
  check(
    "the sub-title is stored trimmed",
    (await navigationService.findItemById(idx.data.id))?.description === "Sous-titre",
  );
  explore = await getMaisonExploreNav();
  check(
    "the sub-title reaches the reader as the hint",
    explore.links.length === 1 &&
      explore.links[0].label === `${TAG} idx` &&
      explore.links[0].hint === "Sous-titre" &&
      explore.links[0].href === "/cgv",
  );
  await workflows.cms.updateNavItem({ id: idx.data.id, label: `${TAG} idx 2` }, ctx);
  check(
    "an update without the field keeps the sub-title",
    (await navigationService.findItemById(idx.data.id))?.description === "Sous-titre",
  );
  const tooLong = await workflows.cms.updateNavItem({ id: idx.data.id, description: "x".repeat(161) }, ctx);
  check("a sub-title over 160 chars is refused", !tooLong.ok);
  await workflows.cms.updateNavItem({ id: idx.data.id, description: null }, ctx);
  check(
    "null clears the sub-title (no hint line)",
    (await navigationService.findItemById(idx.data.id))?.description === null &&
      (await getMaisonExploreNav()).links[0]?.hint === null,
  );
  await workflows.cms.updateNavMenu(
    { id: exploreMenu.id, name: "Index de la maison", description: "Repères" },
    ctx,
  );
  explore = await getMaisonExploreNav();
  check(
    "menu name / description drive the title / eyebrow",
    explore.title === "Index de la maison" && explore.eyebrow === "Repères",
  );
  await workflows.cms.updateNavItem({ id: idx.data.id, isVisible: false }, ctx);
  check("a hidden link is not rendered", (await getMaisonExploreNav()).links.length === 0);

  // ── 3. « Nettoyer › Navigation » keeps the system menus ────────────────────
  console.log("clean navigation:");
  const tbCustom = await workflows.cms.createNavMenu({ key: `${TAG}-tbCustom`, name: "Custom" }, ctx);
  if (tbCustom.ok) {
    await workflows.cms.createNavItem({ menuId: tbCustom.data.id, label: "x", href: "/x" }, ctx);
  }
  await cleanNavigation({ actorUserId: ACTOR, result: emptyDataJobResult() });
  const menusAfter = await db.select().from(nav_menus);
  const itemsAfter = await db.select().from(nav_items);
  check("system footer column kept", menusAfter.some((m) => m.key === "footer-support"));
  check("maison index menu kept", menusAfter.some((m) => m.key === MAISON_EXPLORE_MENU_KEY));
  check("non-system menu deleted", !menusAfter.some((m) => m.key === `${TAG}-tbCustom`));
  check("only system menus remain", menusAfter.every((m) => SYSTEM_NAV_MENU_KEYS.includes(m.key)));
  check("every nav item wiped", itemsAfter.length === 0);
  check("an emptied column renders nothing", (await listFooterColumns()).length === 0);
  await restoreNav();

  // ── 4. trust badges: CRUD + validation + events + ordering ────────────────
  console.log("trust badges:");
  const tbEvents: EventEnvelope[] = [];
  const pushTb = (env: EventEnvelope) => {
    if (env.actorUserId === ACTOR) tbEvents.push(env);
  };
  bus.on("cms.trust_badge.created", (env) => pushTb(env as EventEnvelope));
  bus.on("cms.trust_badge.updated", (env) => pushTb(env as EventEnvelope));
  bus.on("cms.trust_badge.deleted", (env) => pushTb(env as EventEnvelope));
  const tbOf = (name: string) => tbEvents.filter((e) => e.name === name);

  // Validation: retired preorder + unknown icon are refused; every live kind/
  // visibility the admin offers is accepted.
  const pre = await workflows.cms.createTrustBadge({ label: `${TAG} pre`, visibility: "preorder" as never }, ctx);
  check("create with retired `preorder` visibility is refused", !pre.ok && pre.error === "validation");
  const badIcon = await workflows.cms.createTrustBadge({ label: `${TAG} icon`, icon: "NotARealIcon" }, ctx);
  check("create with an unknown icon is refused", !badIcon.ok && Boolean(badIcon.ok === false && badIcon.fieldErrors?.icon));
  const badKind = await workflows.cms.createTrustBadge({ label: `${TAG} k`, kind: "bogus" as never }, ctx);
  check("create with an unknown kind is refused", !badKind.ok && badKind.error === "validation");
  for (const kind of ["security", "delivery", "returns", "warranty"] as const) {
    const r = await workflows.cms.createTrustBadge({ label: `${TAG} ${kind}`, kind, icon: "ShieldCheck" }, ctx);
    check(`create with kind=${kind} ok`, r.ok === true);
  }
  const tbBadge = await workflows.cms.createTrustBadge({ label: `${TAG} badge`, kind: null, icon: "MapPin" }, ctx);
  check("create custom badge (kind null) ok + emits created event with actor", tbBadge.ok && tbOf("cms.trust_badge.created").length >= 1 && tbOf("cms.trust_badge.created").every((e) => e.actorUserId === ACTOR));

  // nextDisplayOrder + listActive (active-only, ordered, stable tiebreaker).
  const base = await trustBadgeService.nextDisplayOrder();
  const a = await trustBadgeService.insert({ label: `${TAG} A`, icon: "Lock", display_order: base + 2 });
  const b = await trustBadgeService.insert({ label: `${TAG} B`, icon: "Lock", display_order: base + 1 });
  const inactive = await trustBadgeService.insert({ label: `${TAG} off`, icon: "Lock", is_active: false, display_order: base });
  check("nextDisplayOrder returns max+1", (await trustBadgeService.nextDisplayOrder()) === base + 3);
  const active = await trustBadgeService.listActive();
  const activeMine = active.filter((r) => r.label.startsWith(`${TAG}`)).map((r) => r.label);
  check("listActive excludes inactive rows", !active.some((r) => r.id === inactive.id));
  check(
    "listActive orders by display_order (B before A)",
    activeMine.indexOf(`${TAG} B`) >= 0 && activeMine.indexOf(`${TAG} B`) < activeMine.indexOf(`${TAG} A`),
  );
  // Tied display_order → stable asc(id) tiebreaker (deterministic across calls).
  const t1 = await trustBadgeService.insert({ label: `${TAG} tie1`, icon: "Lock", display_order: base + 9 });
  const t2 = await trustBadgeService.insert({ label: `${TAG} tie2`, icon: "Lock", display_order: base + 9 });
  const order1 = (await trustBadgeService.listActive()).filter((r) => r.id === t1.id || r.id === t2.id).map((r) => r.id);
  const order2 = (await trustBadgeService.listActive()).filter((r) => r.id === t1.id || r.id === t2.id).map((r) => r.id);
  const expectedTie = [t1.id, t2.id].sort();
  check("tied display_order breaks by asc(id), stable across calls", order1.join() === expectedTie.join() && order1.join() === order2.join());

  // Update: real id ok + event; unknown id not_found.
  check("update unknown id → not_found", !(await workflows.cms.updateTrustBadge({ id: "00000000-0000-4000-8000-000000000000", label: "x" }, ctx)).ok);
  if (tbBadge.ok) {
    const up = await workflows.cms.updateTrustBadge({ id: tbBadge.data.id, label: `${TAG} badge 2` }, ctx);
    check("update ok + emits updated event", up.ok && tbOf("cms.trust_badge.updated").length === 1);
  }

  // Delete: unknown id → not_found (no event); real id → ok + event carrying the label.
  const delMissing = await workflows.cms.deleteTrustBadge({ id: "00000000-0000-4000-8000-000000000001" }, ctx);
  check("delete unknown id → not_found, no event", !delMissing.ok && tbOf("cms.trust_badge.deleted").length === 0);
  if (tbBadge.ok) {
    const del = await workflows.cms.deleteTrustBadge({ id: tbBadge.data.id }, ctx);
    const delEvt = tbOf("cms.trust_badge.deleted")[0];
    check(
      "delete ok + emits deleted event with the label snapshot",
      del.ok && delEvt !== undefined && (delEvt.payload as { label?: string }).label === `${TAG} badge 2`,
    );
    check("…and the row is gone", (await trustBadgeService.findById(tbBadge.data.id)) === null);
  }

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
