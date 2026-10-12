"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";

import { bus } from "@/events/bus";
import { db } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { redirects } from "@/modules/redirects/schema";
import { requirePermission } from "@/lib/auth/session";
import { resolveUserPermissions } from "@/lib/rbac/authorize";
import { WILDCARD } from "@/lib/rbac/registry";
import { type ActionState } from "@/lib/actions/types";
import { redirectService } from "@/modules/redirects";
import {
  effectiveStatusFor,
  internalDestinationPath,
  isOffsiteDestination,
  normalizeDestination,
  normalizeSourcePath,
  normalizeStatusCode,
  parseRedirectsCsv,
  redirectChainEndsOffsite,
  redirectChainHasCycle,
  redirectCoverageWarning,
  redirectWriteNeedsOwner,
  type ParsedRedirect,
} from "@/lib/redirects/normalize";
import { getOwnRedirectHosts, loadActiveRedirectEdges, wouldLoop } from "@/lib/redirects/guard";
import { workflows } from "@/workflows";

function revalidateRedirects() {
  revalidatePath("/admin/system/redirects");
}

/**
 * Off-site destinations are an OWNER decision (`*`, like the tracking scripts and
 * the mail transport): a delegated « Redirections & 404 » operator could
 * otherwise send the store's live product / category URLs to another domain —
 * directly, by moving the owner's off-site rule onto another source, or by
 * chaining an internal rule into it (see redirectWriteNeedsOwner).
 */
async function holdsWildcard(userId: string): Promise<boolean> {
  return (await resolveUserPermissions(userId)).has(WILDCARD);
}

const OFFSITE_OWNER_ONLY =
  "Seul un super-administrateur peut rediriger vers un autre domaine que celui de la boutique.";
const OFFSITE_FIELD_ERROR = "Domaine externe — réservé au super-administrateur.";
const OFFSITE_CHAIN_FIELD_ERROR =
  "Cette destination redirige elle-même vers un autre domaine — réservé au super-administrateur.";
const DUPLICATE_SOURCE = "Une redirection existe déjà pour cette source.";

/** Shared field extraction + validation for create/update. */
function readRedirectForm(formData: FormData, ownHosts: ReadonlySet<string>):
  | { ok: true; source: string; destination: string; statusCode: 301 | 302 | 307 | 308; isActive: boolean; notes: string | null }
  | { ok: false; message: string } {
  const source = normalizeSourcePath(String(formData.get("source") ?? ""));
  if (!source) return { ok: false, message: "Source invalide — doit être un chemin commençant par « / »." };
  const destination = normalizeDestination(String(formData.get("destination") ?? ""));
  if (!destination) {
    return { ok: false, message: "Destination invalide — un chemin « / » ou une URL http(s)." };
  }
  // Compare the INTERNAL path the destination lands on — `/a → https://<store>/a`
  // (or `/a?x=1`) bounces straight back into this rule just like `/a → /a`.
  if (internalDestinationPath(destination, ownHosts) === source) {
    return { ok: false, message: "La source et la destination sont identiques (boucle)." };
  }
  return {
    ok: true,
    source,
    destination,
    statusCode: normalizeStatusCode(String(formData.get("status") ?? "301")),
    // Checkbox sends value="on" when checked, ABSENT when unchecked — so an
    // absent value means OFF (matches every other toggle in the codebase). The
    // old `!== "off"` was always true (never deactivated on edit).
    isActive: formData.get("active") === "on",
    notes: String(formData.get("notes") ?? "").trim().slice(0, 500) || null,
  };
}

/**
 * Create OR update a redirect from the shared admin form. An `id` in the form
 * means update; absent means create. A create NEVER overwrites the rule already
 * holding that source (it used to upsert silently — replacing its destination,
 * status and notes and re-activating it — while reporting « créée »): the
 * operator is told to edit that rule instead. An update onto a source another
 * rule holds is refused the same way (was a raw 23505 → admin error screen).
 *
 * The success message also warns when the source is one the storefront never
 * resolves (home page, a dedicated static page, an application route — see
 * redirectSourceCoverage) and when an off-site target's status was downgraded
 * to a temporary 307.
 */
