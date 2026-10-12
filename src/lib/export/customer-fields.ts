/**
 * Client-safe customer-export field catalog (key + label only) — the allow-list of
 * columns an operator may pick when exporting the Clients CSV. Shared by the export
 * route (which attaches the value accessors) and the field-picker UI, so the two
 * can never drift. No server-only imports: the picker is a client component.
 */
export const CUSTOMER_EXPORT_FIELDS = [
  { key: "id", label: "ID" },
  { key: "firstName", label: "Prénom" },
  { key: "lastName", label: "Nom" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Téléphone" },
  { key: "gender", label: "Genre" },
  { key: "marketing", label: "Marketing" },
  { key: "birthday", label: "Anniversaire" },
  { key: "createdAt", label: "Créé le" },
] as const;

export type CustomerExportFieldKey = (typeof CUSTOMER_EXPORT_FIELDS)[number]["key"];
