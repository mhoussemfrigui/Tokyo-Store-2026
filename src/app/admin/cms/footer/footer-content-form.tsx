"use client";

import { useActionState } from "react";
import { Loader2, Save } from "lucide-react";

import { FieldSection, TextField, TextareaField } from "@/components/admin/_components/setting-fields";
import { useNoResetSubmit } from "@/components/admin/_components/form-tabs";
import { ContactListField } from "@/components/admin/_components/contact-list-field";
import { SocialListField } from "@/components/admin/_components/social-list-field";
import { MediaPicker } from "@/components/admin/media-picker";
import { SelectField } from "@/components/ui/select-field";
import { saveFooterAction } from "@/lib/actions/footer";
import { resolveContactList } from "@/lib/cms/contact-list";
import { resolveSocialList } from "@/lib/cms/social-list";
import {
  FOOTER_SETTING_KEYS,
  FOOTER_SOCIAL_STYLES,
  FOOTER_APPEARANCE_DEFAULTS,
} from "@/lib/cms/footer-appearance";
import { asBool, asEnum } from "@/lib/cms/setting-coerce";
import { type ActionState } from "@/lib/actions/types";

const SOCIAL_LABEL: Record<string, string> = {
  circle: "Cercle",
  square: "Carré",
  plain: "Simple (sans contour)",
};

function Select({ name, label, value, options }: { name: string; label: string; value: string; options: { value: string; label: string }[] }) {
  return (
    <SelectField
      name={name}
      label={label}
      labelClassName="mb-1 block text-[13px] font-bold text-foreground"
      defaultValue={value}
      options={options}
    />
  );
}

/** A labelled checkbox — checked submits value "true"; unchecked submits nothing,
 *  which saveFooterAction stores as "false" (so the toggle round-trips both ways). */
function Toggle({ name, label, defaultChecked }: { name: string; label: string; defaultChecked: boolean }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-[14px] border-[1.5px] border-input bg-card px-4 py-3">
      <span className="text-[14px] font-semibold text-foreground">{label}</span>
      <input type="checkbox" name={name} value="true" defaultChecked={defaultChecked} className="h-4 w-4 rounded-[4px] border-input accent-[var(--primary)]" />
    </label>
  );
}

/**
 * Footer CONTENT + APPEARANCE form. Edits the SAME `site.*`/`social.*` settings
 * the footer reads (identity / contact / socials — single source of truth, shared
 * with the header, invoices and SEO) PLUS the `storefront.footer.*` appearance
 * keys, through saveFooterAction (which writes only this subset). Standard
 * direct-submit settings form (uncontrolled fields) — no JSON composer needed.
 */
export function FooterContentForm({ values = {} }: { values?: Record<string, string> }) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(saveFooterAction, null);
  // Keep the operator's edits when the save fails validation (React 19 otherwise
  // resets every uncontrolled field on settle).
  const onSubmit = useNoResetSubmit(formAction, state);
  const v = (k: string) => values[k] ?? "";
  const d = FOOTER_APPEARANCE_DEFAULTS;
  // Read the pre-fill through the SAME coercers the storefront uses (asBool/asEnum)
  // so the admin checkbox/select and the rendered footer can never disagree on a
  // blank/legacy value (empty → the field default, not a silent OFF).
  const boolVal = (k: string, dflt: boolean) => asBool(values[k], dflt);
  const enumVal = <T extends string>(k: string, allowed: readonly T[], dflt: T) => asEnum(values[k], allowed, dflt);

  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-6">
      <FieldSection title="Identité" description="Logo, nom, slogan et description affichés dans le pied de page (ces valeurs alimentent aussi l'en-tête, la facture et le SEO).">
        <div>
          <label className="text-[13px] font-bold text-foreground">Logo (médiathèque)</label>
          <div className="mt-2">
            <MediaPicker name="site.logo_media_id" value={v("site.logo_media_id") || null} scope="cms" emptyLabel="Choisir un logo" />
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
            SVG idéal, ou PNG transparent ~2× (hauteur d&apos;affichage ~32–80 px selon
            l&apos;emplacement). Partagé avec l&apos;en-tête et les pages de connexion. Vide = logo par défaut.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="site.name" label="Nom du site" defaultValue={v("site.name")} placeholder="Tokyo Store" />
          <TextField name="site.tagline" label="Slogan" defaultValue={v("site.tagline")} placeholder="Votre expert en produits technologiques de pointe" />
        </div>
        <TextareaField name="site.description" label="Description" defaultValue={v("site.description")} placeholder="iPhones, smartphones, gaming et accessoires high-tech — au meilleur prix en Tunisie." rows={3} />
      </FieldSection>

      <FieldSection title="Coordonnées" description="Téléphones, emails et adresses (plusieurs possibles — ex. plusieurs boutiques). Cochez « Footer » pour afficher une entrée dans le pied de page. Ces valeurs sont partagées avec « Identité & contact » (facture, SEO, page d'aide).">
        <ContactListField base="site.contact_phones" label="Téléphones" type="tel" placeholder="+216 12 345 678" addLabel="Ajouter un téléphone" initial={resolveContactList(values, "site.contact_phones", "site.contact_phone")} />
        <ContactListField base="site.contact_emails" label="Emails de contact" type="email" placeholder="contact@tokyostore.tn" addLabel="Ajouter un email" initial={resolveContactList(values, "site.contact_emails", "site.contact_email")} />
        <ContactListField base="site.addresses" label="Adresses" placeholder="Mall Lac 2, Les Berges du Lac 2, Tunis" addLabel="Ajouter une adresse" initial={resolveContactList(values, "site.addresses", "site.address")} />
        <TextField name="site.hours" label="Horaires" defaultValue={v("site.hours")} placeholder="Lun–Sam 9h–18h" />
      </FieldSection>

      <FieldSection title="Réseaux sociaux" description="Les liens affichés en icônes dans le pied de page. Ajoutez plusieurs comptes par réseau si besoin.">
        <SocialListField initial={resolveSocialList(values)} />
      </FieldSection>

      <FieldSection title="Apparence" description="Ce qui s'affiche dans le pied de page de la boutique. Décochez une section pour la masquer ; le style des réseaux change la forme des icônes.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Toggle name={FOOTER_SETTING_KEYS.showDescription} label="Afficher le slogan" defaultChecked={boolVal(FOOTER_SETTING_KEYS.showDescription, d.showDescription)} />
          <Toggle name={FOOTER_SETTING_KEYS.showContact} label="Afficher les coordonnées" defaultChecked={boolVal(FOOTER_SETTING_KEYS.showContact, d.showContact)} />
          <Toggle name={FOOTER_SETTING_KEYS.showSocials} label="Afficher les réseaux" defaultChecked={boolVal(FOOTER_SETTING_KEYS.showSocials, d.showSocials)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Select name={FOOTER_SETTING_KEYS.socialStyle} label="Style des réseaux" value={enumVal(FOOTER_SETTING_KEYS.socialStyle, FOOTER_SOCIAL_STYLES, d.socialStyle)} options={FOOTER_SOCIAL_STYLES.map((t) => ({ value: t, label: SOCIAL_LABEL[t] ?? t }))} />
        </div>
      </FieldSection>

      {state && !state.ok && <p className="text-[14px] text-destructive">{state.message}</p>}
      {state?.ok && <p className="text-[14px] text-[#15803d]">{state.message}</p>}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground shadow-lift hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Enregistrer le contenu & l&apos;apparence
        </button>
      </div>
    </form>
  );
}
