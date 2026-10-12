"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState } from "react";
import { Save, X } from "lucide-react";

import { createAuthorAction, updateAuthorAction } from "@/lib/actions/authors";
import { type ActionState } from "@/lib/actions/types";
import { MediaPicker } from "@/components/admin/media-picker";
import { parseSameAs } from "@/lib/seo/same-as";
import { parseKnowsAbout } from "@/lib/authors/person";
import { AUTHOR_BASE } from "@/lib/authors/author-path";

/** Char-counter colour: muted when empty, green within budget, amber when over. */
const counterClass = (n: number, max: number) =>
  n === 0 ? "text-muted-foreground" : n <= max ? "text-emerald-600" : "text-amber-600";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

export type AuthorFormInitial = {
  id: string;
  name: string;
  slug: string;
  bio: string | null;
  jobTitle: string | null;
  expertise: string | null;
  avatarMediaId: string | null;
  sameAs: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
  isActive: boolean;
};

type Props = {
  mode: "create" | "edit";
  initial?: AuthorFormInitial;
  /** Bare host (no scheme) shown in the SERP + @id previews. */
  siteHost: string;
  successHref?: string;
};

/**
 * Author editor — ONE clean sectioned page (deliberately NOT tabbed, like the
 * category editors). The author profile is the CORE of authorship SEO: a
 * schema.org Person with a durable @id (`/auteur/<slug>#person`) referenced by
 * every article's `author`. Meta title/description + canonical + noindex flow
 * through the SHARED buildPageMetadata + jsonld pipeline server-side; this form
 * edits the overrides, with a live Google SERP preview + read-only Person JSON-LD
 * / <head> previews.
 */
