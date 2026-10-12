"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  MinusCircle,
  Play,
  Settings2,
  XCircle,
} from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { AdminCallout } from "@/components/admin/_components/filter-bar";
import { SCHEDULED_JOBS, type ScheduledJobDef } from "@/lib/jobs/registry";
import type { JobOverview, JobRunView } from "@/lib/jobs/views";
import {
  listJobRunsAction,
  runJobNowAction,
  setJobEnabledAction,
} from "@/lib/actions/jobs";

/**
 * Admin "Tâches planifiées" dashboard. One card per registered job (run state,
 * cadence, last run, controls) + a cross-job recent-activity table. Internal
 * jobs run in the background (their log row lands shortly after, so we refresh
 * a couple of times); the destructive retention purge is confirmed first.
 */

const JOB_LABEL = new Map<string, string>(SCHEDULED_JOBS.map((j) => [j.key, j.label]));
const jobLabel = (key: string) => JOB_LABEL.get(key) ?? key;

const TRIGGER_LABEL: Record<JobRunView["trigger"], string> = {
  schedule: "Planifié",
  manual: "Manuel",
  cron: "Cron",
};

// Pin the timezone so the SSR'd string (container TZ, usually UTC) matches the
// browser-hydrated one (no React hydration mismatch) AND shows Tunisia local
// time, which is the operator's wall clock.
const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("fr-FR", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Africa/Tunis",
      })
    : "—";

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

