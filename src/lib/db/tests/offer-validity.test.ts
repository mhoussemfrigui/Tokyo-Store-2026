/**
 * PURE offer-validity window (src/lib/seo/offer-validity.ts). No DB.
 * Run: pnpm exec tsx --conditions=react-server src/lib/db/tests/offer-validity.test.ts
 */
import { resolveOfferValidity } from "@/lib/seo/offer-validity";

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

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function main() {
  console.log("resolveOfferValidity:");

  // No promo → 1-year horizon, validFrom = createdAt.
  const created = Date.UTC(2025, 0, 1);
  const noPromo = resolveOfferValidity({ nowMs: now, createdAtMs: created, promoStartsAtMs: null, promoEndsAtMs: null });
  check("no promo: priceValidUntil = now + 365d", noPromo.priceValidUntil === day(now + 365 * DAY));
  check("no promo: validFrom = createdAt", noPromo.validFrom === day(created));

  // Active fixed-window promo ending next week → priceValidUntil capped at promo end.
  const promoEnd = now + 7 * DAY;
  const promoStart = now - 3 * DAY;
  const promo = resolveOfferValidity({ nowMs: now, createdAtMs: created, promoStartsAtMs: promoStart, promoEndsAtMs: promoEnd });
  check("promo: priceValidUntil capped at the promo end (not +365d)", promo.priceValidUntil === day(promoEnd));
  check("promo: validFrom = the promo start", promo.validFrom === day(promoStart));

  // Promo ending AFTER the 1-year horizon → keep the horizon (don't extend beyond it).
  const farPromo = resolveOfferValidity({ nowMs: now, createdAtMs: created, promoStartsAtMs: promoStart, promoEndsAtMs: now + 400 * DAY });
  check("promo past 1y: priceValidUntil stays at +365d", farPromo.priceValidUntil === day(now + 365 * DAY));

  // A FUTURE promo start can't move validFrom forward (falls back to createdAt).
  const futureStart = resolveOfferValidity({ nowMs: now, createdAtMs: created, promoStartsAtMs: now + 2 * DAY, promoEndsAtMs: promoEnd });
  check("future promo start: validFrom falls back to createdAt", futureStart.validFrom === day(created));

  // Invariant: validFrom ≤ today ≤ priceValidUntil for the promo case.
  check("invariant validFrom ≤ now ≤ priceValidUntil", promo.validFrom <= day(now) && day(now) <= promo.priceValidUntil);

  console.log(`\n=== offer-validity: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
