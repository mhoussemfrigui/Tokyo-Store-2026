/**
 * Renders a JSON-LD structured-data block. Server-rendered into the page so
 * crawlers get it in the initial HTML. Mirrors the main platform's <JsonLd>.
 */
export function JsonLd({ data }: { data: Record<string, unknown> | Record<string, unknown>[] }) {
  // Escape `<` so a string value (e.g. a user-set review author name) that
  // contains `</script>` or `<!--` can't break out of the tag. This JSON-LD DOES
  // embed user input (review authors), so it is NOT injection-safe without this.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
