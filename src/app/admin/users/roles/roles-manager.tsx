"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, ShieldCheck, X } from "lucide-react";

import {
  createRoleAction,
  updateRoleAction,
  deleteRoleAction,
} from "@/lib/actions/rbac";
import { type PermissionAction, type PermissionModule } from "@/lib/rbac/registry";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { AdminNote } from "@/components/admin/_components/filter-bar";
import {
  PermissionMatrix,
  type MatrixCellState,
  type WildState,
} from "../permission-matrix";

type RoleVM = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissionCount: number;
  userCount: number;
  permissions: string[];
};

export function RolesManager({
  initialRoles,
  canManage = false,
}: {
  initialRoles: RoleVM[];
  /** users:roles — gates create/edit/delete (UI honesty; the actions re-check). */
  canManage?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          {!creating && editingId === null && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a]"
            >
              <Plus className="h-4 w-4" /> Créer un rôle
            </button>
          )}
        </div>
      )}

      {canManage && creating && (
        <RoleEditor mode="create" onDone={() => setCreating(false)} />
      )}

      <div className="space-y-3">
        {initialRoles.length === 0 && !creating && (
          <p className="rounded-[22px] border border-dashed border-border bg-card px-5 py-12 text-center text-[14px] text-muted-foreground">
            Aucun rôle pour l&apos;instant. Créez-en un pour accorder un accès ciblé.
          </p>
        )}
        {initialRoles.map((role) =>
          canManage && editingId === role.id ? (
            <RoleEditor
              key={role.id}
              mode="edit"
              role={role}
              onDone={() => setEditingId(null)}
            />
          ) : (
            <RoleCard
              key={role.id}
              role={role}
              canManage={canManage}
              onEdit={() => setEditingId(role.id)}
            />
          ),
        )}
      </div>
    </div>
  );
}

function RoleCard({
  role,
  canManage,
  onEdit,
}: {
  role: RoleVM;
  canManage: boolean;
  onEdit: () => void;
}) {
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="rounded-[22px] border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-[16px] font-black text-foreground">{role.name}</h3>
            {role.isSystem && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)] px-2.5 py-1 text-[11px] font-bold text-primary">
                <ShieldCheck className="h-3 w-3" /> Système
              </span>
            )}
          </div>
          {role.description && (
            <p className="mt-1 text-[13px] text-muted-foreground">{role.description}</p>
          )}
          <p className="mt-2 text-[12px] text-muted-foreground">
            {role.isSystem && role.permissions.includes("*") ? (
              <span className="font-medium text-foreground">Accès total — toutes les sections</span>
            ) : (
              <>
                <span className="font-medium text-foreground">{role.permissionCount}</span> permission
                {role.permissionCount === 1 ? "" : "s"}
              </>
            )}
            {" · "}
            <span className="font-medium text-foreground">{role.userCount}</span> utilisateur
            {role.userCount === 1 ? "" : "s"}
          </p>
          {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
        </div>

        {canManage && !role.isSystem && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onEdit}
              className="grid h-9 w-9 place-items-center rounded-[11px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              aria-label="Modifier"
              title="Modifier"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="grid h-9 w-9 place-items-center rounded-[11px] bg-surface text-muted-foreground transition hover:bg-[#fdecef] hover:text-[#d40530]"
              aria-label="Supprimer"
              title="Supprimer"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {confirmDelete && (
        <ConfirmDeleteModal
          title="Supprimer ce rôle ?"
          description="Les utilisateurs perdront les accès accordés par ce rôle. Cette action est irréversible."
          confirmLabel="Supprimer"
          preview={
            <div className="rounded-[14px] border border-border bg-[#fbf9f8] p-2 text-xs">
              <p className="font-medium">{role.name}</p>
              <p className="text-[11px] text-muted-foreground">
                {role.userCount} utilisateur{role.userCount === 1 ? "" : "s"} concerné
                {role.userCount === 1 ? "" : "s"}
              </p>
            </div>
          }
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            const res = await deleteRoleAction(role.id);
            if (res.ok) {
              router.refresh();
              return null;
            }
            setError(res.message);
            return res.message ?? "Erreur";
          }}
        />
      )}
    </div>
  );
}

