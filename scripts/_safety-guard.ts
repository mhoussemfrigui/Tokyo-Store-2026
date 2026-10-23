/**
 * Safety guard for the one-off DESTRUCTIVE developer scripts (soft-delete all
 * categories/products, DELETE banners/pages/nav rows, …). These take their
 * target from `DATABASE_URL` (often `.env.local`), print no host, and have no
 * confirmation — so running one against a LIVE store wipes or corrupts content
 * (A-Z audit INF-10).
 *
 * A hostname CANNOT reliably tell "my dev DB" from "prod": the Coolify stack's
 * app reaches its database at host `postgres` (the compose service name), and the
 * runbook tells operators to reach prod through an SSH tunnel on `localhost`. So
 * there is no host whitelist that is safe — this guard therefore ALWAYS requires
 * an explicit opt-in and simply makes the target impossible to miss first.
 *
 * Opt in for THIS run: set `ALLOW_DESTRUCTIVE=1` (env) or pass `--yes`.
 * Pure Node (no app imports) so it runs regardless of the app's compile state.
 */

/**
 * Call at the TOP of a destructive script's `main()`, before any write. It prints
 * the exact host + database the script will connect to, then refuses unless the
 * operator has explicitly confirmed — so a wipe can never happen by simply running
 * the file, whatever `DATABASE_URL` happens to point at.
 *
 * @param databaseUrl the URL the script will actually connect to (its resolved
 *   `process.env.DATABASE_URL || <default>`); omit to read `process.env.DATABASE_URL`.
 * @param label a short name of the destructive action, shown in the banner.
 */
export function assertDestructiveTargetAllowed(databaseUrl?: string, label = "destructive changes"): void {
  const url = (databaseUrl ?? process.env.DATABASE_URL ?? "").trim();
  const confirmed =
    process.env.ALLOW_DESTRUCTIVE === "1" ||
    process.argv.includes("--yes") ||
    process.argv.includes("--force");

  let host = "(unset DATABASE_URL → the script's built-in default)";
  let dbName = "(default)";
  if (url) {
    try {
      const u = new URL(url);
      host = u.hostname || "(no host)";
      dbName = u.pathname.replace(/^\//, "") || "(default)";
    } catch {
      host = "(unparseable DATABASE_URL)";
    }
  }

  // eslint-disable-next-line no-console
  console.error(`\n[safety] ABOUT TO RUN: ${label}`);
  // eslint-disable-next-line no-console
  console.error(`[safety]   target host: "${host}"   database: "${dbName}"`);

  if (confirmed) {
    // eslint-disable-next-line no-console
    console.error("[safety] confirmed (ALLOW_DESTRUCTIVE / --yes) — proceeding.\n");
    return;
  }

  // eslint-disable-next-line no-console
  console.error(
    "[safety] REFUSED: this is a DESTRUCTIVE one-off and no host is trusted automatically\n" +
      "[safety]          (prod's DB host is \"postgres\"; a prod tunnel is \"localhost\").\n" +
      "[safety]          Confirm the host/database above is the one you mean to WIPE, then\n" +
      "[safety]          re-run with ALLOW_DESTRUCTIVE=1 (or --yes).\n",
  );
  process.exit(1);
}
