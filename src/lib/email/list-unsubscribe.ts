import "server-only";

import { signUnsubToken } from "@/lib/crypto/sign";

/** The RFC 8058 one-click endpoint (`src/app/api/unsubscribe/one-click/route.ts`). */
export const ONE_CLICK_UNSUBSCRIBE_PATH = "/api/unsubscribe/one-click";

/**
 * `List-Unsubscribe` + `List-Unsubscribe-Post` headers for ONE marketing
 * recipient (RFC 2369 + RFC 8058 one-click) — what lets Gmail / Yahoo / Apple
 * Mail show their native « Se désabonner » button, and what their bulk-sender
 * rules expect on marketing mail. The URL carries the same stateless HMAC token
 * as the footer link (`unsubFooterHtml`); the mailbox provider POSTs
 * `List-Unsubscribe=One-Click` to it and the route opts the address out with no
 * confirm page.
 *
 * `origin` = `await resolvePublicOrigin()` (seo.site_url aware, like the footer).
 * Returns undefined — send WITHOUT the headers — when no signing key is
 * configured (the footer link is omitted then too) or the address is blank. No
 * `mailto:` variant: nothing processes unsubscribe mail automatically, and the
 * https one-click form is the one the bulk-sender rules require.
 */
export function listUnsubscribeHeaders(
  email: string,
  origin: string,
): Record<string, string> | undefined {
  const token = signUnsubToken(email);
  if (!token) return undefined;
  const url = `${origin.replace(/\/$/, "")}${ONE_CLICK_UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`;
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
