"use client";

import { useMemo, useState } from "react";
import { Loader2, RotateCcw, ShieldCheck } from "lucide-react";

import { useRefreshAction } from "@/hooks/use-refresh-action";
import { setUserPermissionsAction } from "@/lib/actions/rbac";
import { PERMISSION_MODULES, type PermissionAction, type PermissionModule } from "@/lib/rbac/registry";
import {
  PermissionMatrix,
  type MatrixCellState,
  type WildState,
} from "../permission-matrix";

/**
 * Per-user permission OVERLAY editor (0191) — the same matrix the role editor uses,
 * but seeded from this user's ROLE baseline and edited as allow/deny DELTAS: a role
 * is a template you can still customize per user. A checked cell the roles grant is
 * « hérité » (blue); tick a cell the roles DON'T grant to ADD it (green, an `allow`);
 * untick an inherited cell to REMOVE it (red, a `deny`). Saving sends the full delta
 * set to setUserPermissionsAction, which enforces the escalation guards (grant only
 * what you hold, never the global « * », outrank the target).
 *
 * Only CONCRETE keys are produced (the « Tout » button toggles all of a section's
 * actions), so the overlay never needs the module-wildcard bookkeeping the role
 * editor has; a role granting a `<module>:*` still shows every cell inherited, and a
 * per-cell deny carves it out at resolve time (authorize.ts materializes the wildcard
 * before subtracting).
 */
type Effect = "allow" | "deny";

/** Does the role baseline (which may hold `*` / `<module>:*`) grant this concrete cell? */
function baselineAllows(set: Set<string>, moduleId: string, action: string): boolean {
  return set.has("*") || set.has(`${moduleId}:*`) || set.has(`${moduleId}:${action}`);
}

