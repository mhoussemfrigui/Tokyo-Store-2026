"use client";

import { useState, useTransition } from "react";
import { Loader2, Lock, Plus } from "lucide-react";

import { ConfirmDeleteModal } from "@/components/admin/confirm-delete-modal";
import { BannerForm, type BannerFormInitial, type BannerTargetOptions } from "@/components/admin/banner-form";
import { AdminCallout, AdminNote } from "@/components/admin/_components/filter-bar";
import { FooterContentForm } from "./footer-content-form";
import {
  createNavItemAction,
  createNavMenuAction,
  deleteNavItemAction,
  restoreFooterColumnsAction,
} from "@/lib/actions/cms";
import { MAISON_EXPLORE_DEFAULTS, MAISON_EXPLORE_MENU_KEY } from "@/lib/cms/nav-menus";
import {
  MenuCard,
  itemDestination,
  type Menu,
  type NavItem,
  type NavTargets,
} from "../_components/nav-menu-editor";

/**
 * Footer admin — full control of the FOOTER: the three footer column menus
 * (`footer-shop` / `footer-support` / `footer-society`), the « Explorer la
 * maison » index shown at the foot of the Maison & legal pages
 * (`maison-explore`) and the footer / newsletter banner (`footer` placement).
 * The Kawn copyright line is
 * intentionally NOT editable here — it's a contractual attribution hardcoded
 * in `src/components/kawn-attribution.tsx`.
 */
export function FooterPanel({
  menus,
  missingColumns,
  exploreMenu,
  targets,
  footerBanner,
  bannerTargetOptions,
  settingsValues,
  canEditIdentity,
}: {
  menus: Menu[];
  /** Fixed footer column keys with no menu row yet (+ their default title). */
  missingColumns: { key: string; title: string }[];
  /** The `maison-explore` menu (+ items), or null when its row is missing. */
  exploreMenu: Menu | null;
  targets: NavTargets;
  /** Existing `footer`-placement banner (singleton), or null when none yet. */
  footerBanner: BannerFormInitial | null;
  bannerTargetOptions: BannerTargetOptions;
  /** site./social./storefront.footer. values that pre-fill the content form. */
  settingsValues: Record<string, string>;
  /** Viewer holds settings_site:view → show + allow the identity/apparence form.
   *  A navigation-only editor still manages columns / explore / banner below. */
  canEditIdentity: boolean;
}) {
  const [toDelete, setToDelete] = useState<NavItem | null>(null);

  return (
    <div className="space-y-8">
      <AdminNote className="max-w-3xl">
        Tout le pied de page de la boutique : identité, coordonnées, réseaux,
        colonnes de liens et apparence — appliqués en direct sur la vitrine. La
        ligne de copyright (attribution Kawn Digital Studio) est fixe et non
        modifiable.
      </AdminNote>

      {/* ── Contenu & apparence (identité / coordonnées / réseaux / aspect) ──
          Identity data is `settings_site` — shown only to a viewer who holds that
          grant (a navigation-only editor still manages the nav-owned parts below). */}
      {canEditIdentity && (
        <section className="space-y-4">
          <div>
            <h2 className="text-[18px] font-black text-foreground">Contenu &amp; apparence</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Le logo, le nom, les coordonnées et les réseaux sont partagés avec l&apos;en-tête,
              la facture et le SEO — les modifier ici les met à jour partout.
            </p>
          </div>
          <div className="rounded-[28px] border border-border bg-card p-4 sm:p-6">
            <FooterContentForm values={settingsValues} />
          </div>
        </section>
      )}

      {/* ── Footer column menus ───────────────────────────────────────── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-[18px] font-black text-foreground">Colonnes du footer</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Les colonnes de liens du pied de page (Boutique, Tokyo Store, Légal).
            « Renommer » change le titre affiché, et chaque lien s&apos;ajoute, se
            réordonne ou se masque ici — appliqué en direct sur la boutique. Une
            colonne sans lien visible n&apos;est pas affichée. Une 4ᵉ colonne « Blog »
            est générée automatiquement à partir de vos catégories de blog. La
            colonne « Légal » alimente aussi la rangée légale en bas de page.
          </p>
        </div>
        {missingColumns.length > 0 && (
          <CreateFooterColumns missing={missingColumns} noneExist={menus.length === 0} />
        )}
        {menus.length > 0 && (
          <div className="space-y-4">
            {menus.map((m) => (
              <MenuCard
                key={m.id}
                menu={m}
                targets={targets}
                onAskDelete={setToDelete}
                // Footer columns are fixed system menus — items editable and
                // the title renamable, but never deleted.
                allowRename
              />
            ))}
          </div>
        )}
      </section>

      {/* ── « Explorer la maison » index ─────────────────────────────── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-[18px] font-black text-foreground">
            Explorer la maison — pied des pages Maison &amp; légales
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            L&apos;index affiché en bas de Notre histoire, Nos boutiques, Service client, CGV,
            Confidentialité, Aide… (menu <code>{MAISON_EXPLORE_MENU_KEY}</code>). « Renommer »
            règle le surtitre et le titre ; chaque lien a un sous-titre optionnel. La page en
            cours y reste signalée « Vous êtes ici » ; sans lien visible, l&apos;index est masqué.
          </p>
        </div>
        {exploreMenu ? (
          <>
            {exploreMenu.items.length === 0 && <SeedMaisonExplore menuId={exploreMenu.id} />}
            <MenuCard
              menu={exploreMenu}
              targets={targets}
              onAskDelete={setToDelete}
              allowRename
              showDescription
            />
          </>
        ) : (
          <SeedMaisonExplore menuId={null} />
        )}
      </section>

      {/* ── Footer / newsletter banner ────────────────────────────────── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-[18px] font-black text-foreground">
            Bandeau / Newsletter
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Bandeau d&apos;inscription à la newsletter (surtitre / titre / sous-titre +
            libellé du bouton). Le pied de page principal de la boutique n&apos;affiche
            pas de newsletter ; ce bandeau apparaît sur les pages secondaires qui
            l&apos;utilisent. Laisser inactif le masque.
          </p>
        </div>
        <div className="rounded-[28px] border border-border bg-card p-4 sm:p-6">
          <BannerForm
            mode={footerBanner ? "edit" : "create"}
            lockPlacement="footer"
            initial={footerBanner ?? undefined}
            targetOptions={bannerTargetOptions}
          />
        </div>
      </section>

      {/* ── Copyright note (read-only) ────────────────────────────────── */}
      <section>
        <AdminCallout tone="info" icon={Lock} title="Copyright — non modifiable">
          <p className="mt-1">
            La ligne « © {new Date().getFullYear()} Tokyo Store » et
            l&apos;attribution « Propulsé par Kawn Digital Studio » sont fixes
            (engagement contractuel) et ne se règlent pas ici.
          </p>
        </AdminCallout>
      </section>

      {toDelete && (
        <ConfirmDeleteModal
          title="Supprimer cet item ?"
          description="Le lien sera retiré du menu. Les sous-items éventuels seront supprimés également."
          preview={
            <div className="rounded-[14px] border border-border bg-[#fbf9f8] p-3 text-[13px]">
              <p className="font-bold">{toDelete.label}</p>
              <p className="text-[12px] text-muted-foreground">{itemDestination(toDelete)}</p>
            </div>
          }
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            const res = await deleteNavItemAction(toDelete.id);
            return res.ok ? null : (res.message ?? "Erreur");
          }}
        />
      )}
    </div>
  );
}

