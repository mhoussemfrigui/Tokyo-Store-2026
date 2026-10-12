/**
 * API-key scope model — the single source of truth for what a key may do.
 *
 * A key holds a SET of scope strings; two forms compose:
 *   - per-resource: "<resource>:<action>"  e.g. "products:write", "categories:read"
 *   - coarse:       "read" (any :read) · "write" (any :read+:write) · "full" (everything)
 *
 * `write` implies `read` (a writer can read). A route declares the concrete
 * scope it needs (e.g. "products:write"); `hasScope` decides if a key grants it.
 * Used by the create-key UI (offer the scope choices) AND the request guard.
 */

import { WILDCARD } from "@/lib/rbac/registry";

// `content`, `blog`, `reviews` are READ-ONLY content domains a headless
// front-end needs to render pages — no write routes are wired for them, so a
// `<res>:write` scope, while expressible, grants access to nothing; the
// create-key UI doesn't offer it (see WRITABLE_RESOURCES).
export const API_RESOURCES = [
  "products",
  "categories",
  "stock",
  "brands",
  "attributes",
  "orders",
  // `customers` carries PII (name/phone/address/email) — its read routes are
  // forced key-only (`canBePublic:false`) like orders. Stock/order MOVEMENT reads
  // reuse the existing `stock`/`orders` read scopes (no separate resource).
  "customers",
  // `warranty` = the warranty-claim (SAV/RMA) resource: read the claims + open
  // one, and PATCH a claim's status (ERP two-way SAV sync). Carries customer
  // context, so its reads are key-only (canBePublic:false) like orders/customers.
  "warranty",
  "content",
  "blog",
  "reviews",
] as const;
export type ApiResource = (typeof API_RESOURCES)[number];

export const API_ACTIONS = ["read", "write"] as const;
export type ApiAction = (typeof API_ACTIONS)[number];

/** Coarse shortcuts shown in the UI alongside the per-resource scopes. */
export const COARSE_SCOPES = ["read", "write", "full"] as const;

/** Every concrete "resource:action" scope (the accepted vocabulary). */
export const CONCRETE_SCOPES: string[] = API_RESOURCES.flatMap((r) =>
  API_ACTIONS.map((a) => `${r}:${a}`),
);

/** The full allowed scope vocabulary (coarse + concrete). */
export const ALL_SCOPES: string[] = [...COARSE_SCOPES, ...CONCRETE_SCOPES];

/**
 * Resources at least one external WRITE route exists for. The create-key matrix
 * offers a `<res>:write` box only for these — on the read-only resources
 * (content, blog, reviews) a write scope grants nothing. A literal, not derived
 * from EXTERNAL_API_ROUTES (route-catalog imports this module);
 * external-api-contract.test.ts pins it to the route catalog.
 */
export const WRITABLE_RESOURCES: readonly ApiResource[] = [
  "products",
  "categories",
  "stock",
  "brands",
  "attributes",
  "orders",
  "customers",
  "warranty",
];

/** The scopes the create-key UI offers: coarse + every read + the writes that do something. */
export const OFFERED_SCOPES: string[] = [
  ...COARSE_SCOPES,
  ...API_RESOURCES.flatMap((r) => (WRITABLE_RESOURCES.includes(r) ? [`${r}:read`, `${r}:write`] : [`${r}:read`])),
];

/** Concrete scope a route requires, e.g. `scopeFor("products", "write")`. */
export function scopeFor(resource: ApiResource, action: ApiAction): string {
  return `${resource}:${action}`;
}

/**
 * Does a key's scope set grant `required` (a concrete "resource:action")?
 *   full              → everything
 *   write             → all reads + all writes
 *   read              → all reads
 *   "<res>:write"     → that resource's reads + writes
 *   "<res>:read"      → that resource's reads
 */
export function hasScope(keyScopes: readonly string[], required: string): boolean {
  if (keyScopes.includes("full")) return true;
  const [resource, action] = required.split(":");
  if (action === "write") {
    return keyScopes.includes("write") || keyScopes.includes(`${resource}:write`);
  }
  // read — granted by any coarse or resource read/write
  return (
    keyScopes.includes("read") ||
    keyScopes.includes("write") ||
    keyScopes.includes(`${resource}:read`) ||
    keyScopes.includes(`${resource}:write`)
  );
}

/** Validate + normalize a scope set on creation (drop unknowns, dedupe, "*"→"full"). */
export function normalizeScopes(input: string[]): string[] {
  const allowed = new Set<string>([...ALL_SCOPES, "*"]);
  const out = new Set<string>();
  for (const s of input) {
    const t = String(s).trim();
    if (t === "*") out.add("full");
    else if (allowed.has(t)) out.add(t);
  }
  return [...out];
}

