import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless HMAC tokens for unsubscribe links — no DB table needed. Keyed by the
 * already-provisioned `PAYMENT_ENCRYPTION_KEY` (init-secrets.ts), domain-separated
 * from the AES secret-encryption key by hashing a context label in. The token
 * carries the email it signs, so the unsubscribe route needs no lookup.
 *
 * Tokens DON'T expire: a stale unsubscribe link unsubscribing is the correct
 * behaviour. Returns "" when the key is unset (the caller omits the link rather
 * than crash a send).
 */
function signingKey(): Buffer | null {
  const raw = process.env.PAYMENT_ENCRYPTION_KEY ?? "";
  if (!raw.trim()) return null;
  return createHash("sha256").update(`gz.unsub.v1.${raw}`, "utf8").digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** `base64url(email).base64url(hmac)`, or "" when no signing key is configured. */
export function signUnsubToken(email: string): string {
  const key = signingKey();
  if (!key) return "";
  const e = email.trim().toLowerCase();
  if (!e) return "";
  const mac = createHmac("sha256", key).update(e).digest();
  return `${b64url(Buffer.from(e, "utf8"))}.${b64url(mac)}`;
}

/** The signed email, or null if the token is malformed/forged/unverifiable. Constant-time. */
export function verifyUnsubToken(token: string): string | null {
  const key = signingKey();
  if (!key || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  let email = "";
  try {
    email = fromB64url(parts[0]).toString("utf8").trim().toLowerCase();
  } catch {
    return null;
  }
  if (!email) return null;
  const expected = createHmac("sha256", key).update(email).digest();
  let provided: Buffer;
  try {
    provided = fromB64url(parts[1]);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  return timingSafeEqual(provided, expected) ? email : null;
}
