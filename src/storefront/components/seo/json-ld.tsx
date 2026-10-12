/**
 * Renders a JSON-LD structured-data block. Server-rendered into the page so
 * crawlers get it in the initial HTML. Mirrors the main platform's <JsonLd>.
 */
export function JsonLd({ data }: { data: Record<string, unknown> | Record<string, unknown>[] }) {
  return (
    <script
      type="application/ld+json"
      // Data is app-authored (never user input), so this is injection-safe.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
