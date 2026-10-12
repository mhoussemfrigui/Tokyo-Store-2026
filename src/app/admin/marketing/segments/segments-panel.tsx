"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2, UserPlus, Users, X } from "lucide-react";

import {
  addSegmentMemberByEmailAction,
  createSegmentAction,
  deleteSegmentAction,
  removeSegmentMemberAction,
  updateSegmentAction,
} from "@/lib/actions/segments";
import { SelectField } from "@/components/ui/select-field";
import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminNote } from "@/components/admin/_components/filter-bar";
import { ExportFieldPicker } from "@/components/admin/export-field-picker";
import { SEGMENT_MEMBER_FIELDS } from "@/lib/export/segment-member-fields";
import { describeTree } from "@/lib/promotions/rule-leaves";
import { isGroup, legacyRuleToTree, type RuleNode } from "@/lib/promotions/rule-tree";
import { SegmentRuleBuilder, isBuilderTreeValid } from "./segment-builder";

/** Seed the builder from a stored rule: a compound tree is used as-is; a legacy
 *  single-rule (or missing) segment maps to a one-LEAF tree via legacyRuleToTree,
 *  which the builder needs wrapped in a group (its root must be a RuleGroup, else
 *  GroupEditor reads `.children` of a leaf and crashes). */
function seedTree(segment: SegmentView): RuleNode {
  const seed = segment.ruleTree ?? legacyRuleToTree(segment.rule);
  return isGroup(seed) ? seed : { op: "and", children: [seed] };
}

type Kind = "manual" | "dynamic";

/** A fresh dynamic rule tree — one always-true leaf so the group is valid to start. */
const NEW_TREE: RuleNode = { op: "and", children: [{ kind: "marketing_opted_in" }] };

export type SegmentMemberView = { profileId: string; firstName: string; lastName: string };

/** Live demographic breakdown of a segment's members (« Statistiques »). */
export type SegmentStatsView = {
  total: number;
  optedIn: number;
  female: number;
  male: number;
  otherGender: number;
  genderUnset: number;
};

export type SegmentView = {
  id: string;
  name: string;
  kind: Kind;
  rule: string | null;
  /** Compound rule tree (Phase 6); null for a legacy single-rule or manual segment. */
  ruleTree: RuleNode | null;
  enabled: boolean;
  /** Live member count (manual roster, or the dynamic rule's resolved count). */
  memberCount: number | null;
  /** Manual-segment roster (resolved server-side); empty for dynamic. */
  members: SegmentMemberView[];
  /** Live stats; null if the breakdown couldn't be resolved. */
  stats: SegmentStatsView | null;
};

const inputCls =
  "h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-3 text-[15px] focus:outline-none focus-visible:border-foreground focus-visible:bg-white";

const KIND_OPTIONS = [
  { value: "manual", label: "Manuel (liste de clients)" },
  { value: "dynamic", label: "Dynamique (règle automatique)" },
];

