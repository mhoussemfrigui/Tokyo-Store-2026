/**
 * Static WIRING-MATRIX invariants — NO database, NO network. Each registry below
 * is plain data that silently drifts from the code that is supposed to honour
 * it; the TypeScript AST of the source tree is the oracle:
 *
 *  1. Email flows: every EMAIL_FLOWS key is gated by an `isFlowEnabled(…)` call
 *     (literal, a `const FLOW = "…"`, or a `FLOW_BY_STATUS[…]` map value), and
 *     every gated literal is a real flow key — otherwise the admin on/off toggle
 *     of that automation is a dead control (or a typo'd gate never matches).
 *  2. Scheduled jobs: every EXTERNAL SCHEDULED_JOBS key has a JOB_WORK adapter
 *     (src/lib/jobs/run-job.ts), exactly one `src/app/api/cron/<x>/route.ts`
 *     that runs it behind `guardCron` first, and a route-catalog entry; no
 *     orphan adapter, no cron route for an unregistered/internal job.
 *  3. Outbound webhooks: the `["*"]` (all-events) subscription never receives
 *     the auth/security telemetry domains (auth, rbac, api_key, user, data —
 *     PII: emails, client IPs, the bulk-export trail); an integration must opt in
 *     to those BY NAME.
 *  4. Settings read ⇒ write: every literal `site_settings` key the code reads is
 *     written somewhere (a server action / workflow / admin form / seed), except
 *     the documented, deliberately-unwired storefront copy keys listed below.
 *  5. Settings/CMS audit actor: every `workflows.cms.*(…)` call in a server
 *     action forwards the actor ctx (2nd argument), and no action writes
 *     `site_settings` behind the workflow's back (`settingService.upsert`) — so
 *     every admin settings save lands in the audit trail WITH its actor (the
 *     DB-level half lives in settings-actor.test.ts).
 *
 * The internal-API catalog permission labels are validated by
 * internal-api-catalog.test.ts; the RBAC guard matrix by route-invariants.test.ts.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/wiring-matrix.test.ts
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";

import { ALL_ROUTES } from "@/lib/api-auth/route-catalog";
import { EVENT_NAMES } from "@/lib/api-auth/event-catalog";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { EMAIL_FLOWS } from "@/modules/mailing/flows.registry";

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
const SRC = join(ROOT, "src");
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
const list = (xs: string[]) => (xs.length ? ` — ${xs.join(", ")}` : "");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

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

/** Depth-first visit of every node. */
function each(node: ts.Node, fn: (n: ts.Node) => void) {
  fn(node);
  ts.forEachChild(node, (c) => each(c, fn));
}

function stringOf(n: ts.Node | undefined): string | null {
  return n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
}

/** The callee name of a call: `foo(…)` → foo, `a.b.foo(…)` → a.b.foo. */
function calleeName(e: ts.Expression): string {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return `${calleeName(e.expression)}.${e.name.text}`;
  return "?";
}

/** The initializer of the first `const|let <name> = …` in the file. */
function declInit(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  each(sf, (n) => {
    if (!found && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      found = n.initializer;
    }
  });
  return found;
}

/**
 * Every string literal an expression can evaluate to, following same-file
 * `const` indirection, map lookups (`MAP[k]` → every value of MAP), ternaries
 * and arrays. null = not statically resolvable.
 */
function literalsOf(e: ts.Expression | undefined, sf: ts.SourceFile, depth = 0): string[] | null {
  if (!e || depth > 5) return null;
  const lit = stringOf(e);
  if (lit !== null) return [lit];
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
    return literalsOf(e.expression, sf, depth + 1);
  }
  if (ts.isIdentifier(e)) return literalsOf(declInit(sf, e.text), sf, depth + 1);
  if (ts.isElementAccessExpression(e)) return literalsOf(e.expression, sf, depth + 1);
  if (ts.isConditionalExpression(e)) {
    const a = literalsOf(e.whenTrue, sf, depth + 1);
    const b = literalsOf(e.whenFalse, sf, depth + 1);
    return a && b ? [...a, ...b] : null;
  }
  const parts: (ts.Expression | undefined)[] = ts.isObjectLiteralExpression(e)
    ? e.properties.map((p) => (ts.isPropertyAssignment(p) ? p.initializer : undefined))
    : ts.isArrayLiteralExpression(e)
      ? [...e.elements]
      : [];
  if (parts.length === 0) return null;
  const out: string[] = [];
  for (const p of parts) {
    const got = literalsOf(p, sf, depth + 1);
    if (!got) return null;
    out.push(...got);
  }
  return out;
}

