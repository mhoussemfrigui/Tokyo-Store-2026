import "server-only";

/**
 * Data-clean scoping regression test (P1 « Destructive demo/data cleaning safety »).
 *
 * Proves the destructive clean paths only take what they should:
 *   1. « Nettoyer › Réglages » (`cleanSettings`) resets a demo key ONLY while it
 *      still holds the demo-seeded value — an edited identity value, a B2B switch
 *      turned off, an admin-chosen image all survive — and reclaims the
 *      demo-uploaded image behind a deleted image key only when nothing else
 *      uses it (pure planner + the DB segment).
 *   2. `listReferencedMediaIds` / `reclaimUnreferencedMedia` keep média another
 *      entity still references (banner, `*_media_id` setting) and delete only
 *      the truly unreferenced ones.
 *   3. The whole-store `demo.clear` is refused without the RBAC `*` wildcard
 *      (`isSuperAdmin`) and while a purge is in progress (busy gate — asserted
 *      BEFORE the workflow is called, so a broken gate can't wipe the DB).
 *
 * Self-cleaning (`zztest-dcs` tag). The settings section snapshots every demo
 * settings key first and restores it at the end.
 *
 * Run (isolated DB only):
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… pnpm exec tsx --conditions=react-server \
 *     --env-file-if-exists=.env.local src/lib/db/tests/data-clean-scoping.test.ts
 */
import { inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { DEMO_SETTINGS } from "@/lib/demo/data";
import {
  DEMO_SETTINGS_CLEAN_KEYS,
  isDemoUploadedMedia,
  planDemoSettingsClean,
} from "@/lib/demo/settings-clean-plan";
import { beginPurge, endPurge, isPurgeInProgress } from "@/lib/demo/purge-lock";
import { isSuperAdmin } from "@/lib/auth/super-admin";
import { emptyDataJobResult } from "@/modules/import";
import { media } from "@/modules/media/schema";
import { mediaQueries } from "@/modules/media";
import { site_settings, type SiteSettingRow } from "@/modules/cms/setting/schema";
import { settingService } from "@/modules/cms/setting/service";
import { bannerService } from "@/modules/cms/banner/service";
import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import {
  cleanSettings,
  reclaimUnreferencedMedia,
  type SegmentCtx,
} from "@/workflows/data/segments";
import { clearDemoBlocker, clearDemoWorkflow } from "@/workflows/demo/clear-demo";

const TAG = "zztest-dcs";

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

function demoValue(key: string): string {
  const s = DEMO_SETTINGS.find((x) => x.key === key);
  if (!s) throw new Error(`no demo value for ${key}`);
  return s.value;
}

const ctxOf = (): SegmentCtx => ({ actorUserId: `${TAG}-actor`, result: emptyDataJobResult() });

/** Demo settings rows as they were before section 1 (restored in cleanup). */
let settingsSnapshot: SiteSettingRow[] | null = null;

async function insertMedia(name: string, alt: string | null, filename: string): Promise<string> {
  const [row] = await db
    .insert(media)
    .values({
      storage_key: `${TAG}/${name}`,
      url: `/cdn/${TAG}/${name}`,
      filename,
      mime_type: "image/jpeg",
      size_bytes: 1,
      alt_text: alt,
    })
    .returning({ id: media.id });
  return row.id;
}

async function mediaExists(id: string): Promise<boolean> {
  const rows = await db.select({ id: media.id }).from(media).where(inArray(media.id, [id]));
  return rows.length === 1;
}

async function cleanup() {
  await db.execute(sql`delete from banners where name like ${TAG + "%"}`);
  await db.execute(sql`delete from site_settings where key like ${TAG + "%"}`);
  if (settingsSnapshot) {
    await db.delete(site_settings).where(inArray(site_settings.key, [...DEMO_SETTINGS_CLEAN_KEYS]));
    if (settingsSnapshot.length) await db.insert(site_settings).values(settingsSnapshot);
    settingsSnapshot = null;
  }
  await db.execute(sql`delete from media where storage_key like ${TAG + "/%"}`);
  await db.execute(sql`delete from user_roles where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from roles where key like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
}

async function main() {
  await cleanup();

  // ── 0. pure planner ────────────────────────────────────────────────────────
  console.log("pure: planDemoSettingsClean");
  // The only média-valued demo slot now is the nav-bar logo (home editorial blocks
  // were removed with the watch-era chrome). DEMO_IMAGES.logoPng = "tokyo-logo.png".
  const logoDemo = { alt_text: "Demo logoPng", filename: "tokyo-logo.webp" };
  check("demo upload recognised (re-encoded extension)", isDemoUploadedMedia(logoDemo, "logoPng"));
  check(
    "re-labelled demo image = admin-owned",
    !isDemoUploadedMedia({ alt_text: "Notre logo", filename: "tokyo-logo.png" }, "logoPng"),
  );
  check(
    "renamed demo image = admin-owned",
    !isDemoUploadedMedia({ alt_text: "Demo logoPng", filename: "mon-logo.png" }, "logoPng"),
  );
  {
    const current = new Map<string, string | null>([
      ["site.tagline", demoValue("site.tagline")],
      ["site.name", "Ma Boutique"],
      ["site.logo_media_id", "m-logo"],
    ]);
    const plan = planDemoSettingsClean(current, new Map([["m-logo", logoDemo]]));
    const del = new Set(plan.deleteKeys);
    check("unchanged demo text → deleted", del.has("site.tagline"));
    check("edited store name → kept", !del.has("site.name") && plan.keptKeys.includes("site.name"));
    check("demo logo still in place → deleted + reclaimed", del.has("site.logo_media_id") && plan.mediaIds.includes("m-logo"));
    check("absent (non-demo) key is neither deleted nor kept", !del.has("site.hours") && !plan.keptKeys.includes("site.hours"));

    // An admin-chosen logo (different file) → the key is kept, média untouched.
    const planAdmin = planDemoSettingsClean(
      new Map<string, string | null>([["site.logo_media_id", "m-admin"]]),
      new Map([["m-admin", { alt_text: "Notre logo", filename: "mon-logo.png" }]]),
    );
    check(
      "admin-chosen logo → kept, média untouched",
      !new Set(planAdmin.deleteKeys).has("site.logo_media_id") && !planAdmin.mediaIds.includes("m-admin"),
    );
  }

  // ── 1. listReferencedMediaIds + reclaimUnreferencedMedia ───────────────────
  console.log("db: in-use média guard");
  const usedByBanner = await insertMedia("banner.jpg", null, "banner.jpg");
  const usedBySetting = await insertMedia("setting.jpg", null, "setting.jpg");
  const unused = await insertMedia("unused.jpg", null, "unused.jpg");
  await bannerService.insert({
    name: `${TAG}-banner`,
    placement: "category_grid",
    title: "T",
    is_active: true,
    image_media_id: usedByBanner,
  });
  await settingService.upsert({ key: `${TAG}.card.image_media_id`, value: usedBySetting, type: "media", label: TAG });
  const referenced = await mediaQueries.listReferencedMediaIds([usedByBanner, usedBySetting, unused, "not-a-uuid"]);
  check("banner-referenced média reported in use", referenced.has(usedByBanner));
  check("*_media_id setting-referenced média reported in use", referenced.has(usedBySetting));
  check("unreferenced média not reported", !referenced.has(unused));
  check("non-uuid candidate ignored", referenced.size === 2);

  const rctx = ctxOf();
  await reclaimUnreferencedMedia(rctx, [usedByBanner, usedBySetting, unused, null, unused]);
  check("reclaim deletes ONLY the unreferenced média", rctx.result.mediaDeleted === 1 && !(await mediaExists(unused)));
  check("reclaim keeps the in-use média", (await mediaExists(usedByBanner)) && (await mediaExists(usedBySetting)));

  // ── 2. cleanSettings on the DB (snapshot → scenario → restore) ────────────
  console.log("db: cleanSettings value-scoping");
  settingsSnapshot = await db
    .select()
    .from(site_settings)
    .where(inArray(site_settings.key, [...DEMO_SETTINGS_CLEAN_KEYS]));
  await db.delete(site_settings).where(inArray(site_settings.key, [...DEMO_SETTINGS_CLEAN_KEYS]));

  const demoLogo = await insertMedia("logo.png", "Demo logoPng", "tokyo-logo.png");
  const seed: Array<[string, string]> = [
    ["site.tagline", demoValue("site.tagline")],
    ["site.name", "Ma Boutique Perso"],
    ["site.logo_media_id", demoLogo],
  ];
  for (const [key, value] of seed) await settingService.upsert({ key, value, type: "text", label: TAG });

  const sctx = ctxOf();
  await cleanSettings(sctx);
  const after = async (key: string) => (await settingService.findByKey(key))?.value ?? null;
  check("unchanged demo tagline deleted", (await after("site.tagline")) === null);
  check("customised store name survives", (await after("site.name")) === "Ma Boutique Perso");
  check("demo logo key deleted", (await after("site.logo_media_id")) === null);
  check("demo logo média reclaimed (nothing else uses it)", !(await mediaExists(demoLogo)));
  check("counts: 2 deleted, 1 kept, 1 média", sctx.result.deleted === 2 && sctx.result.skipped === 1 && sctx.result.mediaDeleted === 1);
  check("kept settings reported to the operator", sctx.result.warnings.some((w) => w.includes("site.name")));

  // ── 3. demo.clear gates ─────────────────────────────────────────────────────
  console.log("db: demo.clear gates");
  const SUPER = `${TAG}-super`;
  const DELEG = `${TAG}-deleg`;
  const WILD = `${TAG}-wild`;
  // Access is role-only: an "admin" is seeded by granting the super_admin role.
  const mk = async (id: string, type: "admin" | "customer") => {
    await authService.insert({ id, email: `${id}@example.test`, name: id } as never);
    if (type === "admin") {
      const sa = await rbacService.findRoleByKey("super_admin");
      if (sa) await rbacService.assignRoleToUser(id, sa.id);
    }
  };
  await mk(SUPER, "admin");
  await mk(DELEG, "customer");
  await mk(WILD, "customer");
  const ops = await rbacService.createRole({ key: `${TAG}-ops`, name: `${TAG} ops`, description: null, is_system: false });
  await rbacService.setRolePermissions(ops.id, ["system_demo:manage", "system_jobs:manage", "system_jobs:view"]);
  await rbacService.assignRoleToUser(DELEG, ops.id);
  const wild = await rbacService.createRole({ key: `${TAG}-wild`, name: `${TAG} wild`, description: null, is_system: false });
  await rbacService.setRolePermissions(wild.id, ["*"]);
  await rbacService.assignRoleToUser(WILD, wild.id);
  check("system_demo:manage + system_jobs:manage delegate is NOT super-admin (clear/clean refused)", !(await isSuperAdmin(DELEG)));
  check("super_admin-role holder is super-admin", await isSuperAdmin(SUPER));
  check("custom role holding '*' is super-admin", await isSuperAdmin(WILD));

  const markerWasSet = await isPurgeInProgress();
  if (!markerWasSet) await beginPurge();
  try {
    const blocker = await clearDemoBlocker();
    check("clear blocked while a purge is in progress", typeof blocker === "string" && blocker.length > 0);
    if (blocker) {
      // Only safe to call once the gate is proven to refuse (else it would wipe the DB).
      const res = await clearDemoWorkflow({ actorUserId: SUPER });
      check("clearDemoWorkflow refuses with error 'busy'", !res.ok && res.error === "busy");
      check("a refused clear does not release someone else's purge marker", await isPurgeInProgress());
    }
  } finally {
    if (!markerWasSet) await endPurge();
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
