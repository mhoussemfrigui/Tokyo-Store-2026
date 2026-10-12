import "server-only";

/**
 * Promotion / exclusivity security regressions (DB):
 *   1. DUPLICATE workflow — a code/URL promo clones with a unique PLACEHOLDER
 *      code/slug (the old NULL surface violated promotions_trigger_surface_chk →
 *      uncaught 23514), inactive, targets copied verbatim (never widened to
 *      public), promotion.created emitted.
 *   2. `/promo/<slug>` ROUTE HANDLER — a live URL promo sets the httpOnly
 *      `gz.promo` cookie + 307 to `/`; a miss redirects WITHOUT a cookie (the old
 *      RSC page threw on `cookies().set`, so every valid link crashed).
 * Self-cleaning (all rows tagged `__pstest…` / `pstest-…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/promo-security.test.ts
 */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { promotionService } from "@/modules/promotion";
import type { NewPromotionRow, PromotionRow } from "@/modules/promotion/schema";
import { segmentService } from "@/modules/customer/segment.service";
import { workflows } from "@/workflows";
import { GET as promoLanding } from "@/app/promo/[slug]/route";

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

const RUN = randomBytes(3).toString("hex"); // per-run uniqueness for codes/slugs
const ACTOR = { actorUserId: "__pstest-admin" };

async function cleanup() {
  await db.execute(
    sql`delete from promotion_targets where promotion_id in (select id from promotions where name like '__pstest%')`,
  );
  await db.execute(sql`delete from promotions where name like '__pstest%'`);
  await db.execute(sql`delete from customer_segments where name like '__pstest%'`);
}

let seq = 0;
async function mkPromo(over: Partial<NewPromotionRow>): Promise<PromotionRow> {
  seq += 1;
  return promotionService.insert({
    name: `__pstest-${seq}`,
    trigger_kind: "code",
    code: `PSTEST${RUN}${seq}`.toUpperCase(),
    scope: "cart",
    discount_type: "percent",
    discount_value: 10,
    is_active: true,
    ...over,
  } as NewPromotionRow);
}

const CODE_RE = /^[A-Za-z0-9_-]+$/; // the admin form's coupon-code shape
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/; // the admin form's URL-slug shape

