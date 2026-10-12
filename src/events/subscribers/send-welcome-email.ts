import "server-only";

import { dispatchEmail, isFlowEnabled } from "@/modules/mailing";
import { firstNameOf } from "@/lib/email/util";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { bus } from "../bus";

export function registerWelcomeEmailSubscriber() {
  bus.on("user.created", async ({ payload }) => {
    // Honour the Workflows-tab toggle for this flow (default on).
    if (!(await isFlowEnabled("welcome"))) return;
    // dispatchEmail is best-effort (never throws) — a failed welcome email
    // must not affect the already-created account.
    const res = await dispatchEmail({
      key: "welcome",
      to: payload.email,
      flowKey: "welcome",
      variables: {
        first_name: firstNameOf(payload.name),
        shop_url: await resolvePublicOrigin(),
      },
    });
    if (!res.sent && !res.skipped) {
      console.error("[events] send-welcome-email not sent:", res.reason);
    }
  });
}
