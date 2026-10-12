/**
 * resolveInventoryConfig — the opt-in multi-location toggle behind the
 * per_location stock mode. PURE (no DB). Locks the safe-by-default contract:
 * anything but the exact "per_location" / "true" strings resolves to the
 * single-pool / off defaults.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/inventory-config.test.ts
 */
import {
  resolveInventoryConfig,
  INVENTORY_LOCATION_MODE_KEY,
  INVENTORY_CARRIER_LINK_KEY,
  INVENTORY_TRANSFERS_KEY,
  INVENTORY_TRANSFER_AUTO_KEY,
  INVENTORY_TRANSFER_SOURCING_KEY,
} from "@/lib/inventory/locations-config";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

function main() {
  console.log("defaults (empty settings) → single-pool, everything off:");
  const def = resolveInventoryConfig({});
  check("locationMode defaults to shared", def.locationMode === "shared");
  check("carrierLinkEnabled defaults off", def.carrierLinkEnabled === false);
  check("transfersEnabled defaults off", def.transfersEnabled === false);
  check("transferAutoRequest defaults off", def.transferAutoRequest === false);
  check("transferSourcing defaults to priority", def.transferSourcing === "priority");

  console.log("explicit opt-in:");
  const on = resolveInventoryConfig({
    [INVENTORY_LOCATION_MODE_KEY]: "per_location",
    [INVENTORY_CARRIER_LINK_KEY]: "true",
    [INVENTORY_TRANSFERS_KEY]: "true",
  });
  check("per_location enables per-location mode", on.locationMode === "per_location");
  check("carrier link on", on.carrierLinkEnabled === true);
  check("transfers on", on.transfersEnabled === true);

  console.log("safe-by-default: garbage / partial values fall back:");
  check(
    "unknown mode string → shared",
    resolveInventoryConfig({ [INVENTORY_LOCATION_MODE_KEY]: "banana" }).locationMode === "shared",
  );
  check(
    "null mode → shared",
    resolveInventoryConfig({ [INVENTORY_LOCATION_MODE_KEY]: null }).locationMode === "shared",
  );
  check(
    "carrier '1' (not 'true') → off",
    resolveInventoryConfig({ [INVENTORY_CARRIER_LINK_KEY]: "1" }).carrierLinkEnabled === false,
  );
  check(
    "transfers 'TRUE' (case-sensitive) → off",
    resolveInventoryConfig({ [INVENTORY_TRANSFERS_KEY]: "TRUE" }).transfersEnabled === false,
  );

  // Transfer auto-request + sourcing strategy.
  check(
    "transferAutoRequest 'true' → on",
    resolveInventoryConfig({ [INVENTORY_TRANSFER_AUTO_KEY]: "true" }).transferAutoRequest === true,
  );
  check(
    "transferSourcing 'most_stock' → most_stock",
    resolveInventoryConfig({ [INVENTORY_TRANSFER_SOURCING_KEY]: "most_stock" }).transferSourcing === "most_stock",
  );
  check(
    "transferSourcing unknown value → priority (safe default)",
    resolveInventoryConfig({ [INVENTORY_TRANSFER_SOURCING_KEY]: "banana" }).transferSourcing === "priority",
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
