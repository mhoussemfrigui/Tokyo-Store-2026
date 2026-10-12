import type { Metadata } from "next";
import Link from "next/link";
import {
  ChevronLeft,
  Database,
  GitCommitVertical,
  Table as TableIcon,
  Boxes,
  Timer,
  HardDrive,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Gauge as GaugeIcon,
  Activity,
  Brush,
  PieChart,
  ScrollText,
  Image as ImageIcon,
} from "lucide-react";

import { AdminPageHeader } from "@/components/admin/page-header";
import { requirePermission } from "@/lib/auth/session";
import { db, POOL_CONFIG, getPoolStats } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { RETENTION_TARGETS, type RetentionTable } from "@/lib/retention/windows";
import { resolveRetentionWindow, retentionWindowText } from "@/lib/retention/resolve";
import { runLimited } from "@/lib/utils/run-limited";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { pingDbSamples } from "@/lib/telemetry/runtime-metrics";
import { summarizeStorage } from "@/lib/telemetry/storage";
import { jobRunLogService, type JobRunStatus } from "@/modules/jobs";
import journal from "@/lib/db/migrations/meta/_journal.json";

export const metadata: Metadata = { title: "Base de données" };
// Pool gauges, latency probe, applied migrations and table sizes are live; never cache.
export const dynamic = "force-dynamic";

