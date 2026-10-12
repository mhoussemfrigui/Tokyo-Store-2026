"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Lock,
  type LucideIcon,
} from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { AdminCallout } from "@/components/admin/_components/filter-bar";
import {
  listDataJobsAction,
  startDataJobAction,
  type DataJobView,
} from "@/lib/actions/data-jobs";
// Client-safe path (schema submodule) — see segment-meta.ts note: the barrel
// pulls the server-only service into the client bundle.
import type { DataJobResult, DataSegment } from "@/modules/import/schema";
import { formatDate } from "@/lib/format/date";

import {
  CLEAN_DESCRIPTIONS,
  SEGMENT_LABELS,
  SEGMENT_META,
  SEGMENTS,
} from "./segment-meta";

/**
 * Shared client panel for the two segmented background-job flows:
 *
 *   • `operation="import"` — seed demo content (one segment, or "all").
 *   • `operation="clean"`  — delete content (each button opens a confirm step).
 *
 * Renders a segmented button grid (one big "Tout …" + the 8 segments), drives
 * `startDataJobAction`, then polls `listDataJobsAction(operation)` every 2.5 s
 * while any job is queued/running. Single-flight: while a job is active, every
 * button is disabled (one op at a time). Inline status banners — no toaster.
 *
 * `canStart` = the viewer may launch a job (the host page resolves it: import →
 * `system_jobs:manage`, clean → the `*` wildcard; startDataJobAction re-checks).
 * Without it the segment grid is replaced by the « Lecture seule » notice, so a
 * view-only operator never fires an action that would 404 — the live job list
 * (and its poll, gated on `system_jobs:view` like the page) still renders.
 */

const POLL_INTERVAL_MS = 2500;

const STATUS_META: Record<
  DataJobView["status"],
  { label: string; className: string }
> = {
  queued: { label: "En attente", className: "border-border bg-[#f6f2ed] text-[#5b5d62]" },
  running: { label: "En cours", className: "border-[#c9cdf5] bg-[#eef2ff] text-[#3730a3]" },
  completed: {
    label: "Terminé",
    className: "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]",
  },
  failed: { label: "Échec", className: "border-[#f6cdd6] bg-[#fdecef] text-[#d40530]" },
};

type Banner = { type: "ok" | "error"; message: string };

