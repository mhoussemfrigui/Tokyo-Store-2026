import Link from "next/link";
import { ArrowLeft, SearchX } from "lucide-react";

/**
 * Admin-scoped 404 boundary. Every RBAC denial (`requirePermission` /
 * `requirePermissionAny` → `notFound()`) and every stale / bad-id admin URL
 * lands here, INSIDE the admin layout — so the sidebar and topbar stay mounted
 * and staff get a way back, instead of the customer-facing storefront 404 (shop
 * search + suggestions) with no admin chrome.
 *
 * The HTTP status stays 404, and the copy deliberately does not say WHICH of
 * « missing » or « not allowed » applies (no enumeration). Non-staff never see
 * it: the admin layout's own `notFound()` bubbles to the PARENT (root) boundary,
 * so /admin stays undiscoverable for customers and bots.
 */
export default function AdminNotFound() {
  return (
    <div className="grid place-items-center px-4 py-16">
      <div className="w-full max-w-md text-center">
        <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-surface">
          <SearchX className="h-7 w-7 text-muted-foreground" />
        </span>
        <h1 className="font-display text-xl font-bold text-foreground">
          Page introuvable ou accès non autorisé
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cette page n&apos;existe pas (ou plus), ou votre rôle ne donne pas accès à
          cette section. Si vous pensez qu&apos;il s&apos;agit d&apos;une erreur,
          demandez à un administrateur de vérifier vos permissions.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Link
            href="/admin"
            className="inline-flex h-10 items-center gap-2 rounded-full bg-foreground px-4 text-sm font-semibold text-background"
          >
            <ArrowLeft className="h-4 w-4" />
            Retour au tableau de bord
          </Link>
        </div>
      </div>
    </div>
  );
}
