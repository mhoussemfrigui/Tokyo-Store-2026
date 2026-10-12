import "server-only";

/**
 * ERP integration — the two-way API + outbound-webhook subsystem, end to end.
 * Exercises the real workflows/services against a live DB (needs the isolated
 * tokyo schema at 0118+): customer upsert-by-externalRef + LINKING an existing
 * profile + incremental read, order PUSH (createFromLines: duplicate lines,
 * promo codes, field errors, no leaked ephemeral cart, customer attribution by
 * userId / customerId / customerExternalRef — an explicit identifier that
 * resolves to no account is REFUSED, never a silent guest order), return scoping, the
 * µs keyset walks of the customer/stock/loyalty feeds (same-tx rows, limit=1),
 * the /api/stock route (a SHARED-pool variant ref moves the parent's quantity
 * but only its OWN in_stock flag, reported as variant && pool; an API decrement
 * across the threshold raises the low-stock / rupture alerts, gated on the
 * toggle), and the webhook endpoint/delivery queue + HMAC signing. Also a STATIC
 * guard: every fail code an external API route can surface maps to a non-500
 * status.
 *
 * Run: pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *        src/lib/db/tests/erp-api.test.ts
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";

// The webhook endpoint secret is encrypted at rest; supply a key if the env
// doesn't already carry one (encryptSecret reads it at call time, not import).
process.env.PAYMENT_ENCRYPTION_KEY ||= "erp-test-encryption-key-000000000001";

import { db } from "@/lib/db/client";
import { workflows } from "@/workflows";
import { customerService } from "@/modules/customer/service";
import { customer_profiles } from "@/modules/customer/schema";
import { productService } from "@/modules/catalog/product/service";
import { stockMovementService } from "@/modules/stock-movement";
import { orderService } from "@/modules/order/service";
import { order_returns } from "@/modules/order/returns.schema";
import { carts } from "@/modules/cart/schema";
import { keysetCursor } from "@/lib/api/keyset";
import { webhookEndpointService, signWebhookBody, verifyWebhookSignature } from "@/modules/webhook-endpoints";
import { webhook_deliveries } from "@/modules/webhook-endpoints/schema";
import { workflowErrorStatus } from "@/lib/api-auth/enforce";
import { parseIncrementalCursor } from "@/lib/api/cursor";
import { GET as stockGET, PATCH as stockPATCH } from "@/app/api/stock/route";
import { apiKeyService } from "@/modules/api-key";
import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { serializeOrder } from "@/lib/api/orders";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { bus, type EventPayload } from "@/events/bus";

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

const TAG = `__erptest-${Date.now()}`;

// Local read-back helper for the delivery-queue assertions (the production read
// path is the admin `listRecent`; a by-id read is only needed by this test).
const readDelivery = async (id: string) =>
  (await db.select().from(webhook_deliveries).where(eq(webhook_deliveries.id, id)).limit(1))[0] ?? null;

async function cleanup() {
  await db.execute(sql`delete from webhook_deliveries where event_name like '__erptest%'`);
  await db.execute(sql`delete from webhook_endpoints where name like '__erptest%'`);
  await db.execute(sql`delete from customer_profiles where external_ref like '__erptest%' or last_name like '__erptest%'`);
  await db.execute(sql`delete from products where sku like '__erptest%'`);
  await db.execute(sql`delete from stock_movements where note like '__erptest%'`);
  await db.execute(sql`delete from order_returns where comment like '__erptest%'`);
  await db.execute(
    sql`delete from rate_limit_buckets where bucket_key in (select 'apikey:' || id::text from api_keys where name like '__erptest%')`,
  );
  await db.execute(sql`delete from api_keys where name like '__erptest%'`);
  await db.execute(sql`delete from customer_user_links where user_id like '__erptest%'`);
  await db.execute(sql`delete from user_roles where user_id like '__erptest%'`);
  await db.execute(sql`delete from users where id like '__erptest%'`);
}

// The two low-stock alert settings the /api/stock section flips — saved before,
// restored after (and on a crash), so a shared test DB keeps its config.
const STOCK_ALERT_KEYS = ["stock.alert_enabled", "stock.low_threshold_qty"] as const;
let savedStockAlertSettings: Map<string, string | null> | null = null;
async function putSetting(key: string, value: string) {
  await db.execute(
    sql`insert into site_settings (key, value, label) values (${key}, ${value}, ${TAG}) on conflict (key) do update set value = excluded.value`,
  );
}
async function restoreStockAlertSettings() {
  if (!savedStockAlertSettings) return;
  for (const key of STOCK_ALERT_KEYS) {
    if (savedStockAlertSettings.has(key)) {
      await db.execute(sql`update site_settings set value = ${savedStockAlertSettings.get(key) ?? null} where key = ${key}`);
    } else {
      await db.execute(sql`delete from site_settings where key = ${key}`);
    }
  }
  savedStockAlertSettings = null;
}

/**
 * Walk an incremental feed page by page (the way an ERP does) from `startIso`,
 * feeding `nextSince`/`nextId` back verbatim, until an EMPTY page. `terminated`
 * is false if the guard ran out — i.e. the cursor stopped advancing (the
 * ms-truncation fixed point this suite guards against).
 */
async function walkFeed(
  page: (
    sinceIso?: string,
    sinceId?: string,
  ) => Promise<{ items: { id: string }[]; nextSince: string | null; nextId: string | null }>,
  startIso?: string,
): Promise<{ ids: string[]; cursors: string[]; terminated: boolean }> {
  const ids: string[] = [];
  const cursors: string[] = [];
  let sinceIso = startIso;
  let sinceId: string | undefined;
  for (let i = 0; i < 500; i++) {
    const p = await page(sinceIso, sinceId);
    if (p.items.length === 0) return { ids, cursors, terminated: p.nextSince === null };
    ids.push(...p.items.map((x) => x.id));
    if (p.nextSince) cursors.push(p.nextSince);
    sinceIso = p.nextSince ?? undefined;
    sinceId = p.nextId ?? undefined;
  }
  return { ids, cursors, terminated: false };
}