export function AuthorForm({ mode, initial, siteHost, successHref }: Props) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<ActionState | null, FormData>(
    mode === "edit" ? updateAuthorAction : createAuthorAction,
    null,
  );

  // After a successful CREATE, land on the new author's edit page (mirrors categories).
  useEffect(() => {
    if (mode === "create" && state?.ok && state.id) {
      router.push(`/admin/blog/authors/${state.id}`);
    }
  }, [mode, state, router]);

  // Controlled fields that drive the live previews.
  const [name, setName] = useState(initial?.name ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(mode === "edit");
  const [jobTitle, setJobTitle] = useState(initial?.jobTitle ?? "");
  const [bio, setBio] = useState(initial?.bio ?? "");
  const [expertise, setExpertise] = useState(initial?.expertise ?? "");
  const [sameAs, setSameAs] = useState(initial?.sameAs ?? "");
  const [metaTitle, setMetaTitle] = useState(initial?.metaTitle ?? "");
  const [metaDescription, setMetaDescription] = useState(initial?.metaDescription ?? "");
  const [canonicalUrl, setCanonicalUrl] = useState(initial?.canonicalUrl ?? "");
  const [noindex, setNoindex] = useState(initial?.noindex ?? false);

  const effectiveSlug = slug || (slugTouched ? "" : slugify(name)) || "nom-auteur";
  const url = `https://${siteHost}${AUTHOR_BASE}/${effectiveSlug}`;
  const previewTitle = (
    metaTitle.trim() || `${name.trim() || "Nom de l'auteur"}${jobTitle.trim() ? ` — ${jobTitle.trim()}` : ""}`
  ).trim();
  const previewDesc =
    metaDescription.trim() || bio.trim() || "La méta-description de la page auteur s'affiche ici.";
  const canonical = canonicalUrl.trim() || url;

  const knowsAbout = useMemo(() => parseKnowsAbout(expertise), [expertise]);
  const sameAsList = useMemo(() => parseSameAs(sameAs), [sameAs]);

  // Live JSON-LD preview — mirrors the server Person node (ProfilePage + Person +
  // BreadcrumbList) so the operator sees what the page emits.
  const jsonLd = useMemo(() => {
    const person: Record<string, unknown> = {
      "@type": "Person",
      "@id": `${url}#person`,
      name: name.trim() || "Nom de l'auteur",
      url,
    };
    if (jobTitle.trim()) person.jobTitle = jobTitle.trim();
    if (bio.trim()) person.description = bio.trim();
    if (knowsAbout.length) person.knowsAbout = knowsAbout;
    if (sameAsList.length) person.sameAs = sameAsList;
    return JSON.stringify(
      {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "ProfilePage",
            "@id": `${url}#webpage`,
            url,
            name: previewTitle,
            mainEntity: { "@id": `${url}#person` },
          },
          person,
          {
            // Matches the live /auteur page: a 2-level trail (there is no /auteur
            // index page, so no intermediate « Auteurs » crumb that would 404).
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Accueil", item: `https://${siteHost}/` },
              { "@type": "ListItem", position: 2, name: name.trim() || "Auteur", item: url },
            ],
          },
        ],
      },
      null,
      2,
    );
  }, [url, name, jobTitle, bio, knowsAbout, sameAsList, previewTitle, siteHost]);

  const headTags = useMemo(() => {
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const lines = [
      `<title>${esc(previewTitle)}</title>`,
      `<meta name="description" content="${esc(metaDescription.trim() || bio.trim())}" />`,
      `<link rel="canonical" href="${esc(canonical)}" />`,
    ];
    if (noindex) lines.push(`<meta name="robots" content="noindex, follow" />`);
    lines.push(`<meta property="og:title" content="${esc(previewTitle)}" />`);
    lines.push(`<meta property="og:type" content="profile" />`);
    return lines.join("\n");
  }, [previewTitle, metaDescription, bio, canonical, noindex]);

  return (
    <form action={formAction} className="space-y-5">
      {mode === "edit" && initial && <input type="hidden" name="authorId" value={initial.id} />}

      {/* ── 1. Identité ─────────────────────────────────────────────── */}
      <Section title="Identité" description="Nom, slug, fonction et statut de l'auteur.">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="f-name" label="Nom" required />
            <input id="f-name" name="name" required value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </div>
          <div>
            <FieldLabel htmlFor="f-slug" label="Slug" />
            <input
              id="f-slug"
              name="slug"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
              placeholder={slugTouched ? "" : slugify(name)}
              className={inputCls}
            />
            <Helper>Auto d'après le nom si vide. Détermine l'URL /auteur/&lt;slug&gt; (durable).</Helper>
          </div>
          <div>
            <FieldLabel htmlFor="f-jobTitle" label="Fonction" />
            <input
              id="f-jobTitle"
              name="jobTitle"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="Rédacteur tech"
              className={inputCls}
            />
            <Helper>Affichée dans la byline → Person.jobTitle.</Helper>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="isActive"
            defaultChecked={initial?.isActive ?? true}
            className="h-4 w-4 accent-[var(--primary)]"
          />
          Actif (sélectionnable + page publique visible)
        </label>
      </Section>

      {/* ── 2. Avatar ───────────────────────────────────────────────── */}
      <Section
        title="Photo / avatar"
        description="Portrait affiché dans la byline des articles + en tête de la page auteur. Sert aussi d'image de partage. Optionnel."
      >
        <MediaPicker name="avatarMediaId" value={initial?.avatarMediaId ?? null} scope="cms" />
        <Helper>
          Dimensions recommandées : 400 × 400 px minimum (format carré 1:1). JPG ou WebP, &lt; 200 Ko.
        </Helper>
      </Section>

      {/* ── 3. Biographie + expertise ───────────────────────────────── */}
      <Section title="Biographie" description="Présentation de l'auteur (E-E-A-T) → Person.description + knowsAbout.">
        <div>
          <FieldLabel htmlFor="f-bio" label="Biographie" />
          <textarea
            id="f-bio"
            name="bio"
            rows={4}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="2 à 4 phrases, à la 3e personne."
            className={`${inputCls} h-auto py-3`}
          />
        </div>
        <div>
          <FieldLabel htmlFor="f-expertise" label="Domaines d'expertise" />
          <textarea
            id="f-expertise"
            name="expertise"
            rows={3}
            value={expertise}
            onChange={(e) => setExpertise(e.target.value)}
            placeholder={"Un sujet par ligne\nSmartphones\nEntretien & SAV\nHigh-tech"}
            className={`${inputCls} h-auto py-3`}
          />
          <Helper>Un sujet par ligne (max 12) → Person.knowsAbout.</Helper>
        </div>
      </Section>

      {/* ── 4. Liens (sameAs) ───────────────────────────────────────── */}
      <Section
        title="Liens officiels (sameAs)"
        description="Profils sociaux / site personnel de l'auteur → Person.sameAs (renforce l'E-E-A-T)."
      >
        <div>
          <FieldLabel htmlFor="f-sameAs" label="Liens (une URL par ligne)" />
          <textarea
            id="f-sameAs"
            name="sameAs"
            rows={3}
            value={sameAs}
            onChange={(e) => setSameAs(e.target.value)}
            placeholder={"https://x.com/…\nhttps://www.linkedin.com/in/…\nhttps://site-perso.tn"}
            className={`${inputCls} h-auto py-3 font-mono`}
          />
          <Helper>
            Une URL http(s) par ligne (jusqu'à 10).{" "}
            {sameAsList.length > 0 ? `${sameAsList.length} lien(s) valide(s).` : ""}
          </Helper>
        </div>
      </Section>

      {/* ── 5. SEO ──────────────────────────────────────────────────── */}
      <Section
        title="SEO & indexation"
        description="Méta-titre, méta-description, URL canonique et indexation de la page auteur — via le pipeline SEO commun."
      >
        {/* Live Google SERP preview */}
        <div className="rounded-2xl border border-border bg-surface/40 p-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Aperçu Google — rendu approximatif
          </p>
          <div className="space-y-0.5">
            <p className="truncate text-xs text-emerald-700 dark:text-emerald-400">
              {siteHost}
              {AUTHOR_BASE}/{effectiveSlug}
            </p>
            <p className="truncate text-base font-medium text-[#1a0dab] dark:text-[#8ab4f8]">{previewTitle}</p>
            <p className="line-clamp-2 text-xs text-muted-foreground">{previewDesc}</p>
          </div>
          {noindex && (
            <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600">
              noindex — exclue des résultats de recherche
            </p>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="flex items-center justify-between">
              <FieldLabel htmlFor="f-metaTitle" label="Meta title" />
              <span className={`text-[10px] font-medium ${counterClass(metaTitle.trim().length, 60)}`}>
                {metaTitle.trim().length}/60
              </span>
            </div>
            <input id="f-metaTitle" name="metaTitle" value={metaTitle} onChange={(e) => setMetaTitle(e.target.value)} className={inputCls} />
            <Helper>50–60 caractères. Vide = le nom de l'auteur.</Helper>
          </div>
          <div>
            <div className="flex items-center justify-between">
              <FieldLabel htmlFor="f-metaDescription" label="Meta description" />
              <span className={`text-[10px] font-medium ${counterClass(metaDescription.trim().length, 160)}`}>
                {metaDescription.trim().length}/160
              </span>
            </div>
            <textarea
              id="f-metaDescription"
              name="metaDescription"
              rows={3}
              value={metaDescription}
              onChange={(e) => setMetaDescription(e.target.value)}
              className={`${inputCls} h-auto py-3`}
            />
            <Helper>120–160 caractères. Vide = la biographie.</Helper>
          </div>
          <div>
            <FieldLabel htmlFor="f-canonicalUrl" label="URL canonique" />
            <input
              id="f-canonicalUrl"
              name="canonicalUrl"
              value={canonicalUrl}
              onChange={(e) => setCanonicalUrl(e.target.value)}
              placeholder={url}
              className={inputCls}
            />
            <Helper>Optionnel. Vide = l'URL de la page auteur.</Helper>
          </div>
          <label className="flex items-center gap-2 pt-6 text-sm">
            <input
              type="checkbox"
              name="noindex"
              checked={noindex}
              onChange={(e) => setNoindex(e.target.checked)}
              className="h-4 w-4 accent-[var(--primary)]"
            />
            Noindex (exclure des moteurs de recherche)
          </label>
        </div>

        {/* Read-only previews — the schema + <head> the page will emit. */}
        <div className="grid gap-3 lg:grid-cols-2">
          <CodePreview label="Schema (JSON-LD)" code={jsonLd} />
          <CodePreview label="Balises <head> (aperçu)" code={headTags} />
        </div>
      </Section>

      {state && !state.ok && (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          {state.message}
        </div>
      )}
      {state?.ok && (
        <div className="rounded-2xl border border-primary/40 bg-primary/5 p-3 text-xs text-primary">
          {state.message}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          <Save className="h-4 w-4" />
          {isPending ? "Enregistrement…" : mode === "create" ? "Créer" : "Enregistrer"}
        </button>
        {successHref && (
          <Link
            href={successHref}
            className="inline-flex h-10 items-center gap-2 rounded-full border border-border px-5 text-sm font-medium"
          >
            <X className="h-4 w-4" /> Annuler
          </Link>
        )}
      </div>
    </form>
  );
}

const inputCls =
  "mt-1 h-11 w-full rounded-2xl border border-border bg-background px-4 text-sm focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20";

function FieldLabel({ htmlFor, label, required }: { htmlFor: string; label: string; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {label}
      {required && <span className="text-destructive"> *</span>}
    </label>
  );
}

function Helper({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-[10px] text-muted-foreground">{children}</p>;
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-3xl border border-border bg-card p-5">
      <header>
        <h2 className="font-display text-base font-bold text-foreground">{title}</h2>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function CodePreview({ label, code }: { label: string; code: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <pre className="max-h-64 overflow-auto rounded-xl bg-background p-3 text-[11px] leading-relaxed text-muted-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}