function RoleEditor({
  mode,
  role,
  onDone,
}: {
  mode: "create" | "edit";
  role?: RoleVM;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(role?.permissions ?? []),
  );
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const selectedCount = useMemo(() => selected.size, [selected]);

  // ── matrix driver (flat set; no inherited/allow/deny tone in the role editor) ──
  const isModuleWild = (id: string) => selected.has(`${id}:*`);
  const cellState = (id: string, a: PermissionAction): MatrixCellState => ({
    checked: isModuleWild(id) || selected.has(`${id}:${a}`),
    disabled: isModuleWild(id), // the wildcard owns the concrete cells
    tone: "normal",
  });
  const wildState = (id: string): WildState => ({ on: isModuleWild(id), disabled: false, tone: "normal" });

  const toggleAction = (id: string, a: PermissionAction) => {
    if (isModuleWild(id)) return; // wildcard owns it
    setSelected((prev) => {
      const next = new Set(prev);
      const key = `${id}:${a}`;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleModuleWild = (m: PermissionModule) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const wild = `${m.id}:*`;
      if (next.has(wild)) {
        next.delete(wild);
      } else {
        next.add(wild);
        // drop now-redundant concrete keys for this module
        for (const a of m.actions) next.delete(`${m.id}:${a}`);
      }
      return next;
    });
  };

  // Group bulk: « Tout » grants each module's wildcard (incl. future actions);
  // « Effacer » clears the whole section (wildcard + concrete keys).
  const onGroupAll = (modules: readonly PermissionModule[]) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of modules) {
        for (const a of m.actions) next.delete(`${m.id}:${a}`);
        next.add(`${m.id}:*`);
      }
      return next;
    });
  const onGroupClear = (modules: readonly PermissionModule[]) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of modules) {
        next.delete(`${m.id}:*`);
        for (const a of m.actions) next.delete(`${m.id}:${a}`);
      }
      return next;
    });

  const save = () => {
    setError(null);
    setFieldError(null);
    startTransition(async () => {
      const permissions = Array.from(selected);
      const res =
        mode === "create"
          ? await createRoleAction({ name, description: description || undefined, permissions })
          : await updateRoleAction({
              roleId: role!.id,
              name,
              description: description || null,
              permissions,
            });
      if (res.ok) {
        onDone();
        router.refresh();
      } else {
        setError(res.message);
        setFieldError(res.fieldErrors?.name ?? null);
      }
    });
  };

  return (
    <div className="rounded-[22px] border border-primary/30 bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[18px] font-black text-foreground">
          {mode === "create" ? "Nouveau rôle" : `Modifier — ${role?.name}`}
        </h2>
        <button
          type="button"
          onClick={onDone}
          className="grid h-9 w-9 place-items-center rounded-[11px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          aria-label="Fermer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <div role="alert" className="mt-3 rounded-[14px] border border-destructive/30 bg-destructive/5 px-4 py-3 text-[14px] text-destructive">
          {error}
        </div>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-2 block text-[13px] font-bold text-foreground">
            Nom du rôle <span className="text-destructive">*</span>
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Gestionnaire catalogue"
            className={`h-11 w-full rounded-[14px] border-[1.5px] bg-[#fbf9f8] px-4 text-[15px] text-foreground placeholder:text-muted-foreground focus:bg-white focus:outline-none ${
              fieldError
                ? "border-destructive/60"
                : "border-input focus:border-foreground"
            }`}
          />
          {fieldError && <p className="mt-2 text-[11px] text-destructive">{fieldError}</p>}
        </div>
        <div>
          <label className="mb-2 block text-[13px] font-bold text-foreground">
            Description
          </label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Gère les produits, stocks et catégories"
            className="h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] text-foreground placeholder:text-muted-foreground focus:border-foreground focus:bg-white focus:outline-none"
          />
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[13px] font-bold text-foreground">
            Permissions
          </p>
          <span className="text-[11px] text-muted-foreground">
            {selectedCount} sélectionnée{selectedCount === 1 ? "" : "s"}
          </span>
        </div>

        <AdminNote className="mb-2">
          <span className="font-medium text-foreground">Tout</span> couvre toutes les actions d&apos;une section, y
          compris celles ajoutées plus tard. Les actions grisées <span className="text-muted-foreground/60">—</span>{" "}
          n&apos;existent pas pour cette section.
        </AdminNote>
        <PermissionMatrix
          query={query}
          onQueryChange={setQuery}
          cellState={cellState}
          wildState={wildState}
          onToggleAction={toggleAction}
          onToggleWild={toggleModuleWild}
          onGroupAll={onGroupAll}
          onGroupClear={onGroupClear}
        />
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          disabled={pending || name.trim().length < 2}
          onClick={save}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? "Enregistrement…" : mode === "create" ? "Créer le rôle" : "Enregistrer"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground transition hover:bg-surface"
        >
          Annuler
        </button>
      </div>
    </div>
  );
}
