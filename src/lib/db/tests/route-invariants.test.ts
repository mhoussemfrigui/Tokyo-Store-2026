/**
 * Static structural invariants — NO database, NO network. Guards the registries
 * and RBAC gates that silently drift as routes/nav/actions evolve:
 *
 *  1. API catalog ⇔ disk: every `src/app/api/**\/route.ts` handler (its exported
 *     HTTP methods) is registered in `route-catalog.ts`, AND every catalogued
 *     route has a matching file+method on disk. Catches the class of bug where a
 *     route gains a second method (e.g. a GET callback alongside the POST) but
 *     the API & Webhooks inventory keeps under-reporting it.
 *  2. Admin nav ⊆ RBAC registry: every NAV_GROUPS item id is a real
 *     PERMISSION_MODULES id, so nav visibility + the role editor line up.
 *  3. Admin nav ⇔ page guard parity: the page behind each sidebar item guards
 *     exactly what makes the item VISIBLE — `requirePermission("<id>", "view")`,
 *     or, for an item carrying a `visibleWhen` grant list, `requirePermissionAny`
 *     on the SAME constant (src/lib/rbac/nav-access.ts). Otherwise the sidebar
 *     shows a link that 404s (Caisse was shown to orders:view but needs
 *     orders:manage) or hides a page the role may open. Exceptions are declared.
 *  4. Admin page guard coverage: every `src/app/admin/**\/page.tsx` calls an RBAC
 *     gate (requirePermission / requirePermissionAny / requireSuperAdmin) —
 *     module isolation is enforced per-page (the layout only checks admin-AREA
 *     access), so a page added without its guard would expose its data to any
 *     admin-area delegate. `requireAdminArea` alone is accepted ONLY for the
 *     declared allow-list (dashboard: per-block grants; the data-free Système
 *     index). A guard-less page passes only as a pure redirect stub (imports
 *     nothing but next/navigation). Calls are read from the TypeScript AST, so a
 *     guard NAME in a comment never counts.
 *  5. Server-action guard coverage — PER EXPORT, not per file: every export of a
 *     `"use server"` module opens with an RBAC guard as its FIRST awaited call
 *     (directly or through a same-file helper), so one guarded export can't
 *     cover a new unguarded sibling and no DB read runs before authorization.
 *     Shopper-facing exports gated by the caller's own session / a signed token
 *     are declared in PUBLIC_ACTIONS.
 *  6. Owner-only step-ups stay wired: the store-wide destructive / account-
 *     takeover-capable surfaces keep their `*` (super-admin) or RBAC-bounded check
 *     on top of the module grant (demo clear, data-job clean, demo purge, mail
 *     transport + security templates, custom tracking scripts, API-key scopes).
 *
 * Render-time cross-module action calls and the `/new` → `:create` rule are
 * covered by page-guards.test.ts.
 *
 * Pure file/AST scan, so it runs anywhere (no DB connection needed).
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/route-invariants.test.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, sep } from "node:path";

import ts from "typescript";

import { ALL_ROUTES, APP_METADATA_ROUTES, APP_ROUTE_HANDLERS, EXTERNAL_API_ROUTES, TOGGLEABLE_PUBLIC_IDS } from "@/lib/api-auth/route-catalog";
import { PERMISSION_MODULES } from "@/lib/rbac/registry";

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
const APP_DIR = join(ROOT, "src", "app");
const API_DIR = join(APP_DIR, "api");
// Matches `export async function GET`, `export function POST`, `export const PATCH = …`.
const METHOD_RE = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
const list = (xs: string[]) => (xs.length ? ` — ${xs.join(", ")}` : "");

function walkRoutes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkRoutes(p, out);
    else if (entry === "route.ts") out.push(p);
  }
  return out;
}

/** `src/app/api/foo/[id]/route.ts` → `/api/foo/[id]` (the catalog's path syntax). */
function urlPathOf(file: string): string {
  return file.slice(APP_DIR.length).split(sep).join("/").replace(/[\\/]route\.ts$/, "");
}

// ── TypeScript AST helpers ───────────────────────────────────────────────────
const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let sf = parsed.get(file);
  if (!sf) {
    sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    parsed.set(file, sf);
  }
  return sf;
}

