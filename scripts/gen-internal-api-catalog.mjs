// @ts-nocheck
/**
 * Generator for src/lib/api-auth/internal-api-catalog.ts — the INTERNAL WRITE API
 * (server actions) catalog that powers the admin « API interne » tab + the
 * decoupling docs. The source of truth is the disk: we parse every export of the
 * `"use server"` files in src/lib/actions/*.ts (each one is a callable server
 * action — conventionally `*Action`), grab its leading-comment first sentence as
 * a summary, classify its kind by name, DERIVE its RBAC permission from the
 * guard calls it actually makes, and group by a curated domain map.
 *
 * Run:  node scripts/gen-internal-api-catalog.mjs   (rewrites the catalog file)
 *
 * Completeness is then ENFORCED at test time (internal-api-catalog.test.ts): the
 * test re-derives the action-name set from disk and asserts the committed catalog
 * lists every one — so a new action can't ship undocumented (mirrors how
 * route-catalog ⇔ disk is enforced by route-invariants) — and that every
 * permission label is a real registry key.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

const ACTIONS_DIR = "src/lib/actions";
const OUT = "src/lib/api-auth/internal-api-catalog.ts";

// file → [group, label]. Group is the top-level bucket the admin tab segments
// by; label names the domain. The permission column is NOT curated here: a
// hand-written map drifted to keys that don't exist in the RBAC registry
// (system_content, blog, aide, business…), so it is derived from each action's
// real guard calls instead (see `derivePermission`).
const FILE_MAP = {
  "catalog.ts": ["Catalogue", "Produits / marques / catégories / média"],
  "care.ts": ["Catalogue", "Tokyo Care (garanties bonus)"],
  "attribute.ts": ["Catalogue", "Attributs & valeurs"],
  "related-products.ts": ["Catalogue", "Produits liés"],
  "catalog-settings.ts": ["Catalogue", "Réglages catalogue (code produit)"],
  "stock-settings.ts": ["Catalogue", "Stock — alertes opérateur"],
  "stock-locations.ts": ["Catalogue", "Stock — emplacements (multi-stock)"],
  "stock-transfers.ts": ["Catalogue", "Stock — transferts inter-emplacements"],
  "home.ts": ["Contenu", "Page d'accueil (vitrine)"],
  "site.ts": ["Contenu", "Réglages de la vitrine"],
  "theme.ts": ["Contenu", "Thème & design"],
  "showcase-settings.ts": ["Contenu", "Catalogues / showcase"],
  "cms.ts": ["Contenu", "CMS (pages, nav, badges, bannières)"],
  "blog.ts": ["Contenu", "Blog"],
  "authors.ts": ["Contenu", "Blog — auteurs"],
  "blog-comment.ts": ["Contenu", "Blog — commentaires (public)"],
  "blog-comments-admin.ts": ["Contenu", "Blog — commentaires (admin)"],
  "footer.ts": ["Contenu", "Pied de page"],
  "nav-builder.ts": ["Contenu", "Navigation (constructeur)"],
  "reels.ts": ["Contenu", "Vidéos (Reels)"],
  "aid.ts": ["Contenu", "Aide (centre d'aide)"],
  "reviews.ts": ["Contenu", "Avis clients"],
  "review-generation.ts": ["Contenu", "Génération d'avis (IA)"],
  "seo.ts": ["Système", "SEO"],
  "order.ts": ["Commandes", "Commandes (cycle de vie, lignes, expédition)"],
  "returns.ts": ["Commandes", "Retours / SAV"],
  "warranty.ts": ["Commandes", "Garanties / réclamations (SAV)"],
  "manual-order.ts": ["Commandes", "Commandes manuelles (offline)"],
  "payment-settings.ts": ["Commandes", "Passerelles de paiement"],
  "delivery.ts": ["Commandes", "Livraison & zones"],
  "tax.ts": ["Commandes", "Taxes"],
  "tax-settings.ts": ["Commandes", "Réglages de taxe"],
  "currency.ts": ["Commandes", "Devises"],
  "documents.ts": ["Commandes", "Factures / avoirs / BL"],
  "checkout-settings.ts": ["Commandes", "Réglages du checkout"],
  "express-settings.ts": ["Commandes", "Achat express"],
  "cart.ts": ["Panier", "Panier (storefront)"],
  "promotion.ts": ["Promotions", "Promotions & coupons"],
  "segments.ts": ["Promotions", "Segments clients"],
  "guests.ts": ["Clients", "Invités — clients sans compte (recherche, export)"],
  "wishlist.ts": ["Clients", "Favoris / listes de souhaits"],
  "customer.ts": ["Clients", "Compte client (self-service)"],
  "customers.ts": ["Clients", "Clients (admin)"],
  "auth.ts": ["Accès", "Authentification (flux public) + gestion utilisateurs (admin)"],
  "auth-settings.ts": ["Accès", "Réglages d'authentification"],
  "session-policy.ts": ["Accès", "Politique de session"],
  "two-factor.ts": ["Accès", "Double authentification (self)"],
  "rbac.ts": ["Accès", "Rôles & permissions (RBAC)"],
  "newsletter.ts": ["Marketing", "Newsletter (opt-in)"],
  "newsletter-unsubscribe.ts": ["Marketing", "Désinscription newsletter"],
  "mailing.ts": ["Marketing", "Mailing (campagnes, automatisations)"],
  "ai-generate.ts": ["IA", "Génération de contenu IA"],
  "product-generation.ts": ["IA", "Génération produit (IA)"],
  "content-generation.ts": ["IA", "Génération de contenu catalogue (IA)"],
  "ai-assign.ts": ["IA", "Auto-attribution (IA)"],
  "ai-settings.ts": ["IA", "Fournisseurs IA"],
  "ai-job-logs.ts": ["IA", "Journaux des tâches IA"],
  "jobs.ts": ["Système", "Tâches planifiées"],
  "audit-log.ts": ["Système", "Journal d'audit"],
  "audit-settings.ts": ["Système", "Réglages d'audit"],
  "search-settings.ts": ["Système", "Recherche (réglages)"],
  "search-maintenance.ts": ["Système", "Recherche (maintenance)"],
  "search-aliases.ts": ["Système", "Recherche — alias / synonymes"],
  "embeddings.ts": ["Système", "Recherche sémantique (vectorisation)"],
  "redirects.ts": ["Système", "Redirections & 404"],
  "site-mode.ts": ["Système", "Maintenance & lancement"],
  "import.ts": ["Système", "Import catalogue"],
  "data-jobs.ts": ["Système", "Tâches de données (workflows)"],
  "api-settings.ts": ["Système", "API & clés"],
  "webhooks.ts": ["Système", "Webhooks sortants (ERP)"],
  "perf-settings.ts": ["Système", "Performance"],
  "analytics.ts": ["Système", "Suivi & analytics"],
  "cookies.ts": ["Système", "Cookies & RGPD"],
  "demo-purge.ts": ["Système", "Démo (purge / relance)"],
  "admin.ts": ["Système", "Admin (divers)"],
};

// `bulk(delete|remove|purge|clear)` is anchored too: a fan-out like
// `bulkDeleteMediaAction` is just as destructive as a single delete (it hard-
// purges every row's S3 bytes), but the bare `^delete` anchor missed the `bulk`
// prefix and mislabelled it kind:"write".
const DESTRUCTIVE = /^(delete|remove|revoke|purge|clear|cancel|archive|unlink|destroy|wipe|reset2fa|disable|bulk(delete|remove|purge|clear|destroy))/i;
// Mutating verb prefixes (camelCase word-bounded), tested BEFORE the read
// patterns: a write whose name merely ENDS like a read (`…Status`, `…Active`)
// must stay a write — transitionOrderStatus / bulkUpdateOrderStatus /
// setReviewStatus / togglePromotionActive were all catalogued kind:"read".
const WRITE_VERB =
  /^(toggle|set|update|upsert|save|create|add|assign|apply|issue|transition|bulk|mark|send|resend|run|start|trigger|change|move|merge|import|generate|refresh|reset|restore|confirm|reject|approve|enable|publish|pin|link|invite|place|refund|submit|subscribe|unsubscribe|rotate|seed|scan|clone|duplicate|edit|force|reactivate|receive|redeliver|resume|join|upload)(?=[A-Z]|$)/;
// Tested against the name with its `Action` suffix stripped, so `$`-anchored
// patterns (Count/Status/Active) actually fire (they never matched `…Action`).
// The prefixes are word-bounded: a bare `^is` matched `issueInvoice…`.
const READ = /^(get|list|count|search|fetch|load|preview|export|is|has)(?=[A-Z]|$)|(Count|Status|Usage|Active|Enabled)$/;
const SETTINGS = /Settings|Config|Policy/;
// auth.ts mixes the PUBLIC auth flow with ADMIN user-management — only the flow
// actions are kind:"auth"; the admin ones (enable/forceLogout/toggleEmailVerified/
// triggerPasswordReset/disable) fall through to write/destructive.
const AUTH_FLOW = /^(signin|signup|signout|requestPasswordReset|resetPassword|verifyTwoFactor|verifyEmail|resend)/i;

function classify(name, file) {
  const base = name.replace(/Action$/, "");
  if (DESTRUCTIVE.test(base)) return "destructive";
  if (!WRITE_VERB.test(base) && READ.test(base)) return "read";
  if (SETTINGS.test(base) || file.endsWith("-settings.ts")) return "settings";
  if (file === "two-factor.ts") return "auth";
  if (file === "auth.ts") return AUTH_FLOW.test(base) ? "auth" : "write";
  return "write";
}

// ── Permission derivation ────────────────────────────────────────────────────
// Each action's label is read off the guards it really calls (AST, so comments
// and strings never count), following same-file helpers transitively:
//   requirePermission(m, a)            → "m:a"   (hard gate)
//   requirePermissionAny([...])        → "m:a | n:b"  (any one of)
//   requireSuperAdmin(m, a)            → "m:a" + "*"  (grant, then wildcard)
//   permissionSetAllows(perms, m, a)   → "m:a"   (in-code secondary check)
//   checkSuperAdmin / isSuperAdmin / perms.has(WILDCARD) → "*" (owner-only part)
//   requireSession()                   → "session"
//   getSession() / getCurrentUser()    → "session/public" (optional session)
//   none of the above                  → "public"
// Non-literal arguments are resolved through local/top-level consts (e.g. a
// `Record<kind, [module, action]>` map indexed by the input) to every key the
// guard can check, joined with " | ". An unresolvable guard FAILS the run —
// never guess a label.
const SEP_CHECK = " · ";
const SEP_ANY = " | ";
const PSEUDO_ORDER = ["public", "session/public", "session"];

const unwrap = (n) => {
  while (
    n &&
    (ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isSatisfiesExpression(n) ||
      ts.isNonNullExpression(n) ||
      ts.isTypeAssertionExpression(n) ||
      ts.isAwaitExpression(n))
  ) {
    n = n.expression;
  }
  return n;
};
const isStr = (n) => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
const isFn = (n) => n && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n));
const cartesian = (mods, acts) => mods.flatMap((m) => acts.map((a) => [m, a]));

/** Index a source file's top-level declarations + named imports (local → imported). */
function fileScope(sf) {
  const top = new Map();
  const imports = new Map();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) imports.set(el.name.text, (el.propertyName ?? el.name).text);
      }
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      top.set(st.name.text, st);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) top.set(d.name.text, d.initializer);
      }
    }
  }
  return { top, imports };
}

