"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/lib/auth/session";
import { hasEmbeddingProvider } from "@/lib/ai/embed";
import {
  embedNextBackfillBatch,
  getEmbeddingCoverage,
  type BackfillBatchResult,
  type EmbeddingCoverage,
} from "@/modules/search/embedding.service";

/**
 * Server actions for the « Recherche sémantique » backfill panel (Système →
 * Recherche). The backfill is CLIENT-DRIVEN: the panel calls
 * {@link runEmbeddingBackfillBatchAction} repeatedly until `done`, showing progress
 * from `remaining`. State is the DB itself (embedding fingerprints), so it's
 * resumable + idempotent — no job row, no background runner. Every action is gated
 * on `system_search:manage` (or `:view` for the read).
 */

export type EmbeddingStatus = EmbeddingCoverage & { hasProvider: boolean };

/** Coverage snapshot + whether an embedding provider is configured (drives the panel). */
export async function getEmbeddingStatusAction(): Promise<EmbeddingStatus> {
  await requirePermission("system_search", "view");
  const [coverage, hasProvider] = await Promise.all([
    getEmbeddingCoverage(),
    hasEmbeddingProvider(),
  ]);
  return { ...coverage, hasProvider };
}

export type BackfillActionResult =
  | ({ ok: true; hasProvider: boolean } & BackfillBatchResult)
  | { ok: false; message: string };

/**
 * Embed ONE batch of products lacking a current-model embedding, returning progress.
 * The client loops on `done`. Refuses up-front when no provider is configured (so the
 * panel shows a clear "configure a provider" message instead of N failed batches).
 */
export async function runEmbeddingBackfillBatchAction(limit = 100): Promise<BackfillActionResult> {
  const session = await requirePermission("system_search", "manage");
  if (!(await hasEmbeddingProvider())) {
    return {
      ok: false,
      message:
        "Aucun fournisseur d'embeddings configuré. Activez OpenRouter ou OpenAI dans Système → IA & Automation.",
    };
  }
  const result = await embedNextBackfillBatch(Math.max(1, Math.min(limit, 200)), {
    actorUserId: session.user.id,
  });
  // Reflect fresh coverage on the search admin page once the run completes.
  if (result.done) revalidatePath("/admin/system/search");
  return { ok: true, hasProvider: true, ...result };
}
