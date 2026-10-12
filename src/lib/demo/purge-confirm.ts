import "server-only";

import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { verifications } from "@/modules/auth/schema";

/**
 * One-time email confirmation code for the destructive "purge + relaunch demo"
 * flow. Backed by the generic `verifications` table (identifier-scoped,
 * single pending per user, 15-min expiry — the auth retention purge already
 * sweeps expired rows). The PLAINTEXT code is emailed to the acting super-admin
 * and never stored; only its SHA-256 hash is persisted, compared constant-time,
 * and the row is consumed on a successful match (single-use).
 */

const TTL_MINUTES = 15;
const IDENTIFIER_PREFIX = "demo-purge:";

function identifierFor(userId: string): string {
  return `${IDENTIFIER_PREFIX}${userId}`;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/**
 * Mint a 6-digit code, store its hash (replacing any pending one for this user),
 * and return the plaintext + the TTL for the email copy.
 */
export async function createPurgeConfirmCode(
  userId: string,
): Promise<{ code: string; expiresMinutes: number }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const identifier = identifierFor(userId);
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000);
  await db.transaction(async (tx) => {
    await tx.delete(verifications).where(eq(verifications.identifier, identifier));
    await tx.insert(verifications).values({
      id: randomUUID(),
      identifier,
      value: hashCode(code),
      expiresAt,
    });
  });
  return { code, expiresMinutes: TTL_MINUTES };
}

/**
 * Verify the code for this user. ATOMIC single-use: a delete-and-return
 * consumes the pending row(s) in one statement, so two concurrent confirms
 * can't both succeed (only one caller receives the row) — the DB serializes the
 * guarantee, not a SELECT-then-DELETE race. A wrong/expired guess also consumes
 * the code (the user must request a fresh one), which bounds brute force.
 * Returns true only on a correct, non-expired, constant-time match.
 */
export async function consumePurgeConfirmCode(userId: string, code: string): Promise<boolean> {
  const clean = (code ?? "").trim();
  if (!/^\d{6}$/.test(clean)) return false;
  const identifier = identifierFor(userId);
  const rows = await db
    .delete(verifications)
    .where(eq(verifications.identifier, identifier))
    .returning();
  const now = Date.now();
  const target = Buffer.from(hashCode(clean), "hex");
  for (const row of rows) {
    if (row.expiresAt.getTime() < now) continue;
    const stored = Buffer.from(row.value, "hex");
    if (stored.length === target.length && timingSafeEqual(stored, target)) return true;
  }
  return false;
}

/** Drop any pending code for this user (e.g. when the confirm email failed to
 *  send, so no live code is left dangling for its TTL). */
export async function invalidatePurgeConfirmCode(userId: string): Promise<void> {
  await db.delete(verifications).where(eq(verifications.identifier, identifierFor(userId)));
}