/** Lexically resolve an identifier to its `const` initializer (innermost block first). */
function resolveIdent(id, scope) {
  const name = id.text;
  for (let p = id.parent; p; p = p.parent) {
    if (!ts.isBlock(p) && !ts.isSourceFile(p)) continue;
    for (const st of p.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer;
      }
    }
  }
  const top = scope.top.get(name);
  return top && !isFn(top) ? top : null;
}

/** Every string literal an expression can evaluate to (maps → their values). */
function harvestStrings(node, scope, depth = 0) {
  const n = unwrap(node);
  if (!n || depth > 8) return [];
  if (isStr(n)) return [n.text];
  if (ts.isIdentifier(n)) {
    const init = resolveIdent(n, scope);
    return init ? harvestStrings(init, scope, depth + 1) : [];
  }
  if (ts.isElementAccessExpression(n)) return harvestStrings(n.expression, scope, depth + 1);
  if (ts.isConditionalExpression(n)) {
    return [...harvestStrings(n.whenTrue, scope, depth + 1), ...harvestStrings(n.whenFalse, scope, depth + 1)];
  }
  if (ts.isArrayLiteralExpression(n)) return n.elements.flatMap((e) => harvestStrings(e, scope, depth + 1));
  if (ts.isObjectLiteralExpression(n)) {
    return n.properties.flatMap((p) => (ts.isPropertyAssignment(p) ? harvestStrings(p.initializer, scope, depth + 1) : []));
  }
  return [];
}