export async function saveRedirectAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_redirects", "manage");
  const id = String(formData.get("id") ?? "").trim();
  const ownHosts = await getOwnRedirectHosts();
  const parsed = readRedirectForm(formData, ownHosts);
  if (!parsed.ok) return { ok: false, error: "validation", message: parsed.message };

  // The rule being edited — for the off-site gate, the changed-fields list and
  // the audit's previous destination.
  const [prev] = id
    ? await db.select().from(redirects).where(eq(redirects.id, id)).limit(1)
    : [];
  if (id && !prev) return { ok: false, error: "not_found", message: "Redirection introuvable." };

  // Off-site — directly or through the active chain — is owner-only. A delegate
  // may still edit a rule the owner already pointed off-site (notes,
  // deactivation…) as long as it keeps that exact source → destination edge and
  // doesn't re-activate it.
  if (
    redirectWriteNeedsOwner({
      source: parsed.source,
      destination: parsed.destination,
      isActive: parsed.isActive,
      prev: prev ? { source: prev.source_path, destination: prev.destination, isActive: prev.is_active } : null,
      activeEdges: await loadActiveRedirectEdges(id || undefined),
      ownHosts,
    }) &&
    !(await holdsWildcard(session.user.id))
  ) {
    return {
      ok: false,
      error: "forbidden",
      message: OFFSITE_OWNER_ONLY,
      fieldErrors: {
        destination: isOffsiteDestination(parsed.destination, ownHosts)
          ? OFFSITE_FIELD_ERROR
          : OFFSITE_CHAIN_FIELD_ERROR,
      },
    };
  }
  const statusCode = effectiveStatusFor(parsed.destination, parsed.statusCode, ownHosts);

  // Multi-hop loop guard (readRedirectForm only blocks the direct A→A case).
  // Skipped when saving INACTIVE — an inactive rule resolves nothing, so it
  // cannot participate in a live loop (the operator may stage one side first).
  if (parsed.isActive && (await wouldLoop(parsed.source, parsed.destination, ownHosts, id || undefined))) {
    return {
      ok: false,
      error: "validation",
      message: "Cette redirection créerait une boucle avec une règle active existante.",
    };
  }

  const warnings: string[] = [];
  if (statusCode !== parsed.statusCode) {
    warnings.push(
      `type ramené à ${statusCode} (temporaire) — une destination externe n'est jamais une redirection permanente.`,
    );
  }
  const coverage = redirectCoverageWarning(parsed.source);
  if (coverage) warnings.push(coverage);
  const warnSuffix = warnings.length > 0 ? ` Attention : ${warnings.join(" ")}` : "";

  if (prev) {
    try {
      await redirectService.update(prev.id, {
        sourcePath: parsed.source,
        destination: parsed.destination,
        statusCode,
        isActive: parsed.isActive,
        notes: parsed.notes,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return {
        ok: false,
        error: "conflict",
        message: `${DUPLICATE_SOURCE} (« ${parsed.source} ») — modifiez-la dans la liste.`,
        fieldErrors: { source: DUPLICATE_SOURCE },
      };
    }
    const changedFields = [
      prev.source_path !== parsed.source && "source_path",
      prev.destination !== parsed.destination && "destination",
      prev.status_code !== statusCode && "status_code",
      prev.is_active !== parsed.isActive && "is_active",
      (prev.notes ?? null) !== parsed.notes && "notes",
    ].filter((f): f is string => Boolean(f));
    await bus.emit(
      "redirect.updated",
      {
        redirectId: prev.id,
        source: parsed.source,
        changedFields,
        destination: parsed.destination,
        ...(prev.destination !== parsed.destination ? { previousDestination: prev.destination } : {}),
      },
      { actorUserId: session.user.id },
    );
    revalidateRedirects();
    return { ok: true, message: `Redirection mise à jour.${warnSuffix}` };
  }
  const created = await redirectService.create({
    sourcePath: parsed.source,
    destination: parsed.destination,
    statusCode,
    isActive: parsed.isActive,
    notes: parsed.notes,
  });
  if (!created) {
    return {
      ok: false,
      error: "conflict",
      message: `${DUPLICATE_SOURCE} (« ${parsed.source} ») — modifiez-la dans la liste plutôt que d'en créer une seconde.`,
      fieldErrors: { source: DUPLICATE_SOURCE },
    };
  }
  await bus.emit(
    "redirect.created",
    { redirectId: created.id, source: parsed.source, destination: parsed.destination },
    { actorUserId: session.user.id },
  );
  revalidateRedirects();
  return { ok: true, message: `Redirection créée.${warnSuffix}` };
}

export async function deleteRedirectAction(formData: FormData): Promise<void> {
  const session = await requirePermission("system_redirects", "manage");
  const id = String(formData.get("id") ?? "");
  if (id) {
    await redirectService.remove(id);
    await bus.emit("redirect.deleted", { redirectId: id }, { actorUserId: session.user.id });
  }
  revalidateRedirects();
}

export async function toggleRedirectAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_redirects", "manage");
  const id = String(formData.get("id") ?? "");
  const active = String(formData.get("active") ?? "") === "true";
  if (!id) return { ok: false, error: "validation", message: "Redirection introuvable." };
  // Fetch the rule's edge up-front — for the audit envelope AND the activation
  // loop guard below (the toggle form only carries id + active).
  const [row] = await db
    .select({ source: redirects.source_path, destination: redirects.destination, isActive: redirects.is_active })
    .from(redirects)
    .where(eq(redirects.id, id))
    .limit(1);
  const ownHosts = await getOwnRedirectHosts();
  // Re-activating a rule that sends visitors OFF-SITE (directly or by chaining
  // into an off-site rule) is the same owner decision as creating one.
  if (
    active &&
    row &&
    redirectWriteNeedsOwner({
      source: row.source,
      destination: row.destination,
      isActive: true,
      prev: { source: row.source, destination: row.destination, isActive: row.isActive },
      activeEdges: await loadActiveRedirectEdges(id),
      ownHosts,
    }) &&
    !(await holdsWildcard(session.user.id))
  ) {
    revalidateRedirects();
    return { ok: false, error: "forbidden", message: OFFSITE_OWNER_ONLY };
  }
  // Re-enabling a staged rule must not close a live loop (create/import guard on
  // write; a rule can also be re-activated here). This used to refuse SILENTLY —
  // the pill snapped back to Inactive with no message and the operator could not
  // tell the click failed. Now the refusal is surfaced (mirrors saveRedirectAction).
  if (active && row && (await wouldLoop(row.source, row.destination, ownHosts, id))) {
    revalidateRedirects();
    return {
      ok: false,
      error: "validation",
      message:
        "Impossible d'activer : cette redirection créerait une boucle avec une règle active.",
    };
  }
  await redirectService.setActive(id, active);
  await bus.emit(
    "redirect.updated",
    {
      redirectId: id,
      source: row?.source ?? "",
      changedFields: ["is_active"],
      ...(row ? { destination: row.destination } : {}),
    },
    { actorUserId: session.user.id },
  );
  revalidateRedirects();
  return { ok: true };
}

