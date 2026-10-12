"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";
import { ArrowUpRight, FileText, Info, LayoutTemplate, Plus, Trash2 } from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { IconButton } from "@/components/admin/icon-button";
import { AdminKpiStrip } from "@/components/admin/kpi-strip";
import { AdminCallout, AdminNote } from "@/components/admin/_components/filter-bar";
import {
  createPageAction,
  deletePageAction,
  togglePagePublishAction,
} from "@/lib/actions/cms";
import { type ActionState } from "@/lib/actions/types";

type Page = {
  id: string;
  slug: string;
  title: string;
  isPublished: boolean;
  isSystem: boolean;
  publishedAt: string | null;
};

/**
 * Section landings that LOOK like pages but are block-built in their own admin section —
 * the Pages admin points to them instead of duplicating them (they are NOT CMS pages).
 */
const SECTION_LANDINGS = [
  { slug: "boutique", label: "Boutique", href: "/admin/catalog/categories", hint: "Onglet « Page Boutique »" },
  { slug: "marques", label: "Marques", href: "/admin/catalog/brands", hint: "Onglet « Page Marques »" },
];

export function PagesPanel({ pages }: { pages: Page[] }) {
  const [creating, setCreating] = useState(false);
  const [toDelete, setToDelete] = useState<Page | null>(null);
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    createPageAction,
    null,
  );
  const fieldErr = (key: string) => (state && !state.ok ? state.fieldErrors?.[key] : undefined);
  const system = pages.filter((p) => p.isSystem);
  const custom = pages.filter((p) => !p.isSystem);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <AdminNote className="max-w-3xl">
          Toutes les pages de contenu du site — éditables ici avec le <strong>système de blocs</strong>
          {" "}(texte, en-tête, éditorial, chiffres, chronologie, galerie, FAQ…). Cliquez une carte
          pour composer la page.
        </AdminNote>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
        >
          <Plus className="h-4 w-4" />
          {creating ? "Fermer" : "Nouvelle page"}
        </button>
      </div>

      {/* Operator instructions */}
      <AdminCallout tone="info" icon={Info}>
        <div className="space-y-1.5">
          <p>
            <strong className="text-foreground">Pages système</strong> (légales, aide, Maison) — modifiables
            mais non supprimables, slug verrouillé (leur URL est câblée au site). Elles affichent un
            contenu par défaut tant qu&apos;aucune version n&apos;est publiée, donc ne restent jamais vides.
          </p>
          <p>
            <strong className="text-foreground">Pages personnalisées</strong> — créez-en autant que voulu ;
            leur URL est <code className="rounded bg-surface px-1">/le-slug</code>. Un slug déjà utilisé par
            une catégorie, une marque, un produit ou une autre page est refusé.
          </p>
          <p>
            <strong className="text-foreground">Gérées ailleurs</strong> — Boutique et Marques
            sont des pages « vitrine » composées dans leur propre section (voir plus bas).
          </p>
        </div>
      </AdminCallout>

      <AdminKpiStrip
        items={[
          { label: "Total", value: pages.length, tone: "default" },
          { label: "Publiées", value: pages.filter((p) => p.isPublished).length, tone: "success" },
          { label: "Système", value: system.length, tone: "info" },
          { label: "Personnalisées", value: custom.length, tone: "muted" },
        ]}
      />

      {creating && (
        <form action={formAction} className="space-y-3 rounded-[28px] border border-border bg-card p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field name="title" label="Titre" required error={fieldErr("title")} />
            <Field name="slug" label="Slug (URL)" required placeholder="ex: a-propos" error={fieldErr("slug")} />
            {/* metaTitle/metaDescription are optional with no validation rules → no field error. */}
            <Field name="metaTitle" label="Meta title (SEO)" />
            <Field name="metaDescription" label="Meta description" />
          </div>
          <AdminNote>
            La page est créée en <strong>brouillon</strong>. Ajoutez des blocs dans l&apos;éditeur,
            puis publiez-la.
          </AdminNote>
          {state && !state.ok && <p className="text-[13px] text-destructive">{state.message}</p>}
          {state?.ok && <p className="text-[13px] text-primary">{state.message}</p>}
          <div className="flex gap-2 pt-2">
            <button type="submit" disabled={isPending} className="inline-flex h-11 items-center rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60">
              {isPending ? "Création…" : "Créer"}
            </button>
            <button type="button" onClick={() => setCreating(false)} className="inline-flex h-11 items-center rounded-full border-[1.5px] border-input bg-card px-4 text-[14px] font-bold text-foreground hover:bg-surface">
              Annuler
            </button>
          </div>
        </form>
      )}

      {system.length > 0 && (
        <Section title="Pages système">
          <CardGrid>
            {system.map((p) => (
              <PageCard key={p.id} page={p} onAskDelete={() => setToDelete(p)} />
            ))}
          </CardGrid>
        </Section>
      )}

      <Section title="Pages personnalisées">
        {custom.length > 0 ? (
          <CardGrid>
            {custom.map((p) => (
              <PageCard key={p.id} page={p} onAskDelete={() => setToDelete(p)} />
            ))}
          </CardGrid>
        ) : (
          <div className="rounded-[16px] border border-dashed border-border bg-[#fbf9f8] p-10 text-center text-[14px] text-muted-foreground">
            Aucune page personnalisée. Cliquez « Nouvelle page » pour en créer une.
          </div>
        )}
      </Section>

      <Section title="Gérées ailleurs (pages vitrine)">
        <CardGrid>
          {SECTION_LANDINGS.map((s) => (
            <Link
              key={s.slug}
              href={s.href}
              className="group flex flex-col justify-between rounded-[22px] border border-dashed border-border bg-[#fbf9f8] p-4 transition-colors hover:border-primary/40 hover:bg-card"
            >
              <div className="flex items-start justify-between">
                <span className="grid h-9 w-9 place-items-center rounded-[12px] bg-surface text-muted-foreground group-hover:text-foreground">
                  <LayoutTemplate className="h-4 w-4" />
                </span>
                <ArrowUpRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-foreground" />
              </div>
              <div className="mt-3">
                <p className="text-[14px] font-bold text-foreground">{s.label}</p>
                <p className="text-[12px] text-muted-foreground">/{s.slug} · {s.hint}</p>
              </div>
            </Link>
          ))}
        </CardGrid>
      </Section>

      {toDelete && (
        <ConfirmDeleteModal
          title="Supprimer cette page ?"
          description="La page et son contenu seront retirés du site et de cette liste. Son slug reste réservé : il ne pourra pas être réutilisé par une nouvelle page."
          preview={
            <div className="rounded-[14px] border border-border bg-[#fbf9f8] p-3 text-[13px]">
              <p className="font-bold">{toDelete.title}</p>
              <p className="text-[12px] text-muted-foreground">/{toDelete.slug}</p>
            </div>
          }
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            const res = await deletePageAction(toDelete.id);
            return res.ok ? null : (res.message ?? "Erreur");
          }}
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h2 className="text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">{title}</h2>
      {children}
    </section>
  );
}

function CardGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

function PageCard({ page, onAskDelete }: { page: Page; onAskDelete: () => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="group relative flex flex-col justify-between rounded-[22px] border border-border bg-card p-4 transition-shadow hover:shadow-[0_10px_30px_-18px_rgba(0,0,0,0.3)]">
      <Link href={`/admin/cms/pages/${page.id}`} className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[12px] bg-surface text-muted-foreground group-hover:text-foreground">
          <FileText className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] font-bold text-foreground group-hover:underline">{page.title}</span>
            {page.isSystem && (
              <span className="shrink-0 rounded-full bg-[#f6f2ed] px-2.5 py-1 text-[11px] font-bold text-[#5b5d62]">Système</span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">/{page.slug}</span>
        </span>
      </Link>
      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const res = await togglePagePublishAction(page.id, !page.isPublished);
              if (!res.ok) setError(res.message || "La modification n'a pas pu être enregistrée.");
            })
          }
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold transition ${page.isPublished ? "bg-[#eaf7ee] text-[#15803d]" : "bg-[#fff4e0] text-[#b45309]"}`}
        >
          {page.isPublished ? "Publiée" : "Brouillon"}
        </button>
        {!page.isSystem && (
          <IconButton icon={<Trash2 className="h-4 w-4" />} aria-label="Supprimer" tone="danger" onClick={onAskDelete} />
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-[12px] font-bold text-destructive">{error}</p>}
    </div>
  );
}

function Field({ name, label, required, placeholder, error }: { name: string; label: string; required?: boolean; placeholder?: string; error?: string }) {
  const id = `f-${name}`;
  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-bold text-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </label>
      <input
        id={id}
        name={name}
        required={required}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        className={`mt-2 h-11 w-full rounded-[14px] border-[1.5px] bg-[#fbf9f8] px-4 text-[15px] transition focus:border-foreground focus:bg-white focus:outline-none ${error ? "border-destructive" : "border-input"}`}
      />
      {error && <p className="mt-1 text-[12px] text-destructive">{error}</p>}
    </div>
  );
}