/** Every [module, action] pair an expression can evaluate to. */
function harvestPairs(node, scope, depth = 0) {
  const n = unwrap(node);
  if (!n || depth > 8) return [];
  if (ts.isIdentifier(n)) {
    const init = resolveIdent(n, scope);
    return init ? harvestPairs(init, scope, depth + 1) : [];
  }
  if (ts.isElementAccessExpression(n)) return harvestPairs(n.expression, scope, depth + 1);
  if (ts.isArrayLiteralExpression(n)) {
    const els = n.elements.map(unwrap);
    if (els.length === 2 && els.every(isStr)) return [[els[0].text, els[1].text]];
    return n.elements.flatMap((e) => harvestPairs(e, scope, depth + 1));
  }
  if (ts.isObjectLiteralExpression(n)) {
    const prop = (key) =>
      n.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === key)?.initializer;
    const mod = prop("module");
    const act = prop("action");
    if (mod && act) return cartesian(harvestStrings(mod, scope, depth + 1), harvestStrings(act, scope, depth + 1));
    return n.properties.flatMap((p) => (ts.isPropertyAssignment(p) ? harvestPairs(p.initializer, scope, depth + 1) : []));
  }
  // `Object.values(MAP).map(([module, action]) => ({ module, action }))` or
  // `Object.values(MODULE_MAP).map((module) => ({ module, action: "view" }))`.
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "map") {
    const src = unwrap(n.expression.expression);
    const cb = n.arguments[0];
    if (ts.isCallExpression(src) && src.expression.getText() === "Object.values" && isFn(cb)) {
      const map = src.arguments[0];
      const param = cb.parameters[0]?.name;
      if (param && ts.isArrayBindingPattern(param)) return harvestPairs(map, scope, depth + 1);
      const ret = unwrap(ts.isBlock(cb.body) ? null : cb.body);
      const act =
        ret && ts.isObjectLiteralExpression(ret)
          ? ret.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === "action")
          : null;
      if (act) return cartesian(harvestStrings(map, scope, depth + 1), harvestStrings(act.initializer, scope, depth + 1));
    }
  }
  return [];
}

