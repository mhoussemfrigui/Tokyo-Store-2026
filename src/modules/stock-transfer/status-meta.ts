import type { TransferStatus } from "./schema";

/**
 * Display label + chip colour per transfer status — the SINGLE source shared by
 * the Transferts panel, the order page's linked-transfers panel, and the
 * printable slip (which uses the label only). Client-safe: the only import is a
 * type (erased), so importing this pulls no server/DB code. Import it by this
 * sub-path, NOT the module barrel (which re-exports the server-only service).
 */
export const TRANSFER_STATUS_META: Record<TransferStatus, { label: string; cls: string }> = {
  requested: { label: "Demandé", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  accepted: { label: "Accepté", cls: "bg-primary/10 text-primary" },
  in_transit: { label: "En transfert", cls: "bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  completed: { label: "Transféré", cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  cancelled: { label: "Annulé", cls: "bg-muted text-muted-foreground" },
};
