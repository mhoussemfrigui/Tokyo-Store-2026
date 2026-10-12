/**
 * Pure event-severity model (src/events/severity.ts). No React/DOM/DB.
 * Locks the classification rules (explicit > low-signal > .deleted > domain >
 * info), the console-floor gate, and the debug sampling gate.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/audit-severity.test.ts
 */
import {
  severityFor,
  shouldLog,
  passesSample,
  SEVERITY_ORDER,
  LOG_LEVELS,
} from "@/events/severity";

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
  console.log("severityFor — explicit overrides (highest priority):");
  check("payment fraud → error", severityFor("webhook.payment.amount_mismatch") === "error");
  check("unmatched webhook → error", severityFor("webhook.payment.unmatched") === "error");
  check("user.disabled → warn", severityFor("user.disabled") === "warn");
  check("order.refunded → warn", severityFor("order.refunded") === "warn");
  check("api_key.created → warn", severityFor("api_key.created") === "warn");
  check("mailing.campaign_sent → warn", severityFor("mailing.campaign_sent") === "warn");
  check("currency.activated → warn", severityFor("currency.activated") === "warn");
  // Security-failure events (the attack trail) must persist → warn.
  check("user.sign_in_failed → warn", severityFor("user.sign_in_failed") === "warn");
  check("user.two_factor_failed → warn", severityFor("user.two_factor_failed") === "warn");
  check("auth.rate_limited → warn", severityFor("auth.rate_limited") === "warn");
  check("rbac.permission_denied → warn", severityFor("rbac.permission_denied") === "warn");
  check("api_key.auth_failed → warn", severityFor("api_key.auth_failed") === "warn");
  // Access surface + identity / exfiltration trail (a data-egress endpoint is as
  // sensitive as an API key; its domain `webhook_endpoint` ≠ the `webhook` default).
  check("webhook_endpoint.created → warn", severityFor("webhook_endpoint.created") === "warn");
  check("webhook_endpoint.revoked → warn", severityFor("webhook_endpoint.revoked") === "warn");
  check("webhook_endpoint.updated → info (pause/resume)", severityFor("webhook_endpoint.updated") === "info");
  check("api.access_settings_updated → warn", severityFor("api.access_settings_updated") === "warn");
  check("user.password_changed → warn", severityFor("user.password_changed") === "warn");
  check("user.email_changed → warn", severityFor("user.email_changed") === "warn");
  check("auth.oauth_settings_updated → warn", severityFor("auth.oauth_settings_updated") === "warn");
  check("data.exported → warn", severityFor("data.exported") === "warn");

  console.log("severityFor — low-signal (non-destructive churn) → debug:");
  check("attribute_value.updated → debug", severityFor("attribute_value.updated") === "debug");
  check("nav.item.updated → debug", severityFor("nav.item.updated") === "debug");
  check("product.price_changed → debug", severityFor("product.price_changed") === "debug");
  check("product.restocked → debug", severityFor("product.restocked") === "debug");
  check("page.section.changed → debug", severityFor("page.section.changed") === "debug");

  console.log("severityFor — destructive deletes beat the low-signal prefix:");
  check("attribute_value.deleted → warn (not debug)", severityFor("attribute_value.deleted") === "warn");
  check("nav.item.deleted → warn (not debug)", severityFor("nav.item.deleted") === "warn");

  console.log("severityFor — .deleted ⇒ warn (destructive):");
  check("product.deleted → warn", severityFor("product.deleted") === "warn");
  check("category.deleted → warn", severityFor("category.deleted") === "warn");
  check("blog.post.deleted → warn", severityFor("blog.post.deleted") === "warn");
  check("redirect.deleted → warn", severityFor("redirect.deleted") === "warn");

  console.log("severityFor — domain defaults + info fallback:");
  check("rbac.* → warn (domain default)", severityFor("rbac.role_permissions_set") === "warn");
  check("product.updated → info", severityFor("product.updated") === "info");
  check("setting.upserted → info", severityFor("setting.upserted") === "info");
  check("order.created → info", severityFor("order.created") === "info");
  check("unknown.event → info (fallback)", severityFor("totally.unknown") === "info");
  // Config events added for the later phases: info, destructive deletes warn.
  check("delivery.zone.updated → info", severityFor("delivery.zone.updated") === "info");
  check("delivery.zone.deleted → warn (.deleted)", severityFor("delivery.zone.deleted") === "warn");
  check("stock_location.created → info", severityFor("stock_location.created") === "info");
  check("stock_location.deleted → warn (.deleted)", severityFor("stock_location.deleted") === "warn");
  check("search_alias.seeded → info", severityFor("search_alias.seeded") === "info");
  check("ai.feature_prompts_updated → info", severityFor("ai.feature_prompts_updated") === "info");
  check("page.updated → info (not low-signal)", severityFor("page.updated") === "info");

  console.log("shouldLog — console floor gate:");
  check("off silences everything (even error)", shouldLog("off", "error") === false);
  check("info floor: info logs", shouldLog("info", "info") === true);
  check("info floor: debug does NOT log", shouldLog("info", "debug") === false);
  check("warn floor: info does NOT log", shouldLog("warn", "info") === false);
  check("warn floor: warn logs", shouldLog("warn", "warn") === true);
  check("warn floor: error logs", shouldLog("warn", "error") === true);
  check("debug floor: everything logs", shouldLog("debug", "debug") === true && shouldLog("debug", "error") === true);

  console.log("passesSample — debug firehose gate:");
  check("rate 100 always passes", passesSample(100, 0.999) === true);
  check("rate 0 never passes", passesSample(0, 0) === false);
  check("rate 50: rnd 0.4 passes", passesSample(50, 0.4) === true);
  check("rate 50: rnd 0.6 drops", passesSample(50, 0.6) === false);
  check("rate 50: rnd exactly 0.5 drops (strict <)", passesSample(50, 0.5) === false);

  console.log("invariants:");
  check("SEVERITY_ORDER strictly increasing", SEVERITY_ORDER.debug < SEVERITY_ORDER.info && SEVERITY_ORDER.info < SEVERITY_ORDER.warn && SEVERITY_ORDER.warn < SEVERITY_ORDER.error);
  check("LOG_LEVELS includes off + the 4 severities", LOG_LEVELS.length === 5 && LOG_LEVELS.includes("off") && LOG_LEVELS.includes("debug") && LOG_LEVELS.includes("error"));

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