/** (module, action) pairs of a `requirePermission`-shaped argument list. */
function permissionArgPairs(args, scope) {
  if (args.length === 1 && ts.isSpreadElement(args[0])) return harvestPairs(args[0].expression, scope);
  if (args.length < 2) return [];
  const [m, a] = args.map(unwrap);
  // `perm[0], perm[1]` over a tuple map → the map's pairs (not a module×action cross).
  if (
    ts.isElementAccessExpression(m) &&
    ts.isElementAccessExpression(a) &&
    m.expression.getText() === a.expression.getText() &&
    m.argumentExpression.getText() === "0" &&
    a.argumentExpression.getText() === "1"
  ) {
    return harvestPairs(m.expression, scope);
  }
  return cartesian(harvestStrings(m, scope), harvestStrings(a, scope));
}

/**
 * Walk one exported action (and every same-file helper it calls) and return its
 * permission label. `errors` collects guards whose keys can't be resolved.
 */
function derivePermission(fnNode, scope, sf, errors, actionName) {
  const checks = []; // ordered, de-duplicated check strings
  let hard = false; // a requirePermission* gate (implies a signed-in staff session)
  let session = null; // "session" | "session/public"
  let wildcard = false;
  const seen = new Set();
  const addCheck = (pairs, where) => {
    const keys = [...new Set(pairs.map(([m, a]) => `${m}:${a}`))];
    if (keys.length === 0) {
      const { line } = sf.getLineAndCharacterOfPosition(where.getStart());
      errors.push(`${sf.fileName}:${line + 1} ${actionName}: cannot resolve the keys of \`${where.getText().replace(/\s+/g, " ").slice(0, 90)}\``);
      return;
    }
    const check = keys.join(SEP_ANY);
    if (!checks.includes(check)) checks.push(check);
  };
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee)) {
        const local = scope.top.get(callee.text);
        if (isFn(local)) {
          // Same-file helper (or another action): its guards are this action's too.
          if (!seen.has(local)) {
            seen.add(local);
            visit(local);
          }
        } else {
          switch (scope.imports.get(callee.text) ?? callee.text) {
            case "requirePermission":
              hard = true;
              addCheck(permissionArgPairs(n.arguments, scope), n);
              break;
            case "requirePermissionAny":
              hard = true;
              addCheck(harvestPairs(n.arguments[0], scope), n);
              break;
            case "requireSuperAdmin":
              hard = true;
              addCheck(permissionArgPairs(n.arguments, scope), n);
              wildcard = true;
              break;
            case "permissionSetAllows":
              addCheck(permissionArgPairs(n.arguments.slice(1), scope), n);
              break;
            case "checkSuperAdmin":
            case "isSuperAdmin":
              wildcard = true;
              break;
            case "requireSession":
              session = "session";
              break;
            case "getSession":
            case "getCurrentUser":
              session ??= "session/public";
              break;
          }
        }
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "has" &&
        n.arguments.length === 1 &&
        ts.isIdentifier(n.arguments[0]) &&
        (scope.imports.get(n.arguments[0].text) ?? n.arguments[0].text) === "WILDCARD"
      ) {
        wildcard = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fnNode);
  const parts = [];
  // A requirePermission* gate already implies a signed-in session; otherwise the
  // session requirement (or its absence) IS the gate, and any in-code RBAC check
  // is a secondary branch next to it.
  if (!hard) parts.push(session ?? "public");
  parts.push(...checks);
  if (wildcard) parts.push("*");
  return parts.join(SEP_CHECK);
}