async function main() {
  await cleanup();

  const created: string[] = [];
  bus.on("promotion.created", (e) => {
    created.push(e.payload.promotionId);
  });

  // ── 1) DUPLICATE workflow ──────────────────────────────────────────────────
  console.log("duplicate workflow:");
  const seg = await segmentService.insert({ name: "__pstest-seg", kind: "manual" } as never);
  const codeSrc = await mkPromo({});
  await promotionService.setTargets(codeSrc.id, [{ target_type: "segment", target_id: seg.id }]);

  const dup1 = await workflows.promotion.duplicate({ promotionId: codeSrc.id }, ACTOR);
  check("code source → duplicate succeeds (no 23514)", dup1.ok);
  if (dup1.ok) {
    const clone = await promotionService.findById(dup1.data.promotionId);
    check("clone is INACTIVE", clone?.is_active === false);
    check("clone keeps the code trigger", clone?.trigger_kind === "code");
    check(
      "clone gets a placeholder `<CODE>-COPIE-XXXX`",
      !!clone?.code && new RegExp(`^${codeSrc.code}-COPIE-[A-Z2-9]{4}$`).test(clone.code),
    );
    check("placeholder passes the form's code shape (≤40, charset)", !!clone?.code && clone.code.length <= 40 && CODE_RE.test(clone.code));
    check("clone name gets « (copie) »", clone?.name === `${codeSrc.name} (copie)`);
    const t = await promotionService.listTargets(dup1.data.promotionId);
    check("clone copies the source targets verbatim", t.length === 1 && t[0].target_type === "segment" && t[0].target_id === seg.id);
    check("promotion.created emitted for the clone", created.includes(dup1.data.promotionId));
    check("workflow result echoes the placeholder code", dup1.data.code === clone?.code);
  }
  const dup2 = await workflows.promotion.duplicate({ promotionId: codeSrc.id }, ACTOR);
  check(
    "duplicating twice → two distinct placeholder codes",
    dup1.ok && dup2.ok && dup1.data.code !== dup2.data.code,
  );

  // A 40-char source code is clipped so the placeholder stays ≤ 40.
  const longSrc = await mkPromo({ code: `PSTEST${RUN}`.toUpperCase().padEnd(40, "X") });
  const dupLong = await workflows.promotion.duplicate({ promotionId: longSrc.id }, ACTOR);
  check(
    "40-char code → placeholder clipped to ≤ 40",
    dupLong.ok && !!dupLong.data.code && dupLong.data.code.length <= 40 && /-COPIE-[A-Z2-9]{4}$/.test(dupLong.data.code),
  );

  // URL source → slug placeholder that satisfies the slug shape + stays unlive.
  const urlSrc = await mkPromo({ trigger_kind: "url", code: null, url_slug: `pstest-${RUN}-early` });
  const dupUrl = await workflows.promotion.duplicate({ promotionId: urlSrc.id }, ACTOR);
  check("url source → duplicate succeeds (no 23514)", dupUrl.ok);
  if (dupUrl.ok) {
    const slug = dupUrl.data.urlSlug ?? "";
    check("url clone slug `<slug>-copie-xxxx` passes the slug shape", slug.startsWith(urlSrc.url_slug ?? "?") && /-copie-[a-z2-9]{4}$/.test(slug) && SLUG_RE.test(slug) && slug.length <= 80);
    check("url clone is not live (inactive)", !(await promotionService.findLiveByUrlSlug(slug)));
    // The placeholder round-trips through the regular edit-save validation.
    const clone = await promotionService.findById(dupUrl.data.promotionId);
    const edit = clone
      ? await workflows.promotion.update(
          {
            promotionId: clone.id,
            name: clone.name,
            triggerKind: "url",
            urlSlug: slug,
            scope: "cart",
            discountType: "percent",
            discountValue: 10,
            isActive: false,
          },
          ACTOR,
        )
      : null;
    check("url clone placeholder slug passes the edit-save validation", !!edit?.ok);
  }

  // AUTO source (with a stray legacy target row) → no targets on the clone.
  const autoSrc = await mkPromo({ trigger_kind: "auto", code: null });
  await promotionService.setTargets(autoSrc.id, [{ target_type: "segment", target_id: seg.id }]);
  const dupAuto = await workflows.promotion.duplicate({ promotionId: autoSrc.id }, ACTOR);
  check("auto source → duplicate succeeds", dupAuto.ok);
  if (dupAuto.ok) {
    const clone = await promotionService.findById(dupAuto.data.promotionId);
    check("auto clone has no code / slug", clone?.code === null && clone?.url_slug === null);
    check("auto clone carries no targets", (await promotionService.listTargets(dupAuto.data.promotionId)).length === 0);
  }

  const dupMissing = await workflows.promotion.duplicate(
    { promotionId: "00000000-0000-7000-8000-000000000000" },
    ACTOR,
  );
  check("unknown promotion → not_found", !dupMissing.ok && dupMissing.error === "not_found");

  // ── 2) /promo/<slug> route handler ─────────────────────────────────────────
  console.log("/promo/<slug> route:");
  const live = await mkPromo({ trigger_kind: "url", code: null, url_slug: `pstest-${RUN}-live` });
  const hit = await promoLanding(
    new NextRequest(`http://localhost/promo/${live.url_slug}`),
    { params: Promise.resolve({ slug: live.url_slug ?? "" }) },
  );
  const cookie = hit.headers.get("set-cookie") ?? "";
  check("live slug → 307", hit.status === 307);
  check("live slug → Location /", hit.headers.get("location") === "/");
  check("live slug → sets gz.promo=<promotion id>", cookie.includes(`gz.promo=${live.id}`));
  check(
    "live slug → cookie is httpOnly, path /, 7-day, SameSite=Lax",
    /HttpOnly/i.test(cookie) && /Path=\//.test(cookie) && /Max-Age=604800/.test(cookie) && /SameSite=Lax/i.test(cookie),
  );

  const miss = await promoLanding(
    new NextRequest(`http://localhost/promo/pstest-${RUN}-nope`),
    { params: Promise.resolve({ slug: `pstest-${RUN}-nope` }) },
  );
  check("unknown slug → 307 to / WITHOUT a cookie", miss.status === 307 && miss.headers.get("location") === "/" && !miss.headers.get("set-cookie"));

  const off = await mkPromo({ trigger_kind: "url", code: null, url_slug: `pstest-${RUN}-off`, is_active: false });
  const offRes = await promoLanding(
    new NextRequest(`http://localhost/promo/${off.url_slug}`),
    { params: Promise.resolve({ slug: off.url_slug ?? "" }) },
  );
  check("inactive promo slug → no cookie", !offRes.headers.get("set-cookie"));

  const junk = await promoLanding(
    new NextRequest("http://localhost/promo/NOT_A_SLUG"),
    { params: Promise.resolve({ slug: "NOT_A_SLUG" }) },
  );
  check("malformed slug → 307 to / without a cookie", junk.status === 307 && !junk.headers.get("set-cookie"));

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
