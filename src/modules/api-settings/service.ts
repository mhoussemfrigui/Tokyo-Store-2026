import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { TOGGLEABLE_PUBLIC_IDS } from "@/lib/api-auth/route-catalog";

/**
 * Global API & webhooks settings, persisted as key/value rows in `app_secrets`
 * (the same generic store used for the bootstrap flag + encryption key).
 *
 *   api.enabled        — master kill-switch for the EXTERNAL data API. When
 *                        false, every external route (reads AND writes) is
 *                        refused regardless of key. Default ON.
 *   webhooks.enabled   — master toggle for INCOMING webhooks (Flouci callback).
 *                        When false the callback is accepted-and-ignored (200)
 *                        so the provider doesn't hammer retries. Default ON.
 *   api.public_routes  — JSON array of external READ route ids the admin has
 *                        opened to the public (no key). Default empty — i.e.
 *                        key-required-by-default (max-security posture). Writes
 *                        are never listed here.
 *
 * Read on every external API request, so cached for a short TTL; every setter
 * invalidates the cache so a toggle applies within seconds.
 */

const KEY_API_ENABLED = "api.enabled";
const KEY_WEBHOOKS_ENABLED = "webhooks.enabled";
const KEY_PUBLIC_ROUTES = "api.public_routes";
// Master kill-switch for OUTBOUND webhooks (ERP push). When false, the enqueue
// subscriber records nothing (no deliveries). Default ON — the real gate is
// having an active endpoint, so ON is harmless with zero endpoints.
const KEY_OUTBOUND_WEBHOOKS_ENABLED = "webhooks.outbound_enabled";

export type ApiSettings = {
  apiEnabled: boolean;
  webhooksEnabled: boolean;
  /** Master kill-switch for outbound webhooks (ERP push). */
  outboundWebhooksEnabled: boolean;
  /** Validated against the catalog — unknown/stale ids are dropped on read. */
  publicRoutes: string[];
};

// Cache is per-process. invalidate() (on every setter) clears only the process
// that handled the admin save; other instances refresh on their own TTL. So on
// a MULTI-INSTANCE deployment a toggle (incl. the kill-switch) is eventually
// consistent with a worst case of TTL_MS across the fleet — not instant. On the
// current single-instance topology the save and the API run in one process, so
// it's effectively immediate. Keep TTL short so that fleet-wide lag stays small;
// for true instant fleet invalidation, move to Postgres LISTEN/NOTIFY or Redis.
const TTL_MS = 15_000;
let cache: { value: ApiSettings; expires: number } | null = null;

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const t = value.trim().toLowerCase();
  if (t === "true" || t === "1" || t === "on" || t === "yes") return true;
  if (t === "false" || t === "0" || t === "off" || t === "no") return false;
  return fallback;
}

function parsePublicRoutes(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const arr = JSON.parse(value);
    if (!Array.isArray(arr)) return [];
    // Drop anything not a currently-valid, public-toggleable id.
    return [...new Set(arr.filter((x): x is string => typeof x === "string" && TOGGLEABLE_PUBLIC_IDS.has(x)))];
  } catch {
    return [];
  }
}

function toSettings(rows: Array<{ key: string; value: string }>, readFailed: boolean): ApiSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    // Fail CLOSED on a read error: never leave a manually-engaged kill-switch
    // bypassed just because the settings SELECT failed.
    apiEnabled: readFailed ? false : parseBool(map.get(KEY_API_ENABLED), true),
    webhooksEnabled: parseBool(map.get(KEY_WEBHOOKS_ENABLED), true),
    outboundWebhooksEnabled: parseBool(map.get(KEY_OUTBOUND_WEBHOOKS_ENABLED), true),
    publicRoutes: parsePublicRoutes(map.get(KEY_PUBLIC_ROUTES)),
  };
}

class ApiSettingsService {
  /**
   * Read all settings (cached). The external-API kill-switch FAILS CLOSED: a
   * settings-read error treats the API as DISABLED (deny) rather than leaving an
   * operator-engaged kill-switch bypassed. The other flags keep their
   * availability-first defaults (a genuine DB outage 401s at the key lookup
   * anyway). A fail-closed result is NOT cached, so a transient blip doesn't hold
   * the API down for the whole TTL — the next request retries the DB.
   */
  async get(): Promise<ApiSettings> {
    const now = Date.now();
    if (cache && cache.expires > now) return cache.value;

    let rows: Array<{ key: string; value: string }> = [];
    let readFailed = false;
    try {
      rows = await this.readRows();
    } catch {
      // Table missing / DB hiccup → apiEnabled fails CLOSED (see below).
      readFailed = true;
      rows = [];
    }

    const value = toSettings(rows, readFailed);
    // Only cache a CLEAN read — a fail-closed result must not stick for the TTL.
    if (!readFailed) cache = { value, expires: now + TTL_MS };
    return value;
  }

  /**
   * Admin-form read: UNCACHED (the form shows the live values) and THROWS on a
   * read error instead of degrading. `get()`'s fail-closed runtime value
   * (`apiEnabled:false`, `publicRoutes:[]`) must never pre-fill the admin toggles
   * form — a normal save would then PERSIST the kill-switch OFF and wipe the
   * public routes. A throw reaches the admin error boundary (retry) instead.
   */
  async getStrict(): Promise<ApiSettings> {
    return toSettings(await this.readRows(), false);
  }

  private async readRows(): Promise<Array<{ key: string; value: string }>> {
    const res = await db.execute<{ key: string; value: string }>(sql`
      SELECT key, value FROM app_secrets
      WHERE key IN (${KEY_API_ENABLED}, ${KEY_WEBHOOKS_ENABLED}, ${KEY_OUTBOUND_WEBHOOKS_ENABLED}, ${KEY_PUBLIC_ROUTES})
    `);
    return res.rows;
  }

  async setApiEnabled(enabled: boolean): Promise<void> {
    await this.upsert(KEY_API_ENABLED, enabled ? "true" : "false");
  }

  async setWebhooksEnabled(enabled: boolean): Promise<void> {
    await this.upsert(KEY_WEBHOOKS_ENABLED, enabled ? "true" : "false");
  }

  async setOutboundWebhooksEnabled(enabled: boolean): Promise<void> {
    await this.upsert(KEY_OUTBOUND_WEBHOOKS_ENABLED, enabled ? "true" : "false");
  }

  /** Replace the public-route set (only valid, toggleable ids are kept). */
  async setPublicRoutes(ids: string[]): Promise<void> {
    const clean = [...new Set(ids.filter((id) => TOGGLEABLE_PUBLIC_IDS.has(id)))];
    await this.upsert(KEY_PUBLIC_ROUTES, JSON.stringify(clean));
  }

  private async upsert(key: string, value: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO app_secrets (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);
    this.invalidate();
  }

  invalidate(): void {
    cache = null;
  }
}

export const apiSettingsService = new ApiSettingsService();