/** Union of a domain's action labels: one key per module ("m:*" when several actions). */
function domainPermission(actions) {
  const pseudo = new Set();
  const byModule = new Map(); // module → Set(action), insertion-ordered
  let wildcard = false;
  for (const a of actions) {
    for (const token of a.permission.split(/\s*[·|]\s*/)) {
      if (PSEUDO_ORDER.includes(token)) pseudo.add(token);
      else if (token === "*") wildcard = true;
      else {
        const [m, act] = token.split(":");
        if (!byModule.has(m)) byModule.set(m, new Set());
        byModule.get(m).add(act);
      }
    }
  }
  const parts = PSEUDO_ORDER.filter((p) => pseudo.has(p));
  for (const [m, acts] of byModule) parts.push(acts.size > 1 ? `${m}:*` : `${m}:${[...acts][0]}`);
  if (wildcard) parts.push("*");
  return parts.join(SEP_CHECK);
}

/** Exported functions of a "use server" file (each is a callable server action). */
function exportedFunctions(sf) {
  const out = new Map();
  const exported = (st) => (st.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const st of sf.statements) {
    if (!exported(st)) continue;
    if (ts.isFunctionDeclaration(st) && st.name) out.set(st.name.text, st);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && isFn(d.initializer)) out.set(d.name.text, d.initializer);
      }
    }
  }
  return out;
}