// ─────────────────────────────────────────── scope → RBAC (minting bound)
/**
 * The admin RBAC grants (`<module>:<action>`, see `@/lib/rbac/registry`) a
 * scope is EQUIVALENT to — i.e. what the external routes behind it let the key
 * do, expressed as the dashboard permissions that do the same thing. A key's
 * writes run the SAME workflows as the admin UI, attributed to its creator (the
 * workflows don't re-check RBAC) — so a creator may only mint a scope whose keys
 * they ALREADY hold (the "no privilege above your own" rule the role editor
 * enforces via `assertActorMayGrantPermissionKeys`), and requireApiKey re-applies
 * the same bound per request against the creator's CURRENT grants.
 *
 * `write` always includes the resource's `read` keys (a writer can read).
 * An EMPTY `read` list = published, storefront-public content (content bundle,
 * blog, approved reviews) that needs no admin grant to read.
 */
const SCOPE_RBAC: Record<ApiResource, { read: readonly string[]; write: readonly string[] }> = {
  products: { read: ["products:view"], write: ["products:create", "products:update", "products:delete"] },
  categories: {
    read: ["categories:view"],
    write: ["categories:create", "categories:update", "categories:delete"],
  },
  // Every stock write (absolute set or ±delta) is a `stock:update` in the admin.
  stock: { read: ["stock:view"], write: ["stock:update"] },
  brands: { read: ["brands:view"], write: ["brands:create", "brands:update", "brands:delete"] },
  attributes: {
    read: ["attributes:view"],
    write: ["attributes:create", "attributes:update", "attributes:delete"],
  },
  // Status push, shipments, refunds, returns and ERP order push are all
  // `orders:manage` power ops in the dashboard.
  orders: { read: ["orders:view"], write: ["orders:manage"] },
  customers: { read: ["customers:view"], write: ["customers:update"] },
  // Warranty claims (SAV): read = the coverage/claims viewer; write (open + PATCH
  // status) = the claims console power op (warranty module is now VIEW_MANAGE).
  warranty: { read: ["warranty:view"], write: ["warranty:manage"] },
  // Read-only published content — no write route exists; `<res>:write` is
  // mapped to the matching edit grant so a future write route stays bounded.
  content: { read: [], write: ["settings_site:update"] },
  blog: { read: [], write: ["blog_posts:update"] },
  reviews: { read: [], write: ["reviews:update"] },
};

/**
 * RBAC keys an actor must hold to mint `scope`. The coarse `write` / `full`
 * (every resource, including ones added later) require the global wildcard;
 * coarse `read` = every resource's read keys. Unknown scope → `["*"]` (fail
 * closed).
 */
export function rbacKeysForScope(scope: string): string[] {
  if (scope === "full" || scope === "write" || scope === "*") return [WILDCARD];
  if (scope === "read") return [...new Set(API_RESOURCES.flatMap((r) => SCOPE_RBAC[r].read))];
  const [resource, action] = scope.split(":");
  const map = SCOPE_RBAC[resource as ApiResource];
  if (!map || (action !== "read" && action !== "write")) return [WILDCARD];
  return action === "read" ? [...map.read] : [...new Set([...map.read, ...map.write])];
}

/**
 * Does an effective permission set satisfy one RBAC key? Mirrors
 * `permsAllowKey` in `@/lib/rbac/guards` (kept pure here so the create-key UI
 * can grey out scopes client-side): `*` satisfies everything, only `*`
 * satisfies `*`, and `<module>:*` satisfies any `<module>:<action>`.
 */
function permsAllow(perms: ReadonlySet<string>, key: string): boolean {
  if (perms.has(WILDCARD)) return true;
  if (key === WILDCARD) return false;
  const idx = key.indexOf(":");
  if (idx <= 0) return false;
  return perms.has(`${key.slice(0, idx)}:*`) || perms.has(key);
}

/** May an actor with effective permissions `perms` mint `scope` on a key? */
export function actorMayGrantScope(perms: ReadonlySet<string>, scope: string): boolean {
  return rbacKeysForScope(scope).every((k) => permsAllow(perms, k));
}

/** The subset of `scopes` the actor may NOT grant (empty = all allowed). */
export function scopesBeyondActor(perms: ReadonlySet<string>, scopes: readonly string[]): string[] {
  return scopes.filter((s) => !actorMayGrantScope(perms, s));
}
