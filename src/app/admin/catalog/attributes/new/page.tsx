import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";

import { AttributeCreateForm } from "./attribute-create-form";

export const metadata: Metadata = { title: "Nouvel attribut" };

export const dynamic = "force-dynamic";

export default async function NewAttributePage() {
  await requirePermission("attributes", "create");
  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/catalog/attributes"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux attributs
        </Link>
        <h1 className="mt-2 font-display text-2xl font-bold text-foreground sm:text-3xl">
          Nouvel attribut
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choisissez le type, puis (pour les types à liste) ajoutez les premières valeurs. Vous
          pourrez ensuite lier les catégories et compléter les valeurs depuis l&apos;éditeur.
        </p>
      </div>

      <AttributeCreateForm />
    </div>
  );
}
