/**
 * resolveErpConfig — the ERP sync-posture resolver (off / platform / erp / mixed).
 * PURE (no DB). Locks the contract: push/pull are FIXED by the three presets and
 * read from their own keys ONLY in `mixed`, so a preset can't silently disagree
 * with itself; an unknown mode is the safe `off`; pushTransfers reads its own key
 * in every mode. Enforcement of authority is Phase 2 — this only resolves the
 * recorded posture.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/erp-config.test.ts
 */
import {
  resolveErpConfig,
  ERP_MODE_KEY,
  ERP_PUSH_STOCK_KEY,
  ERP_PULL_STOCK_KEY,
  ERP_PUSH_TRANSFERS_KEY,
  ERP_PUSH_WARRANTY_KEY,
  ERP_PULL_WARRANTY_KEY,
} from "@/lib/inventory/erp-config";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

function main() {
  // Default / unset → off, nothing pushed or pulled.
  {
    const c = resolveErpConfig({});
    check("empty → mode off", c.mode === "off");
    check("off → no push, no pull, no pushTransfers", !c.pushStock && !c.pullStock && !c.pushTransfers);
  }

  // Unknown mode falls back to off (safe default).
  check("unknown mode → off", resolveErpConfig({ [ERP_MODE_KEY]: "banana" }).mode === "off");

  // platform preset → push only (ERP mirrors); the axis keys are IGNORED.
  {
    const c = resolveErpConfig({ [ERP_MODE_KEY]: "platform", [ERP_PULL_STOCK_KEY]: "true" });
    check("platform → pushStock true", c.pushStock === true);
    check("platform → pullStock false (preset ignores the pull key)", c.pullStock === false);
  }

  // erp preset → pull only (ERP authoritative); the axis keys are IGNORED.
  {
    const c = resolveErpConfig({ [ERP_MODE_KEY]: "erp", [ERP_PUSH_STOCK_KEY]: "true" });
    check("erp → pullStock true", c.pullStock === true);
    check("erp → pushStock false (preset ignores the push key)", c.pushStock === false);
  }

  // mixed → both axes read from their own keys.
  {
    const c = resolveErpConfig({
      [ERP_MODE_KEY]: "mixed",
      [ERP_PUSH_STOCK_KEY]: "true",
      [ERP_PULL_STOCK_KEY]: "false",
    });
    check("mixed → pushStock from its key (true)", c.pushStock === true);
    check("mixed → pullStock from its key (false)", c.pullStock === false);
  }

  // pushTransfers reads its own key regardless of mode.
  check(
    "pushTransfers true in platform mode",
    resolveErpConfig({ [ERP_MODE_KEY]: "platform", [ERP_PUSH_TRANSFERS_KEY]: "true" }).pushTransfers === true,
  );
  check(
    "pushTransfers true even in off mode (posture recorded independently)",
    resolveErpConfig({ [ERP_MODE_KEY]: "off", [ERP_PUSH_TRANSFERS_KEY]: "true" }).pushTransfers === true,
  );
  check(
    "pushTransfers case-sensitive: 'TRUE' → false",
    resolveErpConfig({ [ERP_MODE_KEY]: "mixed", [ERP_PUSH_TRANSFERS_KEY]: "TRUE" }).pushTransfers === false,
  );

  // pushWarranty / pullWarranty are own-key + mode-INDEPENDENT (like transfers) —
  // the stock mode never fixes them, so the stock presets can't overload SAV sync.
  {
    const off = resolveErpConfig({});
    check("warranty axes default false", off.pushWarranty === false && off.pullWarranty === false);
  }
  check(
    "pushWarranty true even in off mode (independent of stock mode)",
    resolveErpConfig({ [ERP_MODE_KEY]: "off", [ERP_PUSH_WARRANTY_KEY]: "true" }).pushWarranty === true,
  );
  check(
    "pullWarranty true in platform mode (stock preset does NOT fix it)",
    resolveErpConfig({ [ERP_MODE_KEY]: "platform", [ERP_PULL_WARRANTY_KEY]: "true" }).pullWarranty === true,
  );
  check(
    "warranty axes independent of the stock pull/push",
    (() => {
      const c = resolveErpConfig({ [ERP_MODE_KEY]: "erp", [ERP_PUSH_WARRANTY_KEY]: "true" });
      // erp preset → pullStock true / pushStock false, but pushWarranty follows its own key.
      return c.pullStock === true && c.pushStock === false && c.pushWarranty === true && c.pullWarranty === false;
    })(),
  );
  check(
    "pushWarranty case-sensitive: 'TRUE' → false",
    resolveErpConfig({ [ERP_MODE_KEY]: "mixed", [ERP_PUSH_WARRANTY_KEY]: "TRUE" }).pushWarranty === false,
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
