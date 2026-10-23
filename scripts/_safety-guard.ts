/**
 * Safety guard for the one-off DESTRUCTIVE developer scripts (soft-delete all
 * categories/products, DELETE banners/pages/nav rows, …). These take their
 * target from `DATABASE_URL` (often `.env.local`), print no host, and have no
 * confirmation — so running one against a LIVE store wipes or corrupts content
 * (A-Z audit INF-10). This guard refuses to touch a NON-LOCAL database unless the
 * operator explicitly opts in, and always announces the target first.
 *
 * Opt-in to a remote/prod run: set `ALLOW_DESTRUCTIVE=1` (env) or pass `--yes`.
 * Pure Node (no app imports) so it runs regardless of the app's compile state.
 */

/** Hosts we treat as a developer's own machine (safe to wipe without a prompt). */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "0.0.0.0" ||
    h.endsWith(".localhost") ||
    h === "postgres" || // the compose service name on a dev `docker-compose.dev.yml`
    h === "db"
  );
}

/**
 * Call at the TOP of a destructive script's `main()`, before any write.
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

  let host = "";
  let dbName = "";
  try {
    const u = new URL(url || "postgresql://localhost/unknown");
    host = u.hostname;
    dbName = u.pathname.replace(/^\//, "") || "(default)";
  } catch {
    host = "(unparseable DATABASE_URL)";
  }

  // An EMPTY DATABASE_URL means the script falls back to its built-in localhost
  // default, so it can never reach prod without the operator SETTING a non-local
  // url — treat empty as local (safe).
  const local = url === "" || isLocalHost(host);
  // eslint-disable-next-line no-console
  console.error(`\n[safety] ${label} → host "${host}", database "${dbName}"`);

  if (local || confirmed) {
    if (confirmed && !local) {
      // eslint-disable-next-line no-console
      console.error("[safety] NON-LOCAL target explicitly confirmed (ALLOW_DESTRUCTIVE / --yes). Proceeding.\n");
    }
    return;
  }

  // eslint-disable-next-line no-console
  console.error(
    `[safety] REFUSED: "${host}" is not a local database and this run is destructive.\n` +
      "[safety] If you really mean to wipe/rewrite THIS target, re-run with ALLOW_DESTRUCTIVE=1 (or --yes).\n",
  );
  process.exit(1);
}
