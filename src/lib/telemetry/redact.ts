import "server-only";

/**
 * Telemetry redaction.
 *
 * Event payloads are emitted by workflows and consumed by subscribers
 * (logger, audit, metrics, …). Some payloads carry email addresses or
 * arbitrarily-large blobs; one or two might one day carry secrets despite
 * the types.ts contract.
 *
 * `redact` walks an arbitrary value and:
 *   1. Drops keys whose name matches the sensitive list (case-insensitive)
 *   2. Truncates email values to `abc***@domain.tld` so grep still works
 *      on the domain but the local part is unrecoverable
 *   3. Replaces strings longer than 200 chars with `<TRUNCATED:${len}>`
 *   4. Caps array length, object key count and nesting depth so a single fat
 *      event (a bulk-op item list, a big imported batch) can't write a
 *      multi-KB/MB jsonb row into the 365-day audit table.
 *
 * For the PERSISTED metadata path use `redactForStorage`, which additionally
 * enforces a total serialized-size ceiling.
 *
 * Pure (no I/O), safe to call from any subscriber. Returns a new object —
 * does not mutate the input.
 */

// Substrings that mark a key as secret. Matched against the key with '_'/'-'
// stripped and lowercased, so snake_case / kebab-case / camelCase all normalise
// to the same form: `access_token`, `accessToken`, `access-token` → "accesstoken"
// → contains "token". Substring (not exact) matching so compound field names —
// `client_secret`, `api_key`, `password_hash`, `refresh_token`, `authorization`,
// `sessionId` — are all caught; exact-match previously missed every snake_case
// variant. Deliberately over-redacts (e.g. an AI `promptTokens` COUNT gets
// dropped as it contains "token") — a safe-side loss for a 365-day audit table.
const SENSITIVE_KEY_SUBSTRINGS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "authorization",
  "bearer",
  "cookie",
  "creditcard",
  "cardnumber",
  "cvv",
  "privatekey",
  "sessionid",
  "salt",
];

const MAX_STRING_LEN = 200;
/** Per-array element cap — extra items collapse to a single sentinel string. */
const MAX_ARRAY_ITEMS = 50;
/** Per-object key cap — extra keys collapse to a `__more` count. */
const MAX_OBJECT_KEYS = 50;
/** Max nesting depth — deeper structures collapse to a sentinel. */
const MAX_DEPTH = 8;
/** Total serialized-size ceiling for a persisted metadata blob (bytes). */
const MAX_METADATA_BYTES = 16_384;

function isSensitiveKey(key: string): boolean {
  const norm = key.toLowerCase().replace(/[_-]/g, "");
  return SENSITIVE_KEY_SUBSTRINGS.some((s) => norm.includes(s));
}

function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at < 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const prefix = local.slice(0, 3);
  return `${prefix}***@${domain}`;
}

function redactString(value: string): string {
  if (value.length > MAX_STRING_LEN) {
    return `<TRUNCATED:${value.length}>`;
  }
  return value;
}

export function redact(value: unknown, keyHint?: string, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    // Field-name driven: an "email" key always gets masked, regardless of
    // length. Otherwise the regular truncation rule applies.
    if (keyHint && keyHint.toLowerCase() === "email") {
      return maskEmail(value);
    }
    return redactString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  // bigint isn't JSON-serialisable — coerce to a JSON-safe value (mirrors the
  // Date→ISO handling below) so it can't make JSON.stringify throw and collapse
  // the whole metadata blob to {__truncated:-1}.
  if (typeof value === "bigint") {
    return value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER
      ? Number(value)
      : value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  // Beyond the depth cap, collapse the rest of the structure — a runaway
  // nested payload can't grow the row unbounded.
  if (depth >= MAX_DEPTH) return "<DEPTH_LIMIT>";

  if (Array.isArray(value)) {
    const capped = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, undefined, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      capped.push(`<+${value.length - MAX_ARRAY_ITEMS} more>`);
    }
    return capped;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let kept = 0;
    let dropped = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) continue;
      if (kept >= MAX_OBJECT_KEYS) {
        dropped++;
        continue;
      }
      out[k] = redact(v, k, depth + 1);
      kept++;
    }
    if (dropped > 0) out.__more = dropped;
    return out;
  }

  // Functions, symbols — drop.
  return undefined;
}

/**
 * Redact for the PERSISTED metadata column: `redact()` (with its per-string /
 * array / depth caps) plus a hard total-size backstop. If the serialized blob
 * still exceeds the byte ceiling, replace it with a small `{__truncated}`
 * marker so one fat event can never bloat the 365-day audit table. Returns a
 * plain object so the jsonb column always gets an object.
 */
export function redactForStorage(value: unknown): Record<string, unknown> {
  const redacted = redact(value);
  const wrapped =
    redacted && typeof redacted === "object" && !Array.isArray(redacted)
      ? (redacted as Record<string, unknown>)
      : { value: redacted };
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(wrapped), "utf8");
  } catch {
    // Unserialisable (circular/function) — the wildcard logger already guards
    // this, but be safe here too.
    return { __truncated: -1 };
  }
  if (bytes > MAX_METADATA_BYTES) {
    return { __truncated: bytes };
  }
  return wrapped;
}
