import { type CsvField, fieldChoices } from "@/lib/csv/fields";
import type { GuestRow } from "@/lib/customers/guest-filter-shared";

/**
 * Guest-export column catalog — ONE source of truth. `GUEST_CSV_FIELDS` carries the value
 * accessors (used by the export route); `GUEST_EXPORT_FIELDS` is the derived {key,label}
 * list for the client field-picker, so the picker and the route can never drift. GuestRow
 * is already enriched (account match included), so the accessors are pure — no server-only
 * imports, safe to pull into the client bundle. Spend is in millimes (matching the Clients
 * export); the account columns surface the retro-link candidate.
 */
export const GUEST_CSV_FIELDS: ReadonlyArray<CsvField<GuestRow>> = [
  { key: "email", label: "Email", value: (g) => g.email ?? "" },
  { key: "phone", label: "Téléphone", value: (g) => g.phone ?? "" },
  { key: "name", label: "Nom", value: (g) => g.name ?? "" },
  { key: "orders", label: "Commandes", value: (g) => g.orderCount },
  { key: "paidSpend", label: "Payé (millimes)", value: (g) => g.paidSpendCents },
  { key: "totalSpend", label: "Total (millimes)", value: (g) => g.totalSpendCents },
  { key: "hasAccount", label: "Compte existant", value: (g) => (g.accountUserId ? "oui" : "non") },
  { key: "accountVerified", label: "Compte vérifié", value: (g) => (g.accountUserId ? (g.accountVerified ? "oui" : "non") : "") },
  { key: "firstOrderAt", label: "Première commande", value: (g) => g.firstOrderAt?.slice(0, 10) ?? "" },
  { key: "lastOrderAt", label: "Dernière commande", value: (g) => g.lastOrderAt?.slice(0, 10) ?? "" },
];

/** {key,label}[] for the client field-picker (no accessors). */
export const GUEST_EXPORT_FIELDS = fieldChoices(GUEST_CSV_FIELDS);
