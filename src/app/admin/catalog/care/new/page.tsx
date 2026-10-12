import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { CareForm } from "@/components/admin/care-form";
import { loadCareCategoryOptions } from "../_categories";

export const metadata: Metadata = { title: "Nouveau plan Tokyo Care" };

export default async function NewCarePlanPage() {
  await requirePermission("care", "create");
  const categories = await loadCareCategoryOptions();

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/catalog/care"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" aria-hidden /> Tokyo Care
        </Link>
        <h1 className="mt-2 font-display text-2xl font-bold text-foreground sm:text-3xl">Nouveau plan Tokyo Care</h1>
      </div>
      <CareForm mode="create" categories={categories} />
    </div>
  );
}
