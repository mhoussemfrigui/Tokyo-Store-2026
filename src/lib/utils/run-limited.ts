/**
 * Run thunks with BOUNDED concurrency, preserving result order (starts them in
 * array order, at most `limit` in flight). For server work that fans out over
 * the shared DB pool — the Database diagnostics tab, the retention purge — where
 * a raw Promise.all would momentarily demand more connections than the pool
 * holds and starve live storefront traffic. Each thunk is responsible for its
 * own try/catch: a rejection rejects the whole run (like Promise.all).
 */
export async function runLimited<T>(thunks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(thunks.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      // `next++` is atomic on JS's single thread — no lock needed.
      const i = next++;
      if (i >= thunks.length) return;
      results[i] = await thunks[i]();
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, thunks.length)) }, () => worker()),
  );
  return results;
}
