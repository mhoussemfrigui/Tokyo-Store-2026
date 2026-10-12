import "server-only";

/**
 * Promotions admin regression test (A–Z audit 2026-09-23, loyalty-promo-b2b
 * 16/17/24/28). Covers the invariants the admin UI now leans on:
 *   - formatStoreDateTime renders in SHOP time (Africa/Tunis), not the
 *     container's UTC runtime zone (promo detail « Utilisations » + the
 *     announcement « valable jusqu'au »).
 *   - the max-cart < min-cart refine lands on the `maxCartTnd` key the form
 *     field reads (and the auto-trigger refusals on `triggerKind`).
 *   - `promotion.updated` carries the POST-update scope/scopeId (a re-scoped
 *     promo must not report its old target to webhook / audit consumers).
 *   - toggle / duplicate of a missing promo return a French not_found message
 *     (the list + product panels now surface it instead of swallowing it).
 * Self-cleaning (all rows tagged `__patest…`). Run against the isolated DB:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/promotions-admin.test.ts
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import type { EventPayload } from "@/events/types";
import { formatStoreDateTime } from "@/lib/time/store-tz";
import { createPromotionSchema } from "@/workflows/promotion/manage";
import { workflows } from "@/workflows";
import { promotionService } from "@/modules/promotion";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

const ACTOR = "__patest-admin";

async function cleanup() {
  await db.execute(
    sql`delete from promotion_targets where promotion_id in (select id from promotions where name like '__patest%')`,
  );
  await db.execute(sql`delete from promotions where name like '__patest%'`);
}

/** Minimal valid workflow input (auto, cart-wide, −10 %). */
function baseInput(over: Record<string, unknown> = {}) {
  return {
    name: "__patest-promo",
    triggerKind: "auto" as const,
    scope: "cart" as const,
    scopeId: null,
    discountType: "percent" as const,
    discountValue: 10,
    minCartCents: 0,
    isActive: true,
    isStackable: false,
    excludeDiscountedItems: false,
    grantsFreeShipping: false,
    displayPriority: 0,
    ...over,
  };
}

