/**
 * `withLongStatement` (src/lib/db/client.ts) — the ONLY supported way to give a
 * legitimately long job more than the pool-wide statement budget.
 *
 * The pool sets BOTH a server `statement_timeout` and node-postgres' client-side
 * `query_timeout`; the latter can't be lifted per query through Drizzle, so the
 * old advice (`SET LOCAL statement_timeout = '60s'` on the pool) still aborted
 * client-side ("Query read timeout") while the server kept running the query.
 * This pins: the pool budget really cuts a slow query, the helper really lets
 * the same query finish on its dedicated connection, `SET LOCAL` is applied
 * inside the helper's transaction, bad budgets are refused, and the pool is
 * still usable afterwards.
 *
 * The pool budget is shrunk to 300 ms for this process (DB_STATEMENT_TIMEOUT_MS,
 * set before the client module loads) so the test runs in ~2 s. Read-only (only
 * `SELECT`/`SHOW`/`pg_sleep`).
 *
 * Run (isolated DB):
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/long-statement.test.ts
 */
import { sql } from "drizzle-orm";

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

// Must be set before @/lib/db/client is evaluated (it reads env at load).
process.env.DB_STATEMENT_TIMEOUT_MS = "300";

type Row = Record<string, unknown>;

async function main() {
  const { db, withLongStatement, closePool } = await import("@/lib/db/client");
  try {
    console.log("pool budget (300 ms for this run):");
    const st = await db.execute(sql`SHOW statement_timeout`);
    check("pool session statement_timeout is the configured budget", (st.rows[0] as Row)?.statement_timeout === "300ms");

    let poolErr: unknown = null;
    try {
      await db.execute(sql`SELECT pg_sleep(0.8)`);
    } catch (err) {
      poolErr = err;
    }
    check("a 0.8 s query on the pool is aborted", poolErr !== null);

    // Drizzle wraps the driver error ("Failed query: …") with the pg error as
    // `cause`; capture it INSIDE the transaction (the ROLLBACK that follows can
    // itself time out while the server is still sleeping).
    let poolLocalErr: unknown = null;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
        try {
          await tx.execute(sql`SELECT pg_sleep(0.8)`);
        } catch (err) {
          poolLocalErr = err;
          throw err;
        }
      });
    } catch {
      /* expected */
    }
    const cause = (poolLocalErr as { cause?: unknown } | null)?.cause;
    check(
      "…and SET LOCAL on the pool can NOT lengthen it (client-side 'Query read timeout' still fires)",
      poolLocalErr !== null && /Query read timeout/i.test(String((cause as Error)?.message ?? cause ?? poolLocalErr)),
    );
    // Let the abandoned server-side pg_sleep finish before reusing the pool.
    await new Promise((r) => setTimeout(r, 700));

    console.log("withLongStatement(3000, …):");
    const inner = await withLongStatement(3000, async (tx) => {
      const s = await tx.execute(sql`SHOW statement_timeout`);
      await tx.execute(sql`SELECT pg_sleep(0.8)`);
      const r = await tx.execute(sql`SELECT 42 AS answer`);
      return { timeout: (s.rows[0] as Row)?.statement_timeout, answer: Number((r.rows[0] as Row)?.answer) };
    });
    check("SET LOCAL statement_timeout applied inside the helper's transaction", inner.timeout === "3s");
    check("the same 0.8 s query completes and fn's value is returned", inner.answer === 42);

    let longErr: unknown = null;
    try {
      await withLongStatement(400, (tx) => tx.execute(sql`SELECT pg_sleep(1.2)`));
    } catch (err) {
      longErr = err;
    }
    check("the helper still enforces ITS budget (0.4 s < 1.2 s → aborted)", longErr !== null);

    for (const bad of [0, -5, 1.5, Number.NaN]) {
      let threw = false;
      try {
        await withLongStatement(bad, async () => 1);
      } catch {
        threw = true;
      }
      check(`ms=${bad} refused`, threw);
    }

    const ok = await db.execute(sql`SELECT 1 AS one`);
    check("pool still healthy afterwards", Number((ok.rows[0] as Row)?.one) === 1);
  } finally {
    await closePool();
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