function StatusBadge({ status }: { status: JobRunView["status"] }) {
  const map = {
    ok: { Icon: CheckCircle2, cls: "bg-[#eaf7ee] text-[#15803d]", label: "OK" },
    failed: { Icon: XCircle, cls: "bg-[#fdecef] text-[#d40530]", label: "Échec" },
    skipped: { Icon: MinusCircle, cls: "bg-[#fff4e0] text-[#b45309]", label: "Ignoré" },
  }[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${map.cls}`}
    >
      <map.Icon className="h-3 w-3" /> {map.label}
    </span>
  );
}

export function JobsPanel({
  overviews,
  recentRuns,
}: {
  overviews: JobOverview[];
  recentRuns: JobRunView[];
}) {
  const byKey = new Map(overviews.map((o) => [o.key, o]));
  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        {SCHEDULED_JOBS.map((def) => {
          const ov = byKey.get(def.key);
          return ov ? <JobCard key={def.key} def={def} overview={ov} /> : null;
        })}
      </div>
      <RecentRunsTable runs={recentRuns} />
    </div>
  );
}

function JobCard({ def, overview }: { def: ScheduledJobDef; overview: JobOverview }) {
  const router = useRouter();
  const [running, startRun] = useTransition();
  const [toggling, startToggle] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRun, setConfirmRun] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<JobRunView[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  // Hide the no-op « Ignoré » rows (« file vide » drains every ~2 min) so the
  // real runs — and failures — behind them are reachable.
  const [hideSkipped, setHideSkipped] = useState(false);
  // Live mirrors of historyOpen / hideSkipped for deferred callbacks, which
  // would otherwise close over a stale value.
  const historyOpenRef = useRef(false);
  const hideSkippedRef = useRef(false);

  // Without CRON_SECRET the external scheduler can't call the job — warn, but
  // keep « Exécuter maintenant » usable: a manual run never needs the secret and
  // is the only fallback (drain the mail queue, deliver webhooks, …).
  const cronMissing = def.type === "external" && !overview.configured;
  // The latest failure, when later runs have replaced it as the latest run.
  const olderFailure =
    overview.lastFailure && overview.lastFailure.id !== overview.lastRun?.id
      ? overview.lastFailure
      : null;

  // Pull fresh server data (card overview) and, if the history panel is open,
  // its run list too.
  const nudge = () => {
    router.refresh();
    if (historyOpenRef.current) void reloadHistory();
  };


  const doRun = () =>
    startRun(async () => {
      setMsg(null);
      const res = await runJobNowAction(def.key);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) nudge();
    });

  const toggle = (next: boolean) =>
    startToggle(async () => {
      setMsg(null);
      const res = await setJobEnabledAction(def.key, next);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });

  const reloadHistory = async (hide = hideSkippedRef.current) => {
    setLoadingHistory(true);
    try {
      const rows = await listJobRunsAction(def.key, 20, { hideSkipped: hide });
      setHistory(rows);
    } finally {
      setLoadingHistory(false);
    }
  };

  const toggleHideSkipped = (next: boolean) => {
    setHideSkipped(next);
    hideSkippedRef.current = next;
    void reloadHistory(next);
  };

  const toggleHistory = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    historyOpenRef.current = next;
    if (next && history == null) void reloadHistory();
  };

  return (
    <div className="flex flex-col gap-4 rounded-[22px] border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-[12px] bg-[var(--accent)] text-primary">
            {def.type === "internal" ? (
              <CalendarClock className="h-4 w-4" />
            ) : (
              <Clock className="h-4 w-4" />
            )}
          </span>
          <div>
            <h2 className="text-[15px] font-black text-foreground">{def.label}</h2>
            <span className="mt-0.5 inline-flex items-center rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {def.type === "internal" ? "Interne" : "Cron externe"}
            </span>
          </div>
        </div>
        {def.controllable && overview.enabled !== null ? (
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
            <span className={overview.enabled ? "text-[#15803d]" : "text-muted-foreground"}>
              {overview.enabled ? "Activé" : "Désactivé"}
            </span>
            <input
              type="checkbox"
              checked={overview.enabled}
              disabled={toggling}
              onChange={(e) => toggle(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-[var(--primary)]"
            />
          </label>
        ) : null}
        {/* The unconfigured-cron state is surfaced by the `cronMissing` notice below. */}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">{def.description}</p>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-[12px] border border-dashed border-border bg-surface/40 p-3 text-[11px]">
        <Meta label="Cadence" value={overview.scheduleText} />
        <Meta label="Prochaine" value={fmtDate(overview.nextRunAt)} />
        <Meta
          label="Dernière"
          value={overview.lastRun ? fmtDate(overview.lastRun.startedAt) : "Jamais"}
        />
        <Meta label="Durée" value={overview.lastRun ? fmtDuration(overview.lastRun.durationMs) : "—"} />
      </dl>

      {overview.lastRun && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <StatusBadge status={overview.lastRun.status} />
          <span className="rounded-full bg-surface px-2 py-0.5">
            {TRIGGER_LABEL[overview.lastRun.trigger]}
          </span>
          {overview.lastRun.summary && (
            <span className="text-foreground">{overview.lastRun.summary}</span>
          )}
        </div>
      )}

      {(overview.lastError || overview.lastRun?.error) && (
        <AdminCallout tone="danger" icon={AlertTriangle}>
          {overview.lastError ?? overview.lastRun?.error}
        </AdminCallout>
      )}

      {olderFailure && (
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-[#d40530]" />
          <span>
            Dernier échec : {fmtDate(olderFailure.startedAt)}
            {olderFailure.error && <span className="text-[#d40530]"> — {olderFailure.error}</span>}
          </span>
        </p>
      )}

      {cronMissing && (
        <AdminCallout tone="warning" icon={AlertTriangle}>
          Cron non configuré — définissez <code className="font-mono">CRON_SECRET</code> et
          programmez l&apos;appel externe (cadence prévue : {def.defaultSchedule.toLowerCase()} ; voir
          la doc de déploiement). En attendant, « Exécuter maintenant » reste disponible.
        </AdminCallout>
      )}

      {msg && <p className={`text-xs ${msg.ok ? "text-[#15803d]" : "text-destructive"}`}>{msg.text}</p>}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        {def.runnable && (
          <button
            type="button"
            onClick={() => (def.destructive ? setConfirmRun(true) : doRun())}
            disabled={running}
            className={`inline-flex h-9 items-center gap-2 rounded-full px-4 text-xs font-semibold transition disabled:opacity-60 ${
              def.destructive
                ? "border border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10"
                : "border border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
            }`}
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Exécuter maintenant
          </button>
        )}
        {def.configHref && (
          <Link
            href={def.configHref}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-4 text-xs font-bold text-foreground transition hover:bg-surface"
          >
            <Settings2 className="h-3.5 w-3.5" /> Configurer
          </Link>
        )}
        <button
          type="button"
          onClick={toggleHistory}
          className="inline-flex h-9 items-center gap-1 rounded-full px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {historyOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          Historique
        </button>
      </div>

      {historyOpen && (
        <div className="rounded-[16px] border border-border bg-surface/30">
          <label className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={hideSkipped}
              disabled={loadingHistory}
              onChange={(e) => toggleHideSkipped(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border accent-[var(--primary)]"
            />
            Masquer les exécutions « Ignoré » (file vide, tâche en pause)
          </label>
          {loadingHistory ? (
            <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Chargement…
            </p>
          ) : history && history.length > 0 ? (
            <ul className="divide-y divide-border">
              {history.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[11px]"
                >
                  <StatusBadge status={r.status} />
                  <span className="text-muted-foreground">{fmtDate(r.startedAt)}</span>
                  <span className="text-muted-foreground">· {fmtDuration(r.durationMs)}</span>
                  <span className="rounded-full bg-surface px-1.5 py-0.5 text-muted-foreground">
                    {TRIGGER_LABEL[r.trigger]}
                  </span>
                  {r.summary && <span className="text-foreground">{r.summary}</span>}
                  {r.error && <span className="w-full text-[#d40530]">{r.error}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-3 text-xs text-muted-foreground">Aucune exécution enregistrée.</p>
          )}
        </div>
      )}

      {confirmRun && (
        <ConfirmDeleteModal
          title={`Exécuter « ${def.label} » ?`}
          description={`${def.description} Action irréversible.`}
          confirmLabel="Exécuter maintenant"
          onCancel={() => setConfirmRun(false)}
          onConfirm={async () => {
            const res = await runJobNowAction(def.key);
            setMsg({ ok: res.ok, text: res.message });
            if (res.ok) nudge(); // synchronous purge — its log row exists now
            return res.ok ? null : res.message;
          }}
        />
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}

function RecentRunsTable({ runs }: { runs: JobRunView[] }) {
  return (
    <div className="rounded-[22px] border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <Clock className="h-4 w-4 text-primary" />
        <h2 className="text-[15px] font-black text-foreground">Activité récente</h2>
        <span className="text-xs text-muted-foreground">· toutes tâches</span>
      </div>
      {runs.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          Aucune exécution enregistrée pour le moment.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#fbf9f8] text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
              <tr className="border-b border-border">
                <th className="px-5 py-3 font-bold">Tâche</th>
                <th className="px-3 py-3 font-bold">Statut</th>
                <th className="px-3 py-3 font-bold">Déclencheur</th>
                <th className="px-3 py-3 font-bold">Début</th>
                <th className="px-3 py-3 font-bold">Durée</th>
                <th className="px-5 py-3 font-bold">Résumé</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {runs.map((r) => (
                <tr key={r.id} className="transition hover:bg-[#fffbfb]">
                  <td className="px-5 py-2 font-medium text-foreground">{jobLabel(r.jobKey)}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{TRIGGER_LABEL[r.trigger]}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {fmtDate(r.startedAt)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {fmtDuration(r.durationMs)}
                  </td>
                  <td className="px-5 py-2 text-muted-foreground">
                    {r.error ? (
                      <span className="text-[#d40530]">{r.error}</span>
                    ) : (
                      (r.summary ?? "—")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