/**
 * STATIC: every `fail("<code>"` (and custom-error code) in the workflows an
 * EXTERNAL API route calls — plus the workflow files they import — must map to
 * a non-500 status. A business rejection that falls to `default: 500` reads to
 * an ERP as a transient server fault it retries forever (invalid_transition,
 * refund_required and has_variants once did). `internal` is the one true 500.
 */
function apiReachableFailCodes(): {
  calls: string[];
  unresolved: string[];
  files: string[];
  codes: Map<string, string>;
} {
  const ROOT = process.cwd();
  const WF_DIR = join(ROOT, "src", "workflows");
  const toRel = (f: string) => relative(WF_DIR, f).split(sep).join("/");
  const routeFiles = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) routeFiles(p, out);
      else if (e.name === "route.ts") out.push(p);
    }
    return out;
  };
  // The external boundary = handlers answering through workflowResponse.
  const external = routeFiles(join(ROOT, "src", "app", "api")).filter((f) =>
    readFileSync(f, "utf8").includes("workflowResponse"),
  );
  const calls = new Set<string>();
  for (const f of external) {
    for (const m of readFileSync(f, "utf8").matchAll(/workflows\.(\w+)\.(\w+)/g)) calls.add(`${m[1]}.${m[2]}`);
  }

  // Registry: `ns.name` → imported function → its module path.
  const idx = readFileSync(join(WF_DIR, "index.ts"), "utf8");
  const importPath = new Map<string, string>();
  for (const m of idx.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(\.[^"]+)"/g)) {
    for (const n of m[1].split(",")) if (n.trim()) importPath.set(n.trim(), m[2]);
  }
  const registry = new Map<string, string>();
  let ns: string | null = null;
  for (const line of idx.slice(idx.indexOf("export const workflows = {")).split(/\r?\n/)) {
    const nsHit = /^ {2}(\w+): \{$/.exec(line);
    if (nsHit) ns = nsHit[1];
    const entry = ns ? /^ {4}(\w+): (\w+),?$/.exec(line) : null;
    if (ns && entry) registry.set(`${ns}.${entry[1]}`, entry[2]);
  }
  const resolveTs = (fromDir: string, spec: string): string | null => {
    const base = spec.startsWith("@/workflows/")
      ? join(WF_DIR, spec.slice("@/workflows/".length))
      : spec.startsWith(".")
        ? resolve(fromDir, spec)
        : null;
    if (!base) return null;
    for (const c of [`${base}.ts`, join(base, "index.ts")]) if (existsSync(c)) return c;
    return null;
  };

  const unresolved: string[] = [];
  const queue: string[] = [];
  for (const c of calls) {
    const fn = registry.get(c);
    const spec = fn ? importPath.get(fn) : undefined;
    const file = spec ? resolveTs(WF_DIR, spec) : null;
    if (file) queue.push(file);
    else unresolved.push(c);
  }
  // Files whose codes never reach the API as-is because the importer TRANSLATES
  // them: transition-status maps gateway-payment's CancelSafety codes to
  // payment_unverified | conflict (and never calls its payment workflows).
  const TRANSLATED_BY_CALLER = new Set(["order/gateway-payment.ts"]);
  const files = new Set<string>();
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (files.has(f) || TRANSLATED_BY_CALLER.has(toRel(f))) continue;
    files.add(f);
    for (const m of readFileSync(f, "utf8").matchAll(/from\s*"([^"]+)"/g)) {
      const r = resolveTs(dirname(f), m[1]);
      if (r && r.startsWith(WF_DIR)) queue.push(r);
    }
  }

  const codes = new Map<string, string>(); // code → first file it was seen in
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const add = (code: string) => {
      if (!codes.has(code)) codes.set(code, toRel(f));
    };
    for (const m of src.matchAll(/\bfail\(\s*"([a-z_]+)"/g)) add(m[1]);
    // Sentinel error classes thrown + mapped back via fail(err.code, …):
    // literal constructor codes AND the declared `code:` union (covers codes
    // passed through a variable, e.g. place-order's min/max_purchase_qty).
    for (const m of src.matchAll(/new \w+Error\(\s*"([a-z_]+)"/g)) add(m[1]);
    for (const u of src.matchAll(/code:\s*\|\s*"[a-z_]+"(?:\s*\|\s*"[a-z_]+")*/g)) {
      for (const m of u[0].matchAll(/"([a-z_]+)"/g)) add(m[1]);
    }
  }
  return { calls: [...calls], unresolved, files: [...files].map(toRel), codes };
}

