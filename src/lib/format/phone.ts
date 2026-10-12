/**
 * Digits-only phone normalization — strips spaces, `+`, dashes, parentheses so
 * two numbers entered in different formats ("+216 12 345 678", "21612345678",
 * "12 345 678") compare equal. ONE canonical rule shared by the order/warranty
 * phone lookup, the guest-order grouping, and the settings phone validator.
 *
 * NOTE: the equivalent SQL in src/modules/order/queries.ts (listOrdersByPhone)
 * uses `regexp_replace(contact_phone, '\D', '', 'g')` — keep the two aligned.
 */
export function normalizePhoneDigits(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}
