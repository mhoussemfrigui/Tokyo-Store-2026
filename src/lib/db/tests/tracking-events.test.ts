/**
 * Pure tracking event taxonomy — event→group mapping + the per-group activation
 * gate used by the funnel, plus the /api/track server-mirror switch. No DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/tracking-events.test.ts
 */
import {
  ALL_FUNNEL_EVENTS,
  EVENT_GROUPS,
  groupForEvent,
  isEventEnabled,
  type FunnelEvent,
  type TrackingEventGroup,
} from "@/lib/tracking/event-groups";
import { serverMirrorActive } from "@/lib/tracking/server-mirror";

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
  console.log("groupForEvent:");
  const expected: Record<FunnelEvent, TrackingEventGroup> = {
    view_item_list: "view_item_list",
    select_item: "product",
    view_item: "product",
    add_to_cart: "cart",
    remove_from_cart: "cart",
    view_cart: "cart",
    add_to_wishlist: "wishlist",
    begin_checkout: "checkout",
    add_shipping_info: "checkout",
    add_payment_info: "checkout",
    purchase: "purchase",
    refund: "purchase",
    search: "search",
    login: "auth",
    sign_up: "auth",
    view_promotion: "promotion",
    select_promotion: "promotion",
  };
  for (const [event, group] of Object.entries(expected) as [FunnelEvent, TrackingEventGroup][]) {
    check(`${event} → ${group}`, groupForEvent(event) === group);
  }

  console.log("EVENT_GROUPS:");
  check("9 groups", EVENT_GROUPS.length === 9);
  check(
    "every event maps to a declared group",
    (Object.keys(expected) as FunnelEvent[]).every((e) =>
      EVENT_GROUPS.some((g) => g.key === groupForEvent(e)),
    ),
  );
  check("product + cart + checkout + purchase default ON", [
    "product",
    "cart",
    "checkout",
    "purchase",
    "view_item_list",
  ].every((k) => EVENT_GROUPS.find((g) => g.key === k)?.defaultEnabled === true));
  check("wishlist + search + auth + promotion default OFF", [
    "wishlist",
    "search",
    "auth",
    "promotion",
  ].every((k) => EVENT_GROUPS.find((g) => g.key === k)?.defaultEnabled === false));

  console.log("ALL_FUNNEL_EVENTS (drift guard — /api/track derives its allow-list from this):");
  check("17 events total", ALL_FUNNEL_EVENTS.length === 17);
  check(
    "matches the expected union exactly",
    ALL_FUNNEL_EVENTS.length === Object.keys(expected).length &&
      ALL_FUNNEL_EVENTS.every((e) => e in expected),
  );
  check(
    "every listed event resolves to a declared group",
    ALL_FUNNEL_EVENTS.every((e) => EVENT_GROUPS.some((g) => g.key === groupForEvent(e))),
  );

  console.log("isEventEnabled:");
  check("undefined flags → default-on", isEventEnabled(undefined, "purchase") === true);
  check("null flags → default-on", isEventEnabled(null, "add_to_cart") === true);
  check("empty flags → default-on", isEventEnabled({}, "view_item") === true);
  check(
    "group=false suppresses every event in it",
    isEventEnabled({ cart: false }, "add_to_cart") === false &&
      isEventEnabled({ cart: false }, "view_cart") === false &&
      isEventEnabled({ cart: false }, "remove_from_cart") === false,
  );
  check(
    "group=false leaves other groups on",
    isEventEnabled({ cart: false }, "purchase") === true &&
      isEventEnabled({ cart: false }, "view_item") === true,
  );
  check("group=true allows", isEventEnabled({ search: true }, "search") === true);
  check(
    "all-off map suppresses everything (master disabled)",
    EVENT_GROUPS.every((g) => {
      const allOff = Object.fromEntries(EVENT_GROUPS.map((x) => [x.key, false]));
      return isEventEnabled(allOff, "purchase") === false;
    }),
  );

  // No server fan-out is wired yet: production must not POST /api/track (the
  // client skips it + the route answers before any DB work); dev keeps the log.
  console.log("serverMirrorActive (no fan-out wired):");
  check("production → off (no wasted /api/track round-trips)", serverMirrorActive("production") === false);
  check("development → on (the [track] debug log)", serverMirrorActive("development") === true);
  check("test → on", serverMirrorActive("test") === true);
  check("unset NODE_ENV → on (non-production)", serverMirrorActive(undefined) === true);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
