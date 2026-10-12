import "server-only";

import { mediaQueries } from "@/modules/media";
import { deleteObject } from "@/modules/media/storage";
import { bus } from "../bus";

/**
 * Media storage cleanup.
 *
 * Purges the backing S3 objects for every variant of a deleted media
 * row. Centralises object cleanup for BOTH the single-delete (`media.deleted`)
 * and the bulk-delete (`media.bulk_deleted`) paths — the events carry the full
 * list of variant keys (computed BEFORE the DB row was removed), so the
 * subscriber needs no media lookup and works even though the bulk path hard-
 * deletes the rows.
 *
 * Order snapshots: order lines store the resolved image URL (`/cdn/<key>`), not
 * a media id, so purging those objects would break every historical order
 * thumbnail (admin order view, customer order history, sent emails). Keys an
 * order line still displays are KEPT (one query per purge batch — see
 * mediaQueries.listOrderReferencedStorageKeys); the rest are reaped. If that
 * lookup fails, nothing is purged: a leaked object only costs storage, a purged
 * order thumbnail is lost for good.
 *
 * Best-effort: a failed object delete is logged but never thrown. The bus
 * swallows subscriber errors anyway, and blocking the delete on a transient
 * storage error is not worth it. NOTE: there is NO bucket-wide orphan sweep —
 * a leaked object stays until removed by hand, which is why every skipped or
 * failed key is logged.
 */
async function purge(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  let pinned: Set<string>;
  try {
    pinned = await mediaQueries.listOrderReferencedStorageKeys(keys);
  } catch (err) {
    console.error("[events:cleanup-media-storage] order-snapshot lookup failed; skipping purge", {
      keys,
      err,
    });
    return;
  }
  for (const key of keys) {
    if (pinned.has(key)) continue;
    try {
      await deleteObject(key);
    } catch (err) {
      console.error("[events:cleanup-media-storage] object delete failed", { key, err });
    }
  }
}

export function registerMediaStorageCleanupSubscriber() {
  bus.on("media.deleted", async ({ payload }) => {
    await purge(payload.storageKeys);
  });
  bus.on("media.bulk_deleted", async ({ payload }) => {
    await purge(payload.storageKeys);
  });
}
