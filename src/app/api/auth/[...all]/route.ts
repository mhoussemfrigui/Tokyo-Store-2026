import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/lib/auth/server";
import { getClientIp } from "@/lib/client-ip";

/**
 * Better Auth catch-all handler.
 *
 * Serves what must be reachable over HTTP:
 *   GET      /api/auth/get-session             (authClient.useSession)
 *   POST     /api/auth/sign-out
 *   POST     /api/auth/sign-in/social          (Google / Facebook buttons)
 *   GET/POST /api/auth/callback/<provider>     (OAuth return)
 *   GET      /api/auth/verify-email            (emailed verification link)
 *   GET      /api/auth/reset-password/:token   (emailed reset / invite link)
 *   POST     /api/auth/two-factor/{enable,verify-totp,disable} (/account 2FA card)
 *
 * The email/password credential endpoints (sign-in/sign-up/reset/change…) are
 * DISABLED here (`disabledPaths`, see AUTH_HTTP_DISABLED_PATHS in policy.ts):
 * the app calls them IN-PROCESS (`auth.api.*`) from server actions, which add
 * the Postgres throttles, audit events and signup invariants the raw endpoints
 * lack.
 */

/**
 * Better Auth's limiter keys on the FIRST `X-Forwarded-For` entry, which is
 * client-controlled (a rotating fake leading entry = a fresh bucket per
 * request). Rewrite the header to the single hop our own `getClientIp` trusts
 * (the LAST entry, appended by the reverse proxy — falls back to X-Real-IP) so
 * both limiters key on the same, unspoofable address. No resolvable IP ⇒ the
 * header is dropped (Better Auth then behaves as before when it's absent).
 */
function withTrustedClientIp(req: Request): Request {
  const ip = getClientIp(req.headers);
  const headers = new Headers(req.headers);
  if (ip) headers.set("x-forwarded-for", ip);
  else headers.delete("x-forwarded-for");
  // `duplex` is required by undici when a streamed body is forwarded.
  return new Request(req, { headers, duplex: "half" } as RequestInit);
}

// Resolve the (cached) auth instance per request so a credential change
// (resetAuthInstance) is picked up without a redeploy. The lookup is a cached
// promise, so this adds no real overhead.
export async function GET(req: Request): Promise<Response> {
  return toNextJsHandler(await getAuth()).GET(withTrustedClientIp(req));
}

export async function POST(req: Request): Promise<Response> {
  return toNextJsHandler(await getAuth()).POST(withTrustedClientIp(req));
}