export async function importRedirectsCsvAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_redirects", "manage");
  const csv = String(formData.get("csv") ?? "");
  if (!csv.trim()) return { ok: false, error: "validation", message: "Aucun contenu CSV." };
  const ownHosts = await getOwnRedirectHosts();
  const { rows: parsedRows, errors } = parseRedirectsCsv(csv, ownHosts);
  // Off-site rows: owner-only (a delegate's are skipped + counted), and never a
  // permanent redirect (301/308 → 307) — same policy as the single-row form.
  // Resolved lazily: only a row that leaves the site needs the permission read.
  let offsiteSkipped = 0;
  let ownerCache: boolean | null = null;
  const isOwner = async () => (ownerCache ??= await holdsWildcard(session.user.id));
  const rows: ParsedRedirect[] = [];
  for (const r of parsedRows) {
    if (isOffsiteDestination(r.destination, ownHosts) && !(await isOwner())) {
      offsiteSkipped += 1;
      continue;
    }
    rows.push({ ...r, status: effectiveStatusFor(r.destination, r.status, ownHosts) });
  }
  // A function: the graph walk below adds the rows that CHAIN off-site.
  const offsiteDetail = () =>
    offsiteSkipped > 0
      ? ` ${offsiteSkipped} ligne(s) ignorée(s) (destination externe, directe ou via une autre règle — réservée au super-administrateur).`
      : "";
  // Show the first few offending lines so the operator can fix the file.
  const errDetail =
    errors.length > 0
      ? ` ${errors.length} ligne(s) ignorée(s) — ${errors
          .slice(0, 3)
          .map((e) => `L${e.line}: ${e.message}`)
          .join(" · ")}${errors.length > 3 ? "…" : ""}`
      : "";
  if (rows.length === 0) {
    return {
      ok: false,
      error: "validation",
      message: `Aucune ligne valide (format attendu : source,destination,status).${offsiteDetail()}${errDetail}`,
    };
  }
  // Multi-row loop guard — the single-row form runs wouldLoop; the CSV path must
  // too, else `/a→/b` + `/b→/a` in one file creates a live 308 loop the form
  // refuses. Build the post-import active graph (existing active edges overlaid
  // with the CSV — imported rows are written active) and drop any row that would
  // close a cycle, using the SAME detector as the form. The same graph catches a
  // delegate's INTERNAL row chaining into an off-site rule (owner-only, like the
  // form): skipped + counted with the off-site rows.
  const graph = await loadActiveRedirectEdges();
  const safeRows: ParsedRedirect[] = [];
  let loopSkipped = 0;
  for (const r of rows) {
    const prev = graph.get(r.source);
    graph.set(r.source, r.destination);
    const loops = redirectChainHasCycle(graph, r.source, ownHosts);
    const offsiteChain =
      !loops && redirectChainEndsOffsite(graph, r.source, ownHosts) && !(await isOwner());
    if (loops || offsiteChain) {
      if (prev === undefined) graph.delete(r.source);
      else graph.set(r.source, prev);
      if (loops) loopSkipped += 1;
      else offsiteSkipped += 1;
    } else {
      safeRows.push(r);
    }
  }
  const loopDetail = loopSkipped > 0 ? ` ${loopSkipped} ligne(s) ignorée(s) (boucle).` : "";
  if (safeRows.length === 0) {
    return {
      ok: false,
      error: "validation",
      message: `Aucune ligne importable.${loopDetail}${offsiteDetail()}${errDetail}`,
    };
  }
  const { inserted, updated } = await redirectService.bulkUpsert(safeRows);
  await bus.emit(
    "redirect.bulk_imported",
    { created: inserted, updated, skipped: errors.length + loopSkipped + offsiteSkipped },
    { actorUserId: session.user.id },
  );
  revalidateRedirects();
  // Rules on sources the storefront never resolves are imported (harmless) but
  // flagged, so the operator isn't left wondering why they stay at 0 hits.
  const uncovered = safeRows.filter((r) => redirectCoverageWarning(r.source) !== null).length;
  const coverageDetail =
    uncovered > 0
      ? ` Attention : ${uncovered} règle(s) portent sur la page d'accueil, une page dédiée ou une route applicative et ne s'appliqueront jamais.`
      : "";
  return {
    ok: true,
    message: `Import terminé : ${inserted} créée(s), ${updated} mise(s) à jour.${loopDetail}${offsiteDetail()}${errDetail}${coverageDetail}`,
  };
}

