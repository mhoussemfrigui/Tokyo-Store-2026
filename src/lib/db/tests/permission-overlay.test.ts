/**
 * RBAC per-user permission OVERLAY (0191) — pure merge math, no DB.
 * Effective = union(roles) ∪ allow − deny; deny wins; wildcards materialized only
 * when a deny exists. Also covers the derived account-type.
 *
 * Run: npx tsx --conditions=react-server src/lib/db/tests/permission-overlay.test.ts
 */
import { applyPermissionOverlay, materializePermissionSet } from "@/lib/rbac/overlay";
import { accountTypeFromPerms } from "@/lib/rbac/account-type";
import { ALL_PERMISSION_KEYS } from "@/lib/rbac/registry";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}
const eq = (a: Set<string>, b: string[]) => a.size === b.length && b.every((k) => a.has(k));

// `products` is a known module with 5 actions (view/create/update/delete/manage).
const PRODUCTS = ["products:view", "products:create", "products:update", "products:delete", "products:manage"];

// ── fast path: no overrides ⇒ exactly the role grants, wildcard-intact ──
check("no overrides → role grants unchanged", eq(applyPermissionOverlay(["products:*", "orders:view"], []), ["products:*", "orders:view"]));
check("no overrides → '*' kept intact (not materialized)", applyPermissionOverlay(["*"], []).has("*"));

// ── allow adds ──
check("allow adds a key", eq(applyPermissionOverlay(["orders:view"], [{ permission: "products:view", effect: "allow" }]), ["orders:view", "products:view"]));
check("allow with no deny keeps wildcard intact", applyPermissionOverlay(["orders:*"], [{ permission: "products:view", effect: "allow" }]).has("orders:*"));

// ── deny removes a concrete key (materializes the wildcard first) ──
{
  const eff = applyPermissionOverlay(["products:*"], [{ permission: "products:delete", effect: "deny" }]);
  check("deny on a module wildcard drops one concrete action", !eff.has("products:delete") && eff.has("products:view") && eff.has("products:manage"));
  check("deny materialized the module wildcard (no bare 'products:*')", !eff.has("products:*"));
}

// ── deny a module wildcard removes all that module's keys ──
{
  const eff = applyPermissionOverlay(["*"], [{ permission: "products:*", effect: "deny" }]);
  check("deny '<module>:*' removes every key of that module", PRODUCTS.every((k) => !eff.has(k)));
  check("deny '<module>:*' leaves other modules intact", eff.has("orders:view"));
}

// ── global '*' deny clears everything ──
check("deny '*' clears the whole set", applyPermissionOverlay(["*"], [{ permission: "*", effect: "deny" }]).size === 0);

// ── allow + deny together (add one, remove another) ──
{
  const eff = applyPermissionOverlay(["orders:view"], [
    { permission: "products:view", effect: "allow" },
    { permission: "orders:view", effect: "deny" },
  ]);
  check("allow+deny: added key present, denied key gone", eff.has("products:view") && !eff.has("orders:view"));
}

// ── materializePermissionSet ──
check("materialize '*' → every concrete key", eq(materializePermissionSet(new Set(["*"])), [...ALL_PERMISSION_KEYS]));
check("materialize '<module>:*' → that module's concrete keys", eq(materializePermissionSet(new Set(["products:*"])), PRODUCTS));
check("materialize passes concrete keys through", eq(materializePermissionSet(new Set(["orders:view"])), ["orders:view"]));

// ── derived account type ──
check("accountType: '*' → admin", accountTypeFromPerms(new Set(["*"])) === "admin");
check("accountType: some grant → staff", accountTypeFromPerms(new Set(["products:view"])) === "staff");
check("accountType: empty → customer", accountTypeFromPerms(new Set()) === "customer");

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
