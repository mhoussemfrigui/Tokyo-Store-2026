/**
 * Admin nav ↔ page-guard parity (src/lib/rbac/nav-access.ts + the admin shell).
 * PURE — no DB, no network: the visibility predicate is exercised over a matrix
 * of role shapes, and the source files are scanned so a sidebar item with an
 * explicit `visibleWhen` rule keeps sharing ONE grant constant with its page's
 * `requirePermissionAny` guard.
 *
 * Locks the regressions this fixed:
 *   - « Nouvelle commande » (nav + Commandes-list button) was hidden from an
 *     `orders:manage` role its page accepts;
 *   - a delegated `orders_new` operator was redirected to an order page that
 *     404s for them after creating an order;
 *   - no sign-out below the lg breakpoint (the topbar is `hidden` there).
 *
 * (The « Caisse » item — formerly gated on CAISSE_VIEW_GRANTS — was removed with
 * the Caisse tab; « Demande récompense » is now the other visibleWhen item.)
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/admin-nav-access.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ORDER_NEW_VIEW_GRANTS,
  allowsAnyGrant,
  expandGrantedKeys,
  isNavItemVisible,
  type PermissionGrant,
} from "@/lib/rbac/nav-access";
import { ALL_PERMISSION_KEYS, WILDCARD, type PermissionAction, type PermissionModuleId } from "@/lib/rbac/registry";

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

/** Mirror of `permissionSetAllows` (src/lib/rbac/authorize.ts is server-only and
 *  pulls the DB client, so it can't load in a pure test): "*", "<module>:*" or
 *  the exact key. */
function canFor(perms: string[]) {
  const s = new Set(perms);
  return (module: PermissionModuleId, action: PermissionAction) =>
    s.has(WILDCARD) || s.has(`${module}:*`) || s.has(`${module}:${action}`);
}

/** What resolveAdminShellAccess hands the shell: null for the wildcard, else the
 *  expanded concrete keys. */
function shellKeys(perms: string[]): Set<string> | null {
  if (perms.includes(WILDCARD)) return null;
  return new Set(expandGrantedKeys(canFor(perms)));
}

type Item = { id: string; visibleWhen?: readonly PermissionGrant[] };
const COMMANDES: Item = { id: "orders" };
const NEW_ORDER: Item = { id: "orders_new", visibleWhen: ORDER_NEW_VIEW_GRANTS };

const visible = (item: Item, perms: string[]) => isNavItemVisible(item, shellKeys(perms));

