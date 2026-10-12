/**
 * Pure long-tail audit row-shapers (src/events/subscribers/audit-target.ts).
 * No DB. Locks the load-bearing TARGET_ID_KEYS PRIORITY (first-present wins) +
 * the summary/target-type derivation. Also locks the API-access audit payload
 * (src/lib/api-auth/access-settings-diff.ts): only REAL changes, with values.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/audit-target.test.ts
 */
import {
  summarizeEvent,
  targetTypeForEvent,
  targetIdForPayload,
  TARGET_ID_KEYS,
} from "@/events/subscribers/audit-target";
import {
  diffApiAccessSettings,
  summarizeApiAccessChange,
  type ApiAccessSnapshot,
} from "@/lib/api-auth/access-settings-diff";

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

function main() {
  console.log("summarizeEvent / targetTypeForEvent:");
  check("summary is domain → action", summarizeEvent("order.return.created") === "order → return");
  check("target type is the domain", targetTypeForEvent("currency.activated") === "currency");
  check("single-segment name doesn't crash", targetTypeForEvent("ping") === "ping");

  console.log("targetIdForPayload — priority (first present wins):");
  check(
    "userId beats orderId on a user event",
    targetIdForPayload({ orderId: "o1", userId: "u1" }) === "u1",
  );
  check(
    "orderId chosen when no higher-priority id",
    targetIdForPayload({ orderId: "o1", reviewId: "r1" }) === "o1",
  );
  check("currencyId resolved", targetIdForPayload({ currencyId: "c1", code: "TND" }) === "c1");
  check("redirectId resolved", targetIdForPayload({ redirectId: "rd1", source: "/x" }) === "rd1");
  check("keyId resolved (api key)", targetIdForPayload({ keyId: "k1" }) === "k1");
  check("returnId resolved", targetIdForPayload({ returnId: "ret1" }) === "ret1");

  console.log("targetIdForPayload — long-tail entity ids (were NULL before):");
  // Real payload shapes from src/events/types.ts.
  check("blog.post.* → postId", targetIdForPayload({ postId: "p1", slug: "s" }) === "p1");
  check("blog.tag.* → tagId", targetIdForPayload({ tagId: "t1", slug: "s" }) === "t1");
  check("author.* → authorId", targetIdForPayload({ authorId: "au1", slug: "s" }) === "au1");
  check(
    "blog.comment.* → commentId (wins over postId)",
    targetIdForPayload({ commentId: "c1", postId: "p1", status: "approved" }) === "c1",
  );
  check(
    "webhook_endpoint.* → endpointId",
    targetIdForPayload({ endpointId: "e1", name: "ERP", eventTypes: ["*"] }) === "e1",
  );
  check("faq.updated → faqId", targetIdForPayload({ faqId: "f1", scope: "home" }) === "f1");
  check("import.products_* → jobId", targetIdForPayload({ jobId: "j1", created: 1, updated: 0, failed: 0 }) === "j1");
  check("delivery.zone.* → zoneId", targetIdForPayload({ zoneId: "z1", name: "Grand Tunis" }) === "z1");
  check("stock_location.* → locationId", targetIdForPayload({ locationId: "l1", name: "Dépôt" }) === "l1");
  check("search_alias.* → aliasId", targetIdForPayload({ aliasId: "al1", term: "rolex" }) === "al1");
  check("page.updated → pageId", targetIdForPayload({ pageId: "pg1", slug: "a-propos", changedFields: [] }) === "pg1");
  check(
    "appended long-tail keys never outrank an existing one (productId beats pageId)",
    targetIdForPayload({ pageId: "pg1", productId: "pr1" }) === "pr1",
  );

  console.log("targetIdForPayload — null/edge:");
  check("no id key → null", targetIdForPayload({ count: 3, enabled: true }) === null);
  check("empty string id → skipped (null)", targetIdForPayload({ userId: "" }) === null);
  check("non-string id → skipped (null)", targetIdForPayload({ userId: 123 }) === null);
  check("null payload → null", targetIdForPayload(null) === null);
  check("non-object payload → null", targetIdForPayload("nope") === null);

  console.log("invariants:");
  check("TARGET_ID_KEYS has no duplicates", new Set(TARGET_ID_KEYS).size === TARGET_ID_KEYS.length);
  check("userId is first (highest priority)", TARGET_ID_KEYS[0] === "userId");

  console.log("api.access_settings_updated — diff (only real changes, with values):");
  const base: ApiAccessSnapshot = {
    apiEnabled: true,
    webhooksEnabled: true,
    outboundWebhooksEnabled: true,
    publicRoutes: ["products.list", "brands.list"],
  };
  check("no-op save → null (no event)", diffApiAccessSettings(base, { ...base }) === null);
  check(
    "route ORDER alone is not a change",
    diffApiAccessSettings(base, { ...base, publicRoutes: ["brands.list", "products.list"] }) === null,
  );

  const killed = diffApiAccessSettings(base, { ...base, apiEnabled: false });
  check("kill-switch off → apiEnabled {from:true,to:false}", killed?.apiEnabled?.from === true && killed.apiEnabled.to === false);
  check("kill-switch off → only api.enabled in changedFields", JSON.stringify(killed?.changedFields) === '["api.enabled"]');
  check("kill-switch off → untouched settings absent", killed?.webhooksEnabled === undefined && killed?.outboundEnabled === undefined && killed?.publicRoutesAdded === undefined);

  const routes = diffApiAccessSettings(base, {
    ...base,
    publicRoutes: ["products.list", "orders.list", "customers.list"],
  });
  check("routes opened → sorted publicRoutesAdded", JSON.stringify(routes?.publicRoutesAdded) === '["customers.list","orders.list"]');
  check("routes closed → publicRoutesRemoved", JSON.stringify(routes?.publicRoutesRemoved) === '["brands.list"]');
  check("routes change → changedFields = [publicRoutes]", JSON.stringify(routes?.changedFields) === '["publicRoutes"]');

  const hooks = diffApiAccessSettings(base, { ...base, webhooksEnabled: false, outboundWebhooksEnabled: false });
  check(
    "both webhook switches → both present",
    hooks?.webhooksEnabled?.to === false && hooks?.outboundEnabled?.to === false,
  );

  console.log("api.access_settings_updated — French summary:");
  check(
    "kill-switch summary names it",
    killed !== null && summarizeApiAccessChange(killed) === "Accès API/webhooks — API externe désactivée",
  );
  const routeSummary = routes ? summarizeApiAccessChange(routes) : "";
  check("routes summary lists opened ids", routeSummary.includes("rendue(s) publique(s) : customers.list, orders.list"));
  check("routes summary lists closed ids", routeSummary.includes("repassée(s) sous clé : brands.list"));
  check(
    "long route list is capped (+N)",
    summarizeApiAccessChange({ publicRoutesAdded: ["a", "b", "c", "d", "e"] }).endsWith("a, b, c +2"),
  );
  check(
    "value-less payload keeps the generic wording",
    summarizeApiAccessChange({ changedFields: ["api.enabled"] }) === "Réglages d'accès API/webhooks mis à jour",
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
