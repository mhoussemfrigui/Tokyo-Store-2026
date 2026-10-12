"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  FileSpreadsheet,
  FileUp,
  Loader2,
} from "lucide-react";

import {
  listImportJobsAction,
  startProductImportAction,
  type ImportJobView,
} from "@/lib/actions/import";
// Type-only import : l'index du module ré-exporte aussi le service server-only,
// mais un `import type` est effacé à la compilation — rien ne fuit côté client.
import type { ImportJobResult } from "@/modules/import";
import { formatDate } from "@/lib/format/date";

/**
 * Panel client de l'import catalogue :
 *
 *   1. carte upload (fichier .xml/.csv → `startProductImportAction`)
 *   2. notices + téléchargement des fichiers d'exemple
 *   3. historique des jobs avec progression — poll toutes les 2,5 s tant
 *      qu'un job est en file d'attente ou en cours.
 */

const POLL_INTERVAL_MS = 2500;

const NOTICES = [
  "L'import tourne en arrière-plan — vous pouvez quitter cette page",
  "Les images sont téléchargées dans la médiathèque (WebP/AVIF générés automatiquement)",
  "Les catégories du flux sont mappées sur l'arborescence du site ; les chemins non reconnus sont listés dans le rapport",
  "Ré-importable sans doublons : un produit existant (même slug) est ignoré",
  "Formats : XML Google Merchant (tokyostore.tn) ou CSV — téléchargez un exemple ci-dessous",
];

const STATUS_META: Record<ImportJobView["status"], { label: string; className: string }> = {
  queued: { label: "En attente", className: "border-border bg-surface text-muted-foreground" },
  running: { label: "En cours", className: "border-[#c9cdf5] bg-[#eef2ff] text-[#3730a3]" },
  completed: {
    label: "Terminé",
    className: "border-[#cdebd6] bg-[#eaf7ee] text-[#15803d]",
  },
  failed: { label: "Échec", className: "border-[#f6cdd6] bg-[#fdecef] text-[#d40530]" },
};

