/**
 * PURE CSV cell encoder shared by the admin export routes (audit, orders,
 * customers, guests). No deps — unit-testable.
 *
 * Two jobs:
 *   1. RFC-4180 quoting: wrap every cell in double quotes and double any
 *      embedded quote, so commas / newlines / quotes in the data are safe.
 *   2. CSV / formula-injection neutralisation (CWE-1236): a cell whose first
 *      char is = + - @ (or a leading tab / CR) is prefixed with a single quote
 *      so Excel / Google Sheets treat it as TEXT, not a live formula. Without
 *      this an audit summary like `=cmd()` or `+HYPERLINK(...)` becomes an
 *      executable cell when the exported CSV is opened.
 */
export function csvCell(v: unknown): string {
  if (v == null) return '""';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