async function main() {
  await cleanup();

  // ── HTTP status mapping for order/refund business rejections (no DB) ──────
  // A business rejection an ERP can act on must be a 4xx, NEVER a 500 it retries
  // forever. Pins the codes the order-push (placeOrderWorkflow) + refund paths
  // propagate through `workflowErrorStatus`.
  {
    for (const code of ["out_of_stock", "product_unavailable", "promotion_expired", "not_paid", "fully_refunded"]) {
      check(`${code} → 409`, workflowErrorStatus(code) === 409);
    }
    for (const code of ["empty_cart", "min_order", "min_purchase_qty", "max_purchase_qty", "account_required"]) {
      check(`${code} → 422`, workflowErrorStatus(code) === 422);
    }
    // Current-state conflicts on the status / product-type paths (were 500s).
    for (const code of ["invalid_transition", "refund_required", "has_variants"]) {
      check(`${code} → 409`, workflowErrorStatus(code) === 409);
    }
    check("validation → 400 (unchanged)", workflowErrorStatus("validation") === 400);
    check("not_found → 404 (unchanged)", workflowErrorStatus("not_found") === 404);
    check("an unmapped code still → 500 (default preserved)", workflowErrorStatus("totally_unknown") === 500);
  }

  // ── STATIC: no API-reachable fail code falls through to a 500 ─────────────
  {
    const { calls, unresolved, files, codes } = apiReachableFailCodes();
    check(
      unresolved.length === 0
        ? `static: every API workflow call resolved to a file (${calls.length} calls)`
        : `static: UNRESOLVED workflow calls: ${unresolved.join(", ")}`,
      unresolved.length === 0 && calls.length >= 20,
    );
    check(
      `static: parser sees the API workflows (${files.length} files, ${codes.size} codes)`,
      files.includes("order/transition-status.ts") &&
        files.includes("order/place-order.ts") &&
        codes.has("has_variants") &&
        codes.has("max_purchase_qty"),
    );
    codes.delete("internal"); // the one genuine server fault
    const unmapped = [...codes].filter(([code]) => workflowErrorStatus(code) === 500);
    check(
      unmapped.length === 0
        ? "static: every API-reachable fail code maps to a non-500 status"
        : `static: UNMAPPED (→ 500): ${unmapped.map(([c, f]) => `${c} (${f})`).join(", ")}`,
      unmapped.length === 0,
    );
  }

  // ── Incremental-cursor limit default (absent/blank → 50, not clamped to 1) ─
  {
    const absent = parseIncrementalCursor(new URLSearchParams(""));
    check("cursor: absent limit → 50 (not 1)", absent.ok && absent.limit === 50);
    const blank = parseIncrementalCursor(new URLSearchParams("limit="));
    check("cursor: blank limit → 50", blank.ok && blank.limit === 50);
    const explicit = parseIncrementalCursor(new URLSearchParams("limit=10"));
    check("cursor: explicit limit honored", explicit.ok && explicit.limit === 10);
    const over = parseIncrementalCursor(new URLSearchParams("limit=99999"), 200);
    check("cursor: over-max limit clamped to maxLimit", over.ok && over.limit === 200);
    const bad = parseIncrementalCursor(new URLSearchParams("since=not-a-date"));
    check("cursor: malformed since → clean error", !bad.ok);
  }

  // ── Customer upsert-by-externalRef ───────────────────────────────────────
  {
    const ref = `${TAG}-C1`;
    const created = await workflows.customer.upsertFromApi(
      { externalRef: ref, firstName: "Erp", lastName: "One", phone: "+21620111222" },
      { actorUserId: "erp-key", mustExist: false },
    );
    check("customer upsert CREATE ok + created flag", created.ok && created.data.created === true);

    const updated = await workflows.customer.upsertFromApi(
      { externalRef: ref, firstName: "Erp2" },
      { actorUserId: "erp-key", mustExist: false },
    );
    check(
      "customer upsert UPDATE hits the same profile (created=false)",
      updated.ok && updated.data.created === false && updated.data.customerId === (created.ok ? created.data.customerId : ""),
    );

    const byRef = await customerService.findByExternalRef(ref);
    check("findByExternalRef resolves the upserted profile + applied patch", byRef?.first_name === "Erp2");
    check("phone normalized on insert", byRef?.phone_normalized === "21620111222");

    const patchMissing = await workflows.customer.upsertFromApi(
      { externalRef: `${TAG}-NOPE`, firstName: "x" },
      { actorUserId: "erp-key", mustExist: true },
    );
    check("PATCH (mustExist) on an unknown ref → not_found", !patchMissing.ok && patchMissing.error === "not_found");

    // Incremental list returns the profile with an ASC (updated_at,id) cursor.
    // settleSeconds: 0 — the rows were JUST written (the feed holds back rows
    // younger than the settle window by default).
    const list = await customerService.listForApi({ limit: 100, settleSeconds: 0 });
    check("listForApi returns items + a forward cursor", list.items.length > 0 && !!list.nextSince);
    check("customer cursor is µs-precise", !!list.nextSince && /\.\d{6}Z$/.test(list.nextSince));
  }

  // ── Customer LINK: an existing (storefront) profile gets the ERP ref ─────
  {
    // A storefront signup's profile: exists, orders/coins hang off it, no ref.
    const store = await customerService.insertProfile({ first_name: "Store", last_name: TAG } as never);
    const ref = `${TAG}-LINK`;
    const linked = await workflows.customer.upsertFromApi(
      { id: store.id, externalRef: ref },
      { actorUserId: "erp-key", mustExist: true },
    );
    check(
      "PUT {id, externalRef} on an unlinked profile STAMPS the link",
      linked.ok && linked.data.customerId === store.id && linked.data.externalRef === ref && !linked.data.created,
    );
    check("link persisted (findByExternalRef → the same profile)", (await customerService.findByExternalRef(ref))?.id === store.id);

    const before = (await customerService.findProfileById(store.id))?.updated_at.getTime();
    const again = await workflows.customer.upsertFromApi(
      { id: store.id, externalRef: ref },
      { actorUserId: "erp-key", mustExist: true },
    );
    const after = (await customerService.findProfileById(store.id))?.updated_at.getTime();
    check("re-sending the same link is an idempotent success", again.ok && again.data.externalRef === ref);
    check("…and writes nothing (updated_at untouched → no phantom sync change)", before !== undefined && before === after);

    const relink = await workflows.customer.upsertFromApi(
      { id: store.id, externalRef: `${TAG}-OTHER` },
      { actorUserId: "erp-key", mustExist: true },
    );
    check(
      "re-linking to a DIFFERENT ref → conflict (already_linked), never a silent re-link",
      !relink.ok && relink.error === "conflict" && relink.fieldErrors?.externalRef === "already_linked",
    );
    check("…the original link is intact", (await customerService.findByExternalRef(ref))?.id === store.id);

    // A ref already owned by ANOTHER profile → the unique index → clean conflict.
    const other = await customerService.insertProfile({ first_name: "Other", last_name: TAG } as never);
    const steal = await workflows.customer.upsertFromApi(
      { id: other.id, externalRef: ref },
      { actorUserId: "erp-key", mustExist: true },
    );
    check("linking a ref owned by another profile → conflict (not internal)", !steal.ok && steal.error === "conflict");

    // A calendar-invalid birthday is a clean validation (was a 22008 → 500).
    const badBday = await workflows.customer.upsertFromApi(
      { id: store.id, birthday: "2025-02-30" },
      { actorUserId: "erp-key", mustExist: true },
    );
    check(
      "birthday 2025-02-30 → validation with fieldErrors.birthday",
      !badBday.ok && badBday.error === "validation" && !!badBday.fieldErrors?.birthday,
    );
    const goodBday = await workflows.customer.upsertFromApi(
      { id: store.id, birthday: "2000-02-29" },
      { actorUserId: "erp-key", mustExist: true },
    );
    check("a real leap-day birthday is accepted", goodBday.ok);
  }

  // ── Customer feed: same-tx rows paged at limit=1 (µs keyset) ─────────────
  {
    // One multi-row insert → all three share the SAME updated_at (one now()).
    const rows = await db
      .insert(customer_profiles)
      .values([1, 2, 3].map((i) => ({ first_name: `Batch${i}`, last_name: TAG })))
      .returning({ id: customer_profiles.id });
    const mine = new Set(rows.map((r) => r.id));
    const [start] = await db
      .select({ c: keysetCursor(customer_profiles.updated_at) })
      .from(customer_profiles)
      .where(eq(customer_profiles.id, rows[0].id));
    const hidden = await customerService.listForApi({ sinceIso: start.c, limit: 200 });
    check("settle window holds back just-written customers", !hidden.items.some((p) => mine.has(p.id)));
    const w = await walkFeed(
      (sinceIso, sinceId) => customerService.listForApi({ sinceIso, sinceId, limit: 1, settleSeconds: 0 }),
      start.c,
    );
    const seen = w.ids.filter((id) => mine.has(id));
    check("customer feed: same-timestamp rows each delivered EXACTLY once at limit=1", seen.length === 3 && new Set(seen).size === 3);
    check("customer feed: walk ends on an empty page (cursor never stalls)", w.terminated);
    check("customer feed: every cursor is µs-precise", w.cursors.length > 0 && w.cursors.every((c) => /\.\d{6}Z$/.test(c)));
  }

  // ── Order PUSH (createFromLines) ─────────────────────────────────────────
  {
    const sku = `${TAG}-W1`;
    const widget = await productService.insert({
      name: "ERP Widget",
      slug: `${TAG}-widget`,
      sku,
      price_cents: 50000,
      is_published: true,
      product_type: "simple",
      short_desc: "",
      description: "",
      in_stock: true,
      stock_qty: 10,
    } as never);

    const oref = `${TAG}-O1`;
    const placed = await workflows.order.createFromLines(
      {
        externalRef: oref,
        contactEmail: "erp@buyer.tn",
        shipping: { fullName: "ERP Buyer", streetLine1: "1 rue", city: "Tunis" },
        lines: [{ sku, quantity: 2 }],
        deliveryMethod: "in_store",
        paymentChannel: "cod",
      } as never,
      { actorUserId: "erp-key" },
    );
    check("order push (createFromLines by sku) succeeds", placed.ok);
    check("created order carries the ERP externalRef", placed.ok && placed.data.externalRef === oref);

    const dup = await workflows.order.createFromLines(
      {
        externalRef: oref, // reuse → conflict
        contactEmail: "erp@buyer.tn",
        shipping: { fullName: "ERP Buyer", streetLine1: "1 rue", city: "Tunis" },
        lines: [{ sku, quantity: 1 }],
        deliveryMethod: "in_store",
        paymentChannel: "cod",
      } as never,
      { actorUserId: "erp-key" },
    );
    check("duplicate externalRef on push → conflict (not a place-then-fail)", !dup.ok && dup.error === "conflict");

    const badRef = await workflows.order.createFromLines(
      {
        contactEmail: "erp@buyer.tn",
        shipping: { fullName: "B", streetLine1: "1", city: "Tunis" },
        lines: [{ sku: `${TAG}-UNKNOWN` }],
        deliveryMethod: "in_store",
        paymentChannel: "cod",
      } as never,
      { actorUserId: "erp-key" },
    );
    check("push with an unknown product ref → validation", !badRef.ok && badRef.error === "validation");

    // Customer attribution. The customers API hands the ERP the PROFILE id (+ its
    // externalRef + the account `userId`); any of them attaches the sale to the
    // linked account. An explicit identifier that resolves to no account used to
    // place a silent GUEST order behind a 201 — now a validation 4xx.
    {
      const CU = `${TAG}-cust`;
      await authService.insert({ id: CU, email: `${CU}@example.test`, name: CU, role: "customer", emailVerified: true } as never);
      const linkedProfile = await customerService.insertProfile({
        first_name: "Linked",
        last_name: TAG,
        external_ref: `${TAG}-CREF`,
      } as never);
      await customerUserLink.create({ user_id: CU, customer_profile_id: linkedProfile.id });
      const standalone = await customerService.insertProfile({
        first_name: "Standalone",
        last_name: TAG,
        external_ref: `${TAG}-SREF`,
      } as never);
      const push = (extra: Record<string, unknown>) =>
        workflows.order.createFromLines(
          {
            contactEmail: "erp@buyer.tn",
            shipping: { fullName: "ERP Buyer", streetLine1: "1 rue", city: "Tunis" },
            lines: [{ sku, quantity: 1 }],
            deliveryMethod: "in_store",
            paymentChannel: "cod",
            ...extra,
          } as never,
          { actorUserId: "erp-key" },
        );

      const byProfile = await push({ customerId: linkedProfile.id });
      const byProfileRow = byProfile.ok ? await orderService.findById(byProfile.data.orderId) : null;
      check("push { customerId: profile id } → attached to the LINKED account", byProfileRow?.user_id === CU);
      check("…and the order feed exposes it as userId (joins ApiCustomer.userId)", !!byProfileRow && serializeOrder(byProfileRow).userId === CU);

      const byRef = await push({ customerExternalRef: `${TAG}-CREF` });
      const byRefRow = byRef.ok ? await orderService.findById(byRef.data.orderId) : null;
      check("push { customerExternalRef } → attached to the linked account", byRefRow?.user_id === CU);

      const unknownUser = await push({ userId: `${TAG}-nobody` });
      check(
        "push { userId: unknown } → validation (fieldErrors.userId), NOT a silent guest order",
        !unknownUser.ok && unknownUser.error === "validation" && !!unknownUser.fieldErrors?.userId,
      );
      const unknownProfile = await push({ customerId: randomUUID() });
      check(
        "push { customerId: unknown uuid } → validation (fieldErrors.customerId)",
        !unknownProfile.ok && unknownProfile.error === "validation" && !!unknownProfile.fieldErrors?.customerId,
      );
      const unlinked = await push({ customerId: standalone.id });
      check(
        "push { customerId: standalone profile (no account) } → validation, not a guest downgrade",
        !unlinked.ok && unlinked.error === "validation" && !!unlinked.fieldErrors?.customerId,
      );
      const twoIds = await push({ userId: CU, customerId: linkedProfile.id });
      check(
        "push with TWO customer identifiers → validation (one at a time)",
        !twoIds.ok && twoIds.error === "validation" && !!twoIds.fieldErrors?.userId && !!twoIds.fieldErrors?.customerId,
      );
      if (placed.ok) {
        const guest = await orderService.findById(placed.data.orderId);
        check("a push with NO customer identifier stays a guest order (userId null)", !!guest && serializeOrder(guest).userId === null);
      }
    }

    // The sale is ledgered — the movement reader surfaces it (settle window off:
    // the row was just written).
    const moves = await stockMovementService.listForApi({ productId: widget.id, limit: 200, settleSeconds: 0 });
    check("stock movement reader returns the sale decrement", moves.items.some((m) => m.reason === "order" && m.delta < 0));

    // Two lines resolving to the SAME product (same SKU twice / sku + id) are
    // merged into one line — not a cart_items unique-violation 409.
    const DUP_ACTOR = `${TAG}-dup`;
    const merged = await workflows.order.createFromLines(
      {
        contactEmail: "erp@buyer.tn",
        shipping: { fullName: "ERP Buyer", streetLine1: "1 rue", city: "Tunis" },
        lines: [
          { sku, quantity: 1 },
          { productId: widget.id, quantity: 2 },
        ],
        deliveryMethod: "in_store",
        paymentChannel: "cod",
      } as never,
      { actorUserId: DUP_ACTOR },
    );
    check("push with two lines for the same product succeeds", merged.ok);
    const mergedItems = merged.ok ? await orderService.listItems(merged.data.orderId) : [];
    check("…as ONE order line with the summed quantity (3)", mergedItems.length === 1 && mergedItems[0].quantity === 3);

    // Unknown / expired promo code → refused, not a silent full-price order.
    const badPromo = await workflows.order.createFromLines(
      {
        contactEmail: "erp@buyer.tn",
        shipping: { fullName: "ERP Buyer", streetLine1: "1 rue", city: "Tunis" },
        lines: [{ sku, quantity: 1 }],
        deliveryMethod: "in_store",
        paymentChannel: "cod",
        promotionCode: `${TAG}-NOPROMO`,
      } as never,
      { actorUserId: DUP_ACTOR },
    );
    check(
      "unknown promotionCode → validation with fieldErrors.promotionCode",
      !badPromo.ok && badPromo.error === "validation" && !!badPromo.fieldErrors?.promotionCode,
    );

    // Schema failure names the offending field.
    const noEmail = await workflows.order.createFromLines(
      {
        shipping: { fullName: "ERP Buyer", streetLine1: "1 rue", city: "Tunis" },
        lines: [{ sku, quantity: 1 }],
        paymentChannel: "cod",
      } as never,
      { actorUserId: DUP_ACTOR },
    );
    check(
      "schema failure → validation with fieldErrors (contactEmail)",
      !noEmail.ok && noEmail.error === "validation" && !!noEmail.fieldErrors?.contactEmail,
    );

    // A placement that FAILS after the ephemeral cart exists (over-stock).
    const tooMany = await workflows.order.createFromLines(
      {
        contactEmail: "erp@buyer.tn",
        shipping: { fullName: "ERP Buyer", streetLine1: "1 rue", city: "Tunis" },
        lines: [{ sku, quantity: 999 }],
        deliveryMethod: "in_store",
        paymentChannel: "cod",
      } as never,
      { actorUserId: DUP_ACTOR },
    );
    check("over-stock push is refused (4xx code, not internal)", !tooMany.ok && tooMany.error !== "internal");
    const leaked = await db
      .select({ id: carts.id })
      .from(carts)
      .where(like(carts.token, `erp\\_${DUP_ACTOR}\\_%`));
    check("no ephemeral erp_ cart survives a success OR a failed placement", leaked.length === 0);

    // Return scoping: a return of order A must not be actionable through order B.
    if (placed.ok && merged.ok) {
      const [ret] = await db
        .insert(order_returns)
        .values({ order_id: placed.data.orderId, status: "pending", comment: TAG })
        .returning({ id: order_returns.id });
      const wrongReject = await workflows.order.rejectReturn(
        { returnId: ret.id, orderId: merged.data.orderId },
        { actorUserId: "erp-key" },
      );
      const wrongReceive = await workflows.order.receiveReturn(
        { returnId: ret.id, orderId: merged.data.orderId },
        { actorUserId: "erp-key" },
      );
      const stillPending = await db
        .select({ status: order_returns.status })
        .from(order_returns)
        .where(and(eq(order_returns.id, ret.id), eq(order_returns.status, "pending")));
      check(
        "reject/receive via ANOTHER order → not_found, return untouched",
        !wrongReject.ok && wrongReject.error === "not_found" &&
          !wrongReceive.ok && wrongReceive.error === "not_found" &&
          stillPending.length === 1,
      );
      const rightReject = await workflows.order.rejectReturn(
        { returnId: ret.id, orderId: placed.data.orderId },
        { actorUserId: "erp-key" },
      );
      check("reject via its OWN order → ok", rightReject.ok);
    } else {
      check("return scoping (setup pushes succeeded)", false);
    }
  }

  // ── Stock-movement feed: same-tx rows paged at limit=1 (µs keyset) ───────
  {
    // Several movements recorded in ONE tx share `now()` — exactly what a
    // variant save / multi-line order does. Isolated by a throwaway product id.
    const pid = randomUUID();
    await db.transaction(async (tx) => {
      for (let i = 0; i < 3; i++) {
        await stockMovementService.record({ productId: pid, delta: -1, reason: "admin", note: TAG }, tx);
      }
    });
    const hidden = await stockMovementService.listForApi({ productId: pid });
    check("settle window holds back just-written movements (default)", hidden.items.length === 0);
    const w = await walkFeed((sinceIso, sinceId) =>
      stockMovementService.listForApi({ productId: pid, sinceIso, sinceId, limit: 1, settleSeconds: 0 }),
    );
    check("stock feed: 3 same-tx rows each delivered EXACTLY once at limit=1", w.ids.length === 3 && new Set(w.ids).size === 3);
    check("stock feed: walk ends on an empty page (cursor never stalls)", w.terminated);
    check("stock feed: every cursor is µs-precise", w.cursors.length === 3 && w.cursors.every((c) => /\.\d{6}Z$/.test(c)));
    const two = await stockMovementService.listForApi({ productId: pid, limit: 2, settleSeconds: 0 });
    const next = await stockMovementService.listForApi({
      productId: pid,
      sinceIso: two.nextSince ?? undefined,
      sinceId: two.nextId ?? undefined,
      limit: 2,
      settleSeconds: 0,
    });
    check(
      "stock feed: limit=2 page 2 returns ONLY the remaining row (boundary never re-sent)",
      next.items.length === 1 && !two.items.some((m) => m.id === next.items[0].id),
    );
  }

  // ── /api/stock: shared-pool variant refs + low-stock alerts on API decrements ─
  {
    const ADM = `${TAG}-stockadm`;
    await authService.insert({ id: ADM, email: `${ADM}@example.test`, name: ADM, emailVerified: true } as never);
    // Access is role-only: the key creator must hold the scope via an RBAC role.
    // requireApiKey re-checks the creator's live perms, so grant super_admin ('*').
    const admSuper = await rbacService.findRoleByKey("super_admin");
    if (admSuper) await rbacService.assignRoleToUser(ADM, admSuper.id);
    const key = await apiKeyService.create({ name: `${TAG}-stock`, scopes: ["full"], expiresAt: null, createdBy: ADM });
    type StockView = { inStock: boolean; stockQty: number | null; pool: boolean; variantId: string | null };
    const call = async (method: "GET" | "PATCH", arg: Record<string, unknown>) => {
      const url =
        method === "GET"
          ? `http://localhost:3000/api/stock?${new URLSearchParams(arg as Record<string, string>).toString()}`
          : "http://localhost:3000/api/stock";
      const req = new Request(url, {
        method,
        headers: { authorization: `Bearer ${key.plaintext}`, "content-type": "application/json" },
        ...(method === "PATCH" ? { body: JSON.stringify({ note: TAG, ...arg }) } : {}),
      });
      const res = method === "GET" ? await stockGET(req) : await stockPATCH(req);
      const json = (await res.json()) as { stock?: StockView };
      return { status: res.status, stock: json.stock };
    };
    const flags = async (productId: string, variantIds: string[]) => {
      const [p] = await db.select({ inStock: products.in_stock, qty: products.stock_qty }).from(products).where(eq(products.id, productId));
      const vs = await db
        .select({ id: product_variants.id, inStock: product_variants.in_stock })
        .from(product_variants)
        .where(inArray(product_variants.id, variantIds));
      return { parent: p, variant: new Map(vs.map((v) => [v.id, v.inStock])) };
    };

    // SHARED-pool variable product: quantity lives on the parent, each variant
    // keeps its own in_stock flag (checkout + the storefront DTO AND them).
    const [sp] = await db
      .insert(products)
      .values({
        name: `${TAG} pool`, slug: `${TAG}-pool`, sku: `${TAG}-SV`, price_cents: 1000, is_published: true,
        product_type: "variable", shared_variant_stock: true, stock_qty: 5, in_stock: true, short_desc: "", description: "",
      } as never)
      .returning({ id: products.id });
    const [red, blue] = await db
      .insert(product_variants)
      .values([
        { product_id: sp.id, sku: `${TAG}-SV-R`, label: "Rouge", price_cents: 1000, stock_qty: null, in_stock: true },
        { product_id: sp.id, sku: `${TAG}-SV-B`, label: "Bleu", price_cents: 1000, stock_qty: null, in_stock: true },
      ] as never)
      .returning({ id: product_variants.id });

    const off = await call("PATCH", { variantSku: `${TAG}-SV-R`, inStock: false });
    let f = await flags(sp.id, [red.id, blue.id]);
    check("stock: shared variant inStock:false → 200, reported inStock false, pool:true", off.status === 200 && off.stock?.inStock === false && off.stock?.pool === true);
    check("…writes the VARIANT's flag only (parent + sibling stay in stock)", f.variant.get(red.id) === false && f.parent.inStock === true && f.variant.get(blue.id) === true);
    const gRed = await call("GET", { variantSku: `${TAG}-SV-R` });
    const gBlue = await call("GET", { variantSku: `${TAG}-SV-B` });
    check("…GET reports the disabled variant inStock false (variant && pool)", gRed.status === 200 && gRed.stock?.inStock === false && gRed.stock?.stockQty === 5);
    check("…and its sibling inStock true", gBlue.stock?.inStock === true && gBlue.stock?.pool === true);

    const setQty = await call("PATCH", { variantSku: `${TAG}-SV-B`, stockQty: 3 });
    f = await flags(sp.id, [red.id, blue.id]);
    check("stock: shared variant stockQty → sets the PARENT pool (3)", setQty.status === 200 && setQty.stock?.stockQty === 3 && f.parent.qty === 3);
    check("…a quantity write leaves the variant flags alone", f.variant.get(red.id) === false && f.variant.get(blue.id) === true);
    const delta = await call("PATCH", { variantSku: `${TAG}-SV-R`, stockDelta: -1 });
    check("stock: shared variant stockDelta → the pool (2), reported inStock false for the disabled variant", delta.status === 200 && delta.stock?.stockQty === 2 && delta.stock?.inStock === false);

    const restocked: EventPayload<"product.restocked">[] = [];
    bus.on("product.restocked", ({ payload }) => void restocked.push(payload));
    const on = await call("PATCH", { variantSku: `${TAG}-SV-R`, inStock: true });
    f = await flags(sp.id, [red.id, blue.id]);
    check("stock: re-enabling the variant → inStock true, flag written on the variant", on.status === 200 && on.stock?.inStock === true && f.variant.get(red.id) === true);
    check("…fires product.restocked (the variant became sellable again)", restocked.filter((e) => e.productId === sp.id).length === 1);

    // A sold-out POOL refilled through a DISABLED variant's SKU re-lists every
    // sibling → product.restocked must fire off the pool's own transition (the
    // next sync through a sibling sees qty > 0 and never would).
    const spRestocks = () => restocked.filter((e) => e.productId === sp.id).length;
    await call("PATCH", { variantSku: `${TAG}-SV-R`, inStock: false });
    const empty = await call("PATCH", { sku: `${TAG}-SV`, stockQty: 0 });
    f = await flags(sp.id, [red.id, blue.id]);
    check("stock: product-ref set 0 empties + de-lists the pool (no restock)", empty.status === 200 && f.parent.qty === 0 && f.parent.inStock === false && spRestocks() === 1);
    const refill = await call("PATCH", { variantSku: `${TAG}-SV-R`, stockQty: 3 });
    f = await flags(sp.id, [red.id, blue.id]);
    check("…refill 0→3 via the DISABLED variant → reported inStock false, pool re-listed", refill.status === 200 && refill.stock?.inStock === false && refill.stock?.stockQty === 3 && f.parent.inStock === true && f.variant.get(red.id) === false);
    check("…fires exactly ONE product.restocked (pool transition — the sibling is sellable again)", spRestocks() === 2);
    const viaSibling = await call("PATCH", { variantSku: `${TAG}-SV-B`, stockQty: 4 });
    check("…a later sync through the sibling fires nothing more", viaSibling.status === 200 && viaSibling.stock?.inStock === true && spRestocks() === 2);
    await call("PATCH", { sku: `${TAG}-SV`, stockQty: 0 });
    const refillDelta = await call("PATCH", { variantSku: `${TAG}-SV-R`, stockDelta: 2 });
    check("stock: delta refill 0→2 via the DISABLED variant → ONE more product.restocked, reported inStock false", refillDelta.status === 200 && refillDelta.stock?.inStock === false && refillDelta.stock?.stockQty === 2 && spRestocks() === 3);

    // Low-stock alerts on API decrements (same crossing rules as a sale).
    const saved = await db.execute(sql`select key, value from site_settings where key in ('stock.alert_enabled', 'stock.low_threshold_qty')`);
    savedStockAlertSettings = new Map((saved.rows as Array<{ key: string; value: string | null }>).map((r) => [r.key, r.value]));
    await putSetting("stock.alert_enabled", "true");
    await putSetting("stock.low_threshold_qty", "2");
    const lows: EventPayload<"product.stock_low">[] = [];
    const depleted: EventPayload<"product.stock_depleted">[] = [];
    bus.on("product.stock_low", ({ payload }) => void lows.push(payload));
    bus.on("product.stock_depleted", ({ payload }) => void depleted.push(payload));
    const [ls] = await db
      .insert(products)
      .values({ name: `${TAG} low`, slug: `${TAG}-low`, sku: `${TAG}-LS`, price_cents: 1000, is_published: true, product_type: "simple", stock_qty: 4, in_stock: true, short_desc: "", description: "" } as never)
      .returning({ id: products.id });
    const mine = <T extends { productId: string }>(xs: T[]) => xs.filter((e) => e.productId === ls.id);

    await call("PATCH", { sku: `${TAG}-LS`, stockDelta: -2 });
    check("stock alerts: API delta 4→2 (threshold 2) → ONE product.stock_low (qty 2, sku)", mine(lows).length === 1 && mine(lows)[0].currentQty === 2 && mine(lows)[0].sku === `${TAG}-LS`);
    await call("PATCH", { sku: `${TAG}-LS`, stockQty: 0 });
    check("stock alerts: API set 2→0 → ONE product.stock_depleted", mine(depleted).length === 1);
    await call("PATCH", { sku: `${TAG}-LS`, stockQty: 5 });
    check("stock alerts: an increase raises no low/rupture alert", mine(lows).length === 1 && mine(depleted).length === 1);
    await putSetting("stock.alert_enabled", "false");
    await call("PATCH", { sku: `${TAG}-LS`, stockDelta: -5 });
    check("stock alerts: toggle OFF → a 5→0 API delta raises nothing", mine(depleted).length === 1 && mine(lows).length === 1);
    await restoreStockAlertSettings();
  }

  // ── Webhook endpoint + delivery queue + HMAC ─────────────────────────────
  {
    const { row, secret } = await webhookEndpointService.createEndpoint({
      name: `${TAG}-ep`,
      url: "https://erp.example.com/hooks",
      eventTypes: ["*"],
      createdBy: "admin",
    });
    check("endpoint secret stored ENCRYPTED (round-trips)", row.secret_enc.includes(".") && webhookEndpointService.secretOf(row) === secret);

    // HMAC sign/verify + tamper.
    const ts = "1700000000";
    const body = '{"event":"order.paid","data":{}}';
    const sig = signWebhookBody(secret, ts, body);
    check("HMAC verify round-trips", verifyWebhookSignature(secret, ts, body, sig));
    check("tampered body fails verify", !verifyWebhookSignature(secret, ts, body + "x", sig));
    check("wrong secret fails verify", !verifyWebhookSignature(secret + "x", ts, body, sig));
    check("wrong timestamp fails verify", !verifyWebhookSignature(secret, ts + "1", body, sig));

    // Queue mechanics: enqueue → claim (FOR UPDATE SKIP LOCKED) → markDelivered.
    await webhookEndpointService.enqueue([{ endpointId: row.id, eventName: `${TAG}-evt`, payload: { orderId: "o1" } }]);
    // Large batch so any UNRELATED queued rows (e.g. from a prior run on a reused
    // DB) can't crowd this run's row out of the claim.
    const claimed = await webhookEndpointService.claimDueBatch(1000);
    const mine = claimed.find((c) => c.event_name === `${TAG}-evt`);
    check("enqueued delivery is claimed (status pending)", !!mine && mine.status === "pending");
    if (mine) {
      // A concurrent claim can't re-grab a pending row.
      const second = await webhookEndpointService.claimDueBatch(10);
      check("claimed row isn't re-claimed by a second tick", !second.some((c) => c.id === mine.id));
      await webhookEndpointService.markDelivered(mine.id, 200);
      const after = await readDelivery(mine.id);
      check("markDelivered → status delivered + response 200", after?.status === "delivered" && after?.response_status === 200);

      // Redeliver re-queues it AND resets the attempt cycle (attempts → 0), so a
      // terminally-failed row gets a fresh full retry set, not one leftover try.
      await webhookEndpointService.redeliver(mine.id);
      const requeued = await readDelivery(mine.id);
      check("redeliver → back to queued", requeued?.status === "queued");
      check("redeliver resets attempts to 0", requeued?.attempts === 0);

      // Finalizer ownership guard: markDelivered only mutates a row THIS drain
      // owns (status='pending'). The row is 'queued' now, so a stray/late finalize
      // must NO-OP rather than resurrect it to 'delivered'.
      await webhookEndpointService.markDelivered(mine.id, 200);
      const guarded = await readDelivery(mine.id);
      check("markDelivered on a non-pending row no-ops (pending-guard)", guarded?.status === "queued");
    }

    // Revoke pauses future enqueues (listActive drops it).
    await webhookEndpointService.revoke(row.id);
    const active = await webhookEndpointService.listActive();
    check("revoked endpoint absent from listActive", !active.some((e) => e.id === row.id));
  }

  // ── Claim gate: PAUSE holds queued rows; REVOKE lets them drain to terminal ─
  {
    const paused = await webhookEndpointService.createEndpoint({
      name: `${TAG}-paused`, url: "https://erp.example.com/paused", eventTypes: ["*"], createdBy: "admin",
    });
    await webhookEndpointService.enqueue([{ endpointId: paused.row.id, eventName: `${TAG}-pausedevt`, payload: {} }]);
    await webhookEndpointService.setActive(paused.row.id, false); // pause
    const whilePaused = await webhookEndpointService.claimDueBatch(1000);
    check(
      "paused endpoint's queued row is NOT claimed (pause halts delivery)",
      !whilePaused.some((c) => c.event_name === `${TAG}-pausedevt`),
    );

    await webhookEndpointService.setActive(paused.row.id, true); // resume
    const afterResume = await webhookEndpointService.claimDueBatch(1000);
    check(
      "resumed endpoint's row becomes claimable again",
      afterResume.some((c) => c.event_name === `${TAG}-pausedevt`),
    );

    const revoked = await webhookEndpointService.createEndpoint({
      name: `${TAG}-revoked`, url: "https://erp.example.com/revoked", eventTypes: ["*"], createdBy: "admin",
    });
    await webhookEndpointService.enqueue([{ endpointId: revoked.row.id, eventName: `${TAG}-revokedevt`, payload: {} }]);
    await webhookEndpointService.revoke(revoked.row.id);
    const revokedClaim = await webhookEndpointService.claimDueBatch(1000);
    check(
      "revoked endpoint's row IS still claimed (so the drain can terminal-fail it)",
      revokedClaim.some((c) => c.event_name === `${TAG}-revokedevt`),
    );
  }

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await restoreStockAlertSettings();
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