/** First awaited call in a function body (source order, nested functions skipped). */
function firstAwaitedCall(body: ts.Node): string | null {
  let found: string | null = null;
  const visit = (n: ts.Node) => {
    if (found !== null) return;
    if (n !== body && ts.isFunctionLike(n)) return;
    if (ts.isAwaitExpression(n)) {
      let e: ts.Expression = n.expression;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      found = ts.isCallExpression(e) ? calleeName(e.expression) : "<non-call await>";
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

const SOURCE_FILES = walk(SRC).filter((f) => !rel(f).startsWith("src/lib/db/tests/"));

function main() {
  // ── 1. Email flows ⇔ isFlowEnabled gates ────────────────────────────────────
  console.log("email flows:");
  const flowKeys = EMAIL_FLOWS.map((f) => f.key);
  const flowSet = new Set(flowKeys);
  check("EMAIL_FLOWS is non-empty", flowKeys.length > 0);
  check(
    `EMAIL_FLOWS keys are unique${list(flowKeys.filter((k, i) => flowKeys.indexOf(k) !== i))}`,
    flowSet.size === flowKeys.length,
  );
  const gated = new Set<string>();
  const unresolvedGates: string[] = [];
  let gateSites = 0;
  for (const file of SOURCE_FILES) {
    if (!readFileSync(file, "utf8").includes("isFlowEnabled(")) continue;
    const sf = parse(file);
    each(sf, (n) => {
      if (!ts.isCallExpression(n) || !/(^|\.)isFlowEnabled$/.test(calleeName(n.expression))) return;
      gateSites++;
      const keys = literalsOf(n.arguments[0], sf);
      if (!keys) unresolvedGates.push(`${rel(file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      else for (const k of keys) gated.add(k);
    });
  }
  check(`isFlowEnabled call sites found (${gateSites})`, gateSites > 0);
  check(
    `every isFlowEnabled argument resolves to literal flow key(s)${list(unresolvedGates)}`,
    unresolvedGates.length === 0,
  );
  check(
    `every EMAIL_FLOWS key is gated by an isFlowEnabled call${list(flowKeys.filter((k) => !gated.has(k)))}`,
    flowKeys.every((k) => gated.has(k)),
  );
  check(
    `every gated key is a registered flow (no typo'd gate)${list([...gated].filter((k) => !flowSet.has(k)))}`,
    [...gated].every((k) => flowSet.has(k)),
  );

  // ── 2. Scheduled jobs ⇔ JOB_WORK ⇔ cron routes ⇔ route catalog ─────────────
  console.log("scheduled jobs:");
  const runJobSf = parse(join(SRC, "lib", "jobs", "run-job.ts"));
  const jobWorkInit = declInit(runJobSf, "JOB_WORK");
  const jobWork = new Set<string>(
    jobWorkInit && ts.isObjectLiteralExpression(jobWorkInit)
      ? jobWorkInit.properties.flatMap((p) =>
          (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) &&
          (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
            ? [p.name.text]
            : [],
        )
      : [],
  );
  check(`JOB_WORK adapter map parsed (${jobWork.size})`, jobWork.size > 0);
  const external = SCHEDULED_JOBS.filter((j) => j.type === "external").map((j) => j.key as string);
  const internal = SCHEDULED_JOBS.filter((j) => j.type === "internal").map((j) => j.key as string);

  const cronDir = join(SRC, "app", "api", "cron");
  const cronRuns = new Map<string, string[]>(); // job key → cron url paths
  const cronUnknown: string[] = [];
  const cronUnguarded: string[] = [];
  let dispatchRouteSeen = false;
  let dispatchByCadence = false;
  const guardChecked = (sf: ts.SourceFile, path: string) =>
    each(sf, (n) => {
      if (!ts.isFunctionDeclaration(n) || !n.name || !n.body) return;
      if (!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return;
      if (firstAwaitedCall(n.body) !== "guardCron") cronUnguarded.push(`${n.name.text} ${path}`);
    });
  for (const file of walk(cronDir).filter((f) => f.endsWith(`${sep}route.ts`))) {
    const sf = parse(file);
    const path = `/${rel(file).replace(/^src\/app\//, "").replace(/\/route\.ts$/, "")}`;
    // The single dispatch HEARTBEAT is a multi-job route BY DESIGN: it iterates
    // SCHEDULED_JOBS and runs each DUE job, so it is exempt from the one-job-per-route
    // contract below. Its own assertions (further down) verify it dispatches by cadence
    // and is guarded.
    if (path === "/api/cron/dispatch") {
      dispatchRouteSeen = true;
      const src = sf.text;
      dispatchByCadence = /\bisDispatchable\b/.test(src) && /\bSCHEDULED_JOBS\b/.test(src) && /\brunScheduledJob\b/.test(src);
      guardChecked(sf, path);
      continue;
    }
    const keys: string[] = [];
    each(sf, (n) => {
      if (ts.isCallExpression(n) && calleeName(n.expression) === "runScheduledJob") {
        const k = stringOf(n.arguments[0]);
        keys.push(k ?? "<non-literal>");
      }
    });
    if (keys.length !== 1 || !external.includes(keys[0])) cronUnknown.push(`${path} → [${keys.join(", ")}]`);
    for (const k of keys) cronRuns.set(k, [...(cronRuns.get(k) ?? []), path]);
    // Every exported handler authenticates the cron caller BEFORE any work.
    guardChecked(sf, path);
  }
  check(
    `every external job has a JOB_WORK adapter${list(external.filter((k) => !jobWork.has(k)))}`,
    external.every((k) => jobWork.has(k)),
  );
  check(
    `every JOB_WORK adapter is an EXTERNAL registered job${list([...jobWork].filter((k) => !external.includes(k)))}`,
    [...jobWork].every((k) => external.includes(k)),
  );
  check(
    `internal jobs are never centralised in JOB_WORK nor cron-driven${list(internal.filter((k) => jobWork.has(k) || cronRuns.has(k)))}`,
    internal.every((k) => !jobWork.has(k) && !cronRuns.has(k)),
  );
  check(
    `every external job is run by exactly one cron route${list(external.filter((k) => (cronRuns.get(k) ?? []).length !== 1))}`,
    external.every((k) => (cronRuns.get(k) ?? []).length === 1),
  );
  check(
    `every cron route runs exactly one registered external job${list(cronUnknown)}`,
    cronUnknown.length === 0,
  );
  check(`every cron handler calls guardCron as its first awaited call${list(cronUnguarded)}`, cronUnguarded.length === 0);
  const catalogued = new Set(ALL_ROUTES.filter((r) => r.tier === "infra").map((r) => `${r.method} ${r.path}`));
  const uncatalogued = external.flatMap((k) =>
    (cronRuns.get(k) ?? []).filter((p) => !catalogued.has(`POST ${p}`)).map((p) => `${k} → POST ${p}`),
  );
  check(`every cron route is catalogued (POST, infra tier)${list(uncatalogued)}`, uncatalogued.length === 0);
  // The single dispatch heartbeat: exists, dispatches by SCHEDULED_JOBS cadence, guarded, catalogued.
  check("the dispatch heartbeat route exists (POST /api/cron/dispatch)", dispatchRouteSeen);
  check("the dispatch route runs jobs by SCHEDULED_JOBS cadence (isDispatchable)", dispatchByCadence);
  check("the dispatch route is catalogued (POST, infra tier)", catalogued.has("POST /api/cron/dispatch"));
  // Every EXTERNAL job carries a machine dispatch cadence; every dispatchable one is
  // interval|daily; internal jobs are never dispatched.
  check(
    `every external job has an interval|daily dispatch cadence${list(SCHEDULED_JOBS.filter((j) => j.type === "external" && j.dispatch.mode !== "interval" && j.dispatch.mode !== "daily" && j.dispatch.mode !== "opportunistic").map((j) => j.key))}`,
    SCHEDULED_JOBS.filter((j) => j.type === "external").every((j) => j.dispatch.mode !== "internal"),
  );
  check(
    `internal jobs have dispatch mode "internal"${list(SCHEDULED_JOBS.filter((j) => j.type === "internal" && j.dispatch.mode !== "internal").map((j) => j.key))}`,
    SCHEDULED_JOBS.filter((j) => j.type === "internal").every((j) => j.dispatch.mode === "internal"),
  );

  // ── 3. Outbound-webhook wildcard excludes the security domains ──────────────
  console.log("outbound webhooks — wildcard data minimisation:");
  const dispatchSf = parse(join(SRC, "events", "subscribers", "dispatch-webhooks.ts"));
  const domainsInit = declInit(dispatchSf, "SECURITY_DOMAINS");
  const securityDomains = new Set(
    domainsInit && ts.isNewExpression(domainsInit) && domainsInit.arguments?.[0]
      ? (literalsOf(domainsInit.arguments[0], dispatchSf) ?? [])
      : [],
  );
  const REQUIRED_SECURITY_DOMAINS = ["auth", "rbac", "api_key", "user", "data"];
  check(
    `SECURITY_DOMAINS keeps ${REQUIRED_SECURITY_DOMAINS.join(" / ")}${list(REQUIRED_SECURITY_DOMAINS.filter((d) => !securityDomains.has(d)))}`,
    REQUIRED_SECURITY_DOMAINS.every((d) => securityDomains.has(d)),
  );
  const eventDomains = new Set(EVENT_NAMES.map((n) => n.split(".")[0]));
  check(
    `every SECURITY_DOMAINS entry is a live event domain (no stale entry)${list([...securityDomains].filter((d) => !eventDomains.has(d)))}`,
    securityDomains.size > 0 && [...securityDomains].every((d) => eventDomains.has(d)),
  );
  // The PII-bearing telemetry the wildcard must never carry, pinned by name.
  const PII_EVENTS = [
    "user.signed_in",
    "user.password_reset_requested",
    "auth.rate_limited",
    "rbac.permission_denied",
    "api_key.auth_failed",
    "data.exported",
  ];
  check(
    `pinned PII events exist and sit in a security domain${list(PII_EVENTS.filter((e) => !EVENT_NAMES.includes(e) || !securityDomains.has(e.split(".")[0])))}`,
    PII_EVENTS.every((e) => EVENT_NAMES.includes(e) && securityDomains.has(e.split(".")[0])),
  );
  // The filter itself: `isSecuritySensitiveEvent` tests the FIRST dotted segment
  // against SECURITY_DOMAINS, and the `includes("*")` branch returns its negation.
  const predicate = declInit(dispatchSf, "isSecuritySensitiveEvent");
  let predicateBody = "";
  each(dispatchSf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "isSecuritySensitiveEvent" && n.body) {
      predicateBody = n.body.getText(dispatchSf);
    }
  });
  if (!predicateBody && predicate) predicateBody = predicate.getText(dispatchSf);
  check(
    "isSecuritySensitiveEvent tests the first dotted segment against SECURITY_DOMAINS",
    /SECURITY_DOMAINS\.has\(\s*\w+\.split\(\s*["']\.["']\s*\)\[0\]/.test(predicateBody),
  );
  let wildcardFiltered = false;
  let wildcardBranches = 0;
  each(dispatchSf, (n) => {
    if (!ts.isIfStatement(n) || !/\.includes\(\s*["']\*["']\s*\)/.test(n.expression.getText(dispatchSf))) return;
    wildcardBranches++;
    const then = ts.isBlock(n.thenStatement) ? n.thenStatement.statements[0] : n.thenStatement;
    const ret = then && ts.isReturnStatement(then) ? then.expression : undefined;
    wildcardFiltered =
      !!ret &&
      ts.isPrefixUnaryExpression(ret) &&
      ret.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isCallExpression(ret.operand) &&
      calleeName(ret.operand.expression) === "isSecuritySensitiveEvent";
  });
  check(
    'the single `["*"]` branch returns !isSecuritySensitiveEvent(…) (wildcard never gets security events)',
    wildcardBranches === 1 && wildcardFiltered,
  );

  // ── 4. Settings read ⇒ write ────────────────────────────────────────────────
  console.log("settings read ⇒ write:");
  const KEY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
  const eventSet = new Set(EVENT_NAMES);
  const routeIds = new Set(ALL_ROUTES.map((r) => r.id));
  const notSettingKey = (k: string) => eventSet.has(k) || routeIds.has(k);
  // Where a key can be WRITTEN from: server actions, workflows, the admin UI
  // (form fields named after the key), seeds / demo import / bootstrap.
  const isWriterFile = (r: string) =>
    /^src\/(lib\/actions|workflows|app\/admin|components\/admin|lib\/demo|lib\/bootstrap)\//.test(r) ||
    r.startsWith("scripts/");
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const written = new Set<string>();
  const writtenPatterns: RegExp[] = [];
  const reads = new Map<string, Set<string>>();
  const addRead = (k: string, file: string) => {
    if (!KEY_RE.test(k) || notSettingKey(k)) return;
    if (!reads.has(k)) reads.set(k, new Set());
    reads.get(k)!.add(file);
  };
  const scriptsDir = join(ROOT, "scripts");
  const allFiles = [...SOURCE_FILES, ...(existsSync(scriptsDir) ? walk(scriptsDir) : [])];
  for (const file of allFiles) {
    const r = rel(file);
    const src = readFileSync(file, "utf8");
    const writer = isWriterFile(r);
    // A module that loads the settings map / a single row reads every dotted
    // literal it hands to a helper (`text(settings, "cart.empty.title", …)`).
    const settingsReader = /\bgetSettingsMap\b|settingService\.findByKey\(/.test(src);
    const sf = parse(file);
    each(sf, (n) => {
      if (writer) {
        const s = stringOf(n);
        if (s !== null && KEY_RE.test(s)) written.add(s);
        if (ts.isTemplateExpression(n)) {
          // `checkout.payment.${provider}_enabled` → /^checkout\.payment\.[a-z0-9_]+_enabled$/
          const texts = [n.head.text, ...n.templateSpans.map((t) => t.literal.text)];
          if (texts.some((t) => t.includes("."))) {
            writtenPatterns.push(
              new RegExp(`^${escapeRe(n.head.text)}${n.templateSpans.map((t) => `[a-z0-9_]+${escapeRe(t.literal.text)}`).join("")}$`),
            );
          }
        }
      }
      if (r.startsWith("scripts/")) return; // seeds write; they are not storefront readers
      if (ts.isElementAccessExpression(n)) {
        const k = stringOf(n.argumentExpression);
        if (k !== null) addRead(k, r);
      } else if (settingsReader && ts.isCallExpression(n)) {
        for (const a of n.arguments) {
          const k = stringOf(a);
          if (k !== null) addRead(k, r);
        }
      }
    });
  }
  const isWritten = (k: string) => written.has(k) || writtenPatterns.some((re) => re.test(k));
  /**
   * Read with a French code default but DELIBERATELY not admin-editable yet
   * (deferred copy editor) — a row seeded straight into `site_settings` still
   * overrides them. Remove an entry once its keys get a writer; the staleness
   * check below fails while an entry covers nothing.
   */
  const UNWIRED_SETTING_KEYS: { match: string; why: string }[] = [
    { match: "cart.coupon.", why: "cart page copy (src/lib/cart/cart-page-copy.ts)" },
    { match: "cart.empty.", why: "cart page copy" },
    { match: "cart.summary.", why: "cart page copy" },
    { match: "checkout.form.", why: "checkout form copy (src/lib/checkout/form-copy.ts)" },
    { match: "checkout.payment.cod_description", why: "COD radio caption (quick-buy-config.ts: code default)" },
    { match: "checkout.payment.clictopay_label", why: "gateway radio title — code default" },
    { match: "checkout.payment.clictopay_description", why: "gateway radio caption — code default" },
    { match: "checkout.payment.flouci_label", why: "gateway radio title — code default" },
    { match: "checkout.payment.flouci_description", why: "gateway radio caption — code default" },
    // Legacy home fallback config (getHomePageConfig → synthesizeLegacyHomeBlocks): read
    // with code defaults for a home that has NO composer layout yet. Their admin writer
    // moved to the home.blocks composer (home.rail.*.label / promotions.title still have
    // one); a row seeded straight into site_settings still overrides them.
    { match: "home.hero.visible", why: "legacy home fallback — composer superseded the writer" },
    { match: "home.rail.new.visible", why: "legacy home fallback — composer superseded the writer" },
    { match: "home.rail.new.title", why: "legacy home fallback — composer superseded the writer" },
    { match: "home.rail.new.subtitle", why: "legacy home fallback — composer superseded the writer" },
    { match: "home.rail.promotions.visible", why: "legacy home fallback — composer superseded the writer" },
    { match: "home.rail.promotions.subtitle", why: "legacy home fallback — composer superseded the writer" },
  ];
  const allowed = (k: string) =>
    UNWIRED_SETTING_KEYS.some((a) => (a.match.endsWith(".") ? k.startsWith(a.match) : k === a.match));
  const unwritten = [...reads.keys()].filter((k) => !isWritten(k)).sort();
  check(`settings reads found (${reads.size}) + writers parsed (${written.size})`, reads.size > 50 && written.size > 50);
  const orphanReads = unwritten.filter((k) => !allowed(k));
  check(
    `every read settings key has a writer (or is a documented unwired copy key)${list(orphanReads.map((k) => `${k} [${[...reads.get(k)!].join(" ")}]`))}`,
    orphanReads.length === 0,
  );
  const staleAllow = UNWIRED_SETTING_KEYS.filter((a) => !unwritten.some((k) => (a.match.endsWith(".") ? k.startsWith(a.match) : k === a.match)));
  check(
    `every UNWIRED_SETTING_KEYS entry still covers an unwritten read (no stale allow-list)${list(staleAllow.map((a) => a.match))}`,
    staleAllow.length === 0,
  );

  // ── 5. Settings/CMS audit actor forwarded by every server action ────────────
  console.log("settings / CMS audit actor:");
  const actionsDir = join(SRC, "lib", "actions");
  const noCtx: string[] = [];
  const bypass: string[] = [];
  let cmsCalls = 0;
  for (const file of walk(actionsDir)) {
    const sf = parse(file);
    each(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      const name = calleeName(n.expression);
      const at = `${rel(file).replace("src/lib/actions/", "")}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
      if (/^workflows\.cms\.\w+$/.test(name)) {
        cmsCalls++;
        if (n.arguments.length < 2) noCtx.push(`${name} @ ${at}`);
      }
      if (/^settingService\.(upsert|deleteByKeys)$/.test(name)) bypass.push(`${name} @ ${at}`);
    });
  }
  check(`workflows.cms.* calls found in actions (${cmsCalls})`, cmsCalls > 0);
  check(`every workflows.cms.* call passes the actor ctx${list(noCtx)}`, noCtx.length === 0);
  check(`no server action writes site_settings around the workflow${list(bypass)}`, bypass.length === 0);

  console.log(
    `\n=== done: ${passed} passed, ${failed} failed === (flows=${flowKeys.length}, gates=${gateSites}, jobs=${SCHEDULED_JOBS.length}, securityDomains=${securityDomains.size}, settingReads=${reads.size}, cmsCalls=${cmsCalls})`,
  );
  if (failed > 0) process.exit(1);
}

main();
process.exit(0);
