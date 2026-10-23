"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Info, Loader2, Save } from "lucide-react";

import { FieldSection, TextField, TextareaField, ToggleField } from "@/components/admin/_components/setting-fields";
import { AdminCallout, AdminNote } from "@/components/admin/_components/filter-bar";
import { useNoResetSubmit } from "@/components/admin/_components/form-tabs";
import { ContactListField } from "@/components/admin/_components/contact-list-field";
import { SocialListField } from "@/components/admin/_components/social-list-field";
import { MediaPicker } from "@/components/admin/media-picker";
import { saveSiteSettingsAction } from "@/lib/actions/site";
import { resolveContactList } from "@/lib/cms/contact-list";
import { resolveSocialList } from "@/lib/cms/social-list";
import { type ActionState } from "@/lib/actions/types";

/**
 * Structured "Identité & contact" panel — storefront identity, contact, socials
 * and legal copy, consumed by the header/footer/help pages. (The top announcement
 * strip moved to `header_strip` banners in CMS → Bannières.) Deliberately NOT a
 * raw key/value editor; cross-cutting system namespaces (seo./consent./checkout.)
 * have their own dedicated panels.
 */
export function SiteSettingsPanel({ values }: { values: Record<string, string> }) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveSiteSettingsAction,
    null,
  );
  // Keep the operator's edits when the save fails validation (React 19 otherwise
  // resets every uncontrolled field on settle).
  const onSubmit = useNoResetSubmit(formAction, state);
  const v = (k: string) => values[k] ?? "";

  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-6">
      <AdminNote className="max-w-3xl">
        Nom, logo, coordonnées et réseaux sociaux de la vitrine (en-tête, pied de
        page, page d&apos;aide). Le SEO, les cookies, le paiement et la commande
        ont leurs propres pages dédiées.
      </AdminNote>

      <FieldSection title="Identité" description="Nom, slogan et description affichés dans l'en-tête et le pied de page.">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="site.name" label="Nom du site" defaultValue={v("site.name")} placeholder="Tokyo Store" />
          <TextField name="site.tagline" label="Slogan" defaultValue={v("site.tagline")} placeholder="Produits high-tech pour le passionné de technologie" />
        </div>
        <TextareaField
          name="site.description"
          label="Description"
          defaultValue={v("site.description")}
          placeholder="Produits high-tech — smartphones, audio, gaming et accessoires, sélectionnés pour les passionnés de technologie."
          rows={3}
        />
        <div>
          <label className="text-[13px] font-bold text-foreground">
            Logo du site — médiathèque
          </label>
          <div className="mt-2">
            <MediaPicker
              name="site.logo_media_id"
              value={v("site.logo_media_id") || null}
              scope="cms"
              emptyLabel="Choisir un logo"
            />
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
            SVG idéal, ou PNG transparent ~2× (hauteur d&apos;affichage ~32–80 px selon
            l&apos;emplacement). Affiché dans l&apos;en-tête, le pied de page et les pages de
            connexion. Laissez vide pour utiliser le logo Tokyo Store par défaut.
          </p>
        </div>
      </FieldSection>

      <FieldSection title="Contact" description="Affichés sur la page Support &amp; contact (/help) et dans le pied de page. Ajoutez plusieurs téléphones, emails ou adresses (ex. plusieurs boutiques) ; cochez « Footer » pour afficher une entrée dans le pied de page. Le 1ᵉʳ de chaque liste alimente aussi les données structurées (SEO) et llms.txt. L&apos;adresse imprimée sur les factures est celle du siège social (section Informations légales).">
        <ContactListField base="site.contact_phones" label="Téléphones" type="tel" placeholder="+216 12 345 678" addLabel="Ajouter un téléphone" initial={resolveContactList(values, "site.contact_phones", "site.contact_phone")} />
        <ContactListField base="site.contact_emails" label="Emails de contact" type="email" placeholder="contact@tokyostore.tn" addLabel="Ajouter un email" initial={resolveContactList(values, "site.contact_emails", "site.contact_email")} />
        <ContactListField base="site.addresses" label="Adresses" placeholder="Avenue Habib Bourguiba, Tunis" addLabel="Ajouter une adresse" initial={resolveContactList(values, "site.addresses", "site.address")} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="site.whatsapp" label="WhatsApp" defaultValue={v("site.whatsapp")} placeholder="+216 12 345 678" />
          <TextField name="site.hours" label="Horaires" defaultValue={v("site.hours")} placeholder="Lun–Sam 9h–19h" />
        </div>
      </FieldSection>

      <FieldSection title="Réseaux sociaux" description="Les liens affichés en icônes dans le pied de page (et repris dans les données structurées SEO). Ajoutez plusieurs comptes par réseau si besoin.">
        <SocialListField initial={resolveSocialList(values)} />
      </FieldSection>

      <AdminCallout tone="info" icon={Info}>
        La page d&apos;accueil se compose dans{" "}
        <Link href="/admin/cms/home" className="font-bold text-primary hover:underline">
          Contenu → Page d&apos;accueil
        </Link>{" "}
        (rails de produits, bannières, éditoriaux, cartes de réassurance…). Tant qu&apos;aucune
        composition n&apos;y est enregistrée, l&apos;accueil affiche ses sections Tokyo par défaut.
      </AdminCallout>

      <FieldSection title="Informations légales" description="Pour les mentions légales / la facturation.">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="business.legal_name" label="Raison sociale" defaultValue={v("business.legal_name")} placeholder="Tokyo Store SARL" />
          <TextField name="business.tax_id" label="Matricule fiscal / RNE" defaultValue={v("business.tax_id")} placeholder="1234567/A/M/000" />
        </div>
        <TextField
          name="business.hq_address"
          label="Adresse du siège social"
          defaultValue={v("business.hq_address")}
          placeholder="Avenue Habib Bourguiba, 1000 Tunis"
        />
        <p className="-mt-2 text-[12px] leading-relaxed text-muted-foreground">
          L&apos;adresse de l&apos;émetteur imprimée sur les factures, reçus, bons de livraison et
          emails — distincte des boutiques. Laissez vide pour utiliser la 1ʳᵉ adresse boutique.
        </p>
        <ToggleField
          name="business.hq_address_public"
          label="Afficher le siège social sur le site"
          description="Affiche l'adresse du siège dans le pied de page et la page contact. Les boutiques restent affichées normalement."
          defaultChecked={v("business.hq_address_public") === "true"}
        />
      </FieldSection>

      {state && !state.ok && <p className="text-[14px] text-destructive">{state.message}</p>}
      {state?.ok && <p className="text-[14px] text-[#15803d]">{state.message}</p>}

      <div className="sticky bottom-4 z-10 flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground shadow-lift hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Enregistrer les réglages
        </button>
      </div>
    </form>
  );
}
