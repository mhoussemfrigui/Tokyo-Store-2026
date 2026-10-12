/**
 * Upper bounds on the free-text order fields (characters). Enforced by the
 * place-order + quick-order workflow schemas, which every order-creating path
 * shares (web checkout, express, caisse / manual order, ERP push) — so they are
 * generous for real input while keeping a scripted submit from storing
 * arbitrarily large blobs on the order row (the columns are unbounded `text`).
 * Client-safe (no server imports) so storefront forms can mirror them as
 * `maxLength`.
 */
export const ORDER_FIELD_MAX = {
  name: 120,
  addressLine: 300,
  place: 120,
  postalCode: 20,
  phone: 32,
  email: 254,
  notes: 1000,
} as const;
