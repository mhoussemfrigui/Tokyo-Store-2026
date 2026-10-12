"use client";

import { Trash2, FolderPlus } from "lucide-react";

import {
  isGroup,
  MAX_GROUP_CHILDREN,
  MAX_TREE_DEPTH,
  MAX_TREE_LEAVES,
  type RuleGroup,
  type RuleLeaf,
  type RuleNode,
} from "@/lib/promotions/rule-tree";
import { LEAVES, OFFERED_LEAF_KINDS, describeTree, isValidRuleTree } from "@/lib/promotions/rule-leaves";
import { defaultLeaf } from "@/lib/promotions/segment-leaf-defaults";
import { CUSTOMER_GENDER_LABELS } from "@/modules/customer/types";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";

/**
 * Compound segment RULE BUILDER (Phase 6j) — an admin-facing tree editor over the
 * leaf grammar (rule-leaves.ts). It emits a `RuleNode` the server persists as
 * `customer_segments.rule_tree`; the SAME tree drives per-checkout eligibility, the
 * mailing/promo audiences, stats and export. Client-safe: rule-leaves + rule-tree are
 * pure (no DB / server-only), so the builder shares the one leaf definition the
 * resolvers use — an offered kind here is a resolvable kind everywhere. Every dropdown
 * is the design-system SelectField, and each condition shows its plain-French `help`.
 */

const FAMILY_ORDER = [
  "Commandes",
  "Panier",
  "Démographie",
  "Événements de vie",
  "Consentement",
] as const;

const numCls =
  "h-11 w-24 rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-2.5 text-[13px] text-foreground focus:outline-none focus-visible:border-foreground focus-visible:bg-white";

/** Small inline SelectField for a leaf param (constrained width, sm size). */
function InlineSelect({
  value,
  onChange,
  options,
  ariaLabel,
  width = "w-44",
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectFieldOption[];
  ariaLabel: string;
  width?: string;
}) {
  return <SelectField ariaLabel={ariaLabel} size="sm" className={`shrink-0 ${width}`} value={value} onChange={onChange} options={options} />;
}

// ── immutable tree edits by path (array of child indices) ──
type Path = number[];
function updateAt(root: RuleNode, path: Path, fn: (n: RuleNode) => RuleNode): RuleNode {
  if (path.length === 0) return fn(root);
  if (!isGroup(root)) return root;
  return { ...root, children: root.children.map((c, i) => (i === path[0] ? updateAt(c, path.slice(1), fn) : c)) };
}
function removeAt(root: RuleNode, path: Path): RuleNode {
  if (path.length === 0 || !isGroup(root)) return root;
  if (path.length === 1) return { ...root, children: root.children.filter((_, i) => i !== path[0]) };
  return { ...root, children: root.children.map((c, i) => (i === path[0] ? removeAt(c, path.slice(1)) : c)) };
}

/** Total leaf count of a tree (pure) — drives the MAX_TREE_LEAVES cap in the UI. */
function countLeaves(node: RuleNode): number {
  return isGroup(node) ? node.children.reduce((n, c) => n + countLeaves(c), 0) : 1;
}
/** Deepest group at which nesting is still empty (has a group with no children). */
function hasEmptyGroup(node: RuleNode): boolean {
  return isGroup(node) && (node.children.length === 0 || node.children.some(hasEmptyGroup));
}

export function SegmentRuleBuilder({
  value,
  onChange,
}: {
  value: RuleNode;
  onChange: (node: RuleNode) => void;
}) {
  const valid = isValidRuleTree(value);
  const leaves = countLeaves(value);
  const atLeafCap = leaves >= MAX_TREE_LEAVES;
  const update = (path: Path, fn: (n: RuleNode) => RuleNode) => onChange(updateAt(value, path, fn));
  const remove = (path: Path) => onChange(removeAt(value, path));

  // Name the specific reason so the operator isn't stuck guessing why save is disabled.
  const reason = hasEmptyGroup(value)
    ? "Chaque groupe doit contenir au moins une condition."
    : leaves > MAX_TREE_LEAVES
      ? `Trop de conditions (max ${MAX_TREE_LEAVES}).`
      : `Règle incomplète — vérifiez les paramètres (max ${MAX_TREE_DEPTH} niveaux, ${MAX_TREE_LEAVES} conditions).`;

  return (
    <div className="space-y-3">
      <GroupEditor node={value as RuleGroup} path={[]} depth={1} update={update} remove={remove} atLeafCap={atLeafCap} isRoot />
      <div className="rounded-[14px] border border-border bg-surface/40 px-4 py-3 text-[12px]">
        <span className="font-bold text-foreground">Aperçu : </span>
        <span className="text-muted-foreground">{describeTree(value)}</span>
      </div>
      {!valid && <p className="text-[11px] text-destructive">{reason}</p>}
    </div>
  );
}