export function ImportPanel({
  initialJobs,
  hideHistory = false,
  onJobStarted,
}: {
  initialJobs: ImportJobView[];
  /** Embedded in the merged Import-data tab: the parent owns the unified job
   *  list, so the panel hides its own « Historique » section + poll. */
  hideHistory?: boolean;
  /** Called after a successful upload so the embedding parent can refresh its
   *  shared job list (the panel no longer polls when `hideHistory`). */
  onJobStarted?: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ImportJobView[]>(initialJobs);
  const [status, setStatus] = useState<{ type: "ok" | "error"; message: string } | null>(null);
  const [isSubmitting, startSubmit] = useTransition();
  const [isRefreshing, startRefresh] = useTransition();

  const refreshJobs = useCallback(() => {
    startRefresh(async () => {
      try {
        setJobs(await listImportJobsAction());
      } catch {
        // Erreur réseau/session passagère — le prochain tick du poll réessaie.
      }
    });
  }, [startRefresh]);

  const hasActiveJob = jobs.some((j) => j.status === "queued" || j.status === "running");

  // Poll tant qu'un job est actif ; l'intervalle est retiré dès que tous les
  // jobs sont terminaux (cleanup de l'effet) et au démontage du composant.
  useEffect(() => {
    if (!hasActiveJob || hideHistory) return;
    const interval = setInterval(refreshJobs, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [hasActiveJob, hideHistory, refreshJobs]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    startSubmit(async () => {
      try {
        const res = await startProductImportAction(formData);
        if (res.ok) {
          setStatus({ type: "ok", message: "Import lancé — il tourne en arrière-plan." });
          form.reset();
          setFileName(null);
          refreshJobs();
          onJobStarted?.();
        } else {
          setStatus({ type: "error", message: res.message });
        }
      } catch {
        setStatus({ type: "error", message: "L'import n'a pas pu être lancé — réessayez." });
      }
    });
  }

  // Tri défensif (du plus récent au plus ancien) — les ISO se comparent
  // lexicographiquement.
  const orderedJobs = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="space-y-6">
      {/* Upload */}
      <section className="rounded-[28px] border border-border bg-card p-6">
        <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">
          <FileUp className="mr-1 inline h-4 w-4 text-primary" />
          Importer un fichier
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Flux XML Google Merchant ou fichier CSV — 8 Mo maximum. L&apos;import démarre
          immédiatement et l&apos;historique ci-dessous suit sa progression.
        </p>

        <form onSubmit={onSubmit} className="mt-5 flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            name="file"
            accept=".xml,.csv"
            className="hidden"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          />
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => fileRef.current?.click()}
            className="inline-flex h-10 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-5 text-sm font-bold text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            Choisir un fichier
          </button>
          <span
            className={`min-w-0 flex-1 truncate text-sm ${
              fileName ? "font-medium text-foreground" : "text-muted-foreground"
            }`}
          >
            {fileName ?? "Aucun fichier sélectionné"}
          </span>
          <button
            type="submit"
            disabled={isSubmitting || !fileName}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileUp className="h-4 w-4" />
            )}
            {isSubmitting ? "Lancement…" : "Lancer l'import"}
          </button>
        </form>

        {status && (
          <p
            role="status"
            className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${
              status.type === "ok"
                ? "bg-[#eaf7ee] text-[#15803d]"
                : "bg-[#fdecef] text-[#d40530]"
            }`}
          >
            {status.type === "ok" ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5" />
            )}
            {status.message}
          </p>
        )}
      </section>

      {/* Notices + templates */}
      <section className="rounded-[28px] border border-dashed border-border bg-card p-6">
        <h3 className="text-[18px] font-black tracking-[-0.02em] text-foreground">Comment ça marche</h3>
        <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
          {NOTICES.map((notice) => (
            <li key={notice}>• {notice}</li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <a
            href="/api/admin/import/template?format=xml"
            download
            className="inline-flex h-9 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-xs font-bold text-muted-foreground transition hover:text-foreground"
          >
            <FileCode2 className="h-3.5 w-3.5" />
            Exemple XML
          </a>
          <a
            href="/api/admin/import/template?format=csv"
            download
            className="inline-flex h-9 items-center gap-2 rounded-full border-[1.5px] border-input bg-card px-4 text-xs font-bold text-muted-foreground transition hover:text-foreground"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            Exemple CSV
          </a>
        </div>
      </section>

      {/* Jobs — hidden when embedded (the parent owns the unified list). */}
      {!hideHistory && (
        <section className="rounded-[28px] border border-border bg-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">
                Historique des imports
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Les 20 derniers imports. La liste se met à jour automatiquement pendant un
                import.
              </p>
            </div>
            {isRefreshing && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
            )}
          </div>

          {orderedJobs.length === 0 ? (
            <div className="mt-4 rounded-[16px] border border-dashed border-border bg-surface/30 p-8 text-center text-sm text-muted-foreground">
              Aucun import pour le moment — lancez votre premier import ci-dessus.
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {orderedJobs.map((job) => (
                <JobCard key={job.id} job={job} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function JobCard({ job }: { job: ImportJobView }) {
  const meta = STATUS_META[job.status];
  const failed = job.status === "failed";
  const running = job.status === "running";
  const result: ImportJobResult | null = job.result;
  const pct = job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0;
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
        <p
          className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"
          title={job.filename}
        >
          {job.filename}
        </p>
        <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {job.format}
        </span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${meta.className}`}
        >
          {running && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />
          )}
          {meta.label}
        </span>
      </div>

      {/* Les dates relatives dérivent entre rendu serveur et hydratation (le
          poll re-rend ensuite avec les valeurs client) — d'où le suppress. */}
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
              {job.processed} / {job.total} produits
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
        <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-[#d40530]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {job.error}
        </p>
      )}

      {result && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Chip tone={result.created > 0 ? "emerald" : "neutral"}>
            {result.created} créés
          </Chip>
          <Chip tone="neutral">{result.skipped} ignorés</Chip>
          <Chip tone={result.failed > 0 ? "rose" : "neutral"}>
            {result.failed} échecs produit
          </Chip>
          <Chip tone="neutral">{result.mediaCreated} images</Chip>
          <Chip tone={result.mediaFailed > 0 ? "rose" : "neutral"}>
            {result.mediaFailed} images en échec
          </Chip>
          <Chip tone="neutral">{result.brandsCreated} marques créées</Chip>
        </div>
      )}

      {result && hasReport && (
        <details className="mt-3 rounded-[12px] border border-border bg-card p-3 text-xs">
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
                title="Chemins de catégories non mappés"
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

/** « il y a 5 min » — même logique que le helper local de /admin/system/search. */
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
