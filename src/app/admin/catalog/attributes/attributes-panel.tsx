"use client";

import Link from "next/link";
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { AdminPageHeader } from "@/components/admin/page-header";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { IconButton } from "@/components/admin/icon-button";
import { deleteAttributeAction } from "@/lib/actions/attribute";
import type { AttributeKind } from "@/modules/catalog/attribute/schema";

import { KIND_LABELS } from "./_kinds";

type AttributeSummary = {
  id: string;
  slug: string;
  name: string;
  kind: AttributeKind;
  displayOrder: number;
  isActive: boolean;
  valueCount: number;
};

export function AttributesPanel({
  attributes,
  canCreate = false,
  canDelete = false,
}: {
  attributes: AttributeSummary[];
  /** attributes:create — gates the « Nouveau » button. */
  canCreate?: boolean;
  /** attributes:delete — gates each card's delete control. */
  canDelete?: boolean;
}) {
  const [toDelete, setToDelete] = useState<AttributeSummary | null>(null);

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Attributs"
        description="Dimensions de filtre réutilisables (Matière, Mouvement, Étanchéité, Couleur, État…). Chaque attribut porte ses valeurs (ou une donnée par produit) ; les catégories — ou l'attribut lui-même — choisissent où il apparaît comme filtre."
        action={
          canCreate ? (
            <Link
              href="/admin/catalog/attributes/new"
              className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
            >
              <Plus className="h-4 w-4" /> Nouveau
            </Link>
          ) : undefined
        }
      />

      <div className="space-y-6">
        {attributes.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="space-y-3">
            {attributes.map((a) => (
              <AttributeCard
                key={a.id}
                attribute={a}
                onAskDelete={canDelete ? () => setToDelete(a) : null}
              />
            ))}
          </ul>
        )}
      </div>

      {toDelete && (
        <ConfirmDeleteModal
          title="Supprimer cet attribut ?"
          description="Les valeurs associées et les assignations produit seront perdues."
          preview={
            <div className="rounded-2xl border border-border bg-surface/40 p-2">
              <p className="text-xs font-semibold">{toDelete.name}</p>
              <p className="text-[11px] text-muted-foreground">
                /{toDelete.slug} · {toDelete.valueCount} valeur
                {toDelete.valueCount > 1 ? "s" : ""}
              </p>
            </div>
          }
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            const res = await deleteAttributeAction(toDelete.id);
            return res.ok ? null : (res.message ?? "Erreur");
          }}
        />
      )}
    </div>
  );
}

function AttributeCard({
  attribute,
  onAskDelete,
}: {
  attribute: AttributeSummary;
  /** null → the viewer lacks attributes:delete; the delete control is hidden. */
  onAskDelete: (() => void) | null;
}) {
  return (
    <li className="rounded-[22px] border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/admin/catalog/attributes/${attribute.id}`}
              className="text-[14.5px] font-bold text-foreground hover:text-primary"
            >
              {attribute.name}
            </Link>
            <code className="rounded-[8px] bg-surface px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              /{attribute.slug}
            </code>
            <KindChip kind={attribute.kind} />
            {!attribute.isActive && (
              <span className="inline-flex items-center rounded-full bg-[#f6f2ed] px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-[#5b5d62]">
                Inactif
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {valueLine(attribute)} · ordre {attribute.displayOrder}
          </p>
        </div>
        <div className="inline-flex items-center gap-1">
          <Link
            href={`/admin/catalog/attributes/${attribute.id}`}
            className="grid h-11 w-11 place-items-center rounded-[14px] bg-surface text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Modifier"
          >
            <Pencil className="h-4 w-4" />
          </Link>
          {onAskDelete && (
            <IconButton
              icon={<Trash2 className="h-4 w-4" />}
              aria-label="Supprimer"
              tone="danger"
              onClick={onAskDelete}
            />
          )}
        </div>
      </div>
    </li>
  );
}

/** Per-product types (number/text/boolean) have no value list to count. */
function valueLine(attribute: AttributeSummary): string {
  if (attribute.kind === "number" || attribute.kind === "text") {
    return "valeur par produit";
  }
  if (attribute.kind === "boolean") return "Oui / Non";
  return `${attribute.valueCount} valeur${attribute.valueCount > 1 ? "s" : ""}`;
}

function KindChip({ kind }: { kind: AttributeKind }) {
  return (
    <span className="inline-flex items-center rounded-full bg-[#fdecef] px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-[#d40530]">
      {KIND_LABELS[kind]}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-[22px] border border-dashed border-border bg-card p-12 text-center text-[14px] text-muted-foreground">
      Aucun attribut pour le moment. Créez-en un pour structurer les filtres du catalogue.
    </div>
  );
}