export function DataJobsPanel({
  operation,
  initialJobs,
  canStart,
  readOnlyNotice,
}: {
  operation: "import" | "clean";
  initialJobs: DataJobView[];
  /** Viewer may start a job — false hides the segment buttons. */
  canStart: boolean;
  /** Explains why the buttons are hidden (shown only when `canStart` is false). */
  readOnlyNotice: string;
}) {
  const [jobs, setJobs] = useState<DataJobView[]>(initialJobs);
  const [banner, setBanner] = useState<Banner | null>(null);
  /** Segment awaiting confirmation (clean only); null = no modal open. */
  const [confirming, setConfirming] = useState<DataSegment | null>(null);
  const [isStarting, startStart] = useTransition();
  const [, startRefresh] = useTransition();

  const isClean = operation === "clean";
  const allLabel = isClean ? "Tout nettoyer" : "Tout importer";

  const refreshJobs = useCallback(() => {
    startRefresh(async () => {
      try {
        setJobs(await listDataJobsAction(operation));
      } catch {
        // Transient network/session error — the next poll tick retries.
      }
    });
  }, [operation, startRefresh]);

  const hasActiveJob = jobs.some(
    (j) => j.status === "queued" || j.status === "running",
  );
  // Single-flight: one op at a time. Disable everything while a job runs or a
  // start request is in flight.
  const disabled = hasActiveJob || isStarting;

  // Poll while a job is active; the interval is cleared the moment every job is
  // terminal (effect cleanup) and on unmount.
  useEffect(() => {
    if (!hasActiveJob) return;
    const interval = setInterval(refreshJobs, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [hasActiveJob, refreshJobs]);

  const fire = useCallback(
    (segment: DataSegment) => {
      startStart(async () => {
        try {
          const res = await startDataJobAction(operation, segment);
          if (res.ok) {
            setBanner({
              type: "ok",
              message: isClean
                ? `Nettoyage « ${SEGMENT_LABELS[segment]} » lancé — il tourne en arrière-plan.`
                : `Import « ${SEGMENT_LABELS[segment]} » lancé — il tourne en arrière-plan.`,
            });
            refreshJobs();
          } else {
            setBanner({ type: "error", message: res.message });
          }
        } catch {
          setBanner({
            type: "error",
            message: isClean
              ? "Le nettoyage n'a pas pu être lancé — réessayez."
              : "L'import n'a pas pu être lancé — réessayez.",
          });
        }
      });
    },
    [operation, isClean, refreshJobs, startStart],
  );

  // Import fires immediately; clean opens a confirm step first.
  const onSegment = useCallback(
    (segment: DataSegment) => {
      if (disabled || !canStart) return;
      if (isClean) setConfirming(segment);
      else fire(segment);
    },
    [disabled, canStart, isClean, fire],
  );

  // Newest first — ISO timestamps compare lexicographically.
  const orderedJobs = [...jobs].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );

  return (
    <div className="space-y-5">
      {/* Status banner */}
      {banner && (
        <div
          role="status"
          className={`flex items-start gap-3 rounded-[16px] border p-3.5 text-sm ${
            banner.type === "ok"
              ? "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]"
              : "border-[#f6cdd6] bg-[#fdecef] text-[#d40530]"
          }`}
        >
          {banner.type === "ok" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <p className="font-medium">{banner.message}</p>
        </div>
      )}

      {/* Segmented button grid — only for a viewer allowed to start a job. */}
      {canStart ? (
        <div className="space-y-3">
          <SegmentButton
            big
            danger={isClean}
            disabled={disabled}
            icon={SEGMENT_META.all.icon}
            label={allLabel}
            onClick={() => onSegment("all")}
          />
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            {SEGMENTS.map((segment) => (
              <SegmentButton
                key={segment}
                danger={isClean}
                disabled={disabled}
                icon={SEGMENT_META[segment].icon}
                label={SEGMENT_LABELS[segment]}
                onClick={() => onSegment(segment)}
              />
            ))}
          </div>
          {disabled && (
            <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Opération en cours…
            </p>
          )}
        </div>
      ) : (
        <AdminCallout tone="warning" icon={Lock}>
          {readOnlyNotice}
        </AdminCallout>
      )}

      {/* Live job list */}
      <div>
        {orderedJobs.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-surface/30 p-6 text-center text-sm text-muted-foreground">
            {isClean
              ? "Aucun nettoyage pour le moment."
              : canStart
                ? "Aucun import pour le moment — choisissez un segment ci-dessus."
                : "Aucun import pour le moment."}
          </div>
        ) : (
          <ul className="space-y-3">
            {orderedJobs.map((job) => (
              <JobCard key={job.id} job={job} operation={operation} />
            ))}
          </ul>
        )}
      </div>

      {/* Clean confirm step */}
      {confirming && (
        <ConfirmDeleteModal
          title={
            confirming === "all"
              ? "Tout nettoyer ?"
              : `Nettoyer « ${SEGMENT_LABELS[confirming]} » ?`
          }
          description={CLEAN_DESCRIPTIONS[confirming]}
          confirmLabel={confirming === "all" ? "Tout nettoyer" : "Nettoyer"}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            // Mirror `fire` but inline so the modal can report a start failure;
            // success closes the modal (return null) and refreshes the list.
            try {
              const res = await startDataJobAction(operation, confirming);
              if (res.ok) {
                setBanner({
                  type: "ok",
                  message: `Nettoyage « ${SEGMENT_LABELS[confirming]} » lancé — il tourne en arrière-plan.`,
                });
                refreshJobs();
                return null;
              }
              return res.message;
            } catch {
              return "Le nettoyage n'a pas pu être lancé — réessayez.";
            }
          }}
        />
      )}
    </div>
  );
}