/** Whether a builder's tree is a valid rule — exported so the save button can gate. */
export function isBuilderTreeValid(node: RuleNode): boolean {
  return isValidRuleTree(node);
}

function GroupEditor({
  node,
  path,
  depth,
  update,
  remove,
  atLeafCap,
  isRoot = false,
}: {
  node: RuleGroup;
  path: Path;
  depth: number;
  update: (path: Path, fn: (n: RuleNode) => RuleNode) => void;
  remove: (path: Path) => void;
  /** The whole tree already holds MAX_TREE_LEAVES conditions — block adding more. */
  atLeafCap: boolean;
  isRoot?: boolean;
}) {
  const setGroup = (fn: (g: RuleGroup) => RuleGroup) =>
    update(path, (n) => fn(n as RuleGroup));
  const addLeaf = (kind: string) =>
    setGroup((g) => ({ ...g, children: [...g.children, defaultLeaf(kind)] }));
  const addGroup = () =>
    setGroup((g) => ({ ...g, children: [...g.children, { op: "and", children: [defaultLeaf("marketing_opted_in")] }] }));

  // A group can hold at most MAX_GROUP_CHILDREN, and the whole tree at most
  // MAX_TREE_LEAVES leaves. Nesting stops one level ABOVE MAX_TREE_DEPTH: a group at
  // depth `d` holds leaves at depth `d+1`, and isValidRuleTree counts leaves toward
  // depth, so the deepest group that can hold a VALID leaf is MAX_TREE_DEPTH-1.
  const canAddChild = node.children.length < MAX_GROUP_CHILDREN && !atLeafCap;
  const canNest = depth < MAX_TREE_DEPTH - 1;

  return (
    <div className={`rounded-[22px] border ${isRoot ? "border-border" : "border-primary/25 bg-surface/30"} bg-card p-4`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex gap-1 rounded-[14px] bg-[var(--background)] p-1">
          {(["and", "or"] as const).map((op) => (
            <button
              key={op}
              type="button"
              onClick={() => setGroup((g) => ({ ...g, op }))}
              className={`rounded-[10px] px-[14px] py-[8px] text-[11px] transition ${
                node.op === op ? "bg-card font-extrabold text-primary shadow-[0_2px_8px_rgba(14,18,24,0.08)]" : "font-semibold text-muted-foreground hover:text-foreground"
              }`}
            >
              {op === "and" ? "TOUTES (ET)" : "AU MOINS UNE (OU)"}
            </button>
          ))}
        </div>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={!!node.negate}
            onChange={(e) => setGroup((g) => ({ ...g, negate: e.target.checked }))}
            className="h-3.5 w-3.5 accent-[var(--primary)]"
          />
          Inverser (NON)
        </label>
        {!isRoot && (
          <button
            type="button"
            onClick={() => remove(path)}
            className="ml-auto grid h-7 w-7 place-items-center rounded-[10px] text-muted-foreground hover:bg-[var(--accent)] hover:text-destructive"
            aria-label="Supprimer le groupe"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="mt-3 space-y-2.5">
        {node.children.map((child, i) =>
          isGroup(child) ? (
            <GroupEditor
              key={i}
              node={child}
              path={[...path, i]}
              depth={depth + 1}
              update={update}
              remove={remove}
              atLeafCap={atLeafCap}
            />
          ) : (
            <LeafEditor
              key={i}
              leaf={child}
              onChange={(next) => update([...path, i], () => next)}
              onRemove={() => remove([...path, i])}
            />
          ),
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <AddLeafMenu disabled={!canAddChild} onAdd={addLeaf} />
        {canNest && (
          <button
            type="button"
            disabled={!canAddChild}
            onClick={addGroup}
            className="inline-flex h-11 items-center gap-1.5 rounded-full border-[1.5px] border-input bg-card px-3.5 text-[12px] font-bold text-foreground hover:bg-surface disabled:opacity-50"
          >
            <FolderPlus className="h-4 w-4" /> Sous-groupe
          </button>
        )}
      </div>
    </div>
  );
}

/** The condition picker — a searchable SelectField grouped by family (family shown as the
 *  option subtitle). Controlled value stays "" so the trigger always prompts « + Condition ». */
function AddLeafMenu({ disabled, onAdd }: { disabled: boolean; onAdd: (kind: string) => void }) {
  // Subtitle = the (short) family, which always fits the picker + gives grouping context;
  // the full `help` explanation shows on the leaf row after it's added (where it wraps).
  // Search still matches the help text via `keywords`.
  const options: SelectFieldOption[] = FAMILY_ORDER.flatMap((fam) =>
    OFFERED_LEAF_KINDS.filter((k) => LEAVES[k].family === fam).map((k) => ({
      value: k,
      label: LEAVES[k].label,
      description: fam,
      keywords: LEAVES[k].help ? [fam, LEAVES[k].help] : [fam],
    })),
  );
  return (
    <SelectField
      ariaLabel="Ajouter une condition"
      size="sm"
      searchable
      disabled={disabled}
      value=""
      onChange={(v) => v && onAdd(v)}
      options={options}
      placeholder="+ Ajouter une condition"
      className="w-72"
      triggerClassName="border-primary/50 text-primary font-semibold"
    />
  );
}

function LeafEditor({
  leaf,
  onChange,
  onRemove,
}: {
  leaf: RuleLeaf;
  onChange: (leaf: RuleLeaf) => void;
  onRemove: () => void;
}) {
  const def = LEAVES[leaf.kind];
  const set = (patch: Record<string, unknown>) => onChange({ ...leaf, ...patch });

  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-[14px] border border-border bg-surface/40 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-bold text-foreground">{def?.label ?? leaf.kind}</p>
        {def?.help && <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{def.help}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <LeafParams leaf={leaf} set={set} />
        <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={!!leaf.negate}
            onChange={(e) => set({ negate: e.target.checked })}
            className="h-3.5 w-3.5 accent-[var(--primary)]"
          />
          NON
        </label>
        <button
          type="button"
          onClick={onRemove}
          className="grid h-7 w-7 place-items-center rounded-[10px] text-muted-foreground hover:bg-[var(--accent)] hover:text-destructive"
          aria-label="Supprimer la condition"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** The per-kind param inputs. DT amounts edit in dinars, stored as millimes (×1000). */
function LeafParams({
  leaf,
  set,
}: {
  leaf: RuleLeaf;
  set: (patch: Record<string, unknown>) => void;
}) {
  const k = leaf.kind;
  const numInput = (field: string, val: unknown, opts?: { dt?: boolean; min?: number }) => (
    <input
      type="number"
      min={opts?.min ?? 0}
      className={numCls}
      value={opts?.dt ? Number(val ?? 0) / 1000 : Number(val ?? 0)}
      onChange={(e) => {
        const raw = Number(e.target.value);
        set({ [field]: opts?.dt ? Math.round((Number.isFinite(raw) ? raw : 0) * 1000) : Math.trunc(Number.isFinite(raw) ? raw : 0) });
      }}
    />
  );

  if (k === "cart_total_gte" || k === "cart_total_lte") {
    return (
      <span className="inline-flex items-center gap-1.5">
        {numInput("cents", leaf.cents, { dt: true })}
        <span className="text-[11px] text-muted-foreground">DT</span>
      </span>
    );
  }
  if (k === "age_gte" || k === "age_lte") {
    return (
      <span className="inline-flex items-center gap-1.5">
        {numInput("years", leaf.years)}
        <span className="text-[11px] text-muted-foreground">ans</span>
      </span>
    );
  }
  if (k === "cart_age_gte_days" || k === "cart_age_lte_days" || k === "account_age_gte_days" || k === "account_age_lte_days" || k === "birthday_anniversary") {
    const field = k === "birthday_anniversary" ? "daysBefore" : "days";
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {numInput(field, leaf[field], { min: 0 })}
        <span className="text-[11px] text-muted-foreground">jours{field === "daysBefore" ? " avant" : ""}</span>
      </span>
    );
  }
  if (k === "cart_item_count") {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <InlineSelect
          ariaLabel="Opérateur"
          width="w-20"
          value={String(leaf.op ?? "gte")}
          onChange={(v) => set({ op: v })}
          options={[{ value: "gte", label: "≥" }, { value: "lte", label: "≤" }, { value: "eq", label: "=" }]}
        />
        {numInput("count", leaf.count, { min: 0 })}
        <InlineSelect
          ariaLabel="Unité"
          width="w-28"
          value={leaf.distinct ? "1" : "0"}
          onChange={(v) => set({ distinct: v === "1" })}
          options={[{ value: "0", label: "articles" }, { value: "1", label: "lignes" }]}
        />
      </span>
    );
  }
  if (k === "gender") {
    return (
      <InlineSelect
        ariaLabel="Genre"
        width="w-32"
        value={String(leaf.value ?? "female")}
        onChange={(v) => set({ value: v })}
        options={(Object.keys(CUSTOMER_GENDER_LABELS) as Array<keyof typeof CUSTOMER_GENDER_LABELS>).map((g) => ({ value: g, label: CUSTOMER_GENDER_LABELS[g] }))}
      />
    );
  }
  // has_orders / no_orders / cart_has_items / birthday_month / birthday_today / marketing_opted_in — no params.
  return null;
}
