/**
 * PURE delivery-fee rules — NO database, NO network.
 *
 * Guards the shared free-threshold + zone-lookup helpers that keep the fee SHOWN
 * to the customer equal to the fee CHARGED (`applyFreeThreshold` /
 * `zoneHomeAgentFee` in src/lib/checkout/delivery-fee.ts). The DB-backed
 * display==charge invariant lives in delivery-zone.test.ts.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/delivery-fee.test.ts
 */
import {
  applyFreeThreshold,
  normalizeGovernorate,
  canonicalizeGovernorateList,
  zoneHomeAgentFee,
  type RegionAgentFeeIndex,
} from "@/lib/checkout/delivery-fee";

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

// ── applyFreeThreshold ──────────────────────────────────────────────────────
{
  const below = applyFreeThreshold(7000, 50000, 30000);
  check("below threshold → fee charged, not free", below.feeCents === 7000 && !below.freeApplied);

  const at = applyFreeThreshold(7000, 50000, 50000);
  check("AT threshold → free (>=)", at.feeCents === 0 && at.freeApplied);

  const above = applyFreeThreshold(7000, 50000, 80000);
  check("above threshold → free", above.feeCents === 0 && above.freeApplied);

  // 0 threshold is the "never free" sentinel — fee always charged.
  const never = applyFreeThreshold(7000, 0, 999999);
  check("threshold 0 = never free → fee charged", never.feeCents === 7000 && !never.freeApplied);

  // A 0 FEE is how you make delivery always free (not a 0 threshold).
  const freeFee = applyFreeThreshold(0, 0, 0);
  check("fee 0 → 0 regardless", freeFee.feeCents === 0);
}

// ── normalizeGovernorate (accent + case + trim folding) ─────────────────────
{
  check("accents folded: Béja == Beja", normalizeGovernorate("Béja") === normalizeGovernorate("Beja"));
  check("case + trim folded: ' GABÈS ' == gabes", normalizeGovernorate(" GABÈS ") === normalizeGovernorate("gabes"));
  check("Médenine == medenine", normalizeGovernorate("Médenine") === normalizeGovernorate("medenine"));
  check("Kébili == kebili", normalizeGovernorate("Kébili") === normalizeGovernorate("kebili"));
  check("distinct names stay distinct", normalizeGovernorate("Sfax") !== normalizeGovernorate("Sousse"));
  check("null/blank → empty string", normalizeGovernorate(null) === "" && normalizeGovernorate("  ") === "");
}

// ── canonicalizeGovernorateList (admin zone save) ───────────────────────────
{
  check(
    "accent/case normalized to official names",
    canonicalizeGovernorateList("sfax, BÉJA , gabes") === "Sfax, Béja, Gabès",
  );
  check(
    "dropped article tolerated: manouba → La Manouba, kef → Le Kef",
    canonicalizeGovernorateList("manouba, kef") === "La Manouba, Le Kef",
  );
  check(
    "unknown entry kept verbatim (trimmed)",
    canonicalizeGovernorateList("Sfax,  Zone Custom ") === "Sfax, Zone Custom",
  );
  check("empty → empty", canonicalizeGovernorateList("") === "" && canonicalizeGovernorateList(null) === "");
}

// ── zoneHomeAgentFee ────────────────────────────────────────────────────────
{
  const index: RegionAgentFeeIndex = {
    sfax: { "agent-1": { feeCents: 5000, thresholdCents: 50000 } },
    // Index key is normalized (no accent) — matches an accented region lookup.
    beja: { "agent-1": { feeCents: 6000, thresholdCents: 0 } },
  };

  const hit = zoneHomeAgentFee(index, "Sfax", "agent-1", 30000);
  check("region hit (case-insensitive) → zone fee", hit?.feeCents === 5000 && !hit?.freeApplied);

  const hitFree = zoneHomeAgentFee(index, "SFAX", "agent-1", 60000);
  check("region hit above threshold → free", hitFree?.feeCents === 0 && hitFree?.freeApplied === true);

  const wrongRegion = zoneHomeAgentFee(index, "Bizerte", "agent-1", 30000);
  check("region not in index → null (caller uses flat fee)", wrongRegion === null);

  const wrongAgent = zoneHomeAgentFee(index, "Sfax", "agent-2", 30000);
  check("agent not in zone → null", wrongAgent === null);

  check("null region → null", zoneHomeAgentFee(index, null, "agent-1", 30000) === null);
  check("blank region → null", zoneHomeAgentFee(index, "  ", "agent-1", 30000) === null);
  check("null/absent agentId → null", zoneHomeAgentFee(index, "Sfax", null, 30000) === null);
  check("null index → null", zoneHomeAgentFee(null, "Sfax", "agent-1", 30000) === null);

  // Accent-insensitive lookup: accented region "Béja" hits the normalized "beja" key.
  const accented = zoneHomeAgentFee(index, "Béja", "agent-1", 30000);
  check("accented region 'Béja' matches normalized 'beja' key", accented?.feeCents === 6000);
}

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
