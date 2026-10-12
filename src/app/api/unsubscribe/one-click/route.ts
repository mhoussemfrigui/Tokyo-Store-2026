import { NextResponse } from "next/server";

import { verifyUnsubToken } from "@/lib/crypto/sign";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { unsubscribeEmailFromMarketing } from "@/workflows/customer/unsubscribe";

const NO_STORE = { "Cache-Control": "no-store" };

function tokenOf(request: Request): string {
  return new URL(request.url).searchParams.get("token")?.trim() ?? "";
}

/**
 * POST /api/unsubscribe/one-click?token=… — RFC 8058 one-click unsubscribe, the
 * `List-Unsubscribe` target of every marketing email (`listUnsubscribeHeaders`).
 * The mailbox provider (Gmail, Yahoo, Apple Mail…) POSTs
 * `List-Unsubscribe=One-Click` here FROM ITS OWN SERVERS when the recipient hits
 * its native « Se désabonner » button — no cookie, no Origin, no page — so there
 * is no session / same-origin guard: the signed token in the URL IS the
 * authorisation (the same HMAC token as the footer link, verified exactly like
 * the /se-desabonner confirm action). The body is not required: only a POST
 * unsubscribes, and link scanners / prefetchers only ever GET.
 *
 * Anti-enumeration: a valid, forged or malformed token all get the same 200 (a
 * token says nothing about whether the address exists); only a genuine opt-out
 * that FAILED (DB down) answers 500, so it is logged and never silently lost.
 * Never a redirect on POST (RFC 8058 §3.2). Not rate-limited: a forged token
 * costs one HMAC and no DB read, a genuine one is an idempotent opt-out — and the
 * providers POST from shared IP pools, where a per-IP cap would drop real opt-outs.
 */
export async function POST(request: Request): Promise<Response> {
  const token = tokenOf(request);
  const email = token ? verifyUnsubToken(token) : null;
  if (email) {
    try {
      await unsubscribeEmailFromMarketing(email);
    } catch (err) {
      console.error("[unsubscribe/one-click] opt-out failed", err);
      return NextResponse.json({ ok: false }, { status: 500, headers: NO_STORE });
    }
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

/**
 * GET — a client that OPENS the List-Unsubscribe URL in a browser instead of
 * POSTing it. Never unsubscribes (a GET can be a scanner / prefetch): 303 to the
 * POST-confirm page with the same token, on the public origin (seo.site_url
 * aware — `request.url` can be the internal host behind the reverse proxy).
 */
export async function GET(request: Request): Promise<Response> {
  const token = tokenOf(request);
  const target = `${await resolvePublicOrigin()}/se-desabonner${
    token ? `?token=${encodeURIComponent(token)}` : ""
  }`;
  return NextResponse.redirect(target, { status: 303, headers: NO_STORE });
}