function each(node: ts.Node, fn: (n: ts.Node) => void) {
  fn(node);
  ts.forEachChild(node, (c) => each(c, fn));
}

function stringOf(n: ts.Node | undefined): string | null {
  return n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
}

/** Local binding → where it was imported from (+ its original exported name). */
function importsOf(sf: ts.SourceFile): Map<string, { from: string; name: string }> {
  const out = new Map<string, { from: string; name: string }>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      out.set(el.name.text, { from: st.moduleSpecifier.text, name: (el.propertyName ?? el.name).text });
    }
  }
  return out;
}

const isExported = (n: ts.Node) =>
  ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

type LocalFn = { body: ts.Node; exported: boolean };
/** Top-level functions of a module: `function f() {}` and `const f = async () => …`. */
function localFunctions(sf: ts.SourceFile): Map<string, LocalFn> {
  const out = new Map<string, LocalFn>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) {
      out.set(st.name.text, { body: st.body, exported: isExported(st) });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          out.set(d.name.text, { body: init.body, exported: isExported(st) });
        }
      }
    }
  }
  return out;
}

/** Every export of a module that is NOT a function (types are erased, so ignored). */
function nonFunctionExports(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || !isExported(st)) continue;
    for (const d of st.declarationList.declarations) {
      const init = d.initializer;
      if (!(init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))) out.push(d.name.getText(sf));
    }
  }
  return out;
}

/**
 * The first call a function body makes in source order (nested functions
 * skipped): the first AWAITED call, or — with `includeReturns` — a returned
 * call (`return requirePermission(…)` in a helper, `=> otherAction(x)`).
 */
