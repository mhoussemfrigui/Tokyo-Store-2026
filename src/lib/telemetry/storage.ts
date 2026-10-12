/**
 * PURE storage-usage summariser — NO "server-only", NO DB, so it is unit-tested
 * directly. Given the per-table sizes (heap / index / total bytes) the Database
 * tab already loads from pg_*, it computes:
 *   - the data / index / TOAST split across the whole schema,
 *   - the LOGS & telemetry subtotal (exact — an explicit table list, since these
 *     names share no prefix: cart_events, webhook_events, audit_log, …),
 *   - a coarse per-domain group breakdown (first-match-wins, "other" fallback)
 *     for an at-a-glance "where do the bytes go" view. The per-table table stays
 *     the precise drill-down.
 *
 * Object storage (uploaded media / images) lives in S3, NOT Postgres, so it is
 * summarised separately by the Resources tab from `media.size_bytes`.
 */

import { RETENTION_TARGETS } from "@/lib/retention/windows";

export type TableSize = {
  relname: string;
  /** Total relation size incl. heap + indexes + TOAST (pg_total_relation_size). */
  totalBytes: number;
  /** Main fork / heap only (pg_relation_size). */
  heapBytes: number;
  /** All indexes on the table (pg_indexes_size). */
  indexBytes: number;
  rows: number;
};

/**
 * Log / telemetry tables — the bytes the owner wants broken out "separately".
 * Every entry is AUTO-PURGED (the daily retention sweep for the RETENTION_TARGETS
 * flagged `log` — derived, so a new purged log table lands here automatically),
 * so the Stockage card can legitimately caption this subtotal "purge automatique".
 * NOTE: the permanent `stock_movements` ledger is deliberately NOT here — it is
 * never purged (corrections are new rows), so it groups under Catalogue instead.
 */
export const LOG_TABLES: readonly string[] = [
  ...RETENTION_TARGETS.filter((t) => t.log).map((t) => t.table),
];

type GroupDef = {
  key: string;
  label: string;
  /** Exact table names (checked before prefixes). */
  tables?: readonly string[];
  /** relname prefixes (first matching group wins). */
  prefixes?: readonly string[];
};

/**
 * Coarse domain groups, ORDERED — first match wins, so `logs` (explicit names)
 * is checked before the prefix groups (e.g. `cart_events` → logs, not `cart…` →
 * orders). Anything unmatched falls into the synthetic "other" bucket.
 */
export const STORAGE_GROUPS: readonly GroupDef[] = [
  { key: "logs", label: "Journaux & télémétrie", tables: LOG_TABLES },
  {
    key: "catalog",
    label: "Catalogue & médias",
    prefixes: ["product", "categor", "brand", "attribute", "review", "media", "stock"],
  },
  {
    key: "orders",
    label: "Commandes",
    prefixes: [
      "order",
      "cart",
      "shipment",
      "promotion",
      "coupon",
      "delivery",
      "pickup",
      "document_",
      "currenc",
      "serial",
      "tax",
      "return",
      "payment",
    ],
  },
  {
    key: "customers",
    label: "Clients & comptes",
    prefixes: [
      "customer",
      "user",
      "session",
      "account",
      "verification",
      "two_factor",
      "business",
      "wishlist",
      "coin",
      "newsletter",
      "email_",
      "oauth",
      "role",
      "address",
    ],
  },
  {
    key: "cms",
    label: "Contenu & système",
    prefixes: [
      "cms",
      "banner",
      "nav_",
      "legal",
      "blog",
      "aid",
      "redirect",
      "faq",
      "trust_badge",
      "site_settings",
      "app_secret",
      "api_key",
      "page",
      "hero",
      "text_",
      "cta",
      "stats",
      "timeline",
      "showcase",
      "ai",
      "import",
    ],
  },
];

const OTHER_GROUP = { key: "other", label: "Autres" };

/** Resolve which group a table belongs to (first match wins; else "other"). */
export function groupForTable(relname: string): { key: string; label: string } {
  for (const g of STORAGE_GROUPS) {
    if (g.tables?.includes(relname)) return { key: g.key, label: g.label };
    if (g.prefixes?.some((p) => relname.startsWith(p))) return { key: g.key, label: g.label };
  }
  return OTHER_GROUP;
}

export type StorageSummary = {
  totalBytes: number;
  heapBytes: number;
  indexBytes: number;
  /** Derived: total − heap − index (TOAST + fork overhead), clamped ≥ 0. */
  toastBytes: number;
  tableCount: number;
  /** Exact subtotal for the log/telemetry tables (the owner's "logs separately"). */
  logs: { bytes: number; tableCount: number };
  /** Per-domain breakdown, sorted by bytes desc (includes "other" when non-empty). */
  byGroup: Array<{ key: string; label: string; bytes: number; tableCount: number }>;
};

/** Summarise a set of table sizes (pure). Ignores rows; sizes only. */
export function summarizeStorage(tables: TableSize[]): StorageSummary {
  let totalBytes = 0;
  let heapBytes = 0;
  let indexBytes = 0;
  let logsBytes = 0;
  let logsCount = 0;
  const groups = new Map<string, { key: string; label: string; bytes: number; tableCount: number }>();

  for (const t of tables) {
    totalBytes += t.totalBytes;
    heapBytes += t.heapBytes;
    indexBytes += t.indexBytes;
    if (LOG_TABLES.includes(t.relname)) {
      logsBytes += t.totalBytes;
      logsCount += 1;
    }
    const g = groupForTable(t.relname);
    const cur = groups.get(g.key) ?? { key: g.key, label: g.label, bytes: 0, tableCount: 0 };
    cur.bytes += t.totalBytes;
    cur.tableCount += 1;
    groups.set(g.key, cur);
  }

  const byGroup = Array.from(groups.values()).sort((a, b) => b.bytes - a.bytes);

  return {
    totalBytes,
    heapBytes,
    indexBytes,
    toastBytes: Math.max(0, totalBytes - heapBytes - indexBytes),
    tableCount: tables.length,
    logs: { bytes: logsBytes, tableCount: logsCount },
    byGroup,
  };
}
