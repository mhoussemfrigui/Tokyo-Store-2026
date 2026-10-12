/**
 * Search-param contract of the mailing hub's « Journaux » tab — shared by the
 * server page (which feeds the filters to `emailLogService.list`) and the client
 * tab (which writes them). Plain module (no "use client"), so the server page
 * gets real values rather than client references.
 *
 * Filtering + pagination run in SQL over the WHOLE send log (the trigram index
 * on lower(to_email) backs the search) — the tab used to filter only the newest
 * 50 rows it had been handed.
 */

export const LOG_PAGE_SIZE = 50;

export const LOG_STATUSES = ["sent", "queued", "pending", "failed"] as const;

/** Query-string keys, prefixed so they can't collide with other hub params. */
export const LOG_PARAM = { status: "logStatus", q: "logQ", page: "logPage" } as const;

export type LogFilters = { status: string; q: string; page: number };

export function parseLogParams(get: (key: string) => string | null | undefined): LogFilters {
  const rawStatus = get(LOG_PARAM.status) ?? "";
  const status = (LOG_STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : "";
  // Same 100-char cap the service applies to the LIKE fragment.
  const q = (get(LOG_PARAM.q) ?? "").trim().slice(0, 100);
  const page = Math.max(1, Math.floor(Number(get(LOG_PARAM.page) ?? "1")) || 1);
  return { status, q, page };
}