function SegmentButton({
  big = false,
  danger = false,
  disabled,
  icon: Icon,
  label,
  onClick,
}: {
  big?: boolean;
  danger?: boolean;
  disabled: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  // Big = filled primary (or rose for clean); small = bordered tile.
  const cls = big
    ? danger
      ? "h-11 w-full justify-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a]"
      : "h-11 w-full justify-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a]"
    : danger
      ? "h-16 w-full flex-col justify-center gap-1.5 rounded-[16px] border border-[#f6cdd6] bg-[#fdecef] px-3 text-xs font-bold text-[#d40530] transition hover:bg-[#fbdbe2]"
      : "h-16 w-full flex-col justify-center gap-1.5 rounded-[16px] border border-border bg-card px-3 text-xs font-bold text-foreground transition hover:border-primary/40 hover:bg-surface";

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center ${cls} disabled:cursor-not-allowed disabled:opacity-50`}
    >
      <Icon className={big ? "h-4 w-4" : "h-4 w-4"} aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
}

export function JobCard({
  job,
  operation,
}: {
  job: DataJobView;
  operation: "import" | "clean";
}) {
  const meta = STATUS_META[job.status];
  const failed = job.status === "failed";
  const running = job.status === "running";
  const result: DataJobResult | null = job.result;
  const pct =
    job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0;

  const title =
    job.title ??
    `${operation === "clean" ? "Nettoyage" : "Import"} — ${
      SEGMENT_LABELS[job.segment as DataSegment] ?? job.segment
    }`;

  const hasReport = Boolean(
    result &&
      (result.errors.length > 0 ||
        result.warnings.length > 0 ||
        result.unmappedPaths.length > 0),
  );

  return (
    <li
      className={`rounded-[22px] border p-4 ${
        failed ? "border-[#f6cdd6] bg-[#fdecef]" : "border-border bg-surface/30"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground" title={title}>
          {title}
        </p>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${meta.className}`}
        >
          {running && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />
          )}
          {meta.label}
        </span>
      </div>

      {/* Relative dates drift between SSR and hydration (the poll re-renders with
          client values) — hence the suppress. */}
      <p className="mt-1 text-[11px] text-muted-foreground" suppressHydrationWarning>
        Lancé le {formatDate(job.createdAt)} à {formatTime(job.createdAt)}
        {job.finishedAt
          ? ` · terminé ${formatRelative(job.finishedAt)}`
          : ` · ${formatRelative(job.createdAt)}`}
      </p>

      {running && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            <span>
              {job.processed} / {job.total}
            </span>
            <span>{pct} %</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border/60">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {failed && job.error && (
        <p className="mt-2 flex items-start gap-1.5 text-xs font-semibold text-[#d40530]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {job.error}
        </p>
      )}

      {result && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {operation === "clean" ? (
            <>
              <Chip tone={result.deleted > 0 ? "emerald" : "neutral"}>
                {result.deleted} supprimés
              </Chip>
              <Chip tone="neutral">{result.mediaDeleted} médias supprimés</Chip>
            </>
          ) : (
            <>
              <Chip tone={result.created > 0 ? "emerald" : "neutral"}>
                {result.created} créés
              </Chip>
              <Chip tone="neutral">{result.skipped} ignorés</Chip>
              <Chip tone={result.failed > 0 ? "rose" : "neutral"}>
                {result.failed} échecs
              </Chip>
              <Chip tone="neutral">{result.mediaCreated} images</Chip>
              <Chip tone={result.mediaFailed > 0 ? "rose" : "neutral"}>
                {result.mediaFailed} images échec
              </Chip>
              <Chip tone="neutral">{result.brandsCreated} marques</Chip>
            </>
          )}
        </div>
      )}

      {result && result.perSegment.length > 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {result.perSegment
            .map((s) =>
              operation === "clean"
                ? `${s.label} : ${s.deleted} supprimés`
                : `${s.label} : ${s.created} créés${s.skipped ? `, ${s.skipped} ignorés` : ""}`,
            )
            .join(" · ")}
        </p>
      )}

      {result && hasReport && (
        <details className="mt-3 rounded-xl border border-border bg-card p-3 text-xs">
          <summary className="cursor-pointer select-none font-semibold text-foreground">
            Rapport détaillé
          </summary>
          <div className="mt-2 space-y-3">
            {result.errors.length > 0 && (
              <ReportList title="Erreurs" items={result.errors} className="text-[#d40530]" />
            )}
            {result.warnings.length > 0 && (
              <ReportList
                title="Avertissements"
                items={result.warnings}
                className="text-[#b45309]"
              />
            )}
            {result.unmappedPaths.length > 0 && (
              <ReportList
                title="Chemins non mappés"
                items={result.unmappedPaths}
                className="text-muted-foreground"
              />
            )}
          </div>
        </details>
      )}
    </li>
  );
}

const CHIP_TONES = {
  neutral: "border-border bg-card text-muted-foreground",
  emerald: "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]",
  rose: "border-[#f6cdd6] bg-[#fdecef] text-[#d40530]",
} as const;

function Chip({
  tone,
  children,
}: {
  tone: keyof typeof CHIP_TONES;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${CHIP_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

function ReportList({
  title,
  items,
  className,
}: {
  title: string;
  items: string[];
  className: string;
}) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title} ({items.length})
      </p>
      <ul
        className={`mt-1 max-h-48 space-y-0.5 overflow-y-auto font-mono text-[11px] leading-relaxed ${className}`}
      >
        {items.map((item, i) => (
          <li key={`${i}-${item}`} className="break-all">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

const TIME = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : TIME.format(d);
}

/** « il y a 5 min » — same logic as the upload-import panel's local helper. */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "à l'instant";
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `il y a ${hr} h`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `il y a ${d} j`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `il y a ${mo} mois`;
  const yr = Math.floor(d / 365);
  return `il y a ${yr} an${yr > 1 ? "s" : ""}`;
}