/** Pull the exported action names + the first sentence of the leading comment. */
function parseFile(src) {
  const out = [];
  const lines = src.split(/\r?\n/);
  // Any exported function, not only `*Action`: in a "use server" file every
  // export is a callable endpoint, so a misnamed one must still be catalogued.
  const re = /^export\s+(?:async\s+)?(?:function|const)\s+([a-zA-Z0-9_]+)\b/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const name = m[1];
    // Walk upward over a comment block to grab a summary.
    let summary = "";
    const buf = [];
    const isDivider = (s) => /^[\s─=*/_.·•-]+$/.test(s) || /[─━]{3,}/.test(s);
    for (let j = i - 1; j >= 0 && j >= i - 12; j--) {
      const t = lines[j].trim();
      if (t === "" && buf.length === 0) continue;
      if (t.startsWith("*/")) continue;
      if (t.startsWith("/**") || t.startsWith("/*")) break;
      const stripped = t.startsWith("*")
        ? t.replace(/^\*\s?/, "")
        : t.startsWith("//")
          ? t.replace(/^\/\/\s?/, "")
          : null;
      if (stripped === null) break;
      // Skip ASCII/box-drawing section dividers — they are not summaries.
      if (isDivider(stripped)) {
        if (buf.length === 0) continue;
        break;
      }
      buf.unshift(stripped);
    }
    summary = buf.join(" ").replace(/\s+/g, " ").trim();
    // Drop a section header masquerading as a summary (ALL-CAPS, few words, no period).
    if (/^[A-Z0-9 ]{6,}$/.test(summary) && !summary.includes(".")) summary = "";
    const dot = summary.search(/\.(\s|$)/);
    if (dot > 0) summary = summary.slice(0, dot + 1);
    if (summary.length > 200) summary = summary.slice(0, 197) + "…";
    // Too little signal → leave blank (the doc carries prose; UI shows name+kind).
    if ((summary.match(/[a-zA-Z]/g) || []).length < 8) summary = "";
    out.push({ name, summary });
  }
  return out;
}

const files = readdirSync(ACTIONS_DIR)
  .filter((f) => f.endsWith(".ts") && f !== "types.ts" && f !== "coerce.ts")
  .sort();

const groups = {}; // group -> array of { file, label, permission, actions: [] }
const errors = [];
let total = 0;
for (const file of files) {
  const map = FILE_MAP[file];
  if (!map) {
    console.error(`!! no FILE_MAP entry for ${file} — add one`);
    process.exit(1);
  }
  const [group, label] = map;
  const src = readFileSync(join(ACTIONS_DIR, file), "utf8");
  const sf = ts.createSourceFile(`${ACTIONS_DIR}/${file}`, src, ts.ScriptTarget.Latest, true);
  const first = sf.statements[0];
  if (!first || !ts.isExpressionStatement(first) || !isStr(first.expression) || first.expression.text !== "use server") {
    console.error(`!! ${file} is not a "use server" file — move it out of ${ACTIONS_DIR} or add the directive`);
    process.exit(1);
  }
  const scope = fileScope(sf);
  const fns = exportedFunctions(sf);
  const parsed = parseFile(src).filter((p) => {
    if (fns.has(p.name)) return true;
    errors.push(`${sf.fileName}: export "${p.name}" is not a plain function — cannot derive its guard`);
    return false;
  });
  if (parsed.length === 0) continue;
  total += parsed.length;
  for (const p of parsed) {
    if (!p.name.endsWith("Action")) {
      console.warn(`!! ${file}: exported "${p.name}" is a callable server action — rename it *Action (catalogued anyway)`);
    }
  }
  const actions = parsed.map((p) => ({
    name: p.name,
    kind: classify(p.name, file),
    permission: derivePermission(fns.get(p.name), scope, sf, errors, p.name),
    summary: p.summary,
  }));
  (groups[group] ||= []).push({ file: `${ACTIONS_DIR}/${file}`, label, permission: domainPermission(actions), actions });
}
if (errors.length > 0) {
  console.error(
    `!! cannot derive the permission label(s) — pass literal guard keys, or a const map/array of them:\n  ${errors.join("\n  ")}`,
  );
  process.exit(1);
}

