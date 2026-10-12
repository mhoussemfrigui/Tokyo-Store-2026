"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, ShieldCheck } from "lucide-react";

import { setUserRolesAction } from "@/lib/actions/rbac";

type RoleOption = { id: string; name: string; isSystem: boolean };

/**
 * Multi-select of RBAC roles for one user. Toggling chips builds the desired
 * set; "Enregistrer" sends the full set to setUserRolesAction (diffed
 * server-side). Access is role-only now, so a role change CAN affect the
 * last-admin floor — setUserRolesWorkflow runs assertRoleChangeKeepsAnAdmin when
 * a `*`-carrying role is removed. The save is gated by `users:roles`.
 */
export function UserRolesEditor({
  userId,
  allRoles,
  assignedIds,
}: {
  userId: string;
  allRoles: RoleOption[];
  assignedIds: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set(assignedIds));
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const baseline = new Set(assignedIds);
  const dirty =
    selected.size !== baseline.size || [...selected].some((id) => !baseline.has(id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = () => {
    setFeedback(null);
    startTransition(async () => {
      const res = await setUserRolesAction({ userId, roleIds: Array.from(selected) });
      if (res.ok) {
        setFeedback({ kind: "ok", msg: res.message ?? "Enregistré." });
        router.refresh();
      } else {
        setFeedback({ kind: "err", msg: res.message });
      }
    });
  };

  return (
    <div className="pt-2">
      <p className="mb-2 inline-flex items-center gap-1.5 text-[13px] font-bold text-foreground">
        <ShieldCheck className="h-3.5 w-3.5" /> Rôles d&apos;accès
      </p>
      {allRoles.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          Aucun rôle défini. Créez-en un dans « Rôles &amp; permissions ».
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {allRoles.map((r) => {
            const on = selected.has(r.id);
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => toggle(r.id)}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] transition ${
                  on
                    ? "bg-primary font-extrabold text-primary-foreground"
                    : "border-[1.5px] border-input bg-card font-semibold text-muted-foreground hover:bg-surface"
                }`}
              >
                {on && <Check className="h-3 w-3" />} {r.name}
              </button>
            );
          })}
        </div>
      )}

      {feedback && (
        <p className={`mt-2 text-[11px] ${feedback.kind === "ok" ? "text-primary" : "text-destructive"}`}>
          {feedback.msg}
        </p>
      )}

      {dirty && (
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="mt-3 inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Enregistrer les rôles
        </button>
      )}
    </div>
  );
}