export async function saveRedirectEngineSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_redirects", "manage");
  const res = await workflows.cms.upsertSetting(
    {
      key: "redirects.enabled",
      value: formData.get("redirects.enabled") === "on" ? "true" : "false",
      type: "boolean" as never,
      groupKey: "redirects",
      label: "Redirections — moteur activé",
    },
    { actorUserId: session.user.id },
  );
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidateRedirects();
  return { ok: true, message: "Réglages des redirections enregistrés." };
}

export async function saveNotFoundSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_redirects", "manage");
  const TEXT: Array<{ key: string; label: string }> = [
    { key: "notfound.title", label: "404 — titre" },
    { key: "notfound.message", label: "404 — message" },
  ];
  for (const f of TEXT) {
    const res = await workflows.cms.upsertSetting(
      {
        key: f.key,
        value: String(formData.get(f.key) ?? "").trim().slice(0, 400),
        type: "text" as never,
        groupKey: "redirects",
        label: f.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }
  const BOOL: Array<{ key: string; label: string }> = [
    { key: "notfound.show_search", label: "404 — afficher la recherche" },
    { key: "notfound.show_suggestions", label: "404 — afficher les suggestions" },
  ];
  for (const f of BOOL) {
    const res = await workflows.cms.upsertSetting(
      {
        key: f.key,
        value: formData.get(f.key) === "on" ? "true" : "false",
        type: "boolean" as never,
        groupKey: "redirects",
        label: f.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }
  revalidateRedirects();
  revalidatePath("/", "layout");
  return { ok: true, message: "Réglages de la page 404 enregistrés." };
}
