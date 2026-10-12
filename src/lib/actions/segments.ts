"use server";

import { revalidatePath } from "next/cache";

import { bus } from "@/events/bus";
import { requirePermission } from "@/lib/auth/session";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { segmentService } from "@/modules/customer/segment.service";
import { type SegmentKind } from "@/modules/customer/schema";
import { isValidDynamicRule } from "@/lib/promotions/segment-rules";
import { type RuleNode } from "@/lib/promotions/rule-tree";
import { isValidRuleTree } from "@/lib/promotions/rule-leaves";
import { type ActionState } from "@/lib/actions/types";

/**
 * Server actions for the admin Segments-clients area (audience groupings a
 * promotion targets). Every action is gated by the EXISTING `promotions`
 * permission — segments are a sub-surface of promotions, so they share its RBAC
 * key rather than introducing a new module. Pattern mirrors
 * `src/lib/actions/business.ts`: requirePermission → mutate → revalidatePath →
 * the shared `ActionState` shape.
 */
const PATH = "/admin/marketing/segments";

const isKind = (v: unknown): v is SegmentKind => v === "manual" || v === "dynamic";

export async function createSegmentAction(input: {
  name: string;
  kind: SegmentKind;
  rule?: string | null;
  /** Compound AND/OR tree (Phase 6). When present it supersedes the legacy `rule`. */
  ruleTree?: RuleNode | null;
}): Promise<ActionState & { id?: string }> {
  const session = await requirePermission("promotions", "create");
  const name = (input.name ?? "").trim();
  if (name.length < 2) {
    return { ok: false, error: "validation", message: "Nom du segment requis (2 caractères min.)." };
  }
  const kind: SegmentKind = isKind(input.kind) ? input.kind : "manual";

  // A dynamic segment carries EITHER a compound rule_tree (the new builder) OR a legacy
  // single rule; a manual one carries neither. Both are validated fail-closed — an
  // invalid/unknown rule would persist a segment that matches NOBODY (or, for an empty
  // tree, EVERYBODY), so it's rejected on write.
  let rule: string | null = null;
  let ruleTree: RuleNode | null = null;
  if (kind === "dynamic") {
    if (input.ruleTree != null) {
      if (!isValidRuleTree(input.ruleTree)) {
        return { ok: false, error: "validation", message: "Règle de segment invalide." };
      }
      ruleTree = input.ruleTree;
    } else {
      rule = (input.rule ?? "").trim() || null;
      if (!rule) {
        return { ok: false, error: "validation", message: "Choisissez une règle pour un segment dynamique." };
      }
      if (!isValidDynamicRule(rule)) {
        return { ok: false, error: "validation", message: "Règle de segment inconnue." };
      }
    }
  }

  const row = await segmentService.insert({ name, kind, rule, rule_tree: ruleTree });
  await bus.emit("segment.created", { segmentId: row.id, name }, { actorUserId: session.user.id });
  revalidatePath(PATH);
  return { ok: true, message: "Segment créé.", id: row.id };
}

export async function updateSegmentAction(input: {
  id: string;
  name?: string;
  rule?: string | null;
  ruleTree?: RuleNode | null;
  enabled?: boolean;
}): Promise<ActionState> {
  const session = await requirePermission("promotions", "update");
  const existing = await segmentService.get(input.id);
  if (!existing) return { ok: false, error: "not_found", message: "Segment introuvable." };

  const patch: { name?: string; rule?: string | null; rule_tree?: RuleNode | null; enabled?: boolean } = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2) {
      return { ok: false, error: "validation", message: "Nom du segment requis (2 caractères min.)." };
    }
    patch.name = name;
  }
  if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
  // Rule editing only applies to dynamic segments; ignore it for manual ones. A
  // compound tree supersedes the legacy single rule (and vice-versa), so saving one
  // clears the other — the resolver reads rule_tree ?? legacyRuleToTree(rule).
  if (existing.kind === "dynamic") {
    if (input.ruleTree !== undefined && input.ruleTree !== null) {
      if (!isValidRuleTree(input.ruleTree)) {
        return { ok: false, error: "validation", message: "Règle de segment invalide." };
      }
      patch.rule_tree = input.ruleTree;
      patch.rule = null;
    } else if (input.rule !== undefined) {
      const rule = (input.rule ?? "").trim() || null;
      if (!rule) return { ok: false, error: "validation", message: "Choisissez une règle pour un segment dynamique." };
      if (!isValidDynamicRule(rule)) {
        return { ok: false, error: "validation", message: "Règle de segment inconnue." };
      }
      patch.rule = rule;
      patch.rule_tree = null;
    }
  }

  await segmentService.update(input.id, patch);
  await bus.emit(
    "segment.updated",
    { segmentId: input.id, changedFields: Object.keys(patch) },
    { actorUserId: session.user.id },
  );
  revalidatePath(PATH);
  return { ok: true, message: "Segment mis à jour." };
}

export async function deleteSegmentAction(segmentId: string): Promise<ActionState> {
  const session = await requirePermission("promotions", "delete");
  const existing = await segmentService.get(segmentId);
  if (!existing) return { ok: false, error: "not_found", message: "Segment introuvable." };
  await segmentService.softDelete(segmentId);
  await bus.emit("segment.deleted", { segmentId }, { actorUserId: session.user.id });
  revalidatePath(PATH);
  return { ok: true, message: "Segment supprimé." };
}

export async function addSegmentMemberByEmailAction(
  segmentId: string,
  email: string,
): Promise<ActionState> {
  const session = await requirePermission("promotions", "update");
  const segment = await segmentService.get(segmentId);
  if (!segment) return { ok: false, error: "not_found", message: "Segment introuvable." };
  if (segment.kind !== "manual") {
    return { ok: false, error: "validation", message: "Les membres ne s'ajoutent qu'aux segments manuels." };
  }
  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized.includes("@")) {
    return { ok: false, error: "validation", message: "Email invalide." };
  }
  // email → auth user → customer_profile_id (the membership FK).
  const user = await authService.findByEmail(normalized);
  if (!user) return { ok: false, error: "not_found", message: "Aucun compte avec cet email." };
  const link = await customerUserLink.findByUserId(user.id);
  if (!link) return { ok: false, error: "not_found", message: "Ce compte n'a pas de profil client." };
  // An archived profile (« Supprimer le client ») never matches a promo nor gets
  // mailed (buyer context + audiences read live profiles only) — refuse instead
  // of reporting a membership that can never apply.
  if (!(await customerService.findProfileById(link.customer_profile_id))) {
    return { ok: false, error: "validation", message: "Client archivé : il ne peut pas être ajouté au segment." };
  }

  const added = await segmentService.addMember(segmentId, link.customer_profile_id);
  // Only audit a real change — adding an existing member is a no-op.
  if (added) {
    await bus.emit(
      "segment.members_changed",
      { segmentId, change: "added", count: 1 },
      { actorUserId: session.user.id },
    );
  }
  revalidatePath(PATH);
  return { ok: true, message: "Client ajouté au segment." };
}

export async function removeSegmentMemberAction(
  segmentId: string,
  profileId: string,
): Promise<ActionState> {
  const session = await requirePermission("promotions", "update");
  const removed = await segmentService.removeMember(segmentId, profileId);
  // Only audit a real change — removing a non-member is a no-op.
  if (removed) {
    await bus.emit(
      "segment.members_changed",
      { segmentId, change: "removed", count: 1 },
      { actorUserId: session.user.id },
    );
  }
  revalidatePath(PATH);
  return { ok: true, message: "Client retiré du segment." };
}
