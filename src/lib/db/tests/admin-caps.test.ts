import "server-only";

/**
 * Admin silent caps & copy (A–Z gap-hunt 2026-09-23, unit p7-admin-caps).
 *
 *  Pure
 *   • source guards: the link-target picker uses the uncapped listAll(); the
 *     guests copy describes the email + téléphone grouping / verified-email claim
 *     and the guests list keyset-paginates with a visible total (no silent cap);
 *     the customer 360 + user detail headers show uncapped counts.
 *
 *  DB (isolated test DB only)
 *   • attributeService.listProductsUsingAttribute → { rows, total }: a product
 *     reached via a value AND a scalar counts once, soft-deleted products never,
 *     rows are the first N by name and `total` stays the true distinct count.
 *
 * Self-cleaning. Run (isolated DB):
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… EMAIL_PROVIDER=console \
 *     pnpm exec tsx --conditions=react-server src/lib/db/tests/admin-caps.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { like, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import {
  product_attribute_assignments,
  product_attribute_scalars,
  product_attributes,
} from "@/modules/catalog/attribute/schema";
import { attributeService } from "@/modules/catalog/attribute/service";

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

const TAG = "zztest-admcaps";
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/* ─────────────────────────────── pure ─────────────────────────────── */

function pure() {
  console.log("source guards:");
  const linkTargets = read("src/lib/api/link-targets.ts");
  check(
    "link-target picker lists ALL brands (no 500 cap)",
    /brandService\.listAll\(\)/.test(linkTargets) &&
      !/Service\.list\(\{[^}]*limit:\s*500/.test(linkTargets),
  );
  check(
    "link-target picker keeps the is_active filter",
    /brands\.filter\(\(b\) => b\.is_active\)/.test(linkTargets),
  );
  const guests = read("src/app/admin/customers/guests/page.tsx");
  check(
    "guests copy: grouped by email + téléphone, attached via the same (verified) email",
    /regroupées par email \+ téléphone/.test(guests) &&
      /vérifié avec le même email/.test(guests) &&
      !/regroupées par numéro de téléphone/.test(guests),
  );
  // The guests list no longer silently caps: it was reworked from a static
  // "most-recent-N" list into a KEYSET-paginated browser. The page hands a bounded
  // first page + the next cursor to GuestsBrowser, which pages Prev/Next and shows
  // the "X–Y sur TOTAL" range — so the operator can reach every guest AND sees the
  // full count (a stronger anti-silent-truncation guarantee than stating a cap).
  const guestsBrowser = read("src/app/admin/customers/guests/guests-browser.tsx");
  check(
    "guests list is keyset-paginated with a visible total (no silent cap)",
    /<GuestsBrowser/.test(guests) &&
      /initialNextCursor=\{list\.nextCursor\}/.test(guests) &&
      /limit:\s*30/.test(guests) &&
      /hasNext/.test(guestsBrowser) &&
      /sur \{stats\.total/.test(guestsBrowser),
  );
  const customer = read("src/app/admin/customers/[id]/page.tsx");
  check(
    "customer 360: orders header uses the uncapped summary count",
    /Commandes \(\$\{summary\.orderCount\}\)/.test(customer) &&
      !/Commandes \(\$\{orders\.length\}\)/.test(customer),
  );
  check(
    "customer 360: « Tout voir » → orders list + audit (?actor=)",
    /\/admin\/orders\?q=/.test(customer) && /\/admin\/system\/audit\?actor=/.test(customer),
  );
  const userPage = read("src/app/admin/users/[id]/page.tsx");
  check(
    "user detail: audit header no longer passes the capped length off as a total + links the full log",
    /nextCursor: moreAudit/.test(userPage) && /\/admin\/system\/audit\?actor=/.test(userPage),
  );
}

/* ──────────────────────────── attribute usage ──────────────────────────── */

async function attributeUsage() {
  console.log("listProductsUsingAttribute:");
  const cleanup = async () => {
    await db.execute(
      sql`delete from product_attribute_assignments where product_id in (select id from products where slug like ${TAG + "%"})`,
    );
    await db.execute(
      sql`delete from product_attribute_scalars where product_id in (select id from products where slug like ${TAG + "%"})`,
    );
    await db.delete(products).where(like(products.slug, `${TAG}-%`));
    // Values cascade with their attribute.
    await db.delete(product_attributes).where(like(product_attributes.slug, `${TAG}%`));
  };
  await cleanup();
  try {
    const attr = await attributeService.insertAttribute({
      slug: `${TAG}-attr`,
      name: `${TAG} Attr`,
      kind: "multiselect",
    });
    const value = await attributeService.insertValue({
      attribute_id: attr.id,
      slug: `${TAG}-v`,
      label: "V",
    });
    const mk = async (suffix: string, name: string, deleted = false) => {
      const [p] = await db
        .insert(products)
        .values({
          slug: `${TAG}-${suffix}`,
          name,
          price_cents: 1000,
          ...(deleted ? { deleted_at: new Date() } : {}),
        } as never)
        .returning({ id: products.id });
      return p.id;
    };
    // Names chosen so the DB order is unambiguous (plain ASCII, distinct).
    const pA = await mk("a", `${TAG} A value`);
    const pB = await mk("b", `${TAG} B scalar`);
    const pC = await mk("c", `${TAG} C both`);
    const pD = await mk("d", `${TAG} D deleted`, true);
    await db.insert(product_attribute_assignments).values([
      { product_id: pA, attribute_value_id: value.id },
      { product_id: pC, attribute_value_id: value.id },
      { product_id: pD, attribute_value_id: value.id },
    ] as never);
    await db.insert(product_attribute_scalars).values([
      { product_id: pB, attribute_id: attr.id, text_value: "x" },
      { product_id: pC, attribute_id: attr.id, text_value: "y" },
    ] as never);

    const all = await attributeService.listProductsUsingAttribute(attr.id);
    check("total = distinct LIVE products (value ∪ scalar, deleted excluded)", all.total === 3);
    check(
      "each product listed once (value + scalar product not duplicated)",
      all.rows.length === 3 && new Set(all.rows.map((r) => r.id)).size === 3,
    );
    check("soft-deleted product never listed", !all.rows.some((r) => r.id === pD));

    const capped = await attributeService.listProductsUsingAttribute(attr.id, 2);
    check("capped: rows = limit, total stays the true count", capped.rows.length === 2 && capped.total === 3);
    check(
      "capped: the FIRST products by name (deterministic, not an arbitrary subset)",
      capped.rows.map((r) => r.id).join(",") === [pA, pB].join(","),
    );

    const none = await attributeService.listProductsUsingAttribute(
      (await attributeService.insertAttribute({ slug: `${TAG}-empty`, name: `${TAG} Empty`, kind: "text" })).id,
    );
    check("unused attribute → { rows: [], total: 0 }", none.rows.length === 0 && none.total === 0);
  } finally {
    await cleanup();
  }
}

async function main() {
  pure();
  await attributeUsage();

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
