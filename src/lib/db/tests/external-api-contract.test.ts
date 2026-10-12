import "server-only";

/**
 * External API CONTRACT — the ERP-facing identifiers, links and gates.
 *
 *   - Scope matrix: the create-key UI offers `<res>:write` only where a write
 *     route exists (WRITABLE_RESOURCES pinned to EXTERNAL_API_ROUTES).
 *   - Keyed caller on a PUBLIC route is authenticated as keyed (not downgraded to
 *     the public view); a bad key is a 401, a non-Bearer Authorization stays public.
 *   - Public product reads: per-viewer (session cookie) bodies are never
 *     shared-cacheable; list pages report `rawCount` (pre-embargo page size).
 *   - Identifiers join: ApiCustomer.userId ⇔ order.userId; `[id]` segments that
 *     are uuid-shaped ERP refs fall back to the externalRef lookup.
 *   - ERP order link (`order.set_external_ref` + PATCH /api/orders/[id]/status):
 *     idempotent, already_linked / external_ref_conflict (409), blank ref → 400
 *     unless `unlink: true`, audited (order.edited + timeline row), and never a
 *     half-applied request (refused transition ⇒ link not stamped).
 *     paymentReference / notes without `status` → 400.
 *   - ERP customer upsert emits customer.profile_updated WITH the linked userId.
 *   - Outbound-webhook kill-switch stops the DRAIN (queued rows stay queued).
 *   - Admin delivery log: status + endpoint filters.
 *
 * Mutates two global API settings (public routes, outbound kill-switch) for a
 * few statements each and restores them (also on a crash) — run it against the
 * isolated test DB only.
 *
 * Run: pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *        src/lib/db/tests/external-api-contract.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

// Webhook endpoint secrets are encrypted at rest (read at call time).
process.env.PAYMENT_ENCRYPTION_KEY ||= "xapi-test-encryption-key-0000000001";

import { db } from "@/lib/db/client";
import { workflows } from "@/workflows";
import { bus, type EventPayload } from "@/events/bus";
import { orderService } from "@/modules/order/service";
import { order_status_history } from "@/modules/order/schema";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { apiKeyService } from "@/modules/api-key";
import { apiSettingsService } from "@/modules/api-settings/service";
import { productService } from "@/modules/catalog/product/service";
import { webhookEndpointService } from "@/modules/webhook-endpoints";
import { webhook_deliveries } from "@/modules/webhook-endpoints/schema";
import { drainWebhookQueue } from "@/lib/webhooks/dispatch-drain";
import { enforceExternalApi, presentsApiKey, workflowErrorStatus } from "@/lib/api-auth/enforce";
import { EXTERNAL_API_ROUTES } from "@/lib/api-auth/route-catalog";
import { API_RESOURCES, OFFERED_SCOPES, WRITABLE_RESOURCES } from "@/lib/api-auth/scopes";
import { resolveApiOrder, serializeOrder } from "@/lib/api/orders";
import { listApiCustomers, resolveApiCustomer, serializeOneCustomer } from "@/lib/api/customers";
import { listApiProductsPage, publicProductReadHeaders } from "@/lib/api/products";
import { PATCH as statusPATCH } from "@/app/api/orders/[id]/status/route";

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

const TAG = `__xapitest-${Date.now()}`;
const createdOrderIds: string[] = [];

// The two global settings this suite flips — raw app_secrets values saved
// before, restored after (and on a crash), so a shared test DB keeps its config.
const SETTING_KEYS = ["api.public_routes", "webhooks.outbound_enabled"] as const;
let savedSettings: Map<string, string> | null = null;
async function saveSettings() {
  const res = await db.execute<{ key: string; value: string }>(
    sql`select key, value from app_secrets where key in ('api.public_routes', 'webhooks.outbound_enabled')`,
  );
  savedSettings = new Map(res.rows.map((r) => [r.key, r.value]));
}
async function restoreSettings() {
  if (!savedSettings) return;
  for (const key of SETTING_KEYS) {
    if (savedSettings.has(key)) {
      await db.execute(sql`update app_secrets set value = ${savedSettings.get(key)!} where key = ${key}`);
    } else {
      await db.execute(sql`delete from app_secrets where key = ${key}`);
    }
  }
  savedSettings = null;
  apiSettingsService.invalidate();
}

async function cleanup() {
  if (createdOrderIds.length > 0) {
    await db.execute(
      sql`delete from orders where id in (${sql.join(
        createdOrderIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
  }
  await db.execute(sql`delete from webhook_deliveries where event_name like '__xapitest%'`);
  await db.execute(sql`delete from webhook_endpoints where name like '__xapitest%'`);
  await db.execute(sql`delete from customer_user_links where user_id like '__xapitest%'`);
  await db.execute(sql`delete from customer_profiles where last_name like '__xapitest%'`);
  await db.execute(sql`delete from products where sku like '__xapitest%'`);
  await db.execute(
    sql`delete from rate_limit_buckets where bucket_key in (select 'apikey:' || id::text from api_keys where name like '__xapitest%')`,
  );
  await db.execute(sql`delete from api_keys where name like '__xapitest%'`);
  await db.execute(sql`delete from user_roles where user_id like '__xapitest%'`);
  await db.execute(sql`delete from users where id like '__xapitest%'`);
}

async function main() {
  await cleanup();

  // ── PURE: the create-key matrix only offers write scopes that do something ─
  {
    const derived = new Set(
      EXTERNAL_API_ROUTES.filter((r) => r.action === "write" && r.resource).map((r) => r.resource!),
    );
    check(
      "scopes: WRITABLE_RESOURCES === resources with a write route in EXTERNAL_API_ROUTES",
      derived.size === WRITABLE_RESOURCES.length && WRITABLE_RESOURCES.every((r) => derived.has(r)),
    );
    check(
      "scopes: no write box for read-only resources (loyalty/content/blog/reviews)",
      ["loyalty", "content", "blog", "reviews"].every((r) => !OFFERED_SCOPES.includes(`${r}:write`)),
    );
    check(
      "scopes: every resource keeps its read box + coarse shortcuts offered",
      API_RESOURCES.every((r) => OFFERED_SCOPES.includes(`${r}:read`)) &&
        ["read", "write", "full"].every((s) => OFFERED_SCOPES.includes(s)),
    );
  }

  // ── PURE: credential detection + new 409 codes + public cache headers ─────
  {
    const req = (headers: Record<string, string>) => new Request("http://localhost/api/products", { headers });
    check("presentsApiKey: Bearer token → true", presentsApiKey(req({ authorization: "Bearer twk_abc" })));
    check("presentsApiKey: X-API-Key → true", presentsApiKey(req({ "x-api-key": "twk_abc" })));
    check("presentsApiKey: Basic auth (proxy) → false", !presentsApiKey(req({ authorization: "Basic dXNlcjpwdw==" })));
    check("presentsApiKey: empty Bearer / blank X-API-Key → false", !presentsApiKey(req({ authorization: "Bearer   ", "x-api-key": " " })));
    check("presentsApiKey: no credential → false", !presentsApiKey(req({})));

    check("already_linked → 409", workflowErrorStatus("already_linked") === 409);
    check("external_ref_conflict → 409", workflowErrorStatus("external_ref_conflict") === 409);

    const anon = publicProductReadHeaders(req({ cookie: "consent=1; cart_token=x" }));
    check("public read, no session cookie → shared-cacheable + Vary: Cookie", /public, s-maxage=60/.test(anon["Cache-Control"]) && anon.Vary === "Cookie");
    const signedIn = publicProductReadHeaders(req({ cookie: "consent=1; gz.session_token=abc.def" }));
    check("public read WITH a session cookie → private, no-store", signedIn["Cache-Control"] === "private, no-store");
    const secure = publicProductReadHeaders(req({ cookie: "__Secure-gz.session_token=abc" }));
    check("…the __Secure- prefixed session cookie too", secure["Cache-Control"] === "private, no-store");
    const emptyCookie = publicProductReadHeaders(req({ cookie: "gz.session_token=; x=1" }));
    check("…an EMPTY session cookie is anonymous", /public/.test(emptyCookie["Cache-Control"]));
  }

  // ── Fixtures ─────────────────────────────────────────────────────────────
  const ADM = `${TAG}-adm`;
  await authService.insert({ id: ADM, email: `${ADM}@example.test`, name: ADM, emailVerified: true } as never);
  // Access is role-only: requireApiKey re-checks the key creator's live perms,
  // so the creator must hold the scopes via an RBAC role — grant super_admin ('*').
  const admSuper = await rbacService.findRoleByKey("super_admin");
  if (admSuper) await rbacService.assignRoleToUser(ADM, admSuper.id);
  const key = await apiKeyService.create({ name: `${TAG}-key`, scopes: ["full"], expiresAt: null, createdBy: ADM });
  const CU = `${TAG}-cu`;
  await authService.insert({ id: CU, email: `${CU}@example.test`, name: CU, emailVerified: true } as never);
  const linked = await customerService.insertProfile({ first_name: "Linked", last_name: TAG } as never);
  await customerUserLink.create({ user_id: CU, customer_profile_id: linked.id });
  // A standalone ERP profile whose ref is UUID-SHAPED (an ERP keying by uuid).
  const uuidRef = randomUUID();
  const standalone = await customerService.insertProfile({
    first_name: "Standalone",
    last_name: TAG,
    external_ref: uuidRef,
  } as never);
  const sku = `${TAG}-W`;
  await productService.insert({
    name: "XAPI Widget",
    slug: `${TAG}-widget`,
    sku,
    price_cents: 10000,
    is_published: true,
    product_type: "simple",
    short_desc: "",
    description: "",
    in_stock: true,
    stock_qty: 50,
  } as never);
  const pushOrder = async () => {
    const r = await workflows.order.createFromLines(
      {
        contactEmail: "xapi@buyer.tn",
        shipping: { fullName: "XAPI Buyer", streetLine1: "1 rue", city: "Tunis" },
        lines: [{ sku, quantity: 1 }],
        deliveryMethod: "in_store",
        paymentChannel: "cod",
      } as never,
      { actorUserId: ADM },
    );
    if (!r.ok) throw new Error(`fixture order push failed: ${r.error} ${r.message}`);
    createdOrderIds.push(r.data.orderId);
    return r.data.orderId;
  };

  // ── Customers API: userId exposed + uuid-shaped externalRef fallback ──────
  {
    const one = await serializeOneCustomer(linked);
    check("ApiCustomer.userId = the linked account id", one.userId === CU);
    const lone = await serializeOneCustomer(standalone);
    check("ApiCustomer.userId = null for a standalone profile", lone.userId === null);
    const list = await listApiCustomers({
      sinceIso: new Date(linked.updated_at.getTime() - 1000).toISOString(),
      limit: 200,
      settleSeconds: 0,
    } as never);
    const inList = list.customers.find((c) => c.id === linked.id);
    check("incremental customer list carries userId too", inList?.userId === CU);
    check("resolveApiCustomer(profile uuid) → the profile", (await resolveApiCustomer(linked.id))?.id === linked.id);
    check(
      "resolveApiCustomer(UUID-SHAPED externalRef) → falls back to the ref lookup",
      (await resolveApiCustomer(uuidRef))?.id === standalone.id,
    );
    check("resolveApiCustomer(unknown uuid) → null", (await resolveApiCustomer(randomUUID())) === null);
  }

  // ── ERP customer upsert: profile_updated carries the linked userId ────────
  {
    const seen: EventPayload<"customer.profile_updated">[] = [];
    bus.on("customer.profile_updated", ({ payload }) => void seen.push(payload));
    await workflows.customer.upsertFromApi({ id: linked.id, firstName: "Renamed" }, { actorUserId: ADM, mustExist: true });
    const ev = seen.find((e) => e.customerProfileId === linked.id);
    check("ERP update of a LINKED profile emits profile_updated with its userId (name/marketing sync run)", ev?.userId === CU);
    await workflows.customer.upsertFromApi({ id: standalone.id, firstName: "Solo" }, { actorUserId: ADM, mustExist: true });
    const ev2 = seen.find((e) => e.customerProfileId === standalone.id);
    check("…a standalone profile keeps userId null", !!ev2 && ev2.userId === null);
  }

  // ── order.set_external_ref workflow ──────────────────────────────────────
  {
    const o1 = await pushOrder();
    const o2 = await pushOrder();
    const edits: EventPayload<"order.edited">[] = [];
    bus.on("order.edited", ({ payload }) => void edits.push(payload));
    const mine = () => edits.filter((e) => e.orderId === o1);

    const REF1 = `${TAG}-R1`;
    const linkIt = await workflows.order.setExternalRef({ orderId: o1, externalRef: REF1 }, { actorUserId: ADM });
    check("link: stamps the ref (changed)", linkIt.ok && linkIt.data.changed && (await orderService.findById(o1))?.external_ref === REF1);
    check("link: emits order.edited [external_ref] (audit + webhooks)", mine().length === 1 && mine()[0].changedFields?.includes("external_ref") === true);
    const hist = await db
      .select({ notes: order_status_history.notes })
      .from(order_status_history)
      .where(and(eq(order_status_history.order_id, o1), sql`${order_status_history.notes} like ${"%" + REF1 + "%"}`));
    check("link: a timeline row records it", hist.length === 1);

    const again = await workflows.order.setExternalRef({ orderId: o1, externalRef: `  ${REF1} ` }, { actorUserId: ADM });
    check("same ref again → idempotent no-op (no event)", again.ok && !again.data.changed && mine().length === 1);

    const relink = await workflows.order.setExternalRef({ orderId: o1, externalRef: `${TAG}-R2` }, { actorUserId: ADM });
    check("different ref on a linked order → already_linked", !relink.ok && relink.error === "already_linked");

    const blank = await workflows.order.setExternalRef({ orderId: o1, externalRef: "  " }, { actorUserId: ADM });
    check("blank externalRef (no unlink) → validation, link intact", !blank.ok && blank.error === "validation" && (await orderService.findById(o1))?.external_ref === REF1);

    const steal = await workflows.order.setExternalRef({ orderId: o2, externalRef: REF1 }, { actorUserId: ADM });
    check("ref owned by another order → external_ref_conflict", !steal.ok && steal.error === "external_ref_conflict");

    const both = await workflows.order.setExternalRef({ orderId: o1, externalRef: REF1, unlink: true }, { actorUserId: ADM });
    check("unlink + externalRef together → validation", !both.ok && both.error === "validation");

    const unlink = await workflows.order.setExternalRef({ orderId: o1, unlink: true }, { actorUserId: ADM });
    check("explicit unlink:true clears the link (audited)", unlink.ok && unlink.data.changed && (await orderService.findById(o1))?.external_ref === null && mine().length === 2);

    const notANumber = await workflows.order.setExternalRef({ orderId: o1, externalRef: 42 as never }, { actorUserId: ADM });
    check("non-string externalRef → validation (not silently ignored)", !notANumber.ok && notANumber.error === "validation");
  }

  // ── PATCH /api/orders/[id]/status ────────────────────────────────────────
  {
    const o = await pushOrder();
    const other = await pushOrder();
    await workflows.order.setExternalRef({ orderId: other, externalRef: `${TAG}-TAKEN` }, { actorUserId: ADM });
    const patch = async (id: string, body: Record<string, unknown>) => {
      const res = await statusPATCH(
        new Request(`http://localhost:3000/api/orders/${id}/status`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${key.plaintext}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id }) },
      );
      const json = (await res.json()) as { code?: string; data?: { status: string; externalRef: string | null } };
      return { status: res.status, json };
    };

    const refOnly = await patch(o, { paymentReference: "TRK-1" });
    check("PATCH paymentReference WITHOUT status → 400 (was dropped behind a 200)", refOnly.status === 400);
    const notesOnly = await patch(o, { notes: "hello" });
    check("PATCH notes WITHOUT status → 400", notesOnly.status === 400);

    const blank = await patch(o, { externalRef: "" });
    check("PATCH externalRef \"\" → 400 (no silent unlink)", blank.status === 400);

    const doomed = await patch(o, { status: "delivered", externalRef: `${TAG}-P1` });
    const afterDoomed = await orderService.findById(o);
    check("refused transition (pending→delivered) → 409 invalid_transition", doomed.status === 409 && doomed.json.code === "invalid_transition");
    check("…and the link was NOT stamped (no half-applied request)", afterDoomed?.external_ref === null && afterDoomed?.status === "pending");

    const conflict = await patch(o, { status: "preparing", externalRef: `${TAG}-TAKEN` });
    const afterConflict = await orderService.findById(o);
    check("link to a ref another order owns → 409 external_ref_conflict", conflict.status === 409 && conflict.json.code === "external_ref_conflict");
    check("…pre-checked BEFORE the transition (status untouched)", afterConflict?.status === "pending");

    const good = await patch(o, { status: "preparing", externalRef: `${TAG}-P1`, paymentReference: "TRK-2" });
    check("status + externalRef → 200, both applied", good.status === 200 && good.json.data?.status === "preparing" && good.json.data?.externalRef === `${TAG}-P1`);

    const already = await patch(o, { externalRef: `${TAG}-P2` });
    check("re-link to a DIFFERENT ref → 409 already_linked", already.status === 409 && already.json.code === "already_linked");

    const viaRef = await patch(`${TAG}-P1`, { externalRef: `${TAG}-P1` });
    check("[id] = externalRef resolves; same ref → idempotent 200", viaRef.status === 200 && viaRef.json.data?.externalRef === `${TAG}-P1`);

    const unlink = await patch(o, { unlink: true });
    check("PATCH { unlink: true } clears the link", unlink.status === 200 && unlink.json.data?.externalRef === null);

    // A uuid-shaped ERP ref resolves through the [id] segment (fallback).
    const uuidOrderRef = randomUUID();
    await workflows.order.setExternalRef({ orderId: o, externalRef: uuidOrderRef }, { actorUserId: ADM });
    check("resolveApiOrder(UUID-SHAPED externalRef) → falls back to the ref lookup", (await resolveApiOrder(uuidOrderRef))?.id === o);
    check("resolveApiOrder(local uuid id) → the order", (await resolveApiOrder(o))?.id === o);
    const row = await orderService.findById(o);
    check("serializeOrder exposes userId (null = guest)", !!row && "userId" in serializeOrder(row) && serializeOrder(row).userId === null);
  }

  // ── Products list page: rawCount (pre-embargo page size) ──────────────────
  {
    const keyed = await listApiProductsPage({ limit: 5, offset: 0 });
    check("keyed page: rawCount === products.length (no filter)", keyed.rawCount === keyed.products.length && keyed.rawCount <= 5);
    const pub = await listApiProductsPage({ limit: 5, offset: 0, public: true });
    check("public page: rawCount counts the DB page, ≥ products shown", pub.rawCount >= pub.products.length && pub.rawCount === keyed.rawCount);
  }

  await saveSettings();

  // ── Keyed caller on a PUBLIC route is not downgraded ──────────────────────
  {
    await apiSettingsService.setPublicRoutes(["products.list"]);
    const req = (headers: Record<string, string>) => new Request("http://localhost/api/products", { headers });
    const anon = await enforceExternalApi(req({}), "products.list");
    check("public route, no credential → public view", anon.ok && anon.isPublic && anon.keyId === null);
    const keyed = await enforceExternalApi(req({ authorization: `Bearer ${key.plaintext}` }), "products.list");
    check(
      "public route + VALID key → keyed view (isPublic false, key actor)",
      keyed.ok && !keyed.isPublic && keyed.keyId === key.row.id && keyed.actorUserId === ADM,
    );
    const bogus = await enforceExternalApi(req({ "x-api-key": "twk_definitely-not-a-key" }), "products.list");
    check("public route + INVALID key → 401 (never quietly served the public view)", !bogus.ok && bogus.response.status === 401);
    const basic = await enforceExternalApi(req({ authorization: "Basic dXNlcjpwdw==" }), "products.list");
    check("public route + non-Bearer Authorization → still public", basic.ok && basic.isPublic);
    await restoreSettings();
    await saveSettings();
  }

  // ── Outbound kill-switch halts the DRAIN; delivery-log filters ────────────
  {
    const { row: ep } = await webhookEndpointService.createEndpoint({
      name: `${TAG}-ep`,
      url: "https://erp.example.com/hooks",
      eventTypes: ["*"],
      createdBy: ADM,
    });
    await webhookEndpointService.enqueue([
      { endpointId: ep.id, eventName: `${TAG}-a`, payload: {} },
      { endpointId: ep.id, eventName: `${TAG}-b`, payload: {} },
    ]);

    await apiSettingsService.setOutboundWebhooksEnabled(false);
    const drained = await drainWebhookQueue();
    const rows = await db.select().from(webhook_deliveries).where(eq(webhook_deliveries.endpoint_id, ep.id));
    check("kill-switch OFF → drain skipped", drained.status === "skipped" && drained.delivered === 0 && drained.failed === 0);
    check("…queued rows left untouched (still queued, 0 attempts)", rows.length === 2 && rows.every((r) => r.status === "queued" && r.attempts === 0));
    await restoreSettings();

    // Mark one row failed directly (a claim would grab OTHER tests' queued rows).
    const failedRow = rows.find((r) => r.event_name === `${TAG}-a`)!;
    await db.update(webhook_deliveries).set({ status: "failed" }).where(eq(webhook_deliveries.id, failedRow.id));
    const all = await webhookEndpointService.listRecent(50, ep.id);
    const onlyFailed = await webhookEndpointService.listRecent(50, ep.id, "failed");
    check("delivery log: endpoint filter → both of its rows", all.length === 2 && all.every((d) => d.endpoint_id === ep.id));
    check("delivery log: « Échecs uniquement » → only the failed row", onlyFailed.length === 1 && onlyFailed[0].id === failedRow.id);
    const failedAnywhere = await webhookEndpointService.listRecent(200, undefined, "failed");
    check("delivery log: status filter alone → failed rows only", failedAnywhere.every((d) => d.status === "failed"));
  }

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await restoreSettings();
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
