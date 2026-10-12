import "server-only";

/**
 * Settings / CMS audit-actor + no-op-save invariants (ops-01, wiring-15):
 *   - `workflows.cms.upsertSetting(input, { actorUserId })` emits
 *     `setting.upserted` carrying the acting admin, and the curated audit row
 *     stores it in `actor_user_id` (no more "· système" for admin saves).
 *   - an IDENTICAL re-save is a no-op: no write, no event, no audit row. A
 *     changed value / label still saves + emits; an omitted `description` never
 *     counts as a change (the upsert leaves it untouched). First insert emits.
 *   - the ctx stays optional: a call without it (bootstrap/seed) still works and
 *     emits with a null actor.
 *   - the CMS nav-menu workflows forward the same ctx to their events.
 * Self-cleaning (`zztest.settingsactor` / `zztest-settingsactor` + every audit
 * row written by the synthetic actor). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/settings-actor.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus, type EventEnvelope } from "@/events/bus";
import { registerAllSubscribers } from "@/events/subscribers";
import { __resetAuditRuntimeConfig, getAuditRuntimeConfig } from "@/lib/audit/runtime-config";
import { settingService } from "@/modules/cms/setting/service";
import { workflows } from "@/workflows";

const KEY = "zztest.settingsactor.k";
const MENU_KEY = "zztest-settingsactor";
const ACTOR = "__satest-admin";

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

async function cleanup() {
  await db.execute(sql`delete from site_settings where key like 'zztest.settingsactor.%'`);
  await db.execute(sql`delete from audit_log where target_id like 'zztest.settingsactor.%'`);
  // The nav.menu.* rows are keyed by the menu uuid, not the setting key — every
  // write here uses the synthetic ACTOR, so sweep by actor as well.
  await db.execute(sql`delete from audit_log where actor_user_id = ${ACTOR}`);
  await db.execute(
    sql`delete from nav_items where menu_id in (select id from nav_menus where key = ${MENU_KEY})`,
  );
  await db.execute(sql`delete from nav_menus where key = ${MENU_KEY}`);
}

async function auditRowsFor(key: string): Promise<Row[]> {
  return rowsOf(
    await db.execute(
      sql`select actor_user_id from audit_log
          where event_name = 'setting.upserted' and target_id = ${key}
          order by id`,
    ),
  );
}

async function main() {
  await cleanup();
  __resetAuditRuntimeConfig();
  const auditOn = (await getAuditRuntimeConfig()).enabled;

  // The curated audit subscriber is what writes `setting.upserted` rows. The
  // registry is idempotent (global flag) and already self-registers on import;
  // call it explicitly so the test never depends on that side effect. Then add
  // capture listeners for the envelopes themselves.
  registerAllSubscribers();
  const settingEvents: EventEnvelope[] = [];
  bus.on("setting.upserted", (env) => {
    if (env.payload.key === KEY) settingEvents.push(env as EventEnvelope);
  });
  const navEvents: EventEnvelope[] = [];
  const onNav = (env: EventEnvelope) => {
    if ((env.payload as { key?: string }).key === MENU_KEY) navEvents.push(env);
  };
  bus.on("nav.menu.created", onNav);
  bus.on("nav.menu.updated", onNav);

  const base = {
    key: KEY,
    value: "a",
    type: "text" as const,
    groupKey: "zztest",
    label: "Test — acteur",
    description: "d1",
  };

  // ── first save: inserted + emitted with the actor ─────────────────────────
  const first = await workflows.cms.upsertSetting(base, { actorUserId: ACTOR });
  check("first save ok", first.ok === true);
  check("first save emits setting.upserted once", settingEvents.length === 1);
  check("event carries the acting admin", settingEvents[0]?.actorUserId === ACTOR);
  if (auditOn) {
    const rows = await auditRowsFor(KEY);
    check("curated audit row written", rows.length === 1);
    check("audit row actor_user_id = acting admin", rows[0]?.actor_user_id === ACTOR);
  } else {
    console.log("  (audit capture disabled on this DB — audit-row checks skipped)");
  }
  const stored1 = await settingService.findByKey(KEY);

  // ── identical re-save: no write, no event, no audit row ───────────────────
  const same = await workflows.cms.upsertSetting(base, { actorUserId: ACTOR });
  check("identical re-save ok", same.ok === true);
  check("identical re-save emits nothing", settingEvents.length === 1);
  if (auditOn) check("identical re-save adds no audit row", (await auditRowsFor(KEY)).length === 1);
  const stored2 = await settingService.findByKey(KEY);
  check(
    "identical re-save leaves updated_at untouched",
    stored1?.updated_at?.getTime() === stored2?.updated_at?.getTime(),
  );

  // ── omitted description is not a change (upsert would leave it as-is) ─────
  const { description: _omit, ...noDesc } = base;
  void _omit;
  await workflows.cms.upsertSetting(noDesc, { actorUserId: ACTOR });
  check("omitted description → no-op", settingEvents.length === 1);
  check("stored description preserved", (await settingService.findByKey(KEY))?.description === "d1");

  // ── changed value / label still save + emit ────────────────────────────────
  await workflows.cms.upsertSetting({ ...base, value: "b" }, { actorUserId: ACTOR });
  check("changed value emits", settingEvents.length === 2);
  check("changed value persisted", (await settingService.findByKey(KEY))?.value === "b");
  await workflows.cms.upsertSetting({ ...base, value: "b", label: "Test — acteur 2" }, { actorUserId: ACTOR });
  check("changed label emits", settingEvents.length === 3);

  // ── null value round-trip: first null save emits, identical null is a no-op ─
  await workflows.cms.upsertSetting({ ...base, value: null, label: "Test — acteur 2" }, { actorUserId: ACTOR });
  check("value → null emits", settingEvents.length === 4);
  await workflows.cms.upsertSetting({ ...base, value: null, label: "Test — acteur 2" }, { actorUserId: ACTOR });
  check("identical null re-save is a no-op", settingEvents.length === 4);

  // ── ctx stays optional (bootstrap/seed path) → null actor ─────────────────
  const noCtx = await workflows.cms.upsertSetting({ ...base, value: "c", label: "Test — acteur 2" });
  check("save without ctx ok", noCtx.ok === true);
  check("save without ctx emits with a null actor", settingEvents[4]?.actorUserId === null);

  // ── CMS nav-menu workflows forward the actor too ──────────────────────────
  const created = await workflows.cms.createNavMenu(
    { key: MENU_KEY, name: "Test acteur" },
    { actorUserId: ACTOR },
  );
  check("nav menu created", created.ok === true);
  if (created.ok) {
    await workflows.cms.updateNavMenu({ id: created.data.id, name: "Test acteur 2" }, { actorUserId: ACTOR });
    // (No menu delete workflow — system menus are never deleted; cleanup() drops the row.)
  }
  check("nav.menu.{created,updated} emitted", navEvents.length === 2);
  check("every nav.menu event carries the actor", navEvents.every((e) => e.actorUserId === ACTOR));

  // ── upsertSettingsBatch: ATOMIC multi-key save (validate-all → one tx → emit) ──
  // The /boutique landing save writes 15 keys through this — it must be all-or-
  // nothing (no half-saved config) with a per-changed-key emit + no-op skip.
  console.log("upsertSettingsBatch:");
  const BK1 = "zztest.settingsactor.batch1";
  const BK2 = "zztest.settingsactor.batch2";
  const batchEvents: EventEnvelope[] = [];
  bus.on("setting.upserted", (env) => {
    if (env.payload.key === BK1 || env.payload.key === BK2) batchEvents.push(env as EventEnvelope);
  });
  const mkBatch = (v1: string, v2: string) => ({
    settings: [
      { key: BK1, value: v1, type: "text" as const, groupKey: "zztest", label: "Batch 1" },
      { key: BK2, value: v2, type: "text" as const, groupKey: "zztest", label: "Batch 2" },
    ],
  });
  const b1 = await workflows.cms.upsertSettingsBatch(mkBatch("one", "two"), { actorUserId: ACTOR });
  check("batch write ok, 2 changed keys", b1.ok && b1.data.changedKeys.length === 2);
  check(
    "batch wrote BOTH keys",
    (await settingService.findByKey(BK1))?.value === "one" &&
      (await settingService.findByKey(BK2))?.value === "two",
  );
  check("batch emits one setting.upserted per changed key", batchEvents.length === 2);
  check("batch events carry the actor", batchEvents.every((e) => e.actorUserId === ACTOR));

  const b2 = await workflows.cms.upsertSettingsBatch(mkBatch("one", "two"), { actorUserId: ACTOR });
  check(
    "identical re-batch → 0 changed, no new events (no-op skip)",
    b2.ok && b2.data.changedKeys.length === 0 && batchEvents.length === 2,
  );

  const b3 = await workflows.cms.upsertSettingsBatch(mkBatch("one", "THREE"), { actorUserId: ACTOR });
  check(
    "one-key change → only that key reported + emitted",
    b3.ok && b3.data.changedKeys.length === 1 && b3.data.changedKeys[0] === BK2 && batchEvents.length === 3,
  );

  // Atomic all-or-nothing at VALIDATION: one bad site-key rejects the WHOLE batch,
  // writing nothing (not even the valid key before it).
  const NEWK = "zztest.settingsactor.batch_new";
  const badBatch = await workflows.cms.upsertSettingsBatch(
    {
      settings: [
        { key: NEWK, value: "should-not-persist", type: "text", groupKey: "zztest", label: "New" },
        { key: "seo.site_url", value: "not a url", type: "text", groupKey: "seo", label: "Site URL" },
      ],
    },
    { actorUserId: ACTOR },
  );
  check("batch with an invalid site key → validation fail", !badBatch.ok && badBatch.error === "validation");
  check("…and NOTHING written (the valid key too) — validated before any write", (await settingService.findByKey(NEWK)) === null);

  // Atomic rollback on a mid-transaction FAILURE (2nd write throws → whole tx rolls back).
  const origUpsert = settingService.upsert;
  let upsertCalls = 0;
  settingService.upsert = async function (...args: Parameters<typeof origUpsert>) {
    upsertCalls += 1;
    if (upsertCalls === 2) throw new Error("zztest: simulated mid-batch write failure");
    return origUpsert.apply(settingService, args);
  };
  try {
    await workflows.cms
      .upsertSettingsBatch(
        {
          settings: [
            { key: "zztest.settingsactor.roll1", value: "r1", type: "text", groupKey: "zztest", label: "R1" },
            { key: "zztest.settingsactor.roll2", value: "r2", type: "text", groupKey: "zztest", label: "R2" },
          ],
        },
        { actorUserId: ACTOR },
      )
      .catch(() => {});
  } finally {
    settingService.upsert = origUpsert;
  }
  check(
    "a mid-batch write failure rolls the WHOLE tx back (the first key is NOT left half-saved)",
    (await settingService.findByKey("zztest.settingsactor.roll1")) === null,
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