export function UserPermissionsEditor({
  userId,
  baselineGrants,
  initialOverrides,
  targetIsWildcard,
}: {
  userId: string;
  /** Union of the user's assigned roles' grants — the template (may contain `*` / `<module>:*`). */
  baselineGrants: string[];
  initialOverrides: Array<{ permission: string; effect: Effect }>;
  /** The user is an effective super-admin (holds `*` via a role) — the overlay does not apply. */
  targetIsWildcard: boolean;
}) {
  const baseline = useMemo(() => new Set(baselineGrants), [baselineGrants]);
  const [overrides, setOverrides] = useState<Map<string, Effect>>(
    () => new Map(initialOverrides.map((o) => [o.permission, o.effect])),
  );
  const [query, setQuery] = useState("");
  const { pending, run } = useRefreshAction();
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const initialKey = useMemo(
    () => initialOverrides.map((o) => `${o.permission}=${o.effect}`).sort().join("|"),
    [initialOverrides],
  );
  const currentKey = [...overrides].map(([k, v]) => `${k}=${v}`).sort().join("|");
  const dirty = currentKey !== initialKey;
  const allowCount = [...overrides.values()].filter((e) => e === "allow").length;
  const denyCount = [...overrides.values()].filter((e) => e === "deny").length;

  const cellState = (moduleId: string, action: PermissionAction): MatrixCellState => {
    const ov = overrides.get(`${moduleId}:${action}`);
    if (ov === "allow") return { checked: true, disabled: false, tone: "allow" };
    if (ov === "deny") return { checked: false, disabled: false, tone: "deny" };
    const base = baselineAllows(baseline, moduleId, action);
    return { checked: base, disabled: false, tone: base ? "inherited" : "normal" };
  };

  /** Set a cell to `on`; drop the override when it matches the baseline (back to inherited). */
  const setCell = (
    next: Map<string, Effect>,
    moduleId: string,
    action: PermissionAction,
    on: boolean,
  ) => {
    const key = `${moduleId}:${action}`;
    const base = baselineAllows(baseline, moduleId, action);
    if (on === base) next.delete(key);
    else next.set(key, on ? "allow" : "deny");
  };

  const onToggleAction = (moduleId: string, action: PermissionAction) => {
    const on = !cellState(moduleId, action).checked;
    setOverrides((prev) => {
      const next = new Map(prev);
      setCell(next, moduleId, action, on);
      return next;
    });
  };

  const wildState = (moduleId: string): WildState => {
    const m = PERMISSION_MODULES.find((x) => x.id === moduleId)!;
    const states = m.actions.map((a) => cellState(moduleId, a));
    const allOn = states.every((s) => s.checked);
    const tone = allOn
      ? states.some((s) => s.tone === "allow")
        ? "allow"
        : "inherited"
      : states.some((s) => s.tone === "deny")
        ? "deny"
        : "normal";
    return { on: allOn, disabled: false, tone };
  };

  const onToggleWild = (m: PermissionModule) => {
    const allOn = m.actions.every((a) => cellState(m.id, a).checked);
    setOverrides((prev) => {
      const next = new Map(prev);
      for (const a of m.actions) setCell(next, m.id, a, !allOn);
      return next;
    });
  };

  const onGroupAll = (modules: readonly PermissionModule[]) =>
    setOverrides((prev) => {
      const next = new Map(prev);
      for (const m of modules) for (const a of m.actions) setCell(next, m.id, a, true);
      return next;
    });

  // « Effacer » on the overlay = RESET this section to the role baseline (drop its
  // overrides), not "deny all" — the role editor's Effacer clears a blank slate; here
  // the slate is the role.
  const onGroupClear = (modules: readonly PermissionModule[]) =>
    setOverrides((prev) => {
      const next = new Map(prev);
      for (const m of modules) for (const a of m.actions) next.delete(`${m.id}:${a}`);
      return next;
    });

  const save = () => {
    setFeedback(null);
    run(async () => {
      const payload = [...overrides].map(([permission, effect]) => ({ permission, effect }));
      const res = await setUserPermissionsAction({ userId, overrides: payload });
      if (res.ok) setFeedback({ kind: "ok", msg: res.message ?? "Enregistré." });
      else {
        setFeedback({ kind: "err", msg: res.message });
        return false;
      }
    });
  };

  if (targetIsWildcard) {
    return (
      <p className="inline-flex items-start gap-2 rounded-[14px] border border-border bg-[#fbf9f8] px-4 py-3 text-[12px] text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        Ce compte est super-administrateur (accès total via le rôle). Les ajustements par
        utilisateur ne s&apos;appliquent pas — gérez son accès via les rôles.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded border border-primary/60 bg-[var(--accent)]" /> Hérité du rôle
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded border border-[#cdebd6] bg-[#eaf7ee]" /> Ajouté
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded border border-destructive/60 bg-destructive/15" /> Retiré
          </span>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {allowCount + denyCount === 0
            ? "Aucun ajustement — accès = rôles"
            : `${allowCount} ajouté${allowCount === 1 ? "" : "s"} · ${denyCount} retiré${denyCount === 1 ? "" : "s"}`}
        </span>
      </div>

      <PermissionMatrix
        query={query}
        onQueryChange={setQuery}
        cellState={cellState}
        wildState={wildState}
        onToggleAction={onToggleAction}
        onToggleWild={onToggleWild}
        onGroupAll={onGroupAll}
        onGroupClear={onGroupClear}
      />

      {feedback && (
        <p className={`text-[11px] ${feedback.kind === "ok" ? "text-primary" : "text-destructive"}`}>
          {feedback.msg}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Enregistrer les permissions
        </button>
        {overrides.size > 0 && (
          <button
            type="button"
            onClick={() => setOverrides(new Map())}
            disabled={pending}
            className="inline-flex h-11 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground transition hover:bg-surface disabled:opacity-60"
            title="Tout réinitialiser sur les rôles"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Réinitialiser
          </button>
        )}
      </div>
    </div>
  );
}
