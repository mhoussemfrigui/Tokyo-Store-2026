/**
 * Static admin page-guard invariants — NO database, NO network. Guards the RBAC
 * « page 404s for a correctly-scoped role » class (A–Z audit 2026-09-23):
 *
 *  1. No render-time cross-module action call: an admin page.tsx that CALLS a
 *     server action during render (e.g. `listDataJobsAction(...)`) must either
 *     share a module with that action's gate, or put THAT call site behind a
 *     soft-check guard for the action's exact grant
 *     (`const g = permissionSetAllows(perms, "<module>", "<action>")` then
 *     `g ? action(...) : …` / `g && action(...)`; `perms.has(WILDCARD)` guards
 *     anything). Checked per call site, not per file. A gated action called
 *     unconditionally throws notFound() for a role holding the PAGE's grant but
 *     not the ACTION's (the import-data page's listDataJobsAction needs
 *     system_jobs:view, not just the page's own grant), plus a false
 *     `rbac.permission_denied` probe on the security trail.
 *  2. Every `/new` create page requires `<module>:create` (the grant its submit
 *     action requires) — or a multi-grant `requirePermissionAny` (orders/new) —
 *     so a view-only role is refused up front instead of losing a filled form to
 *     a 404 on submit.
 *  3. An admin-segment not-found boundary exists (RBAC denials render INSIDE the
 *     admin shell, not the storefront 404).
 *  4. The shared product picker accepts the review/showcase grants, and its
 *     ids → cards helper is a server-only module (never a "use server" export).
 *  5. The Médiathèque / SEO / Redirections pages resolve their write grants
 *     (view-only roles get read-only UIs).
 *
 * Pure file/text scan (like route-invariants), so it runs anywhere.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/page-guards.test.ts
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

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

const ROOT = process.cwd();
const ADMIN_DIR = join(ROOT, "src", "app", "admin");
const ACTIONS_DIR = join(ROOT, "src", "lib", "actions");

type Grant = { module: string; action: string };

const read = (p: string) => readFileSync(p, "utf8");
const rel = (p: string) => p.slice(ADMIN_DIR.length).split(sep).join("/");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function walkPages(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkPages(p, out);
    else if (entry === "page.tsx") out.push(p);
  }
  return out;
}

/** `{ module: "x", action: "y" }` entries of a grants array literal. */
function grantsInList(list: string): Grant[] {
  return [...list.matchAll(/module:\s*["'](\w+)["']\s*,\s*action:\s*["'](\w+)["']/g)].map((m) => ({
    module: m[1],
    action: m[2],
  }));
}

/**
 * The FIRST auth gate in `body` (an action's body): requirePermission(m, a),
 * requirePermissionAny([...] | CONST) (CONST resolved in `fileSrc`),
 * requireAdmin() / requireSuperAdmin() (→ the `*` wildcard). null = ungated
 * (a public helper — can't throw a permission 404), "unknown" = unresolvable.
 */