const GROUP_ORDER = ["Catalogue", "Commandes", "Panier", "Promotions", "Clients", "Accès", "Contenu", "Marketing", "IA", "Système"];
const orderedGroups = GROUP_ORDER.filter((g) => groups[g]);

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
let body = "";
for (const g of orderedGroups) {
  body += `  {\n    group: "${esc(g)}",\n    domains: [\n`;
  for (const d of groups[g]) {
    body += `      {\n        file: "${esc(d.file)}",\n        label: "${esc(d.label)}",\n        permission: "${esc(d.permission)}",\n        actions: [\n`;
    for (const a of d.actions) {
      body += `          { name: "${esc(a.name)}", kind: "${a.kind}", permission: "${esc(a.permission)}", summary: "${esc(a.summary)}" },\n`;
    }
    body += `        ],\n      },\n`;
  }
  body += `    ],\n  },\n`;
}

const header = `/**
 * GENERATED by scripts/gen-internal-api-catalog.mjs — do not edit by hand.
 * The INTERNAL WRITE API: every exported server action (conventionally
 * \`*Action\`) in src/lib/actions, grouped by domain. Powers the admin « API interne » tab and
 * the decoupling docs (API.md). Completeness is enforced by
 * src/lib/db/tests/internal-api-catalog.test.ts, which re-derives the action set
 * from disk and fails if any action is missing here (and checks every permission
 * label against the RBAC registry). Regenerate after adding a server action or
 * changing a guard: \`node scripts/gen-internal-api-catalog.mjs\`.
 *
 * Total actions: ${total}.
 */

export type InternalActionKind = "write" | "read" | "settings" | "destructive" | "auth";

export type InternalAction = {
  name: string;
  kind: InternalActionKind;
  /**
   * RBAC keys the action's guards check, DERIVED from its requirePermission /
   * requirePermissionAny / permissionSetAllows calls. "a | b" = any one of (or
   * input-dependent); " · " separates distinct checks (a later one may apply to
   * some inputs only — the guard in code is authoritative); "*" = super-admin
   * step-up. Pseudo-scopes: "public" (no auth gate), "session" (signed-in user),
   * "session/public" (optional session, decided in code).
   */
  permission: string;
  summary: string;
};

export type InternalApiDomain = {
  /** Action file (the storefront/admin calls these via React server actions). */
  file: string;
  label: string;
  /** Union of the actions' permission keys ("<module>:*" = several actions of one module). */
  permission: string;
  actions: InternalAction[];
};

export type InternalApiGroup = {
  group: string;
  domains: InternalApiDomain[];
};

export const INTERNAL_API_CATALOG: InternalApiGroup[] = [
${body}];

/** Flat list of every catalogued action name (for the drift test + counts). */
export const INTERNAL_ACTION_NAMES: string[] = INTERNAL_API_CATALOG.flatMap((g) =>
  g.domains.flatMap((d) => d.actions.map((a) => a.name)),
);

export const INTERNAL_ACTION_COUNT = INTERNAL_ACTION_NAMES.length;
`;

writeFileSync(OUT, header, "utf8");
console.log(`wrote ${OUT}: ${total} actions across ${orderedGroups.length} groups`);
