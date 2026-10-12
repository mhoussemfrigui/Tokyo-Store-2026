import "server-only";

import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { decideNameSync } from "@/lib/users/name-sync";
import { bus } from "../bus";

/**
 * Mirror `customer_profiles.first_name/last_name` → the linked `users.name`.
 *
 * `users.name` is a denormalised copy read by the Utilisateurs list, the audit
 * actor-name resolution, the order link-candidate names, and the customer-360
 * header. It's set in lockstep at signup, but `updateProfileWorkflow` /
 * `adminUpdateProfileWorkflow` write only `customer_profiles`, so a client name
 * edit would otherwise leave the stale name everywhere it reads `users.name`
 * (the reported bug). This subscriber closes that gap for BOTH edit paths with
 * one handler.
 *
 * ONE-WAY by design: profile → users.name. There is no reverse sync because
 * admin has no `users.name` editor (the user detail page redirects accounts that
 * own a profile to the customer-360, which edits the profile). If a `users.name`
 * editor is ever added, wire the reverse there — do NOT make this subscriber
 * two-way.
 *
 * Trust note: every `customer.profile_updated` emitter (profile edits, notes,
 * loyalty, promo opt-out, newsletter sync) sends the CUSTOMER's linked user id
 * or null (unlinked profile; the external-API upsert always sends null) — never
 * the acting admin, who travels in `meta.actorUserId`. The
 * `first_name`/`last_name` `changedFields` gate (`decideNameSync`) is still
 * required: only the profile-update workflows put name fields there, so don't
 * add name fields to the other emitters' changedFields.
 *
 * Frozen snapshots (order `ship_full_name`, invoices) are intentionally NOT
 * resynced — they record the name AS IT WAS at the time of the order/document.
 *
 * Loop-safe: `authService.update` is pure SQL and emits nothing, so this can't
 * ping-pong with the other `customer.profile_updated` subscribers. Best-effort:
 * any failure logs and swallows (the profile write already committed).
 */
export function registerUserNameFromProfileSyncSubscriber() {
  bus.on("customer.profile_updated", async ({ payload }) => {
    // Cheap pre-gate before any DB read (full decision needs the user's current
    // name, fetched below).
    if (
      !payload.changedFields.includes("first_name") &&
      !payload.changedFields.includes("last_name")
    ) {
      return;
    }
    if (!payload.userId) return; // unlinked / guest profile — nothing to mirror

    try {
      const [profile, user] = await Promise.all([
        customerService.findProfileById(payload.customerProfileId),
        authService.findById(payload.userId),
      ]);
      if (!profile || !user) return;

      const decision = decideNameSync({
        changedFields: payload.changedFields,
        userId: payload.userId,
        firstName: profile.first_name,
        lastName: profile.last_name,
        currentName: user.name,
      });
      if (decision.action !== "update") return;

      await authService.update(payload.userId, { name: decision.name });
    } catch (err) {
      console.error("[events] sync-user-name-from-profile failed", err);
    }
  });
}
