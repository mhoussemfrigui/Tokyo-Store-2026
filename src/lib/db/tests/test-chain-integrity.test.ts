/**
 * Test-chain integrity — the guard that stops a *.test.ts file from being
 * silently orphaned (added to disk but wired into no `package.json` script, so
 * it never runs). That is exactly how `product-code`/`slug`/`content-gen*` and
 * ~10 others drifted un-run — one of them hiding a stale assertion for months.
 *
 * The test harness has TWO chains:
 *   - `test:pure` — DB-free tests, run with only `--conditions=react-server`.
 *   - `test:db`   — tests needing a live DB, run with `--env-file-if-exists`.
 *   - `test`      — composes the two (`pnpm run test:db && pnpm run test:pure`).
 * A chain may be split into numbered sub-scripts (`test:db:1`, `test:db:2`, …)
 * that the parent runs in order — Windows' cmd.exe caps a command line at
 * ~8191 chars, so one long `&&` chain stops running at all. Append new tests to
 * the LAST sub-script; start a new one when it nears 6000 chars.
 *
 * Every file in this directory must appear in exactly ONE of the two chains,
 * every reference must point at a file that exists, and `test` must run both.
 * Pure (no DB) so it runs in the fast lane and in a no-DB CI job.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

const THIS_FILE = "test-chain-integrity.test.ts";
const TESTS_DIR = join(process.cwd(), "src", "lib", "db", "tests");

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/**
 * A chain's full command text: the script itself plus its numbered sub-scripts.
 * Long chains are split (`test:db` = `pnpm run test:db:1 && pnpm run test:db:2`)
 * because Windows runs package scripts through cmd.exe, which rejects a command
 * line over ~8191 characters ("The command line is too long").
 */
function chainText(chain: string): string {
  return Object.entries(pkg.scripts)
    .filter(([k]) => k === chain || k.startsWith(`${chain}:`))
    .map(([, v]) => v)
    .join(" && ");
}

/** Every `src/lib/db/tests/<name>.test.ts` a chain references, first-seen order. */
function refs(script: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of chainText(script).matchAll(/tests\/([a-z0-9-]+\.test\.ts)/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

const onDisk = readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();
const pure = refs("test:pure");
const db = refs("test:db");
const pureSet = new Set(pure);
const dbSet = new Set(db);
const wired = new Set([...pure, ...db]);

// 1. COVERAGE — no orphans: every file on disk is wired into a chain.
const orphans = onDisk.filter((f) => !wired.has(f));
check(
  orphans.length === 0
    ? "every test file is wired into a chain"
    : `ORPHANED (in no chain): ${orphans.join(", ")}`,
  orphans.length === 0,
);

// 2. NO PHANTOM — every referenced file exists on disk.
const diskSet = new Set(onDisk);
const phantomPure = pure.filter((f) => !diskSet.has(f));
const phantomDb = db.filter((f) => !diskSet.has(f));
check(
  phantomPure.length === 0 && phantomDb.length === 0
    ? "no chain references a missing file"
    : `PHANTOM refs: ${[...phantomPure, ...phantomDb].join(", ")}`,
  phantomPure.length === 0 && phantomDb.length === 0,
);

// 3. DISJOINT — a file lives in exactly one chain (no duplicate execution).
const both = pure.filter((f) => dbSet.has(f));
check(
  both.length === 0 ? "no file is in both chains" : `IN BOTH chains: ${both.join(", ")}`,
  both.length === 0,
);

// 4. NO DUP within a chain (the regex de-dups, so compare raw counts).
const rawPure = [...chainText("test:pure").matchAll(/tests\/([a-z0-9-]+\.test\.ts)/g)];
const rawDb = [...chainText("test:db").matchAll(/tests\/([a-z0-9-]+\.test\.ts)/g)];
check("test:pure lists each file once", rawPure.length === pureSet.size);
check("test:db lists each file once", rawDb.length === dbSet.size);

// 4b. WINDOWS LIMIT — cmd.exe rejects a command line over ~8191 chars, so every
// script (after pnpm prepends its own wrapper) must stay well under it.
const tooLong = Object.entries(pkg.scripts)
  .filter(([k, v]) => (k === "test" || k.startsWith("test:")) && v.length > 7500)
  .map(([k, v]) => `${k} (${v.length})`);
check(
  tooLong.length === 0
    ? "every test script fits the Windows command-line limit"
    : `split these scripts (> 7500 chars): ${tooLong.join(", ")}`,
  tooLong.length === 0,
);

// 4c. Every numbered sub-script is actually invoked by its parent chain.
for (const chain of ["test:pure", "test:db"]) {
  const subs = Object.keys(pkg.scripts).filter((k) => k.startsWith(`${chain}:`));
  const parent = pkg.scripts[chain] ?? "";
  const unrun = subs.filter((k) => !new RegExp(`\\bpnpm run ${k.replace(/:/g, "\\:")}(?!\\d)`).test(parent));
  check(
    unrun.length === 0 ? `${chain} runs all its sub-scripts` : `${chain} never runs: ${unrun.join(", ")}`,
    unrun.length === 0,
  );
}

// 5. COMPOSITION — `test` runs both sub-chains (so `pnpm test` = everything).
const testScript = pkg.scripts["test"] ?? "";
check(
  "`test` composes test:db + test:pure",
  /\btest:db\b/.test(testScript) && /\btest:pure\b/.test(testScript),
);

// 6. This guard is itself wired (in the pure chain).
check("the integrity guard runs in test:pure", pureSet.has(THIS_FILE));

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
