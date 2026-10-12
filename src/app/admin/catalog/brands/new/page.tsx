import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { BrandForm } from "@/components/admin/brand-form";
import { requirePermission } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Nouvelle marque" };

export const dynamic = "force-dynamic";

export default async function NewBrandPage() {
  // Gated on `brands:create` (the grant the submit action requires). Like every
  // admin page it MUST call its own `requirePermission`: the admin layout only
  // checks admin-area access (any grant) and isolates no module.
  await requirePermission("brands", "create");

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/catalog/brands"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux marques
        </Link>
        <h1 className="mt-2 font-display text-2xl font-bold text-foreground sm:text-3xl">
          Nouvelle marque
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Renseignez l&apos;identité et le contenu. La FAQ se complète ensuite, après la première
          sauvegarde.
        </p>
      </div>

      <BrandForm mode="create" successHref="/admin/catalog/brands" />
    </div>
  );
}
