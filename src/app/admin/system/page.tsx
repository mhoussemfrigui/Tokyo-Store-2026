import type { Metadata } from "next";
import Link from "next/link";
import { Bot, CalendarClock, ChevronRight, Cookie, Database, Gauge, Globe, LineChart, Lock, Route, ScrollText, Search, Server, Upload, Webhook, Wrench } from "lucide-react";

import { requireAdminArea } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Système" };

const TILES: {
  href: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    href: "/admin/system/import-data",
    title: "Import data",
    description:
      "Montez toute la boutique en un clic : contenu du site, catalogue high-tech et redirections — ou importez un fichier (CSV / XML).",
    icon: Upload,
  },
  {
    href: "/admin/system/jobs",
    title: "Tâches planifiées",
    description:
      "Crons internes et externes (rétention, mailing, anniversaires, avis) : dernier passage, état et déclenchement manuel.",
    icon: CalendarClock,
  },
  {
    href: "/admin/system/seo",
    title: "SEO & schéma",
    description:
      "Réglages SEO globaux, balises de vérification, données structurées (JSON-LD) et image OG par défaut.",
    icon: Globe,
  },
  {
    href: "/admin/system/audit",
    title: "Journal d'audit",
    description:
      "Historique append-only de chaque action (auth, catalogue, CMS, commandes). Filtrable par événement, acteur et cible.",
    icon: ScrollText,
  },
  {
    href: "/admin/system/cookies",
    title: "Cookies & RGPD",
    description:
      "Bannière de consentement (RGPD/ePrivacy) : activation, texte, catégories proposées et révision. Les balises de suivi se configurent dans Suivi & Analytics.",
    icon: Cookie,
  },
  {
    href: "/admin/system/ai",
    title: "IA & Automation",
    description:
      "Clés API des fournisseurs d'IA (OpenRouter, DeepSeek, OpenAI, Claude) — chiffrées en base, surchargées par variables d'environnement. Génération de contenu, catégorisation et le fournisseur + modèle d'embeddings de la recherche sémantique.",
    icon: Bot,
  },
  {
    href: "/admin/system/search",
    title: "Recherche",
    description:
      "Statistiques d'utilisation, réglages du moteur (pertinence, types, limites), alias / synonymes, recherche sémantique (vectorielle) et conservation du journal.",
    icon: Search,
  },
  {
    href: "/admin/system/analytics",
    title: "Suivi & Analytics",
    description:
      "Balises de suivi (GA4, Meta Pixel, GTM…), identifiants et évènements e-commerce. Les catégories de consentement se règlent dans Cookies & RGPD.",
    icon: LineChart,
  },
  {
    href: "/admin/system/redirects",
    title: "Redirections & 404",
    description:
      "Règles de redirection (301/302) et journal des 404 pour récupérer le trafic et préserver le SEO des anciennes URL.",
    icon: Route,
  },
  {
    href: "/admin/system/redirects?tab=maintenance",
    title: "Maintenance & lancement",
    description:
      "Fermez la boutique au public (maintenance) ou affichez une page « bientôt disponible » avec compte à rebours avant le lancement. L'équipe connectée garde l'accès.",
    icon: Wrench,
  },
  // ── Diagnostics infrastructure (lecture seule) ──────────────────────────
  {
    href: "/admin/system/api",
    title: "API & Webhooks",
    description:
      "Inventaire des points d'accès, webhook Flouci, cron de rétention, passerelles de paiement et limites de débit.",
    icon: Webhook,
  },
  {
    href: "/admin/system/database",
    title: "Base de données",
    description:
      "Connectivité & latence, pool, état par migration, tailles des tables, santé des index, vacuum/bloat, requêtes lentes et rétention.",
    icon: Database,
  },
  {
    href: "/admin/system/resources",
    title: "Ressources",
    description:
      "Stockage objet (S3) + réachabilité, médiathèque, CDN, e-mail, et l'état EN DIRECT des services externes (DB, passerelles, analytics, IA). Relié à Performance & Base de données.",
    icon: Server,
  },
  {
    href: "/admin/system/performance",
    title: "Performance",
    description:
      "RAM, CPU, boucle d'évènements et latence DB en direct, disponibilité, alertes de surcharge, compteurs d'événements et cache.",
    icon: Gauge,
  },
  {
    href: "/admin/system/security",
    title: "Sécurité",
    description:
      "En-têtes & CSP, politique d'authentification, état des secrets, RGPD et protection du dernier admin.",
    icon: Lock,
  },
];

export default async function SystemIndexPage() {
  await requireAdminArea();
  return (
    <div className="space-y-6">
      <header>
        <p className="max-w-3xl text-[14px] leading-relaxed text-muted-foreground">
          Outils opérationnels : import / export de données, scripts de
          maintenance.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        {TILES.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="group flex items-start gap-4 rounded-[22px] border border-border bg-card p-5 transition hover:border-primary/40"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-[var(--accent)] text-primary">
              <t.icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1 text-[16px] font-black text-foreground">
                {t.title}
                <ChevronRight className="h-4 w-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t.description}
              </p>
            </div>
          </Link>
        ))}
      </div>

      <div className="rounded-[16px] border border-dashed border-border bg-card p-5 text-sm text-muted-foreground">
        <Wrench className="mr-2 inline h-4 w-4 align-text-bottom" />
        D&apos;autres outils arrivent ici : export CSV produits, sauvegarde
        des médias, rotation des secrets, etc.
      </div>
    </div>
  );
}
