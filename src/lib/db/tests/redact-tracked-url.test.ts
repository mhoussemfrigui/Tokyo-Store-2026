/**
 * PURE bearer-URL scrubbing for third-party tags (src/lib/tracking/redact-url.ts)
 * — NO database, NO network, NO window.
 *
 * Order UUIDs (the /order summary, guest /facture receipt, guest cancel), live
 * reset / invite / verify / unsubscribe tokens are bearer
 * credentials; GA4 / GTM / Meta read `location.href` by default. Pins:
 *   - bearer path segments → placeholders (`/order/<uuid>` → `/order/:id`, the
 *     verify / facture / account-order variants), rest of the path kept;
 *   - token-like query params (token / t / k, any case) dropped, other params
 *     kept with their original encoding when nothing changed;
 *   - a nested same-site `from=` / absolute callback URL scrubbed too;
 *   - the #fragment dropped; absolute in ⇒ absolute out, relative ⇒ relative;
 *   - TAG_FREE_PATHS matching on segment boundaries;
 *   - isSensitiveTrackedUrl (drives the Meta PageView skip);
 *   - source invariants of the consumers: TrackingScripts / PageLocationSync
 *     wiring, PurchaseTrack without the order UUID, the /facture owner gate and
 *     the `?pay=return` throttle on /order/[id].
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/redact-tracked-url.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TAG_FREE_PATHS,
  isSensitiveTrackedUrl,
  isTagFreePath,
  redactTrackedUrl,
} from "@/lib/tracking/redact-url";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

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
function eq(label: string, actual: string, expected: string) {
  check(`${label} → ${expected}`, actual === expected);
  if (actual !== expected) console.error(`      got: ${actual}`);
}

const UUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ORIGIN = "https://tokyostore.tn";

function main() {
  console.log("bearer path segments:");
  eq("order summary", redactTrackedUrl(`${ORIGIN}/order/${UUID}`), `${ORIGIN}/order/:id`);
  eq(
    "order summary keeps harmless query",
    redactTrackedUrl(`${ORIGIN}/order/${UUID}?fresh=1`),
    `${ORIGIN}/order/:id?fresh=1`,
  );
  eq(
    "gateway return",
    redactTrackedUrl(`${ORIGIN}/order/${UUID}?pay=return`),
    `${ORIGIN}/order/:id?pay=return`,
  );
  eq("QR verify", redactTrackedUrl(`${ORIGIN}/order/verify/${UUID}`), `${ORIGIN}/order/verify/:id`);
  eq(
    "receipt",
    redactTrackedUrl(`${ORIGIN}/facture/${UUID}?autoprint=1`),
    `${ORIGIN}/facture/:id?autoprint=1`,
  );
  eq(
    "account order view (same UUID)",
    redactTrackedUrl(`${ORIGIN}/account/orders/${UUID}`),
    `${ORIGIN}/account/orders/:id`,
  );
  eq(
    "uppercase UUID still redacted",
    redactTrackedUrl(`${ORIGIN}/order/${UUID.toUpperCase()}`),
    `${ORIGIN}/order/:id`,
  );
  eq("trailing sub-path kept", redactTrackedUrl(`/account/orders/${UUID}/retour`), "/account/orders/:id/retour");
  eq("relative in ⇒ relative out", redactTrackedUrl(`/order/${UUID}`), "/order/:id");

  console.log("\nnon-bearer paths untouched:");
  eq("home", redactTrackedUrl(`${ORIGIN}/`), `${ORIGIN}/`);
  eq("order list root", redactTrackedUrl(`${ORIGIN}/account/orders`), `${ORIGIN}/account/orders`);
  eq("bare /order/verify", redactTrackedUrl("/order/verify"), "/order/verify");
  eq("lookalike /orders/x", redactTrackedUrl(`/orders/${UUID}`), `/orders/${UUID}`);
  eq("lookalike /factures", redactTrackedUrl("/factures/x"), "/factures/x");
  eq("product page", redactTrackedUrl(`${ORIGIN}/produit/montre-x?v=2`), `${ORIGIN}/produit/montre-x?v=2`);
  eq(
    "UTM params kept verbatim",
    redactTrackedUrl(`${ORIGIN}/?utm_source=news%20letter&utm_medium=email`),
    `${ORIGIN}/?utm_source=news%20letter&utm_medium=email`,
  );

  console.log("\ntoken query params:");
  eq(
    "reset token dropped",
    redactTrackedUrl(`${ORIGIN}/reset-password?token=live-secret`),
    `${ORIGIN}/reset-password`,
  );
  eq(
    "unsubscribe token dropped, done kept",
    redactTrackedUrl(`${ORIGIN}/se-desabonner?token=YWxpY2VAeC50bg.mac&done=1`),
    `${ORIGIN}/se-desabonner?done=1`,
  );
  eq("short t / k dropped", redactTrackedUrl("/x?t=1&k=2&q=montre"), "/x?q=montre");
  eq("case-insensitive name", redactTrackedUrl("/x?Token=abc&TOKEN=def"), "/x");
  eq("fragment dropped", redactTrackedUrl(`${ORIGIN}/a?b=1#access_token=zzz`), `${ORIGIN}/a?b=1`);

  console.log("\nnested from= / callback URLs:");
  const loginFacture = redactTrackedUrl(
    `${ORIGIN}/login?from=${encodeURIComponent(`/facture/${UUID}?autoprint=1`)}`,
  );
  check("login from=/facture/<uuid> no longer carries the UUID", !loginFacture.includes(UUID));
  eq(
    "login from= value",
    new URL(loginFacture).searchParams.get("from") ?? "",
    "/facture/:id?autoprint=1",
  );
  const absCallback = redactTrackedUrl(
    `/x?callbackURL=${encodeURIComponent(`${ORIGIN}/reset-password?token=zz`)}`,
  );
  check("absolute callback token dropped", !absCallback.includes("zz"));
  eq(
    "plain from= untouched (exact encoding)",
    redactTrackedUrl("/login?from=%2Faccount"),
    "/login?from=%2Faccount",
  );
  eq(
    "protocol-relative value NOT treated as nested",
    redactTrackedUrl(`/login?from=${encodeURIComponent(`//evil.example/order/${UUID}`)}`),
    `/login?from=${encodeURIComponent(`//evil.example/order/${UUID}`)}`,
  );

  console.log("\nTAG_FREE_PATHS:");
  for (const base of TAG_FREE_PATHS) {
    check(`${base} is tag-free`, isTagFreePath(base));
    check(`${base}/ (trailing slash) is tag-free`, isTagFreePath(`${base}/`));
  }
  check("/reset-passwordX is NOT tag-free (segment boundary)", !isTagFreePath("/reset-passwordX"));
  check("/pro is NOT tag-free", !isTagFreePath("/pro"));
  check("/ is NOT tag-free", !isTagFreePath("/"));
  check("null / empty is NOT tag-free", !isTagFreePath(null) && !isTagFreePath(""));

  console.log("\nisSensitiveTrackedUrl (Meta PageView skip):");
  check("order summary sensitive", isSensitiveTrackedUrl(`${ORIGIN}/order/${UUID}?fresh=1`));
  check("receipt sensitive", isSensitiveTrackedUrl(`${ORIGIN}/facture/${UUID}`));
  check("tag-free route sensitive even without a token", isSensitiveTrackedUrl(`${ORIGIN}/verify-email`));
  check("token param sensitive", isSensitiveTrackedUrl(`${ORIGIN}/x?token=a`));
  check(
    "login from=/facture/<uuid> sensitive",
    isSensitiveTrackedUrl(`${ORIGIN}/login?from=${encodeURIComponent(`/facture/${UUID}`)}`),
  );
  check("home NOT sensitive", !isSensitiveTrackedUrl(`${ORIGIN}/`));
  check("fragment alone NOT sensitive", !isSensitiveTrackedUrl(`${ORIGIN}/produit/x#avis`));
  check("utm landing NOT sensitive", !isSensitiveTrackedUrl(`${ORIGIN}/?utm_source=a`));

  // Source invariants for the consumers (RSC / inline-snippet wiring a pure test
  // can't execute) — cheap guards against a silent revert.
  console.log("\nwiring (source invariants):");
  const tags = read("src/components/tracking/tracking-scripts.tsx");
  check("TrackingScripts loads nothing on TAG_FREE_PATHS", tags.includes("if (isTagFreePath(pathname)) return null;"));
  // GA4 page_location at the GLOBAL `set` scope (PageLocationSync re-sets it) —
  // a config-scoped value would outrank `set` and pin later events to landing.
  const gaSet = tags.indexOf("gtag('set',{page_location:");
  check(
    "GA4 page_location set globally BEFORE config",
    gaSet !== -1 && gaSet < tags.indexOf("gtag('config','${gaId}')"),
  );
  check("GA4 config carries NO page_location", !/gtag\('config','\$\{gaId\}',/.test(tags));
  check("GTM gets page_location pushed before gtm.js", tags.indexOf("push({page_location:") < tags.indexOf("'gtm.start'"));
  check("Meta automatic pushState PageView disabled", tags.includes("fbq.disablePushState=true"));
  const autoCfg = tags.indexOf("if(s)fbq('set','autoConfig',false,'${pixelId}')");
  check(
    "Meta autoConfig off on a sensitive landing, BEFORE init",
    tags.includes("s=!u||u.isSensitive(w.location.href)") &&
      autoCfg !== -1 &&
      autoCfg < tags.indexOf("fbq('init','${pixelId}')"),
  );
  check("Meta init PageView gated on isSensitive", tags.includes("if(!s)fbq('track','PageView')"));
  const sync = read("src/components/tracking/page-location-sync.tsx");
  check(
    "PageLocationSync pushes a gz_page_location EVENT (GTM trigger, not History Change)",
    sync.includes('push({ event: "gz_page_location", page_location: pageLocation })'),
  );
  check("PageLocationSync re-sets GA4 page_location globally", sync.includes('w.gtag("set", { page_location: pageLocation })'));
  // The chrome (tracking scripts, PageLocationSync, custom snippets) lives in the
  // (shell) layer since the 404-chrome split; the thin (shop)/layout.tsx is gate-only.
  const layout = read("src/app/(shop)/(shell)/layout.tsx");
  check("(shell) layout mounts PageLocationSync", layout.includes("<PageLocationSync enabled={trackingConfig.enabled} />"));
  check("custom snippets skipped on a token-route render", layout.includes("!isTagFreePath(renderPath)"));
  check(
    "custom snippets gated on the html prop (stay mounted → injected guard survives refresh())",
    layout.includes("html={customTagsAllowed ? trackingConfig.customHead : \"\"}") &&
      layout.includes("html={customTagsAllowed ? trackingConfig.customBody : \"\"}") &&
      !layout.includes("{customTagsAllowed && <CustomTrackingHtml"),
  );
  check("PurchaseTrack no longer pushes the order UUID", !read("src/components/storefront/purchase-track.tsx").includes("order_id"));
  const facture = read("src/app/(documents)/facture/[id]/page.tsx");
  check(
    "/facture gates a registered order (owner or orders:view)",
    facture.includes("if (order.user_id)") &&
      facture.includes("requireSession({ from })") &&
      facture.includes('permissionSetAllows(perms, "orders", "view")'),
  );
  const orderPage = read("src/app/(shop)/(shell)/order/[id]/page.tsx");
  check("?pay=return verify is throttled per order", orderPage.includes("bucket: `pay-return:${id}`"));
  check("/facture link is a hard <a> (no soft nav under loaded tags)", !/<Link\s+href=\{`\/facture\//.test(orderPage));

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main();
