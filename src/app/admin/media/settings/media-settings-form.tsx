"use client";

import { useActionState, useState } from "react";
import { Save } from "lucide-react";

import { updateMediaSettingsAction } from "@/lib/actions/catalog";
import {
  bakedMediaHostEntries,
  describeMediaHostEntry,
  isCdnBaseAllowed,
} from "@/modules/media/cdn-allowlist";
import { MAX_UPLOAD_MB_CEILING } from "@/modules/media/limits";
import { type ActionState } from "@/lib/actions/types";

import { ProductWhiteBgReprocess } from "./product-white-bg-reprocess";

type Initial = {
  generateWebp: boolean;
  generateAvif: boolean;
  keepOriginal: boolean;
  productWhiteBg: boolean;
  productWhiteBgMainOnly: boolean;
  stripExif: boolean;
  maxWidthPx: number;
  maxHeightPx: number;
  webpQuality: number;
  avifQuality: number;
  jpegQuality: number;
  maxUploadMb: number;
  defaultAltText: string | null;
  cdnBaseUrl: string | null;
};

export function MediaSettingsForm({ initial }: { initial: Initial }) {
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    updateMediaSettingsAction,
    null,
  );
  // fieldErrors only exists on the failure branch of the ActionState union.
  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;
  // Hosts next/image + the CSP were COMPILED with (build-time snapshot, see
  // modules/media/cdn-allowlist). A CDN base outside them is REFUSED on save by
  // updateMediaSettingsWorkflow (same isCdnBaseAllowed predicate) — such a base
  // would 400 every storefront image at next/image and be CSP-blocked — until it
  // is added to MEDIA_CDN_URL as a build argument and the image is rebuilt.
  const buildHosts = bakedMediaHostEntries();

  // FULLY CONTROLLED form. `<form action>` in React 19 RESETS its uncontrolled
  // fields once the action resolves — including on a FAILED save (which doesn't
  // revalidate), silently discarding the operator's edits (the exact failure this
  // matches the banner/blog/aid form-reset class). Driving every field from state
  // keeps edits across a validation error; a successful save revalidates so the
  // next render re-seeds `initial` with the persisted values (identical to state).
  const [form, setForm] = useState<Initial>(initial);
  const set = <K extends keyof Initial>(key: K, value: Initial[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const cdnDraft = form.cdnBaseUrl ?? "";
  const setCdnDraft = (v: string) => set("cdnBaseUrl", v);
  const cdnTrimmed = cdnDraft.trim();
  const cdnOutsideBuild =
    cdnTrimmed !== "" && isAbsoluteUrl(cdnTrimmed) && !isCdnBaseAllowed(cdnTrimmed, buildHosts);

  return (
    <form action={formAction} className="space-y-6">
      <section className="space-y-3 rounded-[28px] border border-border bg-card p-5">
        <h2 className="text-[18px] font-black text-foreground">
          Formats générés
        </h2>
        <p className="text-[13px] text-muted-foreground">
          Chaque format coche émet un fichier dérivé à côté de la source. Le storefront pioche
          automatiquement le plus petit format supporté par le navigateur.
        </p>

        <Toggle
          name="generate_webp"
          label="Générer le WebP"
          helper="Format le plus largement supporté (Chrome, Firefox, Safari 14+)."
          checked={form.generateWebp}
          onChange={(v) => set("generateWebp", v)}
        />
        <Toggle
          name="generate_avif"
          label="Générer l'AVIF"
          helper="~40% plus petit que le WebP. Supporté par les navigateurs modernes ; sinon fallback WebP."
          checked={form.generateAvif}
          onChange={(v) => set("generateAvif", v)}
        />
        <Toggle
          name="keep_original"
          label="Conserver l'original"
          helper="Stocke aussi le fichier source (utile pour re-traiter plus tard ou pour les GIF animés)."
          checked={form.keepOriginal}
          onChange={(v) => set("keepOriginal", v)}
        />
        <Toggle
          name="product_white_bg"
          label="Détourage automatique du fond uni (images produits)"
          helper="Rend transparent le fond UNI des packshots — blanc, noir ou gris, détecté automatiquement. Les zones intérieures de même couleur (cadran blanc, sous-cadran noir) sont préservées ; les photos d'ambiance / fonds texturés sont laissées intactes. S'applique uniquement aux images produits."
          checked={form.productWhiteBg}
          onChange={(v) => set("productWhiteBg", v)}
        />
        {/* Sub-option — only meaningful when détourage is on. Indented + disabled
            (greyed) when the parent toggle is off, so the dependency is obvious. */}
        <div className={`ml-8 ${form.productWhiteBg ? "" : "pointer-events-none opacity-45"}`}>
          <Toggle
            name="product_white_bg_main_only"
            label="Uniquement l'image PRINCIPALE de chaque produit"
            helper="Ne détoure que l'image principale (la première de la galerie), au moment de l'enregistrement du produit — les images secondaires gardent leur fond. Désactivé : toutes les images produits sont détourées à l'upload."
            checked={form.productWhiteBgMainOnly}
            onChange={(v) => set("productWhiteBgMainOnly", v)}
          />
        </div>
      </section>

      {/* Re-process existing product packshots — independent background job, not
          part of this form's submit (its own action + single-flight gate). */}
      <ProductWhiteBgReprocess />

      <section className="space-y-3 rounded-[28px] border border-border bg-card p-5">
        <h2 className="text-[18px] font-black text-foreground">
          Qualité &amp; dimensions
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField
            name="webp_quality"
            label="Qualité WebP (1-100)"
            min={30}
            max={100}
            value={form.webpQuality}
            onChange={(v) => set("webpQuality", v)}
            error={fieldErrors?.webp_quality}
          />
          <NumberField
            name="avif_quality"
            label="Qualité AVIF (1-100)"
            min={30}
            max={100}
            value={form.avifQuality}
            onChange={(v) => set("avifQuality", v)}
            error={fieldErrors?.avif_quality}
          />
          <NumberField
            name="jpeg_quality"
            label="Qualité JPEG (1-100)"
            min={30}
            max={100}
            value={form.jpegQuality}
            onChange={(v) => set("jpegQuality", v)}
            error={fieldErrors?.jpeg_quality}
          />
          <NumberField
            name="max_upload_mb"
            label={`Taille max upload (MB, max ${MAX_UPLOAD_MB_CEILING})`}
            min={1}
            max={MAX_UPLOAD_MB_CEILING}
            value={form.maxUploadMb}
            onChange={(v) => set("maxUploadMb", v)}
            error={fieldErrors?.max_upload_mb}
          />
          <NumberField
            name="max_width_px"
            label="Largeur max (px, 0 = pas de limite)"
            min={0}
            max={8000}
            value={form.maxWidthPx}
            onChange={(v) => set("maxWidthPx", v)}
            error={fieldErrors?.max_width_px}
          />
          <NumberField
            name="max_height_px"
            label="Hauteur max (px, 0 = pas de limite)"
            min={0}
            max={8000}
            value={form.maxHeightPx}
            onChange={(v) => set("maxHeightPx", v)}
            error={fieldErrors?.max_height_px}
          />
        </div>
      </section>

      <section className="space-y-3 rounded-[28px] border border-border bg-card p-5">
        <h2 className="text-[18px] font-black text-foreground">
          Vie privée &amp; livraison
        </h2>
        <Toggle
          name="strip_exif"
          label="Supprimer les métadonnées EXIF"
          helper="Retire la position GPS, modèle d'appareil, et autres traces du fichier source."
          checked={form.stripExif}
          onChange={(v) => set("stripExif", v)}
        />
        <div>
          <label
            htmlFor="default_alt_text"
            className="text-[13px] font-bold text-foreground"
          >
            Texte alternatif par défaut
          </label>
          <input
            id="default_alt_text"
            name="default_alt_text"
            value={form.defaultAltText ?? ""}
            onChange={(e) => set("defaultAltText", e.target.value)}
            maxLength={200}
            placeholder="Visuel Tokyo Store"
            className="mt-1 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] focus:border-foreground focus:bg-white focus:outline-none"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            Appliqué quand l&apos;admin ne saisit pas d&apos;alt text à l&apos;upload.
          </p>
        </div>
        <div>
          <label
            htmlFor="cdn_base_url"
            className="text-[13px] font-bold text-foreground"
          >
            URL de base CDN (optionnelle)
          </label>
          <input
            id="cdn_base_url"
            name="cdn_base_url"
            type="url"
            // Controlled (not defaultValue) so the build-host warning always
            // matches what is in the field, including after the form resets.
            value={cdnDraft}
            onChange={(e) => setCdnDraft(e.target.value)}
            placeholder="https://cdn.tokyostore.tn"
            aria-describedby={cdnOutsideBuild ? "cdn_base_url_build_warning" : undefined}
            className="mt-1 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] focus:border-foreground focus:bg-white focus:outline-none"
          />
          {fieldErrors?.cdn_base_url && (
            <p className="mt-1 text-[11px] font-medium text-destructive">
              {fieldErrors.cdn_base_url}
            </p>
          )}
          {cdnOutsideBuild && (
            <p
              id="cdn_base_url_build_warning"
              role="status"
              className="mt-1 rounded-[12px] border border-[#f3e3bd] bg-[#fff4e0] px-3 py-2 text-[11px] text-[#b45309]"
            >
              Cet hôte n&apos;est pas dans la liste compilée avec l&apos;application :
              l&apos;enregistrement sera <strong className="font-bold">refusé</strong> tant que cet
              hôte n&apos;aura pas été ajouté à{" "}
              <code className="rounded bg-card px-1">MEDIA_CDN_URL</code> en argument de build puis
              l&apos;image reconstruite — un simple redémarrage ne suffit pas.
            </p>
          )}
          <p className="mt-1 text-[10px] text-muted-foreground">
            Mécanisme CDN actif : quand renseignée, toutes les URLs média publiques sont servies
            via ce domaine (<code className="rounded bg-card px-1">{"<base>/<clé>"}</code>) au lieu
            du proxy same-origin <code className="rounded bg-card px-1">/cdn</code>. Laisser vide
            pour servir en same-origin (la variable d&apos;env{" "}
            <code className="rounded bg-card px-1">MEDIA_CDN_URL</code> sert de repli si ce champ
            est vide). Hôtes autorisés par ce build (next/image + CSP) :{" "}
            {buildHosts.length > 0 ? (
              buildHosts.map((h, i) => (
                <span key={`${i}-${describeMediaHostEntry(h)}`}>
                  {i > 0 && ", "}
                  <code className="rounded bg-card px-1">{describeMediaHostEntry(h)}</code>
                </span>
              ))
            ) : (
              <span>aucun</span>
            )}
            . Ajouter un hôte exige de le passer dans{" "}
            <code className="rounded bg-card px-1">MEDIA_CDN_URL</code> comme argument de build puis
            de reconstruire l&apos;image.
          </p>
        </div>
      </section>

      {state && !state.ok && (
        <div className="rounded-[14px] border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          {state.message}
        </div>
      )}
      {state?.ok && (
        <div className="rounded-[14px] border border-primary/40 bg-primary/5 p-3 text-xs text-primary">
          {state.message}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground transition hover:bg-[#b8042a] disabled:opacity-60"
      >
        <Save className="h-4 w-4" />
        {isPending ? "Enregistrement…" : "Enregistrer les réglages"}
      </button>
    </form>
  );
}

/** Parseable absolute URL? (Unparseable input is left to the server validation.) */
function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function Toggle({
  name,
  label,
  helper,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  helper?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-5 w-5 accent-[var(--primary)]"
      />
      <span>
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {helper && <span className="block text-[11px] text-muted-foreground">{helper}</span>}
      </span>
    </label>
  );
}

function NumberField({
  name,
  label,
  min,
  max,
  value,
  onChange,
  error,
}: {
  name: string;
  label: string;
  min?: number;
  max?: number;
  value: number;
  onChange: (v: number) => void;
  error?: string;
}) {
  const id = `f-${name}`;
  return (
    <div>
      <label
        htmlFor={id}
        className="text-[13px] font-bold text-foreground"
      >
        {label}
      </label>
      <input
        id={id}
        name={name}
        type="number"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? 0 : Math.trunc(Number(e.target.value)))}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className="mt-1 h-11 w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] focus:border-foreground focus:bg-white focus:outline-none"
      />
      {error && (
        <p id={`${id}-error`} className="mt-1 text-[11px] font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
