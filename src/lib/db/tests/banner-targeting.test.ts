import "server-only";

/**
 * In-grid (category_grid) banner targeting + cadence (migration 0062).
 *
 * Verifies `bannerService.listGridBannersForListing(opts)`:
 *   - a `none` (global) banner shows on EVERY listing;
 *   - a `category` banner shows only when its slug is in `categorySlugs`
 *     (so a parent-targeted banner cascades to a sub-category page that
 *     passes [child, parent]);
 *   - a `brand` banner shows only for its brand slug;
 *   - a `filter` banner shows only when its value-id is in
 *     `filterAttributeIds`;
 *   - inactive / scheduled-out / soft-deleted banners never show.
 *
 * Plus the REAL cadence + rotation helper the storefront renderer uses
 * (@/lib/listing/banner-rotation): a banner with `after_load_more_count = N` is
 * due at block boundaries that are multiples of N (block 1-indexed), and when
 * several are due the rotation reaches EVERY one (the old block-number index
 * starved the first of two equal-cadence banners forever). And the
 * schedule-clear path of updateBannerWorkflow (a cleared datetime input → NULL,
 * an absent key → untouched).
 *
 * Self-cleaning (`zztest-bannertgt` name prefix).
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/banner-targeting.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { gridBannerSchedule, isBannerDueAtBlock as isDueAtBlock } from "@/lib/listing/banner-rotation";
import { bannerService } from "@/modules/cms/banner/service";
import { effectiveBannerButtons } from "@/lib/cms/banner-model";
import { workflows } from "@/workflows";

const TAG = "zztest-bannertgt";

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
  await db.execute(sql`delete from banners where name like ${TAG + "%"}`);
}

async function main() {
  await cleanup();

  const base = {
    placement: "category_grid" as const,
    title: "T",
    is_active: true,
  };

  const global = await bannerService.insert({ ...base, name: `${TAG}-global`, target_kind: "none" });
  const cat = await bannerService.insert({
    ...base,
    name: `${TAG}-cat`,
    target_kind: "category",
    target_ref: `${TAG}-consoles`,
  });
  const brand = await bannerService.insert({
    ...base,
    name: `${TAG}-brand`,
    target_kind: "brand",
    target_ref: `${TAG}-sony`,
  });
  const filt = await bannerService.insert({
    ...base,
    name: `${TAG}-filter`,
    target_kind: "filter",
    target_ref: `${TAG}-valueid`,
  });
  // Negative-control rows that must NEVER surface.
  const inactive = await bannerService.insert({
    ...base,
    name: `${TAG}-inactive`,
    is_active: false,
    target_kind: "none",
  });
  const future = await bannerService.insert({
    ...base,
    name: `${TAG}-future`,
    target_kind: "none",
    start_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
  });

  const ids = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));

  // ── category listing: global + its category, not brand/filter ─────────────
  const onConsoles = ids(
    await bannerService.listGridBannersForListing({ categorySlugs: [`${TAG}-consoles`] }),
  );
  check("global banner shows on a category listing", onConsoles.has(global.id));
  check("matching category banner shows", onConsoles.has(cat.id));
  check("non-matching brand banner hidden on category listing", !onConsoles.has(brand.id));
  check("non-matching filter banner hidden on category listing", !onConsoles.has(filt.id));
  check("inactive banner never shows", !onConsoles.has(inactive.id));
  check("future-scheduled banner not yet live", !onConsoles.has(future.id));

  // ── a different category: only the global one ─────────────────────────────
  const onOther = ids(
    await bannerService.listGridBannersForListing({ categorySlugs: [`${TAG}-other`] }),
  );
  check("category banner hidden on an unrelated category", !onOther.has(cat.id));
  check("global still shows on the unrelated category", onOther.has(global.id));

  // ── brand listing ─────────────────────────────────────────────────────────
  const onBrand = ids(await bannerService.listGridBannersForListing({ brandSlug: `${TAG}-sony` }));
  check("brand banner shows on its brand listing", onBrand.has(brand.id));
  check("global shows on a brand listing", onBrand.has(global.id));
  check("category banner hidden on a brand listing", !onBrand.has(cat.id));

  // ── filter targeting ───────────────────────────────────────────────────────
  const onFilter = ids(
    await bannerService.listGridBannersForListing({
      categorySlugs: [`${TAG}-other`],
      filterAttributeIds: [`${TAG}-valueid`],
    }),
  );
  check("filter banner shows when its value-id is present", onFilter.has(filt.id));
  const noFilter = ids(
    await bannerService.listGridBannersForListing({ categorySlugs: [`${TAG}-other`] }),
  );
  check("filter banner hidden when its value-id is absent", !noFilter.has(filt.id));

  // ── empty opts (showcase/global caller): only the global banner ───────────
  const globalOnly = ids(await bannerService.listGridBannersForListing({}));
  check("empty opts returns global banners", globalOnly.has(global.id));
  check("empty opts excludes category-targeted banners", !globalOnly.has(cat.id));

  // ── cadence rule (position-agnostic `after_rows` helper) ────────────────────
  const dueN = (n: number, block: number) =>
    isDueAtBlock({ afterLoadMoreCount: n, gridPosition: "after_rows" as const }, block);
  check("afterN=2 due at block 2", dueN(2, 2));
  check("afterN=2 not due at block 1", !dueN(2, 1));
  check("afterN=2 due at block 4", dueN(2, 4));
  check("afterN=1 due every block", dueN(1, 1) && dueN(1, 3));
  check("afterN=3 due at block 3 only (not 2)", dueN(3, 3) && !dueN(3, 2));
  check("afterN=0 treated as 1 (never divide-by-zero)", dueN(0, 5));

  // ── grid position: top never schedules, after_load_more is block-1 only ──────
  check(
    "top position excluded from the schedule",
    !isDueAtBlock({ afterLoadMoreCount: 2, gridPosition: "top" as const }, 2),
  );
  check(
    "after_load_more due only at block 1",
    isDueAtBlock({ afterLoadMoreCount: 9, gridPosition: "after_load_more" as const }, 1) &&
      !isDueAtBlock({ afterLoadMoreCount: 9, gridPosition: "after_load_more" as const }, 2),
  );

  // ── rotation (the live bug: 3 global banners at the default N=2 — the pinned
  //    first + two between-row ones — only ever showed the SECOND of the two) ──
  const b1 = { name: "b1", afterLoadMoreCount: 2, gridPosition: "after_rows" as const };
  const b2 = { name: "b2", afterLoadMoreCount: 2, gridPosition: "after_rows" as const };
  const b3 = { name: "b3", afterLoadMoreCount: 2, gridPosition: "after_rows" as const };
  const names = (s: ({ name: string } | null)[]) => s.map((b) => b?.name ?? "-").join(",");
  check(
    "two banners at N=2 alternate at blocks 2/4/6/8 (b1,b2,b1,b2)",
    names(gridBannerSchedule([b1, b2], 8)) === "-,b1,-,b2,-,b1,-,b2",
  );
  const three = gridBannerSchedule([b1, b2, b3], 12);
  check(
    "three banners at N=2 all appear over enough rows",
    ["b1", "b2", "b3"].every((n) => three.some((b) => b?.name === n)),
  );
  const mixed = gridBannerSchedule(
    [
      b1,
      b2,
      { name: "c1", afterLoadMoreCount: 1, gridPosition: "after_rows" as const },
      { name: "c2", afterLoadMoreCount: 1, gridPosition: "after_rows" as const },
    ],
    16,
  );
  check(
    "mixed cadences (N=2,2 + N=1,1) reach every banner",
    ["b1", "b2", "c1", "c2"].every((n) => mixed.some((b) => b?.name === n)),
  );

  // ── schedule clear (updateBannerWorkflow) ─────────────────────────────────
  // The edit form always posts both datetime inputs; a CLEARED one arrives as
  // "" and must null the column (it used to collapse to "untouched", so a
  // banner could never be made permanent / un-scheduled once dated).
  const sched = await bannerService.insert({
    ...base,
    name: `${TAG}-sched`,
    target_kind: "none",
    start_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    end_at: new Date(Date.now() - 1000 * 60 * 60 * 24),
  });
  const cleared = await workflows.cms.updateBanner({ id: sched.id, startAt: "", endAt: "" });
  check("clearing both schedule dates succeeds", cleared.ok === true);
  const afterClear = await bannerService.findById(sched.id);
  check("cleared start_at is NULL", afterClear?.start_at === null);
  check("cleared end_at is NULL", afterClear?.end_at === null);
  check(
    "un-scheduled banner is live again",
    ids(await bannerService.listGridBannersForListing({})).has(sched.id),
  );
  // Absent keys leave the stored schedule untouched (partial update).
  await workflows.cms.updateBanner({ id: sched.id, endAt: "2099-01-01T10:00" });
  const untouched = await workflows.cms.updateBanner({ id: sched.id, title: "T2" });
  const afterPartial = await bannerService.findById(sched.id);
  check(
    "a partial update without the date keys keeps end_at",
    untouched.ok === true && afterPartial?.end_at instanceof Date,
  );
  const inverted = await workflows.cms.updateBanner({
    id: sched.id,
    startAt: "2099-02-01T10:00",
    endAt: "2099-01-01T10:00",
  });
  check(
    "end before start is refused with a field-keyed French message",
    inverted.ok === false && Boolean(inverted.fieldErrors?.endAt),
  );

  // ── 0177 columns round-trip + authoritative buttons clear ─────────────────
  // A hero with LEGACY cta_* only (buttons NULL) synthesises them; clearing the
  // editor (buttons "[]") is AUTHORITATIVE — effectiveBannerButtons returns [] and
  // the legacy columns are ignored. This is the headline fix of this build.
  const heroRow = await bannerService.insert({
    placement: "home_hero",
    name: `${TAG}-hero-legacy`,
    title: "Hero",
    is_active: true,
    cta_label: "Voir",
    cta_href: "/boutique",
    secondary_cta_label: "Plus",
    secondary_cta_href: "/maison",
  });
  check(
    "legacy hero (buttons NULL) synthesises 2 CTAs from cta_*",
    effectiveBannerButtons(await bannerService.findById(heroRow.id).then((r) => r!)).length === 2,
  );
  await workflows.cms.updateBanner({ id: heroRow.id, placement: "home_hero", buttons: "[]" });
  const clearedHero = await bannerService.findById(heroRow.id);
  check("editor-cleared buttons persist as authoritative '[]' (not NULL)", clearedHero?.buttons === "[]");
  check(
    "authoritative '[]' yields NO CTAs even though legacy cta_* remain",
    effectiveBannerButtons(clearedHero!).length === 0,
  );
  const twoBtn = JSON.stringify([
    { label: "A", href: "/a", variant: "primary" },
    { label: "", href: "", variant: "ghost" },
  ]);
  await workflows.cms.updateBanner({ id: heroRow.id, placement: "home_hero", buttons: twoBtn });
  const withBtn = await bannerService.findById(heroRow.id);
  check(
    "buttons round-trip drops the incomplete row (1 of 2 kept)",
    effectiveBannerButtons(withBtn!).length === 1,
  );

  // Non-hero create omits the showText marker → the column stays at its default TRUE
  // (a non-hero must never be stored text-less, which would surface if retargeted to a hero).
  const stripCreate = await workflows.cms.createBanner({
    placement: "header_strip",
    name: `${TAG}-strip`,
    title: "Promo",
    stripTone: "gold",
    stripIcon: "✨",
    // showText / showCountdown intentionally omitted (the strip form never posts them).
  });
  const stripRow = stripCreate.ok ? await bannerService.findById(stripCreate.data.id) : null;
  check("non-hero create keeps show_text = true (schema default, not false)", stripRow?.show_text === true);
  check("non-hero create keeps show_countdown = false (default)", stripRow?.show_countdown === false);
  check("strip 0177 style columns round-trip", stripRow?.strip_tone === "gold" && stripRow?.strip_icon === "✨");

  // video_url is a plain hosted URL (home hero), sanitised by safe-href; javascript: is dropped.
  const vid = await workflows.cms.createBanner({
    placement: "home_hero",
    name: `${TAG}-video`,
    title: "V",
    videoUrl: "https://cdn.example.com/hero.mp4",
  });
  const vidRow = vid.ok ? await bannerService.findById(vid.data.id) : null;
  check("video_url round-trips", vidRow?.video_url === "https://cdn.example.com/hero.mp4");
  const badVid = await workflows.cms.createBanner({
    placement: "home_hero",
    name: `${TAG}-badvideo`,
    title: "V",
    videoUrl: "javascript:alert(1)",
  });
  check("javascript: video_url is rejected at validation", badVid.ok === false);

  // afterLoadMoreCount bounds (zod [1,20]) + grid_position enum.
  const tooBig = await workflows.cms.createBanner({
    placement: "category_grid",
    name: `${TAG}-bigN`,
    title: "N",
    afterLoadMoreCount: 99,
  });
  check("afterLoadMoreCount > 20 is rejected", tooBig.ok === false);
  const gp = await workflows.cms.createBanner({
    placement: "category_grid",
    name: `${TAG}-gp`,
    title: "G",
    gridPosition: "top",
  });
  const gpRow = gp.ok ? await bannerService.findById(gp.data.id) : null;
  check("grid_position round-trips", gpRow?.grid_position === "top");

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
