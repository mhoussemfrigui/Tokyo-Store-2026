import "server-only";

/**
 * resolvePaymentMethod — pure unit test for the AUTHORITATIVE server-side
 * payment-method gate shared by BOTH place-order paths (cart + express).
 * No DB. After the express dedupe (force_online / default_method removed), the
 * contract is: an explicitly-requested gateway must be enabled; otherwise the
 * request is a COD-intent → COD when enabled, else the first enabled gateway,
 * else error. The coercion that used to flip a COD pick to an online gateway is
 * GONE — assertion #6 is the regression guard locking that in.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/quick-buy-payment.test.ts
 */
import {
  resolvePaymentMethod,
  type QuickBuyConfig,
} from "@/lib/checkout/quick-buy-config";

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

/** Minimal payment config — everything off unless overridden. */
function pay(over: Partial<QuickBuyConfig["payment"]>): QuickBuyConfig["payment"] {
  return {
    codEnabled: false,
    codLabel: "Paiement à la livraison",
    codDescription: "",
    clictopayEnabled: false,
    clictopayLabel: "",
    clictopayDescription: "",
    flouciEnabled: false,
    flouciLabel: "",
    flouciDescription: "",
    ...over,
  };
}

/** True when the resolver returned ok with the expected method. */
function isMethod(
  res: ReturnType<typeof resolvePaymentMethod>,
  method: string,
): boolean {
  return res.ok === true && res.method === method;
}

function main() {
  // 1. Explicit enabled gateway → returned verbatim.
  check(
    "clictopay requested + clictopay enabled → clictopay",
    isMethod(resolvePaymentMethod("clictopay", pay({ clictopayEnabled: true })), "clictopay"),
  );
  check(
    "flouci requested + flouci enabled → flouci",
    isMethod(resolvePaymentMethod("flouci", pay({ flouciEnabled: true })), "flouci"),
  );

  // 2. Explicit DISABLED gateway → rejected (can't pay through a disabled provider).
  check(
    "clictopay requested + clictopay disabled → rejected",
    resolvePaymentMethod("clictopay", pay({ codEnabled: true })).ok === false,
  );
  check(
    "flouci requested + only clictopay enabled → rejected",
    resolvePaymentMethod("flouci", pay({ clictopayEnabled: true })).ok === false,
  );

  // 3. COD-intent (cod / empty / null / unknown / legacy card_stripe) + COD on → cod.
  for (const req of ["cod", "", "unknown", "card_stripe"] as const) {
    check(
      `'${req}' + codEnabled → cod`,
      isMethod(resolvePaymentMethod(req, pay({ codEnabled: true })), "cod"),
    );
  }
  check(
    "null request + codEnabled → cod",
    isMethod(resolvePaymentMethod(null, pay({ codEnabled: true })), "cod"),
  );

  // 4. COD off + a gateway live → COD-intent falls back to the FIRST enabled gateway
  //    (ONLINE_METHODS order: clictopay, flouci).
  check(
    "empty + COD off + flouci enabled → flouci (first-gateway fallback)",
    isMethod(resolvePaymentMethod("", pay({ flouciEnabled: true })), "flouci"),
  );
  check(
    "cod requested + COD off + clictopay+flouci enabled → clictopay (first in order)",
    isMethod(
      resolvePaymentMethod("cod", pay({ clictopayEnabled: true, flouciEnabled: true })),
      "clictopay",
    ),
  );

  // 5. No method at all (COD off, zero gateways) → rejected (misconfiguration).
  check(
    "COD off + no gateway → rejected",
    resolvePaymentMethod("cod", pay({})).ok === false,
  );

  // 6. REGRESSION GUARD: a COD/empty request with COD ON must resolve to 'cod'
  //    EVEN when a gateway is also enabled — the old force-online coercion that
  //    flipped this to the gateway is gone. This is the bug the dedupe fixed.
  check(
    "empty + codEnabled + clictopay enabled → cod (NOT coerced to clictopay)",
    isMethod(
      resolvePaymentMethod("", pay({ codEnabled: true, clictopayEnabled: true })),
      "cod",
    ),
  );
  check(
    "cod requested + codEnabled + all gateways enabled → cod",
    isMethod(
      resolvePaymentMethod(
        "cod",
        pay({ codEnabled: true, clictopayEnabled: true, flouciEnabled: true }),
      ),
      "cod",
    ),
  );

  // 7. Requests are trimmed + lower-cased before matching.
  check(
    "' CLICTOPAY ' + clictopay enabled → clictopay (trim + lowercase)",
    isMethod(resolvePaymentMethod(" CLICTOPAY ", pay({ clictopayEnabled: true })), "clictopay"),
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
