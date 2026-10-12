import type { CustomerProfileRow } from "@/modules/customer/schema";
import { CUSTOMER_GENDER_LABELS } from "@/modules/customer/types";
import type { CsvField } from "@/lib/csv/fields";
import { CUSTOMER_EXPORT_FIELDS, type CustomerExportFieldKey } from "./customer-fields";

/**
 * Shared enrichment for a customer-shaped CSV export row (profile + resolved email)
 * and the per-column value accessors. Extracted so the Clients export and the
 * per-segment member export attach the SAME accessors to the SAME client-safe
 * catalog (CUSTOMER_EXPORT_FIELDS) — they can never drift on the column set or its
 * formatting. No DB here; the caller collects + enriches the rows.
 */
export type CustomerExportRow = { p: CustomerProfileRow; email: string };

/** Per-key value accessors, keyed by the client-safe catalog's field keys. */
export const CUSTOMER_ROW_VALUE: Record<CustomerExportFieldKey, (r: CustomerExportRow) => string | number> = {
  id: (r) => r.p.id,
  firstName: (r) => r.p.first_name,
  lastName: (r) => r.p.last_name,
  email: (r) => r.email,
  phone: (r) => r.p.phone ?? "",
  gender: (r) =>
    r.p.gender ? (CUSTOMER_GENDER_LABELS[r.p.gender as "female" | "male" | "other"] ?? r.p.gender) : "",
  marketing: (r) => (r.p.marketing_opt_in ? "oui" : "non"),
  birthday: (r) => r.p.birthday ?? "",
  createdAt: (r) => new Date(r.p.created_at).toISOString().slice(0, 10),
};

/** The catalog with its value accessors attached — ready for selectCsvFields. */
export const CUSTOMER_CSV_FIELDS: ReadonlyArray<CsvField<CustomerExportRow>> = CUSTOMER_EXPORT_FIELDS.map(
  (f) => ({ key: f.key, label: f.label, value: CUSTOMER_ROW_VALUE[f.key] }),
);
