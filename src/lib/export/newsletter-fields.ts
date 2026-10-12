/**
 * Client-safe newsletter-export field catalog. The labels are the ORIGINAL
 * lowercase headers (email / source / is_active / …) so an operator's existing ESP
 * (Resend / Mailjet) import mappings keep working; the operator just chooses WHICH
 * of them to include. Shared by the export route + the field-picker UI.
 */
export const NEWSLETTER_EXPORT_FIELDS = [
  { key: "email", label: "email" },
  { key: "source", label: "source" },
  { key: "is_active", label: "is_active" },
  { key: "created_at", label: "created_at" },
  { key: "confirmed_at", label: "confirmed_at" },
  { key: "unsubscribed_at", label: "unsubscribed_at" },
] as const;

export type NewsletterExportFieldKey = (typeof NEWSLETTER_EXPORT_FIELDS)[number]["key"];
