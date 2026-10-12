"use client";

import { useActionState, useState } from "react";
import { Loader2, Save } from "lucide-react";

import { FieldSection, SelectField } from "@/components/admin/_components/setting-fields";
import { AdminNote } from "@/components/admin/_components/filter-bar";
import { MediaPicker } from "@/components/admin/media-picker";
import { saveThemeSettingsAction } from "@/lib/actions/theme";
import { type ActionState } from "@/lib/actions/types";
import { ColorField } from "./color-field";

// Mirrors THEME_FONT_STACKS keys in src/lib/theme/config.ts (kept here as a
// plain list so this client component doesn't import the server-only config).
// The default keeps the live store's bundled Figtree body + Outfit headings (its
// value stays `manrope` for the settings already stored under that key).
const FONT_OPTIONS = [
  { value: "manrope", label: "Figtree + Outfit (défaut)" },
  { value: "system", label: "Système (rapide, natif)" },
  { value: "geometric", label: "Géométrique" },
  { value: "rounded", label: "Arrondie" },
  { value: "serif", label: "Serif" },
];

const DARK_OPTIONS = [
  { value: "off", label: "Désactivé (clair uniquement)" },
  { value: "system", label: "Selon l'appareil du visiteur" },
  { value: "on", label: "Activé (sombre par défaut)" },
];

// Admin UI font (body/interface + section headings — the sans default).
const ADMIN_FONT_OPTIONS = [
  { value: "montserrat", label: "Figtree (défaut)" },
  { value: "system", label: "Système (rapide, natif)" },
  { value: "geometric", label: "Géométrique" },
  { value: "rounded", label: "Arrondie" },
  { value: "serif", label: "Serif" },
];

// Admin display/title font (brand, page title, greeting, KPI numbers).
const ADMIN_HEADING_FONT_OPTIONS = [
  { value: "playfair", label: "Figtree (défaut)" },
  { value: "serif", label: "Serif (système)" },
  { value: "system", label: "Système (sans)" },
  { value: "geometric", label: "Géométrique" },
  { value: "rounded", label: "Arrondie" },
];

// The default base radius (px) — mirrors THEME_DEFAULTS.radiusBasePx and the
// live `.tokyo` 1.25rem. The slider has no "unset" position, so when it sits at
// the default we submit BLANK (not "20") — otherwise every Save, even one that
// only changes a colour, would persist theme.border_radius_base=20 and inject
// `.storefront{--radius:20px}`, rescaling the legacy storefront's 12px corners.
// Blank ⇒ the key stays unset ⇒ each scope keeps its own default.
const DEFAULT_RADIUS = 20;

