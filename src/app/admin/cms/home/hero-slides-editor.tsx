"use client";

import { useState } from "react";
import { ImageIcon, Pencil, Plus, Trash2, X } from "lucide-react";

import { BannerForm, type BannerFormInitial, type BannerTargetOptions } from "@/components/admin/banner-form";
import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { IconButton } from "@/components/admin/icon-button";
import { AdminNote } from "@/components/admin/_components/filter-bar";
import { deleteBannerAction } from "@/lib/actions/cms";

/** The hero has no in-grid targeting; BannerForm still requires the option lists. */
const NO_TARGETS: BannerTargetOptions = { categories: [], brands: [], filters: [] };
/** After a save/delete the operator stays on « Page d'accueil ». */
const SUCCESS_HREF = "/admin/cms/home";

/**
 * Hero carousel editor — lives in « Contenu & Design → Page d'accueil » (the hero
 * slides used to be edited in « Bannières », now removed). Each slide is a
 * `home_hero` banner with the full feature set: separate desktop + mobile images
 * (médiathèque), a link (or an optional text/button overlay), scheduling and
 * ordering. Reuses the shared BannerForm (locked to the hero placement) for
 * create + inline edit, and deleteBannerAction for removal. When no slide is
 * configured the storefront carousel falls back to the built-in artwork.
 */
export function HeroSlidesEditor({
  slides,
  thumbs,
}: {
  /** The home_hero banners, ordered by display order (the carousel order). */
  slides: BannerFormInitial[];
  /** mediaId → resolved thumbnail URL, for the row previews. */
  thumbs: Record<string, string>;
}) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<BannerFormInitial | null>(null);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-black text-foreground">Carrousel d&apos;accueil</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Les diapositives du grand carrousel en haut de la page d&apos;accueil. Image
            bureau + image mobile (médiathèque), lien, programmation et ordre d&apos;affichage.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setCreating((v) => !v);
            setEditingId(null);
          }}
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
        >
          {creating ? (
            <>
              <X className="h-4 w-4" /> Fermer
            </>
          ) : (
            <>
              <Plus className="h-4 w-4" /> Ajouter une diapositive
            </>
          )}
        </button>
      </div>

      {slides.length === 0 && (
        <AdminNote className="max-w-3xl">
          Aucune diapositive configurée : le carrousel affiche les 4 visuels par défaut.
          Ajoutez vos propres diapositives pour les remplacer.
        </AdminNote>
      )}

      {creating && (
        <div className="rounded-[22px] border border-border bg-card p-4 sm:p-6">
          <BannerForm
            mode="create"
            lockPlacement="home_hero"
            successHref={SUCCESS_HREF}
            targetOptions={NO_TARGETS}
          />
        </div>
      )}

      {slides.length > 0 && (
        <ul className="space-y-3">
          {slides.map((s, i) =>
            editingId === s.id ? (
              <li key={s.id} className="rounded-[22px] border border-primary/30 bg-card p-4 sm:p-6">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-[13px] font-bold text-foreground">Modifier la diapositive</p>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-3 text-[13px] font-semibold text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" /> Fermer
                  </button>
                </div>
                <BannerForm
                  mode="edit"
                  initial={s}
                  lockPlacement="home_hero"
                  successHref={SUCCESS_HREF}
                  targetOptions={NO_TARGETS}
                />
              </li>
            ) : (
              <SlideRow
                key={s.id}
                slide={s}
                index={i}
                thumb={s.imageMediaId ? thumbs[s.imageMediaId] : undefined}
                onEdit={() => {
                  setEditingId(s.id);
                  setCreating(false);
                }}
                onDelete={() => setToDelete(s)}
              />
            ),
          )}
        </ul>
      )}

      {toDelete && (
        <ConfirmDeleteModal
          title="Supprimer cette diapositive ?"
          description="La diapositive disparaîtra immédiatement du carrousel."
          preview={
            <div className="rounded-[14px] border border-border bg-[#fbf9f8] p-3 text-[13px]">
              <p className="font-bold">{toDelete.title || toDelete.name}</p>
            </div>
          }
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            const res = await deleteBannerAction(toDelete.id);
            return res.ok ? null : (res.message ?? "Erreur");
          }}
        />
      )}
    </section>
  );
}

function SlideRow({
  slide,
  index,
  thumb,
  onEdit,
  onDelete,
}: {
  slide: BannerFormInitial;
  index: number;
  thumb: string | undefined;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const scheduled = slide.startAt || slide.endAt;
  return (
    <li className="flex items-center gap-4 rounded-[18px] border border-border bg-card p-3 transition hover:bg-[#fffbfb]">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-[12px] font-black tabular-nums text-foreground">
        {index + 1}
      </span>
      <div className="grid h-14 w-24 shrink-0 place-items-center overflow-hidden rounded-[12px] border border-border bg-[#fbf9f8]">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="h-full w-full object-cover" />
        ) : (
          <ImageIcon className="h-5 w-5 text-muted-foreground" aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-bold text-foreground">
          {slide.title || slide.name || "Diapositive"}
        </p>
        <p className="text-[12px] text-muted-foreground">
          {slide.showText ? "Texte superposé" : "Image pleine + lien"}
          {!slide.isActive && " · désactivée"}
          {slide.imageMobileMediaId && " · image mobile"}
        </p>
        {scheduled && (
          <p className="text-[12px] text-muted-foreground">
            {slide.startAt ? new Date(slide.startAt).toLocaleString("fr-FR") : "—"}
            {" → "}
            {slide.endAt ? new Date(slide.endAt).toLocaleString("fr-FR") : "—"}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onEdit}
          aria-label="Modifier"
          className="grid h-11 w-11 place-items-center rounded-[14px] bg-surface text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <Pencil className="h-4 w-4" />
        </button>
        <IconButton icon={<Trash2 className="h-4 w-4" />} aria-label="Supprimer" tone="danger" onClick={onDelete} />
      </div>
    </li>
  );
}