// ──────────────────────────────────────────────────────────────── helpers

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1).replace(".", ",")} ${units[i]}`;
}

function formatNumber(n: number): string {
  return Number(n ?? 0).toLocaleString("fr-FR");
}

function formatDate(value: string | number | Date | null | undefined): string {
  if (value == null) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("fr-FR");
}

/** Millisecondes → "Xj Yh" / "Xh Ym" / "Xm" for the DB-server uptime. */
function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}j ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Coerce a raw pg value (often a string for bigint) to a finite number. */
function toNum(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** part / total as a French-formatted percentage string ("12,3 %"). */
function pct(part: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "0 %";
  return `${(Math.round((part / total) * 1000) / 10).toString().replace(".", ",")} %`;
}

// ──────────────────────────────────────────────────────────── presentation

function Card({
  title,
  icon: Icon,
  description,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-border bg-card p-5 sm:p-6">
      <header className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" strokeWidth={2} />
        <div>
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">{title}</h2>
          {description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      </header>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ConfigRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function Gauge({ label, value, max }: { label: string; value: number; max?: number }) {
  const pct = max && max > 0 ? Math.min(100, Math.round((value / max) * 100)) : null;
  return (
    <div className="rounded-[16px] border border-border bg-surface/40 p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-display text-xl font-bold tabular-nums text-foreground">
        {formatNumber(value)}
        {max != null && (
          <span className="ml-1 text-sm font-normal text-muted-foreground">/ {max}</span>
        )}
      </p>
      {pct != null && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border">
          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** Green/grey/red pill for present/absent style booleans. */
function StatusPill({
  ok,
  okLabel = "présent",
  koLabel = "absent",
}: {
  ok: boolean;
  okLabel?: string;
  koLabel?: string;
}) {
  return ok ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#eaf7ee] px-2.5 py-1 text-[11px] font-semibold text-[#15803d]">
      <CheckCircle2 className="h-3 w-3" /> {okLabel}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
      <XCircle className="h-3 w-3" /> {koLabel}
    </span>
  );
}

function Unavailable() {
  return (
    <p className="rounded-xl border border-dashed border-border bg-surface/40 px-3 py-4 text-center text-xs text-muted-foreground">
      Données indisponibles.
    </p>
  );
}

/** A single byte-sized stat tile for the Stockage card. */
function ByteTile({
  label,
  value,
  icon: Icon,
  muted = false,
}: {
  label: string;
  value: number;
  icon?: React.ComponentType<{ className?: string }>;
  muted?: boolean;
}) {
  return (
    <div className="rounded-[16px] border border-border bg-surface/40 p-3">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </div>
      <p className="mt-1 font-display text-xl font-bold tabular-nums text-foreground">
        {muted ? "indisponible" : formatBytes(value)}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── data loaders

type AppliedMigration = { hash: string; created_at: number };

async function loadApplied(): Promise<AppliedMigration[] | null> {
  try {
    const res = await db.execute(
      sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    );
    return (res.rows as Record<string, unknown>[]).map((r) => ({
      hash: String(r.hash ?? ""),
      created_at: toNum(r.created_at),
    }));
  } catch {
    return null;
  }
}

type TableRow = {
  relname: string;
  rows: number;
  bytes: number;
  heapBytes: number;
  indexBytes: number;
};

async function loadTables(): Promise<TableRow[] | null> {
  try {
    const res = await db.execute(sql`
      SELECT s.relname AS relname,
             s.n_live_tup::bigint AS rows,
             pg_total_relation_size(c.oid)::bigint AS bytes,
             pg_relation_size(c.oid)::bigint AS heap,
             pg_indexes_size(c.oid)::bigint AS indexes
        FROM pg_stat_user_tables s
        -- Join on the OID pg_stat_user_tables already exposes (s.relid), not the
        -- name — unambiguous across schemas (matches loadIndexHealth). Columns are
        -- table-qualified because BOTH pg_stat_user_tables and pg_class expose a
        -- relname column (an unqualified relname errors ambiguous -> whole card NULL).
        JOIN pg_class c ON c.oid = s.relid
       WHERE c.relnamespace = 'public'::regnamespace
       ORDER BY bytes DESC
    `);
    return (res.rows as Record<string, unknown>[]).map((r) => ({
      relname: String(r.relname ?? ""),
      rows: toNum(r.rows),
      bytes: toNum(r.bytes),
      heapBytes: toNum(r.heap),
      indexBytes: toNum(r.indexes),
    }));
  } catch {
    return null;
  }
}

async function loadDbSize(): Promise<number | null> {
  try {
    const res = await db.execute(
      sql`SELECT pg_database_size(current_database())::bigint AS bytes`,
    );
    const row = (res.rows as Record<string, unknown>[])[0];
    return row ? toNum(row.bytes) : null;
  } catch {
    return null;
  }
}

async function loadExtensions(): Promise<Set<string> | null> {
  try {
    const res = await db.execute(sql`SELECT extname FROM pg_extension`);
    return new Set(
      (res.rows as Record<string, unknown>[]).map((r) => String(r.extname ?? "")),
    );
  } catch {
    return null;
  }
}

async function loadHasFn(): Promise<boolean | null> {
  try {
    const res = await db.execute(
      sql`SELECT 1 FROM pg_proc WHERE proname = 'uuid_generate_v7' LIMIT 1`,
    );
    return (res.rows as unknown[]).length > 0;
  } catch {
    return null;
  }
}

async function loadHasFrUnaccent(): Promise<boolean | null> {
  try {
    const res = await db.execute(
      sql`SELECT 1 FROM pg_ts_config WHERE cfgname = 'fr_unaccent' LIMIT 1`,
    );
    return (res.rows as unknown[]).length > 0;
  } catch {
    return null;
  }
}

/** DB server start time + version → uptime + clock skew vs the app. */
type DbServerInfo = { startedAt: number | null; version: string; skewMs: number | null };
async function loadDbServerInfo(): Promise<DbServerInfo | null> {
  try {
    const res = await db.execute(sql`
      SELECT pg_postmaster_start_time() AS started,
             version() AS version,
             now() AS db_now
    `);
    const row = (res.rows as Record<string, unknown>[])[0];
    if (!row) return null;
    const started = row.started ? new Date(row.started as string).getTime() : null;
    const dbNow = row.db_now ? new Date(row.db_now as string).getTime() : null;
    return {
      startedAt: started,
      version: String(row.version ?? "").split(" on ")[0],
      skewMs: dbNow != null ? dbNow - Date.now() : null,
    };
  } catch {
    return null;
  }
}

type IndexHealth = {
  total: number;
  unused: Array<{ table: string; index: string; bytes: number; isConstraint: boolean }>;
};
async function loadIndexHealth(): Promise<IndexHealth | null> {
  try {
    const res = await db.execute(sql`
      SELECT s.relname AS table,
             s.indexrelname AS index,
             s.idx_scan::bigint AS scans,
             pg_relation_size(s.indexrelid)::bigint AS bytes,
             (i.indisunique OR i.indisprimary) AS is_constraint
        FROM pg_stat_user_indexes s
        JOIN pg_index i ON i.indexrelid = s.indexrelid
       WHERE s.schemaname = 'public'
       ORDER BY s.idx_scan ASC, bytes DESC
    `);
    const rows = res.rows as Record<string, unknown>[];
    const unused = rows
      .filter((r) => toNum(r.scans) === 0)
      .slice(0, 20)
      .map((r) => ({
        table: String(r.table ?? ""),
        index: String(r.index ?? ""),
        bytes: toNum(r.bytes),
        isConstraint: Boolean(r.is_constraint),
      }));
    return { total: rows.length, unused };
  } catch {
    return null;
  }
}

type BloatRow = {
  table: string;
  live: number;
  dead: number;
  deadPct: number;
  lastVacuum: string | null;
  lastAnalyze: string | null;
};
async function loadBloat(): Promise<BloatRow[] | null> {
  try {
    const res = await db.execute(sql`
      SELECT relname AS table,
             n_live_tup::bigint AS live,
             n_dead_tup::bigint AS dead,
             GREATEST(last_vacuum, last_autovacuum) AS last_vacuum,
             GREATEST(last_analyze, last_autoanalyze) AS last_analyze
        FROM pg_stat_user_tables
       WHERE n_dead_tup > 0
       ORDER BY n_dead_tup DESC
       LIMIT 15
    `);
    return (res.rows as Record<string, unknown>[]).map((r) => {
      const live = toNum(r.live);
      const dead = toNum(r.dead);
      return {
        table: String(r.table ?? ""),
        live,
        dead,
        deadPct: live + dead > 0 ? Math.round((dead / (live + dead)) * 1000) / 10 : 0,
        lastVacuum: (r.last_vacuum as string | null) ?? null,
        lastAnalyze: (r.last_analyze as string | null) ?? null,
      };
    });
  } catch {
    return null;
  }
}

type SlowQuery = {
  query: string;
  calls: number;
  meanMs: number;
  totalMs: number;
  rows: number;
};
async function loadSlowQueries(hasExtension: boolean): Promise<SlowQuery[] | null | "absent"> {
  if (!hasExtension) return "absent";
  try {
    const res = await db.execute(sql`
      SELECT query,
             calls::bigint AS calls,
             mean_exec_time AS mean_ms,
             total_exec_time AS total_ms,
             rows::bigint AS rows
        FROM pg_stat_statements
       WHERE query NOT ILIKE '%pg_stat_statements%'
         -- Floor on calls so a single one-off statement (a migration DDL, a
         -- manual psql query, a cold first-hit) can't dominate the "slowest"
         -- list by mean time; we want recurrently-slow queries.
         AND calls >= 5
       ORDER BY mean_exec_time DESC
       LIMIT 15
    `);
    return (res.rows as Record<string, unknown>[]).map((r) => ({
      query: String(r.query ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
      calls: toNum(r.calls),
      meanMs: Math.round(toNum(r.mean_ms) * 100) / 100,
      totalMs: Math.round(toNum(r.total_ms)),
      rows: toNum(r.rows),
    }));
  } catch {
    // Extension present but not query-able here (e.g. role lacks access) → null.
    return null;
  }
}

async function loadOldest(table: RetentionTable): Promise<
  string | number | Date | null | "indispo"
> {
  try {
    const query =
      table === "ephemeral_carts"
        ? sql`SELECT min(created_at) AS oldest FROM carts WHERE token LIKE 'qb-%'`
        : table === "guest_carts"
          ? // Same population + activity column as purgeStaleGuestCarts (the
            // cart row's last activity; line activity can only make it younger).
            sql`SELECT min(updated_at) AS oldest FROM carts
                 WHERE user_id IS NULL AND (token IS NULL OR token NOT LIKE 'qb-%')`
          : table === "guest_wishlists"
            ? sql`SELECT min(GREATEST(created_at, updated_at)) AS oldest FROM wishlists
                   WHERE user_id IS NULL AND token IS NOT NULL`
            : table === "cart_events"
              ? sql`SELECT min(occurred_at) AS oldest FROM cart_events`
              : table === "instance_heartbeats"
                ? // the RETENTION_WINDOWS key differs from the actual table name, and
                  // the purge keys off started_at (last_seen_at < cutoff AND started_at
                  // < cutoff) — so report the oldest started_at.
                  sql`SELECT min(started_at) AS oldest FROM app_instance_heartbeats`
                : sql`SELECT min(created_at) AS oldest FROM ${sql.raw(`"${table}"`)}`;
    const res = await db.execute(query);
    const row = (res.rows as Record<string, unknown>[])[0];
    return (row?.oldest as string | number | Date | null) ?? null;
  } catch {
    return "indispo";
  }
}

type MediaStorage = { totalBytes: number; count: number; byKind: { kind: string; bytes: number; count: number }[] };
/**
 * Object storage (S3) used by uploaded media — the TRUE bucket footprint,
 * summing the primary `size_bytes` PLUS each derived variant (webp/avif/kept
 * original), since each is a separate physical S3 object (see media/storage.ts
 * variantStorageKeys). Otherwise the figure undercounts 2-4× when WebP+AVIF+
 * keep-original are enabled.
 */
async function loadMediaStorage(): Promise<MediaStorage | null> {
  try {
    const res = await db.execute(sql`
      SELECT kind,
             count(*)::int AS n,
             (COALESCE(sum(size_bytes), 0)
              + COALESCE(sum(webp_size_bytes), 0)
              + COALESCE(sum(avif_size_bytes), 0)
              -- The kept original is a DISTINCT object only when its URL differs
              -- from the primary; GIFs / no-variant fallbacks alias it to the
              -- primary object, so counting original_size_bytes there double-counts.
              + COALESCE(sum(CASE WHEN original_url IS DISTINCT FROM url THEN original_size_bytes ELSE 0 END), 0))::bigint AS bytes
        FROM media
       WHERE deleted_at IS NULL
       GROUP BY kind
       ORDER BY bytes DESC
    `);
    const byKind = (res.rows as Record<string, unknown>[]).map((r) => ({
      kind: String(r.kind ?? ""),
      bytes: toNum(r.bytes),
      count: toNum(r.n),
    }));
    return {
      totalBytes: byKind.reduce((s, k) => s + k.bytes, 0),
      count: byKind.reduce((s, k) => s + k.count, 0),
      byKind,
    };
  } catch {
    return null;
  }
}

/** Count rows already past expiry for an auth table purged by expires_at. */
async function loadExpiredCount(table: "sessions" | "verifications"): Promise<number | "indispo"> {
  try {
    const res = await db.execute(
      sql`SELECT count(*)::bigint AS n FROM ${sql.raw(`"${table}"`)} WHERE expires_at < now()`,
    );
    const row = (res.rows as Record<string, unknown>[])[0];
    return row ? toNum(row.n) : 0;
  } catch {
    return "indispo";
  }
}

// ────────────────────────────────────────────────────────────────── page

const STATUS_FR: Record<JobRunStatus, string> = { ok: "OK", failed: "échec", skipped: "ignorée" };

export default async function DatabaseDiagnosticsPage() {
  await requirePermission("system_database", "view");
  const definedMigrations = (journal.entries ?? []).slice().sort((a, b) => a.idx - b.idx);

  // Bounded fan-out: three sequential waves of ≤6 typed Promise.all each, so a
  // single diagnostics render never demands more connections than the pool holds
  // (12) — keeping it off the hot pool that serves live storefront traffic. Each
  // loader is sub-10ms, so the three waves still render in a few ms total.
  const [applied, tables, dbSize, extensions, hasUuidV7, hasFrUnaccent] = await Promise.all([
    loadApplied(),
    loadTables(),
    loadDbSize(),
    loadExtensions(),
    loadHasFn(),
    loadHasFrUnaccent(),
  ]);
  const [latency, serverInfo, indexHealth, bloat, settingsMap, lastRunMap] = await Promise.all([
    pingDbSamples(5).catch(() => null),
    loadDbServerInfo(),
    loadIndexHealth(),
    loadBloat(),
    // null (not {}) on failure: the configurable retention windows then show
    // « indisponible » instead of the shorter defaults the purge would NOT use.
    getSettingsMap().catch(() => null),
    jobRunLogService.lastRunByJob(["retention_purge"]).catch(() => null),
  ]);
  const [expiredSessions, expiredVerifications, mediaStorage] = await Promise.all([
    loadExpiredCount("sessions"),
    loadExpiredCount("verifications"),
    loadMediaStorage(),
  ]);

  // pg_stat_statements is read AFTER extensions resolves (gated on presence).
  const slowQueries = await loadSlowQueries(Boolean(extensions?.has("pg_stat_statements")));

  // getPoolStats() is in-process and synchronous; still guard against surprises.
  let pool: ReturnType<typeof getPoolStats> | null = null;
  try {
    pool = getPoolStats();
  } catch {
    pool = null;
  }

  // Storage breakdown (pure) from the per-table sizes already loaded — logs are
  // broken out exactly; object/media storage (S3) is summed separately. Map the
  // page's TableRow ({bytes}) to the helper's TableSize ({totalBytes}).
  const storage = tables
    ? summarizeStorage(
        tables.map((t) => ({
          relname: t.relname,
          totalBytes: t.bytes,
          heapBytes: t.heapBytes,
          indexBytes: t.indexBytes,
          rows: t.rows,
        })),
      )
    : null;

  const definedCount = definedMigrations.length;
  const appliedCount = applied?.length ?? null;
  const migrationMismatch = appliedCount != null && definedCount !== appliedCount;
  // Direction matters: code-ahead (defined > applied) ⇒ pending migrations to run;
  // DB-ahead (applied > defined) ⇒ a rollback / wrong-image deploy (surplus rows
  // the code doesn't know about) — a different, more alarming anomaly.
  const dbAhead = appliedCount != null && appliedCount > definedCount;
  const surplusApplied = dbAhead && applied ? applied.slice(definedCount) : [];
  const latestApplied =
    applied && applied.length > 0 ? applied[applied.length - 1].created_at : null;

  // One row per RETENTION_TARGETS entry (the purge's own inventory, so the card
  // can't omit a purged table). Windows are resolved exactly like
  // runRetentionPurge does: search_log + audit_log LIVE from settings, the rest
  // static; an unreadable settings map shows « indisponible » for the two live
  // ones — the purge skips them in that case too.
  const retentionRows: Array<{
    key: string;
    table: string;
    window: string;
    live: boolean;
    label: string;
    rowKey: RetentionTable | "sessions" | "verifications";
  }> = RETENTION_TARGETS.map((t) => {
    const w = resolveRetentionWindow(t, settingsMap);
    return {
      key: t.key,
      table: t.table,
      window: retentionWindowText(w),
      live: w.kind === "days" && w.live,
      label: t.label,
      rowKey: t.id,
    };
  });

  // Same bounded fan-out (≤6 concurrent) as the main loaders above — this is a
  // second burst (one min() per retention target) and must not out-demand the
  // pool either. Homogeneous return type, so runLimited<T> keeps it typed.
  const oldestByTable = await runLimited<string | number | Date | null | "indispo">(
    retentionRows.map((r) => () => {
      if (r.rowKey === "sessions" || r.rowKey === "verifications") return Promise.resolve(null);
      return loadOldest(r.rowKey);
    }),
    6,
  );

  const lastRun = lastRunMap?.get("retention_purge") ?? null;

  // Mirror of the four CREATE EXTENSION statements in 0000_squash_baseline.sql
  // + pgvector (`CREATE EXTENSION vector`, 0112_product_embedding.sql — required
  // by the semantic-search migrations 0111+; a Postgres image without it fails
  // those migrations).
  const expectedExtensions = ["pgcrypto", "pg_trgm", "btree_gin", "unaccent", "vector"];

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/system"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour au Système
        </Link>
        <div className="mt-2">
          <AdminPageHeader
            title="Base de données"
            description="Connectivité, pool, migrations, tables, santé des index, maintenance et rétention."
          />
        </div>
      </div>

      {/* Display-only page: a failed settings read degrades (the live retention
          windows show « indisponible ») but says so up front. */}
      {settingsMap === null && (
        <p
          role="alert"
          className="rounded-2xl border border-[#f3e3bd] bg-[#fff4e0] px-4 py-3 text-xs text-[#b45309] dark:text-amber-300"
        >
          Réglages indisponibles — rechargez la page. Les fenêtres de rétention
          configurables ne peuvent pas être affichées.
        </p>
      )}

      {/* ── Connectivité & latence ─────────────────────────────────── */}
      <Card
        title="Connectivité & latence"
        icon={GaugeIcon}
        description="Aller-retour d'un SELECT 1 (vérification en direct) et informations du serveur Postgres."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            {latency ? (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <StatusPill ok={latency.ok} okLabel="en ligne" koLabel="erreur" />
                  <span className="text-xs text-muted-foreground">
                    {latency.samples} sonde(s)
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <Gauge label="Min (ms)" value={latency.minMs ?? 0} />
                  <Gauge label="Médiane (ms)" value={latency.medianMs ?? 0} />
                  <Gauge label="Max (ms)" value={latency.maxMs ?? 0} />
                </div>
              </>
            ) : (
              <Unavailable />
            )}
          </div>
          <div className="divide-y divide-border">
            {serverInfo ? (
              <>
                <ConfigRow
                  label="Disponibilité du serveur"
                  value={
                    serverInfo.startedAt != null
                      ? // Async Server Component: renders once per request, so reading the clock is intended.
                        // eslint-disable-next-line react-hooks/purity
                        humanDuration(Date.now() - serverInfo.startedAt)
                      : "—"
                  }
                />
                <ConfigRow label="Démarré le" value={formatDate(serverInfo.startedAt)} />
                <ConfigRow
                  label="Décalage d'horloge"
                  value={serverInfo.skewMs != null ? `${serverInfo.skewMs} ms` : "—"}
                />
                <ConfigRow
                  label="Version"
                  value={<span className="font-mono text-xs">{serverInfo.version || "—"}</span>}
                />
              </>
            ) : (
              <Unavailable />
            )}
          </div>
        </div>
      </Card>

      {/* ── Pool de connexions ─────────────────────────────────────── */}
      <Card
        title="Pool de connexions"
        icon={Database}
        description="Configuration du pool (env-réglable) et jauges de l'instance courante."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="divide-y divide-border">
            <ConfigRow label="Connexions max." value={formatNumber(POOL_CONFIG.max)} />
            <ConfigRow
              label="Délai d'inactivité"
              value={`${formatNumber(POOL_CONFIG.idleTimeoutMs)} ms`}
            />
            <ConfigRow
              label="Délai de connexion"
              value={`${formatNumber(POOL_CONFIG.connectionTimeoutMs)} ms`}
            />
            <ConfigRow
              label="Délai d'instruction (statement)"
              value={`${formatNumber(POOL_CONFIG.statementTimeoutMs)} ms`}
            />
            <ConfigRow
              label="Keep-alive TCP"
              value={<StatusPill ok={POOL_CONFIG.keepAlive} okLabel="activé" koLabel="désactivé" />}
            />
            <ConfigRow
              label="Nom d'application"
              value={<span className="font-mono text-xs">{POOL_CONFIG.applicationName}</span>}
            />
          </div>
          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Instance courante (process-local)
            </p>
            {pool ? (
              <div className="grid grid-cols-2 gap-3">
                <Gauge label="Total" value={pool.total} max={pool.max} />
                <Gauge label="Inactives" value={pool.idle} />
                <Gauge label="En attente" value={pool.waiting} />
                <Gauge label="Max" value={pool.max} />
              </div>
            ) : (
              <Unavailable />
            )}
          </div>
        </div>
      </Card>

      {/* ── Migrations ─────────────────────────────────────────────── */}
      <Card
        title="Migrations"
        icon={GitCommitVertical}
        description="État par migration : définie dans le code (journal) versus appliquée en base (jointure par position)."
      >
        {migrationMismatch && (
          <div
            className={`mb-4 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium ${
              dbAhead
                ? "border-destructive/40 bg-destructive/5 text-destructive"
                : "border-[#f3e3bd] bg-[#fff4e0] text-[#b45309]"
            }`}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            {dbAhead
              ? `La base est en avance sur le code : ${appliedCount} appliquée(s) pour ${definedCount} définie(s) — déploiement ou rollback incohérent. Les migrations en surplus (inconnues du code) sont listées ci-dessous.`
              : `Écart : ${definedCount} définie(s), ${appliedCount} appliquée(s). Les migrations « en attente » ci-dessous ne sont pas encore en base.`}
          </div>
        )}
        <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <span className="text-muted-foreground">
            Définies : <span className="font-medium tabular-nums text-foreground">{definedCount}</span>
          </span>
          <span className="text-muted-foreground">
            Appliquées :{" "}
            <span className="font-medium tabular-nums text-foreground">{appliedCount ?? "—"}</span>
          </span>
          <span className="text-muted-foreground">
            Dernière : <span className="font-medium text-foreground">{formatDate(latestApplied)}</span>
          </span>
        </div>
        {applied == null ? (
          <Unavailable />
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface/60 backdrop-blur">
                <tr className="border-b border-border text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                  <th className="px-3 py-2 font-bold">#</th>
                  <th className="px-3 py-2 font-bold">Migration</th>
                  <th className="px-3 py-2 font-bold">État</th>
                  <th className="px-3 py-2 font-bold">Hash appliqué</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {definedMigrations.map((m, i) => {
                  // Drizzle applies in journal order; __drizzle_migrations is
                  // created_at-sorted → match by ordinal position.
                  const appliedRow = applied[i] ?? null;
                  const isApplied = appliedRow != null;
                  return (
                    <tr key={m.idx} className="transition hover:bg-[#fffbfb]">
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{m.idx}</td>
                      <td className="px-3 py-2 font-mono text-xs text-foreground">{m.tag}</td>
                      <td className="px-3 py-2">
                        {isApplied ? (
                          <StatusPill ok okLabel="appliquée" />
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[#fff4e0] px-2.5 py-1 text-[11px] font-semibold text-[#b45309]">
                            <AlertTriangle className="h-3 w-3" /> en attente
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                        {appliedRow ? `${appliedRow.hash.slice(0, 12)}…` : "—"}
                      </td>
                    </tr>
                  );
                })}
                {/* Surplus applied migrations the code journal doesn't define
                    (DB-ahead anomaly) — surfaced so they aren't silently hidden. */}
                {surplusApplied.map((row, j) => (
                  <tr key={`surplus-${j}`} className="bg-destructive/5">
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {definedCount + j}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-destructive">
                      (inconnue du code)
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2.5 py-1 text-[11px] font-semibold text-destructive">
                        <AlertTriangle className="h-3 w-3" /> en surplus
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                      {`${row.hash.slice(0, 12)}…`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Stockage ───────────────────────────────────────────────── */}
      <Card
        title="Stockage"
        icon={PieChart}
        description="Répartition de l'espace utilisé : données vs index, journaux comptés séparément, et stockage objet des médias (S3)."
      >
        {storage == null ? (
          <Unavailable />
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <ByteTile label="Tables (public)" value={storage.totalBytes} icon={Database} />
              <ByteTile label="Données (heap)" value={storage.heapBytes} />
              <ByteTile label="Index" value={storage.indexBytes} />
              <ByteTile
                label="Médias (objet S3)"
                value={mediaStorage?.totalBytes ?? 0}
                icon={ImageIcon}
                muted={mediaStorage == null}
              />
            </div>

            {/* Logs subtotal — broken out as requested. */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface/40 px-4 py-3">
              <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                <ScrollText className="h-4 w-4 text-muted-foreground" />
                Journaux &amp; télémétrie ({storage.logs.tableCount} tables)
              </span>
              <span className="text-sm">
                <span className="font-semibold tabular-nums text-foreground">
                  {formatBytes(storage.logs.bytes)}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {pct(storage.logs.bytes, storage.totalBytes)} de la base · purge automatique
                </span>
              </span>
            </div>

            {/* Per-domain breakdown bars. */}
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Répartition par domaine
              </p>
              <div className="space-y-2">
                {storage.byGroup.map((g) => (
                  <div key={g.key}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-foreground">
                        {g.label}{" "}
                        <span className="text-muted-foreground">({g.tableCount})</span>
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatBytes(g.bytes)} · {pct(g.bytes, storage.totalBytes)}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-border">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{
                          width: `${storage.totalBytes > 0 ? Math.min(100, (g.bytes / storage.totalBytes) * 100) : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Object storage by kind (images separated). */}
            {mediaStorage && mediaStorage.byKind.length > 0 && (
              <div>
                <p className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>Stockage objet par type ({mediaStorage.count} médias)</span>
                  <Link href="/admin/system/resources" className="normal-case text-primary hover:underline">
                    Ressources →
                  </Link>
                </p>
                <div className="flex flex-wrap gap-2">
                  {mediaStorage.byKind.map((k) => (
                    <span
                      key={k.kind}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/40 px-3 py-1 text-xs"
                    >
                      <span className="font-medium text-foreground">{k.kind}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatBytes(k.bytes)} ({formatNumber(k.count)})
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ── Tables & tailles ───────────────────────────────────────── */}
      <Card
        title="Tables & tailles"
        icon={TableIcon}
        description="Tables du schéma public, triées par taille totale (estimation des lignes)."
      >
        <div className="mb-4 flex items-center gap-2 text-sm">
          <HardDrive className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">Taille totale de la base :</span>
          <span className="font-semibold tabular-nums text-foreground">
            {dbSize != null ? formatBytes(dbSize) : "indisponible"}
          </span>
        </div>
        {tables == null ? (
          <Unavailable />
        ) : tables.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">Aucune table utilisateur.</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                  <th className="py-2 pr-4 font-bold">Table</th>
                  <th className="py-2 pr-4 text-right font-bold">Lignes (est.)</th>
                  <th className="py-2 text-right font-bold">Taille</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tables.map((t) => (
                  <tr key={t.relname} className="transition hover:bg-[#fffbfb]">
                    <td className="py-2 pr-4 font-mono text-xs text-foreground">{t.relname}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                      {formatNumber(t.rows)}
                    </td>
                    <td className="py-2 text-right tabular-nums font-medium text-foreground">
                      {formatBytes(t.bytes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Santé des index ────────────────────────────────────────── */}
      <Card
        title="Santé des index"
        icon={Activity}
        description="Index jamais parcourus depuis la dernière remise à zéro des statistiques. Un index de CONTRAINTE (unique/clé primaire) ne doit jamais être supprimé même s'il n'est pas lu."
      >
        {indexHealth == null ? (
          <Unavailable />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span className="text-muted-foreground">
                Index totaux :{" "}
                <span className="font-medium tabular-nums text-foreground">{indexHealth.total}</span>
              </span>
              <span className="text-muted-foreground">
                Jamais parcourus :{" "}
                <span className="font-medium tabular-nums text-foreground">
                  {indexHealth.unused.length}
                </span>
              </span>
            </div>
            {indexHealth.unused.length === 0 ? (
              <p className="rounded-xl border border-[#cdebd6] bg-[#eaf7ee] px-3 py-3 text-xs text-[#15803d]">
                Tous les index ont été utilisés depuis la dernière remise à zéro des statistiques.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                      <th className="py-2 pr-4 font-bold">Index</th>
                      <th className="py-2 pr-4 font-bold">Table</th>
                      <th className="py-2 pr-4 text-right font-bold">Taille</th>
                      <th className="py-2 font-bold">Note</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {indexHealth.unused.map((ix) => (
                      <tr key={ix.index} className="transition hover:bg-[#fffbfb]">
                        <td className="py-2 pr-4 font-mono text-[11px] text-foreground">{ix.index}</td>
                        <td className="py-2 pr-4 font-mono text-[11px] text-muted-foreground">
                          {ix.table}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">{formatBytes(ix.bytes)}</td>
                        <td className="py-2 text-[11px]">
                          {ix.isConstraint ? (
                            <span className="text-[#b45309]">contrainte — conserver</span>
                          ) : (
                            <span className="text-muted-foreground">candidat à revoir</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-[11px] text-muted-foreground">
              « idx_scan = 0 » signifie « non utilisé depuis le dernier reset des stats » — pas
              forcément inutile. À recouper avec les requêtes lentes avant toute décision.
            </p>
          </>
        )}
      </Card>

      {/* ── Maintenance (vacuum / bloat) ───────────────────────────── */}
      <Card
        title="Maintenance (vacuum / bloat)"
        icon={Brush}
        description="Lignes mortes en attente de VACUUM et date du dernier passage (autovacuum)."
      >
        {bloat == null ? (
          <Unavailable />
        ) : bloat.length === 0 ? (
          <p className="rounded-xl border border-[#cdebd6] bg-[#eaf7ee] px-3 py-3 text-xs text-[#15803d]">
            Aucune ligne morte significative — l&apos;autovacuum suit le rythme.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                  <th className="py-2 pr-4 font-bold">Table</th>
                  <th className="py-2 pr-4 text-right font-bold">Lignes mortes</th>
                  <th className="py-2 pr-4 text-right font-bold">% mortes</th>
                  <th className="py-2 pr-4 font-bold">Dernier vacuum</th>
                  <th className="py-2 font-bold">Dernier analyze</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {bloat.map((b) => (
                  <tr key={b.table} className="transition hover:bg-[#fffbfb]">
                    <td className="py-2 pr-4 font-mono text-xs text-foreground">{b.table}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                      {formatNumber(b.dead)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      <span className={b.deadPct >= 20 ? "font-semibold text-[#b45309]" : ""}>
                        {b.deadPct} %
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-[11px] text-muted-foreground">
                      {formatDate(b.lastVacuum)}
                    </td>
                    <td className="py-2 text-[11px] text-muted-foreground">
                      {formatDate(b.lastAnalyze)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Requêtes lentes ────────────────────────────────────────── */}
      <Card
        title="Requêtes lentes"
        icon={Timer}
        description="Top 15 par temps moyen d'exécution (extension pg_stat_statements, requêtes paramétrées sans données personnelles)."
      >
        {slowQueries === "absent" ? (
          <p className="rounded-xl border border-dashed border-border bg-surface/40 px-3 py-4 text-center text-xs text-muted-foreground">
            Extension <span className="font-mono">pg_stat_statements</span> absente — activez-la
            côté serveur (préchargée sur Coolify) pour suivre les requêtes lentes.
          </p>
        ) : slowQueries == null ? (
          <Unavailable />
        ) : slowQueries.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            Aucune statistique de requête pour le moment.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                  <th className="py-2 pr-4 font-bold">Requête</th>
                  <th className="py-2 pr-4 text-right font-bold">Appels</th>
                  <th className="py-2 pr-4 text-right font-bold">Moy. (ms)</th>
                  <th className="py-2 text-right font-bold">Total (ms)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {slowQueries.map((q, i) => (
                  <tr key={i} className="transition hover:bg-[#fffbfb]">
                    <td className="max-w-md py-2 pr-4 font-mono text-[11px] text-foreground">
                      <span className="line-clamp-2">{q.query}</span>
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                      {formatNumber(q.calls)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums font-medium">{q.meanMs}</td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">
                      {formatNumber(q.totalMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Extensions ─────────────────────────────────────────────── */}
      <Card
        title="Extensions & objets"
        icon={Boxes}
        description="Extensions Postgres attendues et objets de recherche (UUID v7, config FTS française)."
      >
        {extensions == null ? (
          <Unavailable />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {expectedExtensions.map((ext) => (
              <div
                key={ext}
                className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2"
              >
                <span className="font-mono text-xs text-foreground">{ext}</span>
                <StatusPill ok={extensions.has(ext)} />
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2">
              <span className="font-mono text-xs text-foreground">uuid_generate_v7()</span>
              {hasUuidV7 == null ? (
                <StatusPill ok={false} okLabel="présent" koLabel="indispo." />
              ) : (
                <StatusPill ok={hasUuidV7} />
              )}
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2">
              <span className="font-mono text-xs text-foreground">fr_unaccent (config FTS)</span>
              {hasFrUnaccent == null ? (
                <StatusPill ok={false} okLabel="présent" koLabel="indispo." />
              ) : (
                <StatusPill ok={hasFrUnaccent} />
              )}
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2">
              <span className="font-mono text-xs text-foreground">pg_stat_statements</span>
              <StatusPill
                ok={Boolean(extensions.has("pg_stat_statements"))}
                okLabel="présent"
                koLabel="absent"
              />
            </div>
          </div>
        )}
      </Card>

      {/* ── Rétention ──────────────────────────────────────────────── */}
      <Card
        title="Rétention des données"
        icon={Timer}
        description={`Fenêtres de purge des ${retentionRows.length} cibles non bornées / porteuses de données personnelles (cron de rétention). Les fenêtres « live » sont résolues depuis les réglages (Recherche, Journal d'audit), exactement comme le cron de purge.`}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
                <th className="py-2 pr-4 font-bold">Table</th>
                <th className="py-2 pr-4 font-bold">Fenêtre</th>
                <th className="py-2 font-bold">Plus ancienne / en attente</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {retentionRows.map((r, i) => {
                const oldest = oldestByTable[i];
                const isAuth = r.rowKey === "sessions" || r.rowKey === "verifications";
                const expiredCount = r.rowKey === "sessions" ? expiredSessions : r.rowKey === "verifications" ? expiredVerifications : null;
                return (
                  <tr key={r.key} className="transition hover:bg-[#fffbfb]">
                    <td className="py-2 pr-4">
                      <span className="font-mono text-xs text-foreground">{r.table}</span>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{r.label}</p>
                    </td>
                    <td className="py-2 pr-4 tabular-nums font-medium text-foreground">
                      {r.window}
                      {r.live && (
                        <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-primary">
                          live
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-[11px] text-muted-foreground">
                      {isAuth
                        ? expiredCount === "indispo"
                          ? "indisponible"
                          : `${formatNumber(expiredCount as number)} expirée(s)`
                        : oldest === "indispo"
                          ? "indisponible"
                          : oldest == null
                            ? "aucune ligne"
                            : formatDate(oldest)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            Mécanisme : cron <span className="font-mono">/api/cron/retention</span> via le centre
            des tâches planifiées.{" "}
            <Link href="/admin/system/jobs" className="text-primary hover:underline">
              Tâches planifiées →
            </Link>
          </span>
          {lastRun && (
            <span>
              Dernier passage : {formatDate(lastRun.created_at)} ·{" "}
              {STATUS_FR[lastRun.status as JobRunStatus] ?? lastRun.status}
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}
