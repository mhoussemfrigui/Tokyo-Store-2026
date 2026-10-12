import "server-only";

import { z } from "zod";

import { trustBadgeService } from "@/modules/cms/trust_badge/service";
import { TRUST_ICON_NAMES } from "@/lib/home/trust-icon-names";
import { bus } from "@/events/bus";
import { fail, ok, workflow, ZOD_FR, zodValidationFail } from "../shared";

/**
 * Trust badges — the admin-managed reassurance strip (buy-box + optionally cart /
 * checkout). CRUD; the storefront is force-dynamic and the action revalidates the
 * layout, but the mutations are emitted on the bus so they land in the audit log.
 * `kind` is an optional discriminator the renderer uses to special-case copy
 * (warranty → per-product value / generic checkout warranty; delivery/returns →
 * dynamic checkout copy). `visibility` gates the badge by stock state.
 *
 * `icon` is validated against the curated TRUST_ICON_NAMES set — an unknown name
 * is rejected here (not silently coerced to ShieldCheck at render), so the admin's
 * appearance choice is authoritative even against a scripted / headless write.
 */
/** French field labels for the validation banner (zodValidationFail). */
const BADGE_FIELD_LABELS: Record<string, string> = {
  label: "Libellé",
  icon: "Icône",
  kind: "Type",
  visibility: "Visibilité",
  displayOrder: "Ordre",
};
// Physical-only store: visibility is always | in_stock. The retired `preorder`
// value was migrated to `in_stock` (migration 0179) and is no longer accepted.
const visibilityEnum = z.enum(["always", "in_stock"]);
const kindEnum = z.enum(["security", "delivery", "returns", "warranty"]);
const iconSchema = z
  .string()
  .trim()
  .refine((n) => (TRUST_ICON_NAMES as readonly string[]).includes(n), "Icône inconnue.");

export const createTrustBadgeSchema = z.object({
  label: z.string().trim().min(1, "Champ requis.").max(80),
  icon: iconSchema.default("ShieldCheck"),
  kind: kindEnum.nullable().optional(),
  visibility: visibilityEnum.default("always"),
  displayOrder: z.number().int().min(0).max(100000).default(0),
});

export const createTrustBadgeWorkflow = workflow<
  [z.input<typeof createTrustBadgeSchema>, { actorUserId: string }],
  { id: string }
>("cms.trust_badge.create", async (input, { actorUserId }) => {
  const parsed = createTrustBadgeSchema.safeParse(input, ZOD_FR);
  if (!parsed.success) return zodValidationFail(parsed.error, BADGE_FIELD_LABELS);
  const row = await trustBadgeService.insert({
    label: parsed.data.label,
    icon: parsed.data.icon,
    kind: parsed.data.kind ?? null,
    visibility: parsed.data.visibility,
    display_order: parsed.data.displayOrder,
  });
  await bus.emit("cms.trust_badge.created", { badgeId: row.id }, { actorUserId });
  return ok({ id: row.id });
});

export const updateTrustBadgeSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1, "Champ requis.").max(80).optional(),
  icon: iconSchema.optional(),
  kind: kindEnum.nullable().optional(),
  visibility: visibilityEnum.optional(),
  isActive: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(100000).optional(),
});

export const updateTrustBadgeWorkflow = workflow<
  [z.input<typeof updateTrustBadgeSchema>, { actorUserId: string }],
  { id: string }
>("cms.trust_badge.update", async (input, { actorUserId }) => {
  const parsed = updateTrustBadgeSchema.safeParse(input, ZOD_FR);
  if (!parsed.success) return zodValidationFail(parsed.error, BADGE_FIELD_LABELS);
  const patch: Parameters<typeof trustBadgeService.update>[1] = {};
  if (parsed.data.label !== undefined) patch.label = parsed.data.label;
  if (parsed.data.icon !== undefined) patch.icon = parsed.data.icon;
  if (parsed.data.kind !== undefined) patch.kind = parsed.data.kind;
  if (parsed.data.visibility !== undefined) patch.visibility = parsed.data.visibility;
  if (parsed.data.isActive !== undefined) patch.is_active = parsed.data.isActive;
  if (parsed.data.displayOrder !== undefined) patch.display_order = parsed.data.displayOrder;
  const row = await trustBadgeService.update(parsed.data.id, patch);
  if (!row) return fail("not_found", "Badge introuvable.");
  await bus.emit("cms.trust_badge.updated", { badgeId: row.id }, { actorUserId });
  return ok({ id: row.id });
});

export const deleteTrustBadgeWorkflow = workflow<
  [{ id: string }, { actorUserId: string }],
  { id: string }
>("cms.trust_badge.delete", async ({ id }, { actorUserId }) => {
  // delete() returns the removed row (null when nothing matched) → report
  // not_found and only emit the audit event on a real deletion, with the badge's
  // label/kind so the log shows WHAT was removed (not just an opaque id).
  const row = await trustBadgeService.delete(id);
  if (!row) return fail("not_found", "Badge introuvable.");
  await bus.emit(
    "cms.trust_badge.deleted",
    { badgeId: id, label: row.label, kind: row.kind },
    { actorUserId },
  );
  return ok({ id });
});
