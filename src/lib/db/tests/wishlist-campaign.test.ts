import "server-only";

/**
 * « Campagne liste d'envies » auto-campaign runner (Phase E3) — the owner's
 * cross-data campaign (promo on a customer's wishlist items, targeted by a segment
 * that can carry an anniversary rule). Against a live DB through the real runner.
 *
 *   guards — skipped when the flow is off / no segment / no code / code not live;
 *   happy  — emails a segment member WHO HAS a wishlist (personalized), skips a
 *            member with no wishlist, and DEDUPS on a re-run within the same month.
 *
 * Self-cleaning (`__wcamp…`). Run:
 *   export DATABASE_URL=$(grep ^DATABASE_URL= .env.development.local|cut -d= -f2-)
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/wishlist-campaign.test.ts
 */
import "@/events/subscribers";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { segmentService } from "@/modules/customer/segment.service";
import { promotionService } from "@/modules/promotion";
import { wishlistService } from "@/modules/wishlist";
import { products } from "@/modules/catalog/product/schema";
import { runWishlistCampaignEmails } from "@/lib/mailing/wishlist-campaign/run";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__wcamp";
const SEG_KEY = "mail.wishlist_campaign_segment_id";
const CODE_KEY = "mail.wishlist_campaign_code";

async function setSetting(key: string, value: string | null) {
  if (value == null) {
    await db.execute(sql`delete from site_settings where key = ${key}`);
    return;
  }
  await db.execute(
    sql`insert into site_settings (key, value, type, label) values (${key}, ${value}, 'text', ${key})
        on conflict (key) do update set value = ${value}`,
  );
}

async function cleanup() {
  await db.execute(sql`delete from mailing_sends where flow_key = 'wishlist_campaign' and dedup_key like ${TAG + "%"}`);
  await db.execute(sql`delete from email_flows where flow_key = 'wishlist_campaign'`);
  await setSetting(SEG_KEY, null);
  await setSetting(CODE_KEY, null);
  await db.execute(sql`delete from wishlist_items where wishlist_id in (select id from wishlists where user_id like ${TAG + "%"})`);
  await db.execute(sql`delete from wishlists where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from customer_segment_members where segment_id in (select id from customer_segments where name like ${TAG + "%"})`);
  await db.execute(sql`delete from customer_segments where name like ${TAG + "%"}`);
  await db.execute(sql`delete from customer_user_links where user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from customer_profiles where last_name = ${TAG}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
  await db.execute(sql`delete from promotions where name like ${TAG + "%"}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

async function main() {
  await cleanup();
  // Enable the flow (default is off) — one insert; isFlowEnabled populates its
  // cache from here on the first call.
  await db.execute(sql`insert into email_flows (flow_key, is_enabled) values ('wishlist_campaign', true) on conflict (flow_key) do update set is_enabled = true`);

  // ── guard: no segment configured ──
  const noSeg = await runWishlistCampaignEmails();
  check("skip: no segment configured", noSeg.status === "skipped" && noSeg.summary.includes("segment"));

  // A dynamic segment: marketing-opted-in customers.
  const seg = await segmentService.insert({
    name: `${TAG}-seg`,
    kind: "dynamic",
    rule_tree: { op: "and", children: [{ kind: "marketing_opted_in" }] },
    enabled: true,
  } as never);
  await setSetting(SEG_KEY, seg.id);

  const noCode = await runWishlistCampaignEmails();
  check("skip: no code configured", noCode.status === "skipped" && noCode.summary.includes("code"));

  await setSetting(CODE_KEY, "__WCAMPNOPE");
  const badCode = await runWishlistCampaignEmails();
  check("skip: code not live", badCode.status === "skipped" && badCode.summary.includes("introuvable"));

  // A live code promo.
  const promo = await promotionService.insert({
    name: `${TAG}-promo`,
    trigger_kind: "code",
    code: "__WCAMPGIFT",
    scope: "cart",
    discount_type: "percent",
    discount_value: 20,
    is_active: true,
  } as never);
  await setSetting(CODE_KEY, promo.code!);

  // A published product for the wishlist.
  const [prod] = await db
    .insert(products)
    .values({ slug: `${TAG}-prod`, name: `${TAG} Montre`, price_cents: 50_000, stock_qty: 5, in_stock: true, is_published: true } as never)
    .returning({ id: products.id });

  // Member A — opted in, WITH a wishlist containing the product.
  const A = `${TAG}-a`;
  await authService.insert({ id: A, email: `${A}@example.test`, name: A, role: "customer" } as never);
  const profA = await customerService.insertProfile({ first_name: "Aline", last_name: TAG, marketing_opt_in: true } as never);
  await customerUserLink.create({ customer_profile_id: profA.id, user_id: A } as never);
  const wlA = await wishlistService.createForUser(A);
  await wishlistService.addItem(wlA.id, prod.id);

  // Member B — opted in, NO wishlist.
  const B = `${TAG}-b`;
  await authService.insert({ id: B, email: `${B}@example.test`, name: B, role: "customer" } as never);
  const profB = await customerService.insertProfile({ first_name: "Bilel", last_name: TAG, marketing_opt_in: true } as never);
  await customerUserLink.create({ customer_profile_id: profB.id, user_id: B } as never);

  // ── happy: A (wishlist) gets an email; B (no wishlist) is skipped ──
  const run1 = await runWishlistCampaignEmails();
  check("happy: run ok (not skipped)", run1.ok === true && run1.status !== "skipped");
  check("happy: exactly 1 email queued (A has a wishlist, B doesn't)", /:\s*1 email/.test(run1.summary));
  const [{ n: sendsA }] = (await db.execute(sql`select count(*)::int as n from mailing_sends where flow_key = 'wishlist_campaign' and dedup_key like ${profA.id + ":%"}`)).rows as Array<{ n: number }>;
  check("happy: A has a mailing_sends claim", Number(sendsA) === 1);
  const [{ n: sendsB }] = (await db.execute(sql`select count(*)::int as n from mailing_sends where flow_key = 'wishlist_campaign' and dedup_key like ${profB.id + ":%"}`)).rows as Array<{ n: number }>;
  check("happy: B (no wishlist) has NO claim", Number(sendsB) === 0);

  // ── dedup: a re-run this month sends 0 more ──
  const run2 = await runWishlistCampaignEmails();
  check("dedup: re-run within the month queues 0", /:\s*0 email/.test(run2.summary));

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try { await cleanup(); } catch { /* best-effort */ }
    process.exit(1);
  })
  .then(() => process.exit(0));
