"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/lib/auth/session";
import { isUuid } from "@/lib/utils/uuid";
import {
  createSearchAliasWorkflow,
  deleteSearchAliasWorkflow,
  seedDefaultSearchAliasesWorkflow,
  updateSearchAliasWorkflow,
} from "@/workflows/search/aliases";
import { type ActionState } from "@/lib/actions/types";

/**
 * Search ALIAS / SYNONYM management (0114) — CRUD + the catalogue-derived default
 * seed, from Système → Recherche → Alias and the « Créer alias » shortcut on a
 * zero-result query. Every action is gated by `system_search:manage` (the same
 * class as the engine tuning), goes through the `workflows/search/aliases`
 * workflows (which emit the audited `search_alias.*` events) and revalidates the
 * admin page + the storefront search page (whose cached alias set is also busted
 * inside the service methods).
 */

function done(message: string): ActionState {
  revalidatePath("/admin/system/search");
  revalidatePath("/recherche");
  return { ok: true, message };
}

export async function createSearchAliasAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_search", "manage");
  const term = String(formData.get("term") ?? "");
  const expansion = String(formData.get("expansion") ?? "");
  const res = await createSearchAliasWorkflow(
    { term, expansion },
    { actorUserId: session.user.id },
  );
  if (!res.ok) return { ok: false, error: "validation", message: res.message };
  return done("Alias créé.");
}

/** Toggle a rule active/inactive without deleting it. `active` is the DESIRED state. */
export async function toggleSearchAliasAction(id: string, active: boolean): Promise<ActionState> {
  const session = await requirePermission("system_search", "manage");
  if (!isUuid(id)) return { ok: false, error: "validation", message: "Alias introuvable." };
  const res = await updateSearchAliasWorkflow(
    { id, isActive: active },
    { actorUserId: session.user.id },
  );
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  return done(active ? "Alias activé." : "Alias désactivé.");
}

export async function deleteSearchAliasAction(id: string): Promise<ActionState> {
  const session = await requirePermission("system_search", "manage");
  if (!isUuid(id)) return { ok: false, error: "validation", message: "Alias introuvable." };
  const res = await deleteSearchAliasWorkflow({ id }, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  return done("Alias supprimé.");
}

/** Seed the catalogue-derived defaults, idempotently (adds only missing rules). */
export async function seedDefaultSearchAliasesAction(): Promise<ActionState> {
  const session = await requirePermission("system_search", "manage");
  const res = await seedDefaultSearchAliasesWorkflow({ actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  const added = res.data.added;
  return done(
    added > 0
      ? `${added} alias par défaut ajouté${added > 1 ? "s" : ""}.`
      : "Les alias par défaut sont déjà présents.",
  );
}
