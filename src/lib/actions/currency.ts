"use server";

import { revalidatePath } from "next/cache";

import { bus } from "@/events/bus";
import { requirePermission } from "@/lib/auth/session";
import { currencyService, currencyQueries } from "@/modules/currency";
import {
  normalizeCode,
  normalizePosition,
  clampInt,
  canDeleteCurrency,
} from "@/lib/currency/normalize";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { type ActionState } from "@/lib/actions/types";

/**
 * Currency registry admin actions (Commandes → Devises). Every action is a
 * `(prev, formData) => ActionState` so the panel's useActionState / confirm
 * modal can SHOW the outcome — a duplicate ISO code on edit, a refused delete
 * — instead of the row silently snapping back. Changing the active currency
 * revalidates the storefront layout so the price label updates immediately.
 * Money values are NOT converted — this is a relabel only (see
 * src/lib/currency/active.ts). Input normalization lives in the pure
 * `currency/normalize.ts` (unit-tested).
 */

const ADMIN_PATH = "/admin/system/currency";

function str(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim();
}

async function revalidate() {
  revalidatePath(ADMIN_PATH);
  // Storefront layout caches the active currency — refresh so the label updates.
  revalidatePath("/", "layout");
}

const NOT_FOUND: ActionState = {
  ok: false,
  error: "not_found",
  message: "Devise introuvable (elle a peut-être été supprimée) — rechargez la page.",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The row, or null when absent / the id is malformed (a bad uuid would throw in PG). */
async function findCurrency(id: string) {
  if (!UUID_RE.test(id)) return null;
  return currencyQueries.getById(id);
}

function duplicateCode(code: string): ActionState {
  return {
    ok: false,
    error: "conflict",
    message: `Le code de devise « ${code} » existe déjà.`,
    fieldErrors: { code: "Ce code est déjà utilisé." },
  };
}

export async function createCurrencyAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_currency", "create");
  const code = normalizeCode(formData.get("code"));
  // Operator feedback: a blank/invalid ISO code and a duplicate used to `return`
  // silently — the "Ajouter une devise" form reset and looked saved while nothing
  // was added. Both are now clear, surfaced errors.
  if (!code)
    return {
      ok: false,
      error: "validation",
      message: "Code ISO requis (3 lettres, ex : TND, EUR, USD).",
      fieldErrors: { code: "Saisissez un code ISO." },
    };
  let created;
  try {
    created = await currencyService.create({
      code,
      name: str(formData.get("name")) || code,
      symbol: str(formData.get("symbol")) || code,
      symbolPosition: normalizePosition(formData.get("symbol_position")),
      displayOrder: clampInt(formData.get("display_order"), 0, 9999),
    });
  } catch (err) {
    if (isUniqueViolation(err)) return duplicateCode(code);
    throw err;
  }
  await bus.emit(
    "currency.created",
    { currencyId: created.id, code: created.code },
    { actorUserId: session.user.id },
  );
  await revalidate();
  return { ok: true, message: `Devise « ${created.code} » ajoutée.` };
}

export async function updateCurrencyAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_currency", "update");
  const existing = await findCurrency(str(formData.get("currencyId")));
  if (!existing) return NOT_FOUND;
  const id = existing.id;

  // A blank / letter-less code used to be dropped silently (the old code kept).
  if (formData.has("code") && !normalizeCode(formData.get("code"))) {
    return {
      ok: false,
      error: "validation",
      message: "Code ISO requis (3 lettres, ex : TND, EUR, USD).",
      fieldErrors: { code: "Saisissez un code ISO." },
    };
  }

  // Build the patch from the fields actually SUBMITTED (and non-empty) — the
  // edit card has no « ordre » input, so a clamp fallback must never overwrite
  // the stored display order with 0 — then keep only real changes so the audit
  // row lists what moved and an unchanged save writes nothing.
  const submitted = (field: string) => str(formData.get(field)) !== "";
  const candidate = {
    code: submitted("code") ? normalizeCode(formData.get("code")) : undefined,
    name: submitted("name") ? str(formData.get("name")) : undefined,
    symbol: submitted("symbol") ? str(formData.get("symbol")) : undefined,
    symbolPosition: submitted("symbol_position")
      ? normalizePosition(formData.get("symbol_position"))
      : undefined,
    displayOrder: submitted("display_order")
      ? clampInt(formData.get("display_order"), existing.display_order, 9999)
      : undefined,
  };
  const stored = {
    code: existing.code,
    name: existing.name,
    symbol: existing.symbol,
    symbolPosition: existing.symbol_position,
    displayOrder: existing.display_order,
  };
  const patch: Partial<typeof stored> = {};
  for (const key of Object.keys(candidate) as Array<keyof typeof candidate>) {
    const value = candidate[key];
    if (value !== undefined && value !== stored[key]) (patch as Record<string, unknown>)[key] = value;
  }
  const changedFields = Object.keys(patch);
  if (changedFields.length === 0) {
    return { ok: true, message: `Devise « ${existing.code} » : aucune modification.` };
  }

  try {
    await currencyService.update(id, patch);
  } catch (err) {
    if (isUniqueViolation(err)) return duplicateCode(patch.code ?? existing.code);
    throw err;
  }
  const code = patch.code ?? existing.code;
  await bus.emit(
    "currency.updated",
    { currencyId: id, code, changedFields },
    { actorUserId: session.user.id },
  );
  await revalidate();
  return { ok: true, message: `Devise « ${code} » enregistrée.` };
}

export async function setActiveCurrencyAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_currency", "update");
  // Existence first: `setActive` deactivates every OTHER row, so an unknown id
  // would leave the store with NO active currency.
  const row = await findCurrency(str(formData.get("currencyId")));
  if (!row) return NOT_FOUND;
  if (row.is_active) return { ok: true, message: `« ${row.code} » est déjà la devise active.` };
  // setActive is atomic + rolls back if the row was deleted between the pre-read
  // above and the write, so the store can never be left with zero active currency.
  if (!(await currencyService.setActive(row.id))) return NOT_FOUND;
  await bus.emit(
    "currency.activated",
    { currencyId: row.id, code: row.code },
    { actorUserId: session.user.id },
  );
  await revalidate();
  return {
    ok: true,
    message: `« ${row.code} » est désormais la devise active (prix ré-étiquetés, montants non convertis).`,
  };
}

export async function deleteCurrencyAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_currency", "delete");
  const row = await findCurrency(str(formData.get("currencyId")));
  if (!row) return NOT_FOUND;
  // Never delete the active currency — the store must always have one.
  const active = await currencyQueries.getActive().catch(() => null);
  if (!canDeleteCurrency(active?.id, row.id)) {
    return {
      ok: false,
      error: "conflict",
      message: "Impossible de supprimer la devise active — activez-en une autre d'abord.",
    };
  }
  // Authoritative guard: the delete is atomic (WHERE is_active = false), so if a
  // concurrent setActive made this the active currency after the check above, it
  // deletes nothing rather than leaving zero active — refuse the same way.
  const deleted = await currencyService.remove(row.id);
  if (!deleted) {
    return {
      ok: false,
      error: "conflict",
      message: "Impossible de supprimer la devise active — activez-en une autre d'abord.",
    };
  }
  await bus.emit(
    "currency.deleted",
    { currencyId: row.id, code: row.code },
    { actorUserId: session.user.id },
  );
  await revalidate();
  return { ok: true, message: `Devise « ${row.code} » supprimée.` };
}