export function ThemePanel({ values }: { values: Record<string, string> }) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveThemeSettingsAction,
    null,
  );
  const v = (k: string) => values[k] ?? "";

  // Live-preview state (mirrored from the inputs; submission stays in each field).
  // Fallbacks = the effective .tokyo defaults, so the preview matches a blank form.
  const [primary, setPrimary] = useState(v("theme.primary_color") || "#d40530");
  const [primaryFg, setPrimaryFg] = useState(v("theme.primary_foreground") || "#ffffff");
  const [accent, setAccent] = useState(v("theme.accent_color") || "#886E5C");
  const [accentFg, setAccentFg] = useState(v("theme.accent_foreground") || "#ffffff");
  const [foreground, setForeground] = useState(v("theme.foreground_color") || "#0e1218");
  const [radius, setRadius] = useState(() => {
    // Mirrors radiusPx (lib/theme/config.ts): a stored 0 (square corners) is
    // kept; only a blank / invalid value means the default. The slider shows the
    // default, but at the default the hidden input below submits BLANK (see
    // DEFAULT_RADIUS) so an untouched Save never materialises the key.
    const raw = v("theme.border_radius_base").trim();
    const n = Number(raw);
    return raw !== "" && Number.isFinite(n) ? Math.min(28, Math.max(0, Math.round(n))) : DEFAULT_RADIUS;
  });

  return (
    <form action={formAction} className="space-y-6">
      <AdminNote className="max-w-3xl">
        Couleurs, arrondis, police et favicon de la vitrine — appliqués en direct
        sur tout le site. Laissez un champ vide pour conserver la valeur par défaut.
      </AdminNote>

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-6">
          <FieldSection title="Couleurs" description="La couleur principale (boutons et surfaces principales), l'accent (promos, badges) et la couleur du texte de marque. Les couleurs « Texte sur… » règlent la lisibilité du libellé posé SUR ces fonds (ex. texte des boutons).">
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField name="theme.primary_color" label="Couleur principale" defaultValue={v("theme.primary_color")} placeholder="#d40530" onValueChange={setPrimary} helper="Boutons, CTA, prix. Vide = crimson Tokyo." />
              <ColorField name="theme.primary_foreground" label="Texte sur couleur principale" defaultValue={v("theme.primary_foreground")} placeholder="#ffffff" onValueChange={setPrimaryFg} helper="Texte/icônes sur les boutons principaux. Vide = blanc." />
              <ColorField name="theme.accent_color" label="Couleur d'accent" defaultValue={v("theme.accent_color")} placeholder="#886E5C" onValueChange={setAccent} helper="Accents des pages éditoriales (filets, icônes). Vide = défaut." />
              <ColorField name="theme.accent_foreground" label="Texte sur couleur d'accent" defaultValue={v("theme.accent_foreground")} placeholder="#ffffff" onValueChange={setAccentFg} helper="Texte/icônes sur les surfaces d'accent. Vide = blanc." />
              <ColorField name="theme.foreground_color" label="Couleur du texte" defaultValue={v("theme.foreground_color")} placeholder="#0e1218" onValueChange={setForeground} helper="Texte principal (titres, contenu). Vide = encre." />
            </div>
          </FieldSection>

          <FieldSection title="Forme & typographie" description="L'arrondi de base rééchelonne toutes les cartes/boutons ; la police s'applique à toute la vitrine.">
            <div>
              <label htmlFor="radius-range" className="flex items-center justify-between text-[13px] font-bold text-foreground">
                <span>Arrondi de base</span>
                <span className="font-mono tabular-nums text-foreground">{radius}px</span>
              </label>
              <input
                id="radius-range"
                type="range"
                min={0}
                max={28}
                step={1}
                value={radius}
                onChange={(e) => setRadius(Number(e.target.value))}
                className="mt-2 w-full accent-[var(--primary)]"
              />
              {/* Submit BLANK at the default so an untouched Save doesn't persist
                  the key (which would rescale the legacy .storefront corners). */}
              <input
                type="hidden"
                name="theme.border_radius_base"
                value={radius === DEFAULT_RADIUS ? "" : radius}
              />
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                20px = défaut. 0 = anguleux, 28 = très arrondi.
              </p>
            </div>
            <SelectField
              name="theme.font_family"
              label="Police"
              defaultValue={v("theme.font_family") || "manrope"}
              options={FONT_OPTIONS}
              helper="Par défaut : Figtree (texte) + Outfit (titres), chargées localement. Tout autre choix remplace les deux."
            />
          </FieldSection>

          <FieldSection title="Identité visuelle" description="Favicon (onglet navigateur, écran d'accueil) et image de partage par défaut (réseaux sociaux), depuis la médiathèque.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-[13px] font-bold text-foreground">Favicon</label>
                <div className="mt-2">
                  <MediaPicker name="theme.favicon_media_id" value={v("theme.favicon_media_id") || null} scope="cms" emptyLabel="Choisir un favicon" />
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                  PNG ou SVG carré (512×512 idéal). Vide = icône Tokyo Store par défaut.
                </p>
              </div>
              <div>
                <label className="text-[13px] font-bold text-foreground">Image de partage par défaut (OG)</label>
                <div className="mt-2">
                  <MediaPicker name="theme.default_og_media_id" value={v("theme.default_og_media_id") || null} scope="cms" emptyLabel="Choisir une image" />
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                  Paysage 1200×630 px (ratio 1,91:1) recommandé — JPG ou PNG. Utilisée quand une
                  page n&apos;a pas d&apos;image SEO dédiée. Vide = logo du site.
                </p>
              </div>
            </div>
          </FieldSection>

          <FieldSection title="Apparence" description="Le mode sombre de la vitrine. « Selon l'appareil » respecte la préférence système du visiteur.">
            <SelectField
              name="theme.dark_mode"
              label="Mode sombre"
              defaultValue={v("theme.dark_mode") || "off"}
              options={DARK_OPTIONS}
            />
          </FieldSection>

          <FieldSection
            title="Panneau admin"
            description="Le thème du panneau d'administration — une surface distincte de la vitrine (design « Tokyo Admin »). Réglez ses propres couleurs et police ici ; les titres restent en Outfit (sans). Vide = valeurs par défaut du design."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField name="admin.theme.accent_color" label="Accent (crimson)" defaultValue={v("admin.theme.accent_color")} placeholder="#d40530" helper="Boutons, liens, élément actif de la barre latérale." />
              <ColorField name="admin.theme.accent_strong" label="Accent foncé (survol)" defaultValue={v("admin.theme.accent_strong")} placeholder="#b8042a" />
              <ColorField name="admin.theme.secondary_color" label="Couleur secondaire" defaultValue={v("admin.theme.secondary_color")} placeholder="#efe9e3" />
              <ColorField name="admin.theme.gold_color" label="Libellés (accent)" defaultValue={v("admin.theme.gold_color")} placeholder="#d40530" helper="« ADMINISTRATION » + libellés de section." />
              <ColorField name="admin.theme.background_color" label="Fond du contenu" defaultValue={v("admin.theme.background_color")} placeholder="#f6f2ed" />
              <ColorField name="admin.theme.sidebar_color" label="Fond barre latérale" defaultValue={v("admin.theme.sidebar_color")} placeholder="#FFFFFF" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                name="admin.theme.font"
                label="Police d'interface & sections (admin)"
                defaultValue={v("admin.theme.font") || "montserrat"}
                options={ADMIN_FONT_OPTIONS}
                helper="Corps, libellés, tableaux ET titres de section (« Chiffre d'affaires »…)."
              />
              <SelectField
                name="admin.theme.heading_font"
                label="Police des titres d'affichage (admin)"
                defaultValue={v("admin.theme.heading_font") || "playfair"}
                options={ADMIN_HEADING_FONT_OPTIONS}
                helper="Marque, titre de page, salutation et grands chiffres (KPI)."
              />
            </div>
            <div>
              <label className="text-[13px] font-bold text-foreground">
                Logo de la barre latérale
              </label>
              <div className="mt-2">
                <MediaPicker
                  name="admin.theme.logo_media_id"
                  value={v("admin.theme.logo_media_id") || null}
                  scope="cms"
                  emptyLabel="Choisir un logo"
                />
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                Affiché à ~26–34 px de haut (barre latérale + en-tête mobile). SVG idéal,
                ou PNG ~2× (≈ 72 px de haut, plus large si le logo est horizontal), fond
                transparent. Vide = le logo du site (onglet Identité &amp; contact), sinon le
                logo de marque par défaut.
              </p>
            </div>
          </FieldSection>
        </div>

        {/* Live preview — reflects the picked colors + radius before saving. */}
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">Aperçu</p>
          <div className="space-y-3 rounded-[22px] border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <span className="inline-block h-8 w-8 rounded-full border border-border" style={{ background: primary }} />
              <span className="inline-block h-8 w-8 rounded-full border border-border" style={{ background: accent }} />
              <span className="text-sm font-semibold" style={{ color: foreground }}>
                Aa
              </span>
            </div>
            <div className="overflow-hidden border border-border bg-surface/40" style={{ borderRadius: Math.round(radius * 1.5) }}>
              <div className="aspect-[16/9] bg-gradient-to-br from-black/5 to-black/0" />
              <div className="space-y-2 p-3">
                <p className="text-sm font-bold" style={{ color: foreground }}>Produit exemple</p>
                <span
                  className="inline-block px-2 py-0.5 text-[11px] font-semibold"
                  style={{ background: accent, color: accentFg, borderRadius: 9999 }}
                >
                  -20%
                </span>
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-sm font-semibold"
                  style={{ background: primary, color: primaryFg, borderRadius: 9999 }}
                >
                  Ajouter au panier
                </button>
              </div>
            </div>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Indicatif. Le rendu final applique aussi la police et le mode sombre.
            </p>
          </div>
        </aside>
      </div>

      {state && !state.ok && <p className="text-[14px] text-destructive">{state.message}</p>}
      {state?.ok && <p className="text-[14px] text-[#15803d]">{state.message}</p>}

      <div className="sticky bottom-4 z-10 flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground shadow-lift hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Enregistrer le thème
        </button>
      </div>
    </form>
  );
}