function firstGate(body: string, fileSrc: string): Grant[] | "unknown" | null {
  const cands: { i: number; grants: Grant[] | "unknown" }[] = [];
  const one = /\brequirePermission\(\s*["'](\w+)["']\s*,\s*["'](\w+)["']\s*\)/.exec(body);
  if (one) cands.push({ i: one.index, grants: [{ module: one[1], action: one[2] }] });
  const any = /\brequirePermissionAny\(\s*(\w+|\[[\s\S]*?\])\s*\)/.exec(body);
  if (any) {
    let list: string | null = any[1];
    if (!list.startsWith("[")) {
      const def = new RegExp(`const\\s+${escapeRe(list)}\\b[^=]*=\\s*(\\[[\\s\\S]*?\\])`).exec(fileSrc);
      list = def ? def[1] : null;
    }
    cands.push({ i: any.index, grants: list ? grantsInList(list) : "unknown" });
  }
  const admin = /\brequire(?:SuperAdmin|Admin)\(/.exec(body);
  if (admin) cands.push({ i: admin.index, grants: [{ module: "*", action: "*" }] });
  if (cands.length === 0) return null;
  cands.sort((a, b) => a.i - b.i);
  return cands[0].grants;
}

/** Gate of `export async function <name>` / `export const <name> =` in an action file. */
function actionGate(file: string, name: string): Grant[] | "unknown" | null {
  const p = join(ACTIONS_DIR, `${file}.ts`);
  if (!existsSync(p)) return "unknown";
  const src = read(p);
  const re = new RegExp(
    `export\\s+(?:async\\s+function\\s+${escapeRe(name)}\\b|const\\s+${escapeRe(name)}\\s*=)`,
  );
  const m = re.exec(src);
  if (!m) return "unknown";
  const rest = src.slice(m.index + m[0].length);
  const next = rest.search(/\nexport\s/);
  return firstGate(next >= 0 ? rest.slice(0, next) : rest, src);
}

const ACTION_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/actions\/([\w\-/]+)["']/g;

/** A render-time call of an imported action, and what (if anything) guards it. */
type ActionCall = {
  /** `<action file>.<exported name>` */
  action: string;
  gate: Grant[] | "unknown" | null;
  /** The page's own hard gate shares a module with the action's gate. */
  viaPageGrant: boolean;
  /** The soft-check guard directly in front of THIS call site (`guard ? call(`
   *  / `guard && call(`) when it satisfies the action's gate, else null. */
  guard: Grant | "*" | null;
};

/**
 * Every render-time call of a `@/lib/actions/*` import in an admin page, each
 * with its OWN guard. Guards are `const g = permissionSetAllows(<perms>, "m",
 * "a")` (satisfies a gate listing exactly m:a — requirePermission has no action
 * implication) and `const g = <perms>.has(WILDCARD)` (only a `*` holder runs the
 * call → every gate passes). A guard only counts at the call site it directly
 * precedes: a soft-check elsewhere in the file does not make a second,
 * unconditional call safe.
 */
function analysePage(rawSrc: string): { calls: ActionCall[]; fullAdminPage: boolean } {
  // Whole-line and block comments may name an action with `(` — not a call.
  const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const pageModules = new Set<string>();
  for (const m of src.matchAll(/\brequire(?:Permission|SuperAdmin)\(\s*["'](\w+)["']/g)) pageModules.add(m[1]);
  for (const m of src.matchAll(/\brequirePermissionAny\(\s*(\[[\s\S]*?\])\s*\)/g)) {
    for (const g of grantsInList(m[1])) pageModules.add(g.module);
  }
  const fullAdminPage = /\brequireAdmin\(\s*\)/.test(src);

  const guards = new Map<string, Grant | "*">();
  for (const m of src.matchAll(
    /const\s+(\w+)\s*=\s*permissionSetAllows\(([^;]*?),\s*["'](\w+)["']\s*,\s*["'](\w+)["']/g,
  )) {
    guards.set(m[1], { module: m[3], action: m[4] });
  }
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*\w+\.has\(\s*WILDCARD\s*\)/g)) guards.set(m[1], "*");

  const calls: ActionCall[] = [];
  for (const imp of src.matchAll(ACTION_IMPORT_RE)) {
    const body = src.replace(imp[0], "");
    const names = imp[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("type "))
      .map((s) => {
        const [orig, local] = s.split(/\s+as\s+/);
        return { orig: orig.trim(), local: (local ?? orig).trim() };
      });
    for (const n of names) {
      // Only CALLS during render matter — an action merely passed down as a
      // prop (form action / client handler) runs later, under its own gate.
      const sites = [...body.matchAll(new RegExp(`\\b${escapeRe(n.local)}\\s*\\(`, "g"))];
      if (sites.length === 0) continue;
      const gate = actionGate(imp[2], n.orig);
      const viaPageGrant = Array.isArray(gate) && gate.some((g) => pageModules.has(g.module));
      for (const site of sites) {
        const before = /\b(\w+)\s*(?:\?|&&)\s*(?:await\s+)?$/.exec(body.slice(0, site.index));
        const g = before ? guards.get(before[1]) : undefined;
        const satisfies =
          g !== undefined &&
          (g === "*" ||
            (Array.isArray(gate) && gate.some((x) => x.module === g.module && x.action === g.action)));
        calls.push({ action: `${imp[2]}.${n.orig}`, gate, viaPageGrant, guard: satisfies ? g : null });
      }
    }
  }
  return { calls, fullAdminPage };
}

function main() {
  const pages = walkPages(ADMIN_DIR);
  check("admin pages found", pages.length > 0);

  // ── 1. No render-time cross-module action call ─────────────────────────────
  console.log("render-time action calls:");
  const offenders: string[] = [];
  let calls = 0;
  for (const page of pages) {
    const { calls: pageCalls, fullAdminPage } = analysePage(read(page));
    for (const c of pageCalls) {
      calls++;
      if (c.gate === null) continue; // ungated helper — cannot 404
      const label = `${rel(page)} → ${c.action}`;
      if (c.gate === "unknown") {
        offenders.push(`${label} (gate not resolvable)`);
        continue;
      }
      if (fullAdminPage) continue; // `*`-only page: every gate passes
      if (c.viaPageGrant || c.guard) continue;
      offenders.push(`${label} [${c.gate.map((g) => `${g.module}:${g.action}`).join(" | ")}] (unguarded call site)`);
    }
  }
  check(`render-time action calls scanned (${calls})`, calls > 0);
  check(
    `no admin page calls another module's gated action unconditionally during render${offenders.length ? ` — ${offenders.join("; ")}` : ""}`,
    offenders.length === 0,
  );

  // Pin the six pages the audit found (a regression here re-404s a scoped role):
  // the action is still called during render, and EVERY call site sits behind
  // its own soft-check guard for exactly the action's gate.
  const pin = (file: string, action: string, module: string, grant: string) => {
    const hits = analysePage(read(join(ADMIN_DIR, file))).calls.filter((c) => c.action === action);
    return (
      hits.length > 0 &&
      hits.every(
        (c) => c.guard !== null && c.guard !== "*" && c.guard.module === module && c.guard.action === grant,
      )
    );
  };
  const JOBS = "data-jobs.listDataJobsAction";
  // (cms/settings no longer renders the data-cleanup danger zone — the « Nettoyage
  //  des données » section was removed, so the page makes no listDataJobsAction call.)
  check(
    "import-data page calls listDataJobsAction only behind a system_jobs:view guard",
    pin("system/import-data/page.tsx", JOBS, "system_jobs", "view"),
  );
  // ── 2. /new create pages require :create ───────────────────────────────────
  console.log("/new pages:");
  const newPages = pages.filter((p) => rel(p).endsWith("/new/page.tsx"));
  check(`/new pages found (${newPages.length})`, newPages.length >= 6);
  const weakNew = newPages
    .filter((p) => {
      const src = read(p);
      if (/\brequirePermissionAny\(/.test(src)) return false; // multi-grant surface (orders/new)
      const gates = [...src.matchAll(/\brequirePermission\(\s*["'](\w+)["']\s*,\s*["'](\w+)["']/g)];
      return gates.length === 0 || !gates.some((g) => g[2] === "create");
    })
    .map(rel);
  check(
    `every /new page requires <module>:create${weakNew.length ? ` — view-gated: ${weakNew.join(", ")}` : ""}`,
    weakNew.length === 0,
  );

  // ── 3. Admin-segment not-found boundary ────────────────────────────────────
  console.log("admin not-found:");
  const nf = join(ADMIN_DIR, "not-found.tsx");
  check("src/app/admin/not-found.tsx exists", existsSync(nf));
  const nfSrc = existsSync(nf) ? read(nf) : "";
  check("admin not-found links back to /admin", /href=["']\/admin["']/.test(nfSrc));
  check("admin not-found copy is French + non-enumerating", /Page introuvable ou accès non autorisé/.test(nfSrc));
  check(
    "admin not-found never re-throws notFound() (no next/navigation import)",
    !/from\s+["']next\/navigation["']/.test(nfSrc),
  );

  // ── 4. Shared product picker grants ────────────────────────────────────────
  console.log("product picker:");
  for (const name of ["searchProductsForPickerAction", "resolveRelatedProductOptionsAction"]) {
    const gate = actionGate("related-products", name);
    const has = (m: string, a: string) =>
      Array.isArray(gate) && gate.some((g) => g.module === m && g.action === a);
    check(
      `${name} accepts products:view + reviews:create + showcase:update`,
      has("products", "view") &&
        has("reviews", "create") &&
        has("showcase", "update"),
    );
  }
  const helper = join(ROOT, "src", "lib", "catalog", "product-picker-options.server.ts");
  const helperSrc = existsSync(helper) ? read(helper) : "";
  check(
    "picker ids → cards helper is server-only and NOT a \"use server\" module",
    /^import "server-only";/m.test(helperSrc) && !/^\s*["']use server["'];?\s*$/m.test(helperSrc),
  );

  // ── 5. Write-grant resolution on the Médiathèque / SEO / Redirections pages ─
  console.log("read-only gating:");
  const allows = (file: string, module: string, action: string) =>
    new RegExp(`permissionSetAllows\\([^"']*["']${module}["']\\s*,\\s*["']${action}["']`).test(
      read(join(ADMIN_DIR, file)),
    );
  check("media page resolves media:create", allows("media/page.tsx", "media", "create"));
  check("media page resolves media:update", allows("media/page.tsx", "media", "update"));
  check("media page resolves media:delete", allows("media/page.tsx", "media", "delete"));
  check("SEO page resolves system_seo:update", allows("system/seo/page.tsx", "system_seo", "update"));
  check(
    "redirects page resolves system_redirects:manage",
    allows("system/redirects/page.tsx", "system_redirects", "manage"),
  );
  check(
    "SEO panel disables its form without the grant",
    /<fieldset disabled=\{!canUpdate\}/.test(read(join(ADMIN_DIR, "system", "seo", "seo-settings-panel.tsx"))),
  );
  const settingsForms = read(join(ADMIN_DIR, "system", "redirects", "settings-forms.tsx"));
  check(
    "all three redirect settings forms disable their fieldset without the grant",
    (settingsForms.match(/<fieldset disabled=\{!canManage\}/g) ?? []).length === 3,
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
process.exit(0);
