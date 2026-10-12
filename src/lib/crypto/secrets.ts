import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for secrets at rest (payment credentials).
 *
 * Stored format: `base64(iv).base64(authTag).base64(ciphertext)` (dot-joined).
 * The key is derived by SHA-256 of `PAYMENT_ENCRYPTION_KEY`, so any non-empty
 * passphrase works (32 bytes out). The value is provisioned automatically at
 * container start (src/lib/db/init-secrets.ts: env wins, else loaded/generated
 * and persisted in `app_secrets`), so a fresh deploy needs no `openssl rand`
 * ceremony — set the env var in Coolify only to supply or rotate it yourself.
 *
 * Decryption is forgiving: a missing key, malformed blob, or wrong key returns
 * "" (treated as "not configured") rather than throwing — a rotated/lost key
 * must never crash payment init; the admin just re-enters the credential.
 * Encryption is strict: it throws if the key is unset, so the admin save action
 * surfaces a clear "set PAYMENT_ENCRYPTION_KEY first" error.
 */
function deriveKey(): Buffer {
  const raw = process.env.PAYMENT_ENCRYPTION_KEY ?? "";
  if (!raw.trim()) {
    throw new Error(
      "PAYMENT_ENCRYPTION_KEY is not set — cannot encrypt payment secrets. " +
        "It is normally auto-provisioned at container start (init-secrets.ts); " +
        "for local dev, set it in your environment (e.g. `openssl rand -base64 32`).",
    );
  }
  return createHash("sha256").update(raw, "utf8").digest();
}

export function isEncryptionConfigured(): boolean {
  return Boolean((process.env.PAYMENT_ENCRYPTION_KEY ?? "").trim());
}

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return "";
  const parts = stored.split(".");
  if (parts.length !== 3) return "";
  try {
    const [ivB, tagB, ctB] = parts;
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(), Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    const pt = Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    // No plaintext/ciphertext in the log — just a greppable signal so a key
    // rotation / typo / cross-key DB restore is diagnosable instead of all
    // gateways silently going "non configuré".
    console.warn(
      "[crypto] payment secret decrypt failed — PAYMENT_ENCRYPTION_KEY may have changed " +
        "or the stored value is corrupt; treating it as not configured.",
    );
    return "";
  }
}