/**
 * One-click (re)creation of the fixed-key footer column menus — the only way
 * they come back after a fresh non-demo install or a « Nettoyer › Navigation »
 * (nothing creates them at boot). Mirrors the header's CreateMainMenu: each
 * missing key is created through createNavMenuAction with its default title,
 * then the page revalidates and the column editors appear (empty — add links).
 */
function CreateFooterColumns({
  missing,
  noneExist,
}: {
  missing: { key: string; title: string }[];
  noneExist: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const create = () => {
    setError(null);
    startTransition(async () => {
      // One call: the boot-time seeder (re)creates every missing footer column
      // WITH its built-in links (idempotent — existing menus are untouched), so a
      // one-click restore brings back the full columns, not empty shells.
      const res = await restoreFooterColumnsAction();
      if (!res.ok) setError(res.message ?? "Erreur");
    });
  };

  return (
    <div
      className={`rounded-[22px] border border-dashed border-border bg-[#fbf9f8] text-center ${
        noneExist ? "p-10" : "p-5"
      }`}
    >
      <p className="text-[14px] text-muted-foreground">
        {noneExist
          ? "Aucune colonne de footer n'existe : le pied de page n'affiche aucun lien."
          : `Colonne${missing.length > 1 ? "s" : ""} manquante${missing.length > 1 ? "s" : ""} : ${missing
              .map((c) => c.title)
              .join(", ")}.`}
      </p>
      <button
        type="button"
        onClick={create}
        disabled={pending}
        className="mt-4 inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        {pending
          ? "Création…"
          : noneExist
            ? "Créer les colonnes du footer"
            : "Créer les colonnes manquantes"}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-[14px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * One-click (re)creation of the « Explorer la maison » index. With no menu row
 * (it is seeded at boot, so only a failed boot seed gets here) it creates the
 * menu with its built-in surtitre + titre; once the menu exists but is empty
 * (e.g. after « Nettoyer › Navigation ») it inserts the built-in links. Each
 * write goes through the regular nav server actions (validation + audit).
 */
function SeedMaisonExplore({ menuId }: { menuId: string | null }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    startTransition(async () => {
      if (!menuId) {
        const fd = new FormData();
        fd.set("key", MAISON_EXPLORE_MENU_KEY);
        fd.set("name", MAISON_EXPLORE_DEFAULTS.name);
        fd.set("description", MAISON_EXPLORE_DEFAULTS.description);
        const res = await createNavMenuAction(null, fd);
        // A concurrent create of the same key is fine — the menu exists.
        if (!res.ok && res.error !== "conflict") setError(res.message ?? "Erreur");
        return;
      }
      let order = 0;
      for (const item of MAISON_EXPLORE_DEFAULTS.items) {
        const fd = new FormData();
        fd.set("menuId", menuId);
        fd.set("label", item.label);
        fd.set("description", item.hint);
        fd.set("linkKind", "url");
        fd.set("linkValue", item.href);
        fd.set("displayOrder", String(order++));
        fd.set("isVisible", "on");
        const res = await createNavItemAction(null, fd);
        if (!res.ok) {
          setError(res.message ?? "Erreur");
          return;
        }
      }
    });
  };

  return (
    <div className="rounded-[22px] border border-dashed border-border bg-[#fbf9f8] p-5 text-center">
      <p className="text-[14px] text-muted-foreground">
        {menuId
          ? "L'index ne contient aucun lien : il n'est pas affiché sur la boutique."
          : "Le menu « Explorer la maison » n'existe pas encore."}
      </p>
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="mt-4 inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        {pending
          ? "Création…"
          : menuId
            ? `Insérer les ${MAISON_EXPLORE_DEFAULTS.items.length} liens par défaut`
            : "Créer l'index « Explorer la maison »"}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-[14px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
