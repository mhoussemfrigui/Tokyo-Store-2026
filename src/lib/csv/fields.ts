import { csvCell } from "./cell";

/**
 * A selectable export column: a stable `key` (what the `?fields=` query carries),
 * a French `label` (the CSV header), and a `value` accessor from a row. The route
 * owns the catalog (the allow-list of what CAN be exported); the operator picks a
 * subset at export time (`?fields=a,b,c`). Shared by every admin CSV export so the
 * picker UI + the RBAC `export` grant behave identically everywhere (incl. the
 * per-segment export reused by the Segments tab).
 */
export type CsvField<T> = {
  key: string;
  label: string;
  value: (row: T) => string | number | null | undefined;
};

/** The catalog as `{key,label}[]` — for the client field-picker (no accessors). */
export function fieldChoices<T>(fields: ReadonlyArray<CsvField<T>>): Array<{ key: string; label: string }> {
  return fields.map((f) => ({ key: f.key, label: f.label }));
}

/**
 * Resolve `?fields=` into an ORDERED, validated, de-duped subset of the catalog.
 * Unknown keys are dropped (an operator can't export a column the route didn't
 * offer); an empty / all-invalid selection falls back to the FULL catalog so a
 * bare export URL still returns everything (backward-compatible with the old
 * no-picker links).
 */
export function selectCsvFields<T>(
  fields: ReadonlyArray<CsvField<T>>,
  raw: string | null | undefined,
): CsvField<T>[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const seen = new Set<string>();
  const picked: CsvField<T>[] = [];
  for (const k of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const f = byKey.get(k);
    if (f && !seen.has(k)) {
      picked.push(f);
      seen.add(k);
    }
  }
  return picked.length > 0 ? picked : [...fields];
}

/** CSV header line for the chosen fields (each label escaped). */
export function csvHeaderLine<T>(fields: ReadonlyArray<CsvField<T>>): string {
  return fields.map((f) => csvCell(f.label)).join(",");
}

/** CSV data line for one row across the chosen fields (each cell escaped). */
export function csvRowLine<T>(fields: ReadonlyArray<CsvField<T>>, row: T): string {
  return fields.map((f) => csvCell(f.value(row) ?? "")).join(",");
}