function main() {
  console.log("expandGrantedKeys:");
  const ordersStar = expandGrantedKeys(canFor(["orders:*"]));
  check(
    "orders:* → exactly the registry's orders actions",
    ordersStar.length === 3 && ["orders:view", "orders:update", "orders:manage"].every((k) => ordersStar.includes(k)),
  );
  check("wildcard → every registry key", expandGrantedKeys(canFor([WILDCARD])).length === ALL_PERMISSION_KEYS.length);
  check("never emits a wildcard key", !expandGrantedKeys(canFor([WILDCARD])).some((k) => k.includes("*")));
  check("unknown / stale key is dropped", expandGrantedKeys(canFor(["orders:frobnicate"])).length === 0);

  console.log("view-only order agent (orders:view):");
  check("Commandes visible", visible(COMMANDES, ["orders:view"]));
  check("Nouvelle commande hidden", !visible(NEW_ORDER, ["orders:view"]));

  console.log("orders:manage-only role (post-0109, no orders_new / orders:view):");
  check("Nouvelle commande VISIBLE (page accepts orders:manage)", visible(NEW_ORDER, ["orders:manage"]));
  check("Commandes hidden (no orders:view)", !visible(COMMANDES, ["orders:manage"]));

  console.log("delegated « Nouvelle commande » operator (orders_new:view+create):");
  check("Nouvelle commande visible", visible(NEW_ORDER, ["orders_new:view", "orders_new:create"]));
  check("Commandes hidden", !visible(COMMANDES, ["orders_new:view", "orders_new:create"]));
  check("orders_new:* → Nouvelle commande visible", visible(NEW_ORDER, ["orders_new:*"]));
  check("orders_new:create alone (page needs :view) → hidden", !visible(NEW_ORDER, ["orders_new:create"]));

  console.log("full access:");
  check("orders:* → Commandes + Nouvelle commande", [COMMANDES, NEW_ORDER].every((i) => visible(i, ["orders:*"])));
  check("wildcard → null keys → every item", [COMMANDES, NEW_ORDER].every((i) => isNavItemVisible(i, null)));

  console.log("default items keep the <id>:view rule:");
  check("products:view → Produits visible", visible({ id: "products" }, ["products:view"]));
  check("products:update only → Produits hidden", !visible({ id: "products" }, ["products:update"]));

  console.log("nav visibility === page guard, over a role matrix:");
  const ROLES: string[][] = [
    [],
    ["orders:view"],
    ["orders:update"],
    ["orders:manage"],
    ["orders:view", "orders:manage"],
    ["orders:*"],
    ["orders_new:view"],
    ["orders_new:create"],
    ["orders_new:*"],
    ["orders_new:view", "orders:view"],
    ["products:*"],
    [WILDCARD],
  ];
  let mismatches = 0;
  for (const role of ROLES) {
    const can = canFor(role);
    if (visible(NEW_ORDER, role) !== allowsAnyGrant(can, NEW_ORDER.visibleWhen!)) mismatches++;
    if (visible(COMMANDES, role) !== can("orders", "view")) mismatches++;
  }
  check(`nav shows an item iff its page guard passes (${ROLES.length} roles)`, mismatches === 0);

  // ── Source parity: a `visibleWhen: X` nav item ⇔ its page guards on X ─────
  console.log("source parity:");
  const ROOT = process.cwd();
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
  const shell = read("src/app/admin/_components/admin-shell.tsx");
  const navStart = shell.indexOf("const NAV_GROUPS");
  const navEnd = shell.indexOf("\n];", navStart);
  const navBlock = navStart >= 0 && navEnd >= 0 ? shell.slice(navStart, navEnd) : "";
  // Nav items are flat object literals (no nested braces) → one match per item.
  const items = [...navBlock.matchAll(/\{[^{}]*?href:\s*"([^"]+)"[^{}]*\}/g)].map((m) => ({
    href: m[1],
    visibleWhen: /visibleWhen:\s*(\w+)/.exec(m[0])?.[1] ?? null,
  }));
  check("NAV_GROUPS items parsed", items.length > 10);
  const byHref = new Map(items.map((i) => [i.href, i]));
  check(
    "Nouvelle commande item uses ORDER_NEW_VIEW_GRANTS",
    byHref.get("/admin/orders/new")?.visibleWhen === "ORDER_NEW_VIEW_GRANTS",
  );
  const ruled = items.filter((i) => i.visibleWhen);
  const drift = ruled.filter((i) => {
    const page = `src/app${i.href}/page.tsx`;
    if (!existsSync(join(ROOT, page))) return true;
    return !read(page).includes(`requirePermissionAny(${i.visibleWhen})`);
  });
  check(
    `every visibleWhen item's page guards on the same constant${drift.length ? ` — drift: ${drift.map((d) => d.href).join(", ")}` : ""}`,
    ruled.length >= 2 && drift.length === 0,
  );
  check(
    "Commandes-list button follows ORDER_NEW_VIEW_GRANTS",
    read("src/app/admin/orders/page.tsx").includes("permissionSetAllowsAny(perms, ORDER_NEW_VIEW_GRANTS)"),
  );
  check(
    "manual-order form redirects to the order only with orders:view",
    /if \(canViewOrders\) router\.push\(/.test(read("src/app/admin/orders/new/manual-order-form.tsx")),
  );
  check(
    "sign-out is reachable on both desktop and mobile",
    // The master/detail shell renders the desktop rail (`renderRail`) and the
    // mobile drawer (`renderMobileNav`) SEPARATELY — each embeds its own sign-out
    // `<form action={signoutAction}>`. So the sign-out form appears ≥2× (once per
    // surface); a mobile user always has a sign-out — the requirement the old
    // shared-rail heuristic protected.
    (shell.match(/action=\{signoutAction\}/g) ?? []).length >= 2,
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
