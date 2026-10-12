import { requirePermission } from "@/lib/auth/session";
import { bus } from "@/events/bus";
import { selectCsvFields, csvHeaderLine, csvRowLine, type CsvField } from "@/lib/csv/fields";
import { NEWSLETTER_EXPORT_FIELDS, type NewsletterExportFieldKey } from "@/lib/export/newsletter-fields";
import {
  countSubscribers,
  listSubscribersForExport,
  type SubscriberFilters,
} from "@/modules/newsletter/queries";
import type { NewsletterSubscriptionRow } from "@/modules/newsletter/schema";

/**
 * Admin newsletter export → CSV download (the file operators import into
 * Resend / Mailjet / another ESP).
 *
 * STREAMED + UNCAPPED: walks the table in id-keyset pages and writes each page
 * as it is read, so the export is the WHOLE filtered list at constant memory —
 * it used to be built client-side from the newest 500 rows the page had
 * loaded, silently truncating any larger list. Honours the panel's `status`
 * (active | inactive | all) and `q` (email search) so the file matches what the
 * operator is looking at. Same columns as before (ESP import mappings keep
 * working); every cell goes through csvCell — `source` is attacker-controllable
 * via the public subscribe endpoint, so formula injection is neutralised.
 *
 * Emits `data.exported` (resource "newsletter", row count) BEFORE streaming, so
 * even an aborted download leaves the audit trail.
 */
export const dynamic = "force-dynamic";

const PAGE = 1000;

const VALUE: Record<NewsletterExportFieldKey, (s: NewsletterSubscriptionRow) => string> = {
  email: (s) => s.email,
  source: (s) => s.source,
  is_active: (s) => (s.is_active ? "true" : "false"),
  created_at: (s) => s.created_at.toISOString(),
  confirmed_at: (s) => s.confirmed_at?.toISOString() ?? "",
  unsubscribed_at: (s) => s.unsubscribed_at?.toISOString() ?? "",
};
const FIELDS: ReadonlyArray<CsvField<NewsletterSubscriptionRow>> = NEWSLETTER_EXPORT_FIELDS.map((f) => ({
  key: f.key,
  label: f.label,
  value: VALUE[f.key],
}));

export async function GET(req: Request) {
  const session = await requirePermission("newsletter", "export");

  const url = new URL(req.url);
  const rawStatus = url.searchParams.get("status");
  const filters: SubscriberFilters = {
    status: rawStatus === "active" || rawStatus === "inactive" ? rawStatus : "all",
    q: url.searchParams.get("q")?.trim() || undefined,
  };
  // Operator-chosen columns (?fields=), validated against the catalog (all if none).
  const fields = selectCsvFields(FIELDS, url.searchParams.get("fields"));

  const total = await countSubscribers(filters);
  await bus
    .emit("data.exported", { resource: "newsletter", count: total }, { actorUserId: session.user.id })
    .catch(() => {});

  const encoder = new TextEncoder();
  let headerSent = false;
  let afterId: string | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(encoder.encode(csvHeaderLine(fields) + "\n"));
        return;
      }
      try {
        const rows = await listSubscribersForExport(filters, { limit: PAGE, afterId });
        if (rows.length > 0) {
          afterId = rows[rows.length - 1].id;
          controller.enqueue(encoder.encode(rows.map((r) => csvRowLine(fields, r)).join("\n") + "\n"));
        }
        if (rows.length < PAGE) controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="newsletter-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