async function main() {
  await cleanup();

  // ── 1. formatStoreDateTime — shop time, not runtime zone ───────────────
  console.log("formatStoreDateTime — Africa/Tunis (UTC+1):");
  {
    // 23:30Z on the 30th is 00:30 on the 1st in Tunis.
    const medium = formatStoreDateTime(new Date("2026-09-30T23:30:00Z"));
    check(`medium 23:30Z → 1 oct. 00:30 (got « ${medium} »)`, medium.includes("1 oct") && medium.includes("00:30"));
    const long = formatStoreDateTime("2026-09-30T22:59:00Z", "long");
    check(
      `long 22:59Z → 30 septembre 2026 23:59 (got « ${long} »)`,
      long.includes("30 septembre 2026") && long.includes("23:59"),
    );
    check("null → empty string", formatStoreDateTime(null) === "");
    check("invalid → empty string", formatStoreDateTime("nope") === "");
  }

  // ── 2. schema refine keys match the form's inline slots ────────────────
  console.log("createPromotionSchema — field-error keys:");
  {
    const band = createPromotionSchema.safeParse(baseInput({ minCartCents: 500_000, maxCartCents: 100_000 }));
    check("max < min cart rejected", !band.success);
    const bandIssue = band.success ? undefined : band.error.issues.find((i) => i.path.join(".") === "maxCartTnd");
    check("…on the `maxCartTnd` key the form field renders", Boolean(bandIssue?.message));

    const okBand = createPromotionSchema.safeParse(baseInput({ minCartCents: 100_000, maxCartCents: 100_000 }));
    check("max == min cart accepted", okBand.success);

    const autoShip = createPromotionSchema.safeParse(baseInput({ grantsFreeShipping: true }));
    check(
      "auto + free shipping rejected on `triggerKind`",
      !autoShip.success && autoShip.error.issues.some((i) => i.path.join(".") === "triggerKind"),
    );

    // E1: first_order_only is a buyer-aware gate → rejected on an auto promo.
    const autoFirst = createPromotionSchema.safeParse(baseInput({ firstOrderOnly: true }));
    check(
      "auto + first_order_only rejected on `triggerKind`",
      !autoFirst.success && autoFirst.error.issues.some((i) => i.path.join(".") === "triggerKind"),
    );
    const codeFirst = createPromotionSchema.safeParse(
      baseInput({ triggerKind: "code", code: "__PAWELCOME", firstOrderOnly: true }),
    );
    check("code + first_order_only accepted", codeFirst.success);

    // E2: inline audience_rule_tree — valid on a code coupon, rejected on auto, and
    // an EMPTY group (would match everybody) is refused (fail-closed).
    const goodTree = { op: "and", children: [{ kind: "marketing_opted_in" }] };
    const codeAud = createPromotionSchema.safeParse(
      baseInput({ triggerKind: "code", code: "__PAAUD", audienceRuleTree: goodTree }),
    );
    check("code + valid audience rule accepted", codeAud.success);
    const autoAud = createPromotionSchema.safeParse(baseInput({ audienceRuleTree: goodTree }));
    check(
      "auto + audience rule rejected on `triggerKind`",
      !autoAud.success && autoAud.error.issues.some((i) => i.path.join(".") === "triggerKind"),
    );
    const emptyTree = { op: "and", children: [] };
    const codeEmptyAud = createPromotionSchema.safeParse(
      baseInput({ triggerKind: "code", code: "__PAEMPTY", audienceRuleTree: emptyTree }),
    );
    check(
      "empty audience group rejected on `audienceRuleTree` (fail-closed)",
      !codeEmptyAud.success && codeEmptyAud.error.issues.some((i) => i.path.join(".") === "audienceRuleTree"),
    );
  }

  // ── E2 persistence: create a code coupon WITH an audience rule → it is stored. ──
  {
    const created = await workflows.promotion.create(
      baseInput({
        name: "__patest-aud-persist",
        triggerKind: "code",
        code: "__PAAUDPERSIST",
        audienceRuleTree: { op: "and", children: [{ kind: "marketing_opted_in" }, { kind: "cart_total_gte", cents: 100000 }] },
      }) as never,
      { actorUserId: "__patest-actor" },
    );
    check("audience-ruled coupon created", created.ok === true);
    if (created.ok) {
      const row = await promotionService.findById(created.data.promotionId);
      check("audience_rule_tree persisted as jsonb", row?.audience_rule_tree != null && (row.audience_rule_tree as { op?: string }).op === "and");
    }
  }

  // ── 3. promotion.updated carries the POST-update scope ─────────────────
  console.log("promotion.updated payload — post-update scope/scopeId:");
  {
    const seen: EventPayload<"promotion.updated">[] = [];
    bus.on("promotion.updated", ({ payload }) => {
      seen.push(payload);
    });

    const productA = randomUUID();
    const categoryB = randomUUID();
    const created = await workflows.promotion.create(
      baseInput({ name: "__patest-rescope", scope: "product", scopeId: productA }),
      { actorUserId: ACTOR },
    );
    check("create ok", created.ok);
    if (created.ok) {
      const promotionId = created.data.promotionId;

      const toCategory = await workflows.promotion.update(
        { promotionId, ...baseInput({ name: "__patest-rescope", scope: "category", scopeId: categoryB }) },
        { actorUserId: ACTOR },
      );
      check("re-scope product → category ok", toCategory.ok);
      const e1 = seen.filter((p) => p.promotionId === promotionId).at(-1);
      check("event scope is the NEW scope (category)", e1?.scope === "category");
      check("event scopeId is the NEW target (B, not A)", e1?.scopeId === categoryB);

      const toCart = await workflows.promotion.update(
        { promotionId, ...baseInput({ name: "__patest-rescope", scope: "cart", scopeId: null }) },
        { actorUserId: ACTOR },
      );
      check("re-scope category → cart ok", toCart.ok);
      const e2 = seen.filter((p) => p.promotionId === promotionId).at(-1);
      check("event scope is cart", e2?.scope === "cart");
      check("event scopeId is null for a cart promo", e2?.scopeId === null);
    }
  }

  // ── 4. toggle / duplicate of a missing promo → French not_found ────────
  console.log("toggle / duplicate on a missing promotion:");
  {
    const missing = randomUUID();
    const toggled = await workflows.promotion.toggleActive(
      { promotionId: missing, isActive: true },
      { actorUserId: ACTOR },
    );
    check("toggle → not_found", !toggled.ok && toggled.error === "not_found");
    check("toggle → operator message", !toggled.ok && toggled.message.length > 0);

    const cloned = await workflows.promotion.duplicate({ promotionId: missing }, { actorUserId: ACTOR });
    check("duplicate → not_found", !cloned.ok && cloned.error === "not_found");
    check("duplicate → operator message", !cloned.ok && cloned.message.length > 0);
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