export function SegmentsPanel({
  segments,
  title,
  description,
  canExport = false,
}: {
  segments: SegmentView[];
  title: string;
  description?: React.ReactNode;
  /** Whether the operator holds `customers:export` (shows the per-segment CSV control). */
  canExport?: boolean;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      <AdminPageHeader
        title={title}
        description={description}
        action={
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
          >
            {creating ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {creating ? "Fermer" : "Créer un segment"}
          </button>
        }
      />

      {creating && <CreateForm onDone={() => setCreating(false)} />}

      {segments.length === 0 && !creating ? (
        <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
          Aucun segment. Créez-en un pour cibler vos promotions.
        </div>
      ) : (
        <div className="space-y-3">
          {segments.map((s) => (
            <SegmentCard key={s.id} segment={s} canExport={canExport} />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("manual");
  const [tree, setTree] = useState<RuleNode>(NEW_TREE);
  const [error, setError] = useState<string | null>(null);

  const dynamicInvalid = kind === "dynamic" && !isBuilderTreeValid(tree);

  return (
    <div className="rounded-[28px] border border-primary/30 bg-card p-5">
      <h2 className="text-[18px] font-black text-foreground">Nouveau segment</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nom du segment *"
          className={`${inputCls} sm:col-span-2`}
        />
        <SelectField
          ariaLabel="Type de segment"
          options={KIND_OPTIONS}
          value={kind}
          onChange={(v) => setKind(v as Kind)}
        />
      </div>
      {kind === "dynamic" && (
        <div className="mt-3">
          <p className="mb-2 text-[13px] font-bold text-foreground">
            Règle du segment
          </p>
          <SegmentRuleBuilder value={tree} onChange={setTree} />
        </div>
      )}
      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={pending || name.trim().length < 2 || dynamicInvalid}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const res = await createSegmentAction({
                name,
                kind,
                ruleTree: kind === "dynamic" ? tree : null,
              });
              if (res.ok) {
                onDone();
                router.refresh();
              } else setError(res.message);
            });
          }}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Créer
        </button>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-5 text-[14px] font-bold text-foreground hover:bg-surface"
        >
          Annuler
        </button>
      </div>
    </div>
  );
}

function SegmentCard({ segment, canExport }: { segment: SegmentView; canExport: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [membersOpen, setMembersOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tree, setTree] = useState<RuleNode>(NEW_TREE);
  const [error, setError] = useState<string | null>(null);

  const op = (fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (res.ok) router.refresh();
      else setError(res.message ?? "Erreur");
    });
  };

  return (
    <div className="rounded-[28px] border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="inline-flex items-center gap-2 text-[18px] font-black text-foreground">
            <Users className="h-4 w-4" /> {segment.name}
            <span
              className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${
                segment.kind === "dynamic"
                  ? "bg-[#fdecef] text-[#d40530]"
                  : "bg-[#f6f2ed] text-[#5b5d62]"
              }`}
            >
              {segment.kind === "dynamic" ? "Dynamique" : "Manuel"}
            </span>
            {!segment.enabled && (
              <span className="rounded-full bg-[#fdecef] px-2.5 py-1 text-[10px] font-bold text-[#d40530]">
                Désactivé
              </span>
            )}
          </h3>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {segment.kind === "dynamic"
              ? `Règle : ${describeTree(segment.ruleTree ?? legacyRuleToTree(segment.rule))}`
              : `${segment.memberCount ?? 0} membre${(segment.memberCount ?? 0) === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canExport && (segment.memberCount ?? 0) > 0 && (
            <ExportFieldPicker
              baseUrl={`/api/admin/segments/${segment.id}/export`}
              fields={SEGMENT_MEMBER_FIELDS}
              label="Exporter"
            />
          )}
          {segment.kind === "dynamic" && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                if (!editing) setTree(seedTree(segment));
                setEditing((v) => !v);
              }}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[12px] font-bold text-foreground hover:bg-surface"
            >
              {editing ? "Fermer" : "Modifier la règle"}
            </button>
          )}
          {segment.kind === "manual" && (
            <button
              type="button"
              onClick={() => setMembersOpen((v) => !v)}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[12px] font-bold text-foreground hover:bg-surface"
            >
              <UserPlus className="h-3.5 w-3.5" /> Membres
            </button>
          )}
          <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3 text-[12px] font-bold text-muted-foreground hover:bg-surface">
            <input
              type="checkbox"
              checked={segment.enabled}
              disabled={pending}
              onChange={(e) =>
                op(() => updateSegmentAction({ id: segment.id, enabled: e.target.checked }))
              }
              className="h-4 w-4 accent-[var(--primary)]"
            />
            Activé
          </label>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (!confirm(`Supprimer le segment « ${segment.name} » ?`)) return;
              op(() => deleteSegmentAction(segment.id));
            }}
            className="grid h-9 w-9 place-items-center rounded-[12px] border-[1.5px] border-input bg-card text-muted-foreground hover:bg-[var(--accent)] hover:text-destructive disabled:opacity-60"
            aria-label="Supprimer"
            title="Supprimer"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {segment.stats && <StatsStrip stats={segment.stats} />}

      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}

      {editing && segment.kind === "dynamic" && (
        <div className="mt-4 border-t border-border pt-4">
          <SegmentRuleBuilder value={tree} onChange={setTree} />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={pending || !isBuilderTreeValid(tree)}
              onClick={() =>
                op(async () => {
                  const res = await updateSegmentAction({ id: segment.id, ruleTree: tree });
                  if (res.ok) setEditing(false);
                  return res;
                })
              }
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-[12px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Enregistrer la règle
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="inline-flex h-9 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[12px] font-bold text-foreground hover:bg-surface"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {membersOpen && segment.kind === "manual" && <MemberPanel segment={segment} />}
    </div>
  );
}

/** Compact « Statistiques » strip — the live demographic breakdown of the members. */
function StatsStrip({ stats }: { stats: SegmentStatsView }) {
  if (stats.total === 0) {
    return (
      <p className="mt-3 border-t border-border pt-3 text-[11px] text-muted-foreground">
        Aucun membre actif pour l&apos;instant.
      </p>
    );
  }
  const pill = (label: string, value: string) => (
    <span className="inline-flex items-baseline gap-1 rounded-full bg-surface px-2.5 py-1">
      <span className="text-[12px] font-semibold text-foreground">{value}</span>
      <span className="text-[10.5px] text-muted-foreground">{label}</span>
    </span>
  );
  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {pill("membres", String(stats.total))}
        {pill("abonnés", String(stats.optedIn))}
        {pill("♀", String(stats.female))}
        {pill("♂", String(stats.male))}
        {stats.otherGender > 0 && pill("autre", String(stats.otherGender))}
        {stats.genderUnset > 0 && pill("genre ?", String(stats.genderUnset))}
      </div>
    </div>
  );
}

function MemberPanel({ segment }: { segment: SegmentView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email du client (compte existant)"
          className={`${inputCls} max-w-xs`}
        />
        <button
          type="button"
          disabled={pending || !email.trim()}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const res = await addSegmentMemberByEmailAction(segment.id, email.trim());
              if (res.ok) {
                setEmail("");
                router.refresh();
              } else setError(res.message);
            });
          }}
          className="inline-flex h-11 items-center gap-1.5 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
          Ajouter
        </button>
      </div>
      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
      <AdminNote className="mt-2">
        Le client doit déjà avoir un compte (recherché par email).
      </AdminNote>

      {segment.members.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {segment.members.map((m) => (
            <li
              key={m.profileId}
              className="flex items-center justify-between gap-3 rounded-[14px] border border-border bg-surface/40 px-3 py-2 text-sm"
            >
              <span className="min-w-0 truncate">
                {[m.firstName, m.lastName].filter(Boolean).join(" ") || "—"}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setError(null);
                  startTransition(async () => {
                    const res = await removeSegmentMemberAction(segment.id, m.profileId);
                    if (res.ok) router.refresh();
                    else setError(res.message);
                  });
                }}
                className="grid h-7 w-7 place-items-center rounded-[10px] text-muted-foreground hover:bg-[var(--accent)] hover:text-destructive disabled:opacity-60"
                aria-label="Retirer"
                title="Retirer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <AdminNote className="mt-3">
          Aucun membre. Ajoutez un client par email ci-dessus.
        </AdminNote>
      )}
    </div>
  );
}
