/**
 * Server-rendered JSON-LD <script>. Escapes `<` so a stray `</script>` (or any
 * `<`) inside string values can't break out of the tag. Render this in the
 * server component tree — never inject via client JS (AI crawlers may not run it).
 */
export function JsonLd({ data }: { data: unknown }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
