/**
 * PURE (node:crypto only) per-challenge 2FA rate-limit key, derived from the
 * pending sign-in challenge cookie EXACTLY as Better Auth reads it — so the two
 * paths that can verify a sign-in TOTP (verifyTwoFactorAction in-process, and a
 * direct HTTP /two-factor/verify-totp through the hooks.before in
 * lib/auth/server.ts) charge ONE bucket per challenge.
 *
 * Better Auth (better-call@1.3 `getSignedCookie`) verifies only the EXACT cookie
 * name `createAuthCookie("two_factor").name` (`__Secure-gz.two_factor` in prod),
 * takes its FIRST occurrence, strips one pair of surrounding double quotes,
 * %-decodes it, then checks `<token>.<base64 HMAC-SHA256(secret, token)>`. We
 * mirror that and key on the VERIFIED token (the challenge identity Better Auth
 * itself uses), never on "the first cookie that looks like a challenge":
 *
 *   - a decoy `x.two_factor=<random>` (or a later duplicate) can't mint a fresh
 *     bucket per guess while Better Auth verifies the real challenge;
 *   - encodings of one challenge (quoted, %-escaped or not, base64 padding-bit
 *     variants of the signature) collapse to one key;
 *   - an unsigned / forged cookie yields no key, so it writes no bucket row
 *     (Better Auth rejects it anyway — there is nothing to guess against).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** The twoFactor plugin's cookie name (Better Auth `TWO_FACTOR_COOKIE_NAME`),
 *  before `createAuthCookie` adds the `<cookiePrefix>.` / `__Secure-` parts. */
export const TWO_FACTOR_CHALLENGE_COOKIE = "two_factor";

/** Per-challenge guess budget, shared by both verify paths. */
export const TWO_FACTOR_CHALLENGE_RATE_LIMIT = { max: 8, windowSeconds: 900 } as const;

/**
 * Value of cookie `name` in a raw Cookie header, parsed like better-call@1.3
 * `parseCookies` (port of its loop): FIRST occurrence wins, name + value
 * trimmed, one leading `"` and the last character stripped when quoted, then
 * %-decoded only when it contains `%` (a malformed escape keeps the raw value).
 * Empty → null (better-call treats "" as absent too).
 */
export function readCookieLikeBetterAuth(cookieHeader: string, name: string): string | null {
  let index = 0;
  while (index < cookieHeader.length) {
    const eqIdx = cookieHeader.indexOf("=", index);
    if (eqIdx === -1) break;
    let endIdx = cookieHeader.indexOf(";", index);
    if (endIdx === -1) endIdx = cookieHeader.length;
    else if (endIdx < eqIdx) {
      index = cookieHeader.lastIndexOf(";", eqIdx - 1) + 1;
      continue;
    }
    if (cookieHeader.slice(index, eqIdx).trim() === name) {
      let val = cookieHeader.slice(eqIdx + 1, endIdx).trim();
      if (val.codePointAt(0) === 34) val = val.slice(1, -1);
      if (val.includes("%")) {
        try {
          val = decodeURIComponent(val);
        } catch {
          // malformed escape — better-call keeps the raw value
        }
      }
      return val || null;
    }
    index = endIdx + 1;
  }
  return null;
}

/**
 * Verify a better-call signed cookie value `<token>.<signature>` (signature =
 * 44-char padded base64 of HMAC-SHA256(secret, token), decoded with `atob` like
 * better-call). Returns the token, or null when unsigned / forged.
 */
export function verifySignedCookieValue(value: string, secret: string): string | null {
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const token = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (signature.length !== 44 || !signature.endsWith("=")) return null;
  let given: Buffer;
  try {
    given = Buffer.from(atob(signature), "latin1");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(token).digest();
  return given.length === expected.length && timingSafeEqual(given, expected) ? token : null;
}

/** sha256/24 of the verified challenge token — no token lands in a bucket key. */
export function twoFactorChallengeKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 24);
}

/**
 * Per-challenge key for the pending challenge in a raw Cookie header, or null
 * when the header carries no VALIDLY SIGNED `cookieName` cookie.
 */
export function twoFactorChallengeKeyFromCookieHeader(
  cookieHeader: string | null | undefined,
  cookieName: string,
  secret: string,
): string | null {
  if (!cookieHeader) return null;
  const raw = readCookieLikeBetterAuth(cookieHeader, cookieName);
  const token = raw ? verifySignedCookieValue(raw, secret) : null;
  return token ? twoFactorChallengeKey(token) : null;
}
