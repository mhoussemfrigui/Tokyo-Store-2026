import "server-only";

import { randomUUID } from "node:crypto";

import type { EmailProvider } from "../types";

/**
 * Dev provider — prints emails to the server log.
 * Set EMAIL_PROVIDER=console (default) to use it.
 *
 * Outputs a compact summary + a clickable verify/reset link if found in the
 * payload (so you don't need to scrape HTML).
 */
export const consoleProvider: EmailProvider = {
  name: "console",
  async send(payload, { from }) {
    const id = randomUUID();
    // Pull the first ACTIONABLE link (an <a href="http...">), skipping
    // doctype / schema URLs and known third-party CDNs. We used to match
    // the first bare `https?://...` which picked up the xhtml1 DTD URL in
    // the HTML doctype.
    const NON_APP = /^https?:\/\/(www\.)?(w3\.org|schema\.org)/i;
    let link: string | null = null;
    for (const m of payload.html.matchAll(/<a\b[^>]*\bhref="(https?:\/\/[^"]+)"/gi)) {
      if (!NON_APP.test(m[1])) {
        link = m[1];
        break;
      }
    }
    console.log(
      [
        "",
        "─── ✉  EMAIL (console provider) ───────────────────────────",
        `id:      ${id}`,
        `from:    ${from}`,
        `to:      ${Array.isArray(payload.to) ? payload.to.join(", ") : payload.to}`,
        `subject: ${payload.subject}`,
        link ? `link:    ${link}` : "",
        "───────────────────────────────────────────────────────────",
        "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return { id };
  },
};