function firstCall(body: ts.Node, includeReturns: boolean): string | null {
  if (!ts.isBlock(body)) {
    let e = body as ts.Expression;
    while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
    if (ts.isCallExpression(e)) return e.expression.getText();
  }
  let found: string | null = null;
  const visit = (n: ts.Node) => {
    if (found !== null) return;
    if (n !== body && ts.isFunctionLike(n)) return;
    let e: ts.Expression | undefined;
    if (ts.isAwaitExpression(n)) e = n.expression;
    else if (includeReturns && ts.isReturnStatement(n)) e = n.expression;
    if (e) {
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isCallExpression(e)) {
        found = e.expression.getText();
        return;
      }
      if (ts.isAwaitExpression(n)) {
        found = "<non-call await>";
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

/** Where the RBAC gates live — a guard NAME only counts when imported from here. */
const AUTH_GUARD_MODULES = new Set(["@/lib/auth/session", "@/lib/auth/super-admin"]);
/** 404-on-deny RBAC gates: one grant, any-of grants, grant + the `*` step-up. */
const RBAC_GUARDS = new Set(["requirePermission", "requirePermissionAny", "requireSuperAdmin"]);

/** Calls to an auth-module helper, resolved through import aliases (AST — comments never count). */
function authCalls(sf: ts.SourceFile): { name: string; call: ts.CallExpression }[] {
  const imports = importsOf(sf);
  const out: { name: string; call: ts.CallExpression }[] = [];
  each(sf, (n) => {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return;
    const imp = imports.get(n.expression.text);
    if (imp && AUTH_GUARD_MODULES.has(imp.from)) out.push({ name: imp.name, call: n });
  });
  return out;
}

type Grant = `${string}:${string}`;
/** `{ module: "m", action: "a" }` object literals of a grants array literal. */
function grantsOfArray(arr: ts.ArrayLiteralExpression): Grant[] {
  const out: Grant[] = [];
  for (const el of arr.elements) {
    if (!ts.isObjectLiteralExpression(el)) continue;
    const prop = (k: string) => {
      const p = el.properties.find(
        (x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && x.name.getText() === k,
      );
      return p ? stringOf(p.initializer) : null;
    };
    const m = prop("module");
    const a = prop("action");
    if (m && a) out.push(`${m}:${a}`);
  }
  return out;
}

/** What a page's RBAC gates grant: literal grants + `requirePermissionAny(<CONST>)` refs. */
function pageGates(sf: ts.SourceFile) {
  const grants: Grant[] = [];
  const anyRefs: { name: string; from: string }[] = [];
  const anyLiterals: Grant[][] = [];
  const imports = importsOf(sf);
  const calls = authCalls(sf);
  for (const { name, call } of calls) {
    if (name === "requirePermission" || name === "requireSuperAdmin") {
      const m = stringOf(call.arguments[0]);
      const a = stringOf(call.arguments[1]);
      if (m && a) grants.push(`${m}:${a}`);
    } else if (name === "requirePermissionAny") {
      const arg = call.arguments[0];
      if (arg && ts.isIdentifier(arg)) anyRefs.push({ name: arg.text, from: imports.get(arg.text)?.from ?? "<local>" });
      else if (arg && ts.isArrayLiteralExpression(arg)) anyLiterals.push(grantsOfArray(arg));
    }
  }
  return {
    grants,
    anyRefs,
    anyLiterals,
    rbac: calls.some((c) => RBAC_GUARDS.has(c.name)),
    area: calls.some((c) => c.name === "requireAdminArea"),
  };
}

/** The initializer of the first `const <name> = …` anywhere in the file. */
function declInit(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  each(sf, (n) => {
    if (!found && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) found = n.initializer;
  });
  return found;
}

function objProp(o: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  const p = o.properties.find((x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && x.name.getText() === key);
  return p?.initializer;
}

function main() {
  // ── API catalog ⇔ disk ────────────────────────────────────────────────────
  const disk = new Set<string>();
  for (const file of walkRoutes(API_DIR)) {
    const path = urlPathOf(file);
    for (const m of readFileSync(file, "utf8").matchAll(METHOD_RE)) {
      disk.add(`${m[1]} ${path}`);
    }
  }
  const catalog = new Set(ALL_ROUTES.map((r) => `${r.method} ${r.path}`));

  const unregistered = [...disk].filter((d) => !catalog.has(d)).sort();
  check(
    `every API handler is registered in route-catalog${unregistered.length ? ` — missing: ${unregistered.join(", ")}` : ""}`,
    unregistered.length === 0,
  );

  const phantom = [...catalog].filter((c) => !disk.has(c)).sort();
  check(
    `every catalogued route exists on disk${phantom.length ? ` — phantom: ${phantom.join(", ")}` : ""}`,
    phantom.length === 0,
  );

  // No duplicate route ids (the inventory keys on id).
  const ids = ALL_ROUTES.map((r) => r.id);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  check(`no duplicate route ids${dupIds.length ? ` — ${[...new Set(dupIds)].join(", ")}` : ""}`, dupIds.length === 0);

  // ── External public-toggle invariants ──────────────────────────────────────
  // Only READ routes may ever be public-toggleable; a WRITE route must never be.
  const writeTogglable = EXTERNAL_API_ROUTES.filter((r) => r.canBePublic && r.action !== "read");
  check(
    `no WRITE route is public-toggleable${writeTogglable.length ? ` — ${writeTogglable.map((r) => r.id).join(", ")}` : ""}`,
    writeTogglable.length === 0,
  );
  // The order reads carry customer PII (name/email/phone/address/payment ref), so
  // they are key-ONLY (canBePublic:false). A regression that flips them back would
  // let an admin expose order data keyless via the API settings panel.
  check("orders.list is key-ONLY (not public-toggleable)", !TOGGLEABLE_PUBLIC_IDS.has("orders.list"));
  check("orders.get is key-ONLY (not public-toggleable)", !TOGGLEABLE_PUBLIC_IDS.has("orders.get"));

  // Every external (ERP) route carries a concrete action + scope. The ERP admin
  // tab splits the surface into reads (action==='read') vs writes by this field,
  // so a route missing `action` would silently land in the wrong bucket.
  const extNoAction = EXTERNAL_API_ROUTES.filter((r) => !r.action || !r.scope).map((r) => r.id);
  check(
    `every external route has action + scope${extNoAction.length ? ` — missing: ${extNoAction.join(", ")}` : ""}`,
    extNoAction.length === 0,
  );

  // ── Admin nav ⊆ RBAC registry ─────────────────────────────────────────────
  const shellFile = join(APP_DIR, "admin", "_components", "admin-shell.tsx");
  const shellSf = parse(shellFile);
  const shellImports = importsOf(shellSf);
  type NavItem = { id: string; href: string; visibleWhen: ts.Expression | undefined; group: string | undefined };
  const navItems: NavItem[] = [];
  const groups = declInit(shellSf, "NAV_GROUPS");
  if (groups && ts.isArrayLiteralExpression(groups)) {
    for (const g of groups.elements) {
      const groupLabel = ts.isObjectLiteralExpression(g) ? stringOf(objProp(g, "label")) : undefined;
      const items = ts.isObjectLiteralExpression(g) ? objProp(g, "items") : undefined;
      if (!items || !ts.isArrayLiteralExpression(items)) continue;
      for (const it of items.elements) {
        if (!ts.isObjectLiteralExpression(it)) continue;
        const id = stringOf(objProp(it, "id"));
        const href = stringOf(objProp(it, "href"));
        if (id && href) navItems.push({ id, href, visibleWhen: objProp(it, "visibleWhen"), group: groupLabel ?? undefined });
      }
    }
  }
  const navIds = navItems.map((i) => i.id);
  const moduleIds = new Set<string>(PERMISSION_MODULES.map((m) => m.id));

  check("NAV_GROUPS block was located + parsed", navIds.length > 0);
  const orphanNav = navIds.filter((id) => !moduleIds.has(id));
  check(
    `every admin nav id maps to a permission module${orphanNav.length ? ` — orphans: ${[...new Set(orphanNav)].join(", ")}` : ""}`,
    orphanNav.length === 0,
  );

  // Each nav item's registry `group` must equal the sidebar group it lives under, so
  // the role editor (which sections permission checkboxes by registry `group`) mirrors
  // the sidebar (admin-shell.tsx documents this sync contract). Ids REUSED across
  // groups (e.g. `promotions`, the Commandes module also surfaced as « Segments » under
  // Clients) are skipped — one canonical registry group can't match every nav home.
  const navGroupsById = new Map<string, Set<string>>();
  for (const it of navItems) {
    if (!it.group) continue;
    navGroupsById.set(it.id, (navGroupsById.get(it.id) ?? new Set<string>()).add(it.group));
  }
  const moduleGroup = new Map<string, string>(PERMISSION_MODULES.map((m) => [m.id, m.group]));
  const groupMismatch: string[] = [];
  for (const [id, labels] of navGroupsById) {
    if (labels.size !== 1) continue; // reused id across groups — canonical group can't match all
    const label = [...labels][0];
    const regGroup = moduleGroup.get(id);
    if (regGroup && regGroup !== label) groupMismatch.push(`${id}: registry "${regGroup}" ≠ nav "${label}"`);
  }
  check(
    `every single-group nav id's registry group matches its sidebar group${groupMismatch.length ? ` — ${groupMismatch.join("; ")}` : ""}`,
    groupMismatch.length === 0,
  );

  // ── Admin nav ⇔ page guard parity ─────────────────────────────────────────
  // An item WITHOUT `visibleWhen` is visible with `<id>:view` (nav-access.ts
  // isNavItemVisible), so its page must guard exactly that; an item WITH one is
  // visible with ANY of those grants, so its page must gate with
  // requirePermissionAny on the SAME list. Declared exceptions:
  const NAV_PAGE_EXCEPTIONS: Record<string, { why: string; holds: (src: string) => boolean }> = {
    "/admin": {
      why: "dashboard — every staff user's landing page; each block is gated by its own module grant (dashboard:view is the in-page master switch)",
      holds: (src) => /\bresolveDashboardAccess\(/.test(src),
    },
  };
  const navMismatch: string[] = [];
  for (const item of navItems) {
    const file = join(APP_DIR, ...item.href.split("/").filter(Boolean), "page.tsx");
    if (!existsSync(file)) {
      navMismatch.push(`${item.href} (no page.tsx)`);
      continue;
    }
    const sf = parse(file);
    const gates = pageGates(sf);
    const exception = NAV_PAGE_EXCEPTIONS[item.href];
    if (exception) {
      if (!exception.holds(sf.text)) navMismatch.push(`${item.href} (declared exception no longer holds: ${exception.why})`);
      continue;
    }
    const vw = item.visibleWhen;
    if (!vw) {
      if (!gates.grants.includes(`${item.id}:view`)) {
        navMismatch.push(`${item.href} [nav: ${item.id}:view, page: ${[...gates.grants, ...gates.anyRefs.map((r) => `any(${r.name})`)].join(" ") || "—"}]`);
      }
    } else if (ts.isIdentifier(vw)) {
      const shellFrom = shellImports.get(vw.text)?.from ?? "<local>";
      const ok = gates.anyRefs.some((r) => r.name === vw.text && r.from === shellFrom && shellFrom !== "<local>");
      if (!ok) navMismatch.push(`${item.href} [nav visibleWhen ${vw.text} (${shellFrom}) ≠ page requirePermissionAny]`);
    } else if (ts.isArrayLiteralExpression(vw)) {
      const want = grantsOfArray(vw).sort().join(" ");
      const ok =
        gates.anyLiterals.some((g) => [...g].sort().join(" ") === want) ||
        (want !== "" && !want.includes(" ") && gates.grants.includes(want as Grant));
      if (!ok) navMismatch.push(`${item.href} [nav visibleWhen [${want}] ≠ page guard]`);
    } else {
      navMismatch.push(`${item.href} (unsupported visibleWhen form — use a nav-access.ts constant)`);
    }
  }
  check(`every nav item's page guards the grant that shows it${list(navMismatch)}`, navMismatch.length === 0);
  const staleNavExceptions = Object.keys(NAV_PAGE_EXCEPTIONS).filter((h) => !navItems.some((i) => i.href === h));
  check(`every NAV_PAGE_EXCEPTIONS entry is still a nav href${list(staleNavExceptions)}`, staleNavExceptions.length === 0);

  // ── Admin page guard coverage ──────────────────────────────────────────────
  // The /admin layout only checks admin-AREA access (any permission); per-module
  // isolation is enforced by each page's own guard. A page added WITHOUT one would
  // leak its data to any delegate, and the layout would not catch it.
  const ADMIN_DIR = join(APP_DIR, "admin");
  const adminPages: string[] = [];
  (function walkPages(dir: string) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walkPages(p);
      else if (entry === "page.tsx") adminPages.push(p);
    }
  })(ADMIN_DIR);
  const relAdmin = (f: string) => f.slice(ADMIN_DIR.length).split(sep).join("/");
  /**
   * Pages that may gate on `requireAdminArea` ALONE (any staff grant). Everything
   * else needs a module guard — requireAdminArea is the same check the layout
   * already does, so on a data-bearing page it would expose that data to every
   * delegate (the old dashboard leak).
   */
  const AREA_ONLY_PAGES: Record<string, { why: string; holds: (sf: ts.SourceFile) => boolean }> = {
    "/page.tsx": {
      why: "dashboard: every block gated by its own module grant via resolveDashboardAccess",
      holds: (sf) => /\bresolveDashboardAccess\(/.test(sf.text),
    },
    "/system/page.tsx": {
      why: "Système index: static tiles, loads no data",
      holds: (sf) =>
        [...importsOf(sf).values()].every((i) => !/^@\/(modules|workflows|lib\/db|lib\/actions)(\/|$)/.test(i.from)),
    },
  };
  const DATA_FREE_STUB_IMPORTS = new Set(["next/navigation", "next"]);
  const unguarded: string[] = [];
  const areaOnly: string[] = [];
  for (const f of adminPages) {
    const sf = parse(f);
    const gates = pageGates(sf);
    const r = relAdmin(f);
    if (gates.rbac) continue;
    if (gates.area) {
      areaOnly.push(r);
      const allowed = AREA_ONLY_PAGES[r];
      if (!allowed) unguarded.push(`${r} (requireAdminArea only)`);
      else if (!allowed.holds(sf)) unguarded.push(`${r} (area-only allowance no longer holds: ${allowed.why})`);
      continue;
    }
    // Redirect stub: calls next/navigation's redirect()/permanentRedirect() and
    // imports nothing else (a moved route keeps a 308 permanentRedirect stub).
    const imports = importsOf(sf);
    const specifiers = sf.statements
      .filter(ts.isImportDeclaration)
      .map((d) => (ts.isStringLiteral(d.moduleSpecifier) ? d.moduleSpecifier.text : ""));
    let redirects = false;
    each(sf, (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const imp = imports.get(n.expression.text);
        if (imp?.from === "next/navigation" && (imp.name === "redirect" || imp.name === "permanentRedirect"))
          redirects = true;
      }
    });
    if (!(redirects && specifiers.every((s) => DATA_FREE_STUB_IMPORTS.has(s)))) unguarded.push(r);
  }
  unguarded.sort();
  check("admin pages found", adminPages.length > 0);
  check(
    `every admin page.tsx calls an RBAC guard (or is a declared area-only page / pure redirect stub)${unguarded.length ? ` — ungated: ${unguarded.join(", ")}` : ""}`,
    unguarded.length === 0,
  );
  const staleArea = Object.keys(AREA_ONLY_PAGES).filter((p) => !areaOnly.includes(p));
  check(`every AREA_ONLY_PAGES entry is still an area-only page${list(staleArea)}`, staleArea.length === 0);

  // ── App-level metadata/SEO routes (outside /api) map to real source files ────
  const META_FILES: Record<string, string[]> = {
    "/sitemap.xml": ["src/app/sitemap.ts"],
    "/robots.txt": ["src/app/robots.txt/route.ts"],
    "/manifest.webmanifest": ["src/app/manifest.ts"],
    // Static icon.png is served at its literal filename /icon.png (the bare /icon
    // URL would be a GENERATED icon.tsx/.ts, which this project doesn't use).
    "/icon.png": ["src/app/icon.png"],
    "/llms.txt": ["src/app/llms.txt/route.ts"],
  };
  const metaMissing = APP_METADATA_ROUTES.filter((r) => {
    const candidates = META_FILES[r.path];
    return !candidates || !candidates.some((f) => existsSync(join(ROOT, f)));
  }).map((r) => r.path);
  check("every APP_METADATA_ROUTES path resolves to a known source file", Object.keys(META_FILES).length === APP_METADATA_ROUTES.length);
  check(
    `every metadata route has a source file on disk${metaMissing.length ? ` — missing: ${metaMissing.join(", ")}` : ""}`,
    metaMissing.length === 0,
  );

  // ── Non-/api app route handlers ⇔ disk ──────────────────────────────────────
  // Real HTTP route.ts handlers also live UNDER src/app but OUTSIDE src/app/api
  // (admin CSV exports, the /cdn media proxy, the llms.txt route). The /api walk
  // above never sees them, so without this they could ship uncatalogued and the
  // inventory tab would under-report them. Assert every such handler's exported
  // methods are registered in APP_METADATA_ROUTES ∪ APP_ROUTE_HANDLERS, and that
  // every APP_ROUTE_HANDLERS entry actually exists on disk (no phantom).
  const diskNonApi = new Set<string>();
  (function walkNonApi(dir: string) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (p === API_DIR) continue; // /api is covered by the bidirectional walk above
        walkNonApi(p);
      } else if (entry === "route.ts") {
        const path = urlPathOf(p);
        for (const m of readFileSync(p, "utf8").matchAll(METHOD_RE)) diskNonApi.add(`${m[1]} ${path}`);
      }
    }
  })(APP_DIR);
  const nonApiRegistered = new Set(
    [...APP_METADATA_ROUTES, ...APP_ROUTE_HANDLERS].map((r) => `${r.method} ${r.path}`),
  );
  const nonApiUnregistered = [...diskNonApi].filter((d) => !nonApiRegistered.has(d)).sort();
  check(
    `every non-/api route.ts handler is registered (APP_METADATA_ROUTES ∪ APP_ROUTE_HANDLERS)${nonApiUnregistered.length ? ` — missing: ${nonApiUnregistered.join(", ")}` : ""}`,
    nonApiUnregistered.length === 0,
  );
  const handlerPhantom = APP_ROUTE_HANDLERS.filter((r) => !diskNonApi.has(`${r.method} ${r.path}`))
    .map((r) => `${r.method} ${r.path}`)
    .sort();
  check(
    `every APP_ROUTE_HANDLERS entry exists on disk${handlerPhantom.length ? ` — phantom: ${handlerPhantom.join(", ")}` : ""}`,
    handlerPhantom.length === 0,
  );

  // ── Server-action guard coverage (per export) ──────────────────────────────
  // Server actions are the third mutating surface (alongside admin pages + route
  // handlers). EVERY export of a "use server" module is a callable endpoint, so
  // each one must open with an RBAC guard as its first awaited call — checked per
  // export (a guarded sibling no longer covers a new unguarded action, which is
  // how the L10 stock-alert action shipped ungated) and by ORDER (no DB read
  // before authorization). A same-file helper (`const s = await guard()`) is
  // followed; a guard name only counts when imported from the auth modules.
  const ACTIONS_DIR = join(ROOT, "src", "lib", "actions");
  /**
   * Shopper-facing / self-service exports, gated by the caller's OWN session or
   * a signed token — not RBAC. `"*"` = the whole file. Every listed name must
   * still be an export (stale-entry check below).
   */
  const PUBLIC_ACTIONS: Record<string, "*" | string[]> = {
    "cart.ts": "*", // add/remove/set own cart lines (cartId-owned)
    "customer.ts": "*", // own profile / addresses / password / email
    "newsletter-unsubscribe.ts": "*", // signed-token unsubscribe (no session)
    "blog-comment.ts": [
      "submitBlogCommentAction", // signed-in reader comment/reply (getCurrentUser + rate limit)
      "loadMoreBlogCommentsAction", // public read: next page of a post's approved comment thread
    ],
    "auth.ts": [
      // sign-up / sign-in / 2FA / sign-out / password reset (rate-limited, pre-session)
      "signupAction",
      "signinAction",
      "verifyTwoFactorAction",
      "signoutAction",
      "requestPasswordResetAction",
      "resetPasswordAction",
      "setOauthAutolinkAction", // own OAuth auto-link preference (requireSession)
    ],
    "newsletter.ts": ["subscribeNewsletterAction"], // public footer subscribe (rate-limited)
    "order.ts": [
      // checkout + the shopper's own pending order
      "placeOrderFromCartAction",
      "placeQuickOrderAction",
      "resumeOrderPaymentAction",
      "cancelMyPendingOrderAction",
      "trackOrderAction", // public guest order-tracking lookup (order# + phone, IP rate-limited)
    ],
    "promotion.ts": ["applyCouponAction", "clearCouponAction"], // cart coupon cookie
    "reviews.ts": ["submitReviewAction"], // signed-in customer review
    "two-factor.ts": ["twoFactorQrAction"], // own 2FA enrolment QR
    "wishlist.ts": [
      "toggleWishlistAction", // own favourites
      "getWishlistSlugsAction",
      "setPublicFavoritesAction",
    ],
  };
  /** Ownership gates that stand in for RBAC in a file (non-RBAC self-scoped guards). */
  const OWNERSHIP_GUARDS: Record<string, string[]> = {};

  const actionFiles = readdirSync(ACTIONS_DIR).filter((f) => f.endsWith(".ts"));
  const unguardedActions: string[] = [];
  const nonFnExports: string[] = [];
  const stalePublic: string[] = [];
  let actionExports = 0;
  for (const f of actionFiles) {
    const sf = parse(join(ACTIONS_DIR, f));
    const first = sf.statements[0];
    const useServer =
      !!first && ts.isExpressionStatement(first) && stringOf(first.expression) === "use server";
    const publicList = PUBLIC_ACTIONS[f];
    const fns = localFunctions(sf);
    if (!useServer) {
      if (publicList) stalePublic.push(`${f} (not a "use server" module)`);
      continue; // helper/types module (coerce.ts, types.ts) — not callable
    }
    nonFnExports.push(...nonFunctionExports(sf).map((n) => `${f}:${n}`));
    const imports = importsOf(sf);
    const extra = new Set(OWNERSHIP_GUARDS[f] ?? []);
    const guardOf = (body: ts.Node, depth: number): string | null => {
      const callee = firstCall(body, depth > 0) ?? (depth === 0 ? firstCall(body, true) : null);
      if (!callee) return "<no awaited call>";
      if (extra.has(callee)) return null;
      const local = fns.get(callee);
      if (local && depth < 3) {
        const inner = guardOf(local.body, depth + 1);
        return inner === null ? null : `${callee} → ${inner}`;
      }
      const imp = imports.get(callee);
      return imp && AUTH_GUARD_MODULES.has(imp.from) && RBAC_GUARDS.has(imp.name) ? null : callee;
    };
    for (const [name, fn] of fns) {
      if (!fn.exported) continue;
      actionExports++;
      if (publicList === "*" || publicList?.includes(name)) continue;
      const bad = guardOf(fn.body, 0);
      if (bad !== null) unguardedActions.push(`${f}:${name} (first call: ${bad})`);
    }
    if (Array.isArray(publicList)) {
      for (const n of publicList) if (!fns.get(n)?.exported) stalePublic.push(`${f}:${n}`);
    }
  }
  for (const f of Object.keys(PUBLIC_ACTIONS)) {
    if (!actionFiles.includes(f)) stalePublic.push(`${f} (missing file)`);
  }
  check(`server-action exports found (${actionExports})`, actionExports > 0);
  check(
    `every non-public server-action export opens with an RBAC guard${unguardedActions.length ? ` — ungated: ${unguardedActions.join("; ")}` : ""}`,
    unguardedActions.length === 0,
  );
  check(`"use server" modules export only functions${list(nonFnExports)}`, nonFnExports.length === 0);
  check(`every PUBLIC_ACTIONS entry is still a "use server" export${list(stalePublic)}`, stalePublic.length === 0);

  // ── Owner-only step-ups (admin-authz-01/02/03/04) ──────────────────────────
  // The module grant alone must not unlock these: each keeps its `*` wildcard
  // (or, for API keys, creator-bounded scope) check. Pinned by the helper call in
  // the export's body; the behaviour itself is DB-tested in data-clean-scoping,
  // mailing-security, privilege-escalation and rbac-escalation.
  const STEP_UPS: { file: string; exportName: string; calls: string; why: string }[] = [
    { file: "src/app/api/admin/system/demo/route.ts", exportName: "POST", calls: "checkSuperAdmin", why: "demo clear wipes the catalogue" },
    { file: "src/lib/actions/data-jobs.ts", exportName: "startDataJobAction", calls: "checkSuperAdmin", why: "« nettoyer » data jobs" },
    { file: "src/lib/actions/demo-purge.ts", exportName: "requestDemoPurgeAction", calls: "requireSuperAdmin", why: "purge & relaunch" },
    { file: "src/lib/actions/demo-purge.ts", exportName: "confirmDemoPurgeAction", calls: "requireSuperAdmin", why: "purge & relaunch" },
    { file: "src/lib/actions/mailing.ts", exportName: "saveMailSettingsAction", calls: "holdsWildcard", why: "mail transport" },
    { file: "src/lib/actions/mailing.ts", exportName: "saveEmailTemplateAction", calls: "holdsWildcard", why: "security templates" },
    { file: "src/lib/actions/mailing.ts", exportName: "toggleEmailTemplateAction", calls: "holdsWildcard", why: "security templates" },
    { file: "src/lib/actions/mailing.ts", exportName: "resetEmailTemplateAction", calls: "holdsWildcard", why: "security templates" },
    { file: "src/lib/actions/analytics.ts", exportName: "saveAnalyticsSettingsAction", calls: "ownerOnlyTrackingViolation", why: "custom tracking scripts" },
    { file: "src/lib/actions/api-settings.ts", exportName: "createApiKeyAction", calls: "scopesBeyondActor", why: "API-key scopes bounded by the creator" },
  ];
  const lostStepUps = STEP_UPS.filter((s) => {
    const p = join(ROOT, ...s.file.split("/"));
    if (!existsSync(p)) return true;
    const fn = localFunctions(parse(p)).get(s.exportName);
    if (!fn?.exported) return true;
    let calls = false;
    each(fn.body, (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === s.calls) calls = true;
    });
    return !calls;
  }).map((s) => `${s.file}:${s.exportName} → ${s.calls} (${s.why})`);
  check(`owner-only step-ups are still wired${list(lostStepUps)}`, lostStepUps.length === 0);

  console.log(`\n=== done: ${passed} passed, ${failed} failed === (disk=${disk.size}, catalog=${catalog.size}, meta=${APP_METADATA_ROUTES.length}, nonApi=${diskNonApi.size}, nav=${navIds.length}, adminPages=${adminPages.length}, actionFiles=${actionFiles.length}, actionExports=${actionExports})`);
  if (failed > 0) process.exit(1);
}

main();
process.exit(0);
