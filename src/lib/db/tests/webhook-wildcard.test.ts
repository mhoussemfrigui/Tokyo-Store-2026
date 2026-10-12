import "server-only";

/**
 * Outbound-webhook `["*"]` data minimisation — the behaviour of
 * `isSecuritySensitiveEvent` (dispatch-webhooks.ts) plus the admin copy that
 * explains it. A wildcard endpoint receives every event EXCEPT the PII-bearing
 * security domains (auth / rbac / api_key / user / data); an integrator must
 * subscribe to those BY NAME. wiring-matrix.test.ts pins the dispatcher's
 * STRUCTURE (the `includes("*")` branch returns the predicate's negation); this
 * file pins the predicate's RESULTS and that the « S'abonner à TOUS les
 * évènements » helper text in the API panel names every excluded domain — so
 * adding a domain to SECURITY_DOMAINS without telling operators fails here.
 *
 * In test:db only because importing the subscriber pulls in the db client (it
 * needs the env to IMPORT); no query runs.
 *
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/webhook-wildcard.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SECURITY_DOMAINS, isSecuritySensitiveEvent } from "@/events/subscribers/dispatch-webhooks";
import { EVENT_NAMES } from "@/lib/api-auth/event-catalog";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

function main() {
  console.log("security events are excluded from the wildcard:");
  for (const name of [
    "user.created",
    "user.email_verified",
    "user.signed_in",
    "auth.rate_limited",
    "rbac.permission_denied",
    "api_key.auth_failed",
    "data.exported",
  ]) {
    check(`« ${name} » → sensitive`, isSecuritySensitiveEvent(name) === true);
  }

  console.log("business events still reach the wildcard:");
  for (const name of [
    "product.updated",
    "order.placed",
    "order.status_changed",
    "customer.deleted",
    "job.run_triggered",
  ]) {
    check(`« ${name} » → not sensitive`, isSecuritySensitiveEvent(name) === false);
  }

  console.log("only the FIRST dotted segment decides (no prefix/substring match):");
  check("« users.created » (domain users) → not sensitive", isSecuritySensitiveEvent("users.created") === false);
  check("« userx.created » → not sensitive", isSecuritySensitiveEvent("userx.created") === false);
  check("« order.user_linked » (user in a later segment) → not sensitive", isSecuritySensitiveEvent("order.user_linked") === false);
  check("empty name → not sensitive", isSecuritySensitiveEvent("") === false);

  console.log("catalog coverage:");
  const excluded = EVENT_NAMES.filter((n) => isSecuritySensitiveEvent(n));
  check(`some catalogued events are excluded (${excluded.length})`, excluded.length > 0);
  check(
    "every excluded catalogued event sits in a SECURITY_DOMAINS domain",
    excluded.every((n) => SECURITY_DOMAINS.has(n.split(".")[0] ?? "")),
  );
  check(
    "most catalogued events still reach a wildcard endpoint",
    EVENT_NAMES.length - excluded.length > excluded.length,
  );

  console.log("admin helper copy names every excluded domain:");
  const panel = readFileSync(
    join(process.cwd(), "src", "app", "admin", "system", "api", "api-webhooks-panel.tsx"),
    "utf8",
  );
  for (const d of SECURITY_DOMAINS) {
    check(`api-webhooks-panel.tsx mentions « ${d}.* »`, panel.includes(`${d}.*`));
  }
  check("helper copy says the wildcard has exceptions (SAUF)", panel.includes("SAUF les évènements de sécurité"));

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main();
