import "server-only";

import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { customerService } from "@/modules/customer/service";
import { customer_user_links } from "@/associations/customer-user";
import { users } from "@/modules/auth/schema";
import type { AddressRow, CustomerProfileRow } from "@/modules/customer/schema";
import { isUuid } from "@/lib/utils/uuid";

/**
 * Serializers + resolvers for the keyed external CUSTOMER API (ERP sync).
 *
 * PII posture (mirrors orders): these reads are KEY-ONLY (`canBePublic:false`) —
 * name/phone/address/email/birthday must never be public. `admin_notes` is
 * INTERNAL and deliberately NEVER serialized. Money-free; timestamps ISO-8601;
 * the ERP link is `externalRef`. Email lives on the linked Better-Auth user
 * (joined via `customer_user_links`), not on the profile; that account's id is
 * exposed as `userId` — the key the order feed carries.
 */

export type ApiCustomer = {
  id: string;
  externalRef: string | null;
  /** The linked storefront ACCOUNT id (Better-Auth `users.id`), null for a
   *  standalone profile. It is the join key to `userId` on the order feed, and
   *  what `POST /api/orders` attaches a sale to. */
  userId: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  marketingOptIn: boolean;
  birthday: string | null;
  createdAt: string;
  updatedAt: string;
};

type LinkedAccount = { userId: string; email: string };

/** Batch-resolve profileId → linked auth account (id + email; registered customers only). */
async function accountsForProfiles(profileIds: string[]): Promise<Map<string, LinkedAccount>> {
  if (profileIds.length === 0) return new Map();
  const rows = await db
    .select({ pid: customer_user_links.customer_profile_id, userId: users.id, email: users.email })
    .from(customer_user_links)
    .innerJoin(users, eq(users.id, customer_user_links.user_id))
    .where(inArray(customer_user_links.customer_profile_id, profileIds));
  return new Map(rows.map((r) => [r.pid, { userId: r.userId, email: r.email }]));
}

export function serializeCustomer(
  p: CustomerProfileRow,
  email: string | null,
  userId: string | null = null,
): ApiCustomer {
  return {
    id: p.id,
    externalRef: p.external_ref ?? null,
    userId,
    firstName: p.first_name,
    lastName: p.last_name,
    email,
    phone: p.phone,
    marketingOptIn: p.marketing_opt_in,
    birthday: p.birthday ?? null,
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
  };
}

export function serializeAddress(a: AddressRow) {
  return {
    id: a.id,
    type: a.type,
    label: a.label,
    fullName: a.full_name,
    company: a.company,
    streetLine1: a.street_line1,
    streetLine2: a.street_line2,
    city: a.city,
    region: a.region,
    postalCode: a.postal_code,
    country: a.country,
    phone: a.phone,
    isDefaultShipping: a.is_default_shipping,
    isDefaultBilling: a.is_default_billing,
  };
}

/**
 * Resolve a live profile from a path/segment that may be a uuid id OR externalRef.
 * A uuid-shaped segment that is not a local id FALLS BACK to the externalRef
 * lookup — an ERP that keys its own records by UUID must still resolve its link.
 */
export async function resolveApiCustomer(idOrRef: string): Promise<CustomerProfileRow | null> {
  if (isUuid(idOrRef)) {
    const byId = await customerService.findProfileById(idOrRef);
    if (byId) return byId;
  }
  return customerService.findByExternalRef(idOrRef);
}

/** Resolve a live profile by the linked auth email (exact, case-insensitive). */
export async function findApiCustomerByEmail(email: string): Promise<CustomerProfileRow | null> {
  const clean = email.trim().toLowerCase();
  if (!clean) return null;
  const [link] = await db
    .select({ pid: customer_user_links.customer_profile_id })
    .from(customer_user_links)
    .innerJoin(users, eq(users.id, customer_user_links.user_id))
    .where(sql`lower(${users.email}) = ${clean}`)
    .limit(1);
  return link ? customerService.findProfileById(link.pid) : null;
}

/** Full serialization (profile + email + addresses) for GET-by-id. */
export async function getApiCustomerFull(profile: CustomerProfileRow) {
  const [accounts, addrRows] = await Promise.all([
    accountsForProfiles([profile.id]),
    customerService.listAddressesByProfile(profile.id),
  ]);
  const account = accounts.get(profile.id);
  const base = serializeCustomer(profile, account?.email ?? null, account?.userId ?? null);
  return { ...base, addresses: addrRows.map(serializeAddress) };
}

/** Core serialization of one resolved profile (batched account). */
export async function serializeOneCustomer(profile: CustomerProfileRow): Promise<ApiCustomer> {
  const accounts = await accountsForProfiles([profile.id]);
  const account = accounts.get(profile.id);
  return serializeCustomer(profile, account?.email ?? null, account?.userId ?? null);
}

/** Incremental-sync list (core fields, batched account). */
export async function listApiCustomers(opts: {
  sinceIso?: string;
  sinceId?: string;
  limit?: number;
}): Promise<{ customers: ApiCustomer[]; nextSince: string | null; nextId: string | null }> {
  const { items, nextSince, nextId } = await customerService.listForApi(opts);
  const accounts = await accountsForProfiles(items.map((p) => p.id));
  return {
    customers: items.map((p) => {
      const account = accounts.get(p.id);
      return serializeCustomer(p, account?.email ?? null, account?.userId ?? null);
    }),
    nextSince,
    nextId,
  };
}
