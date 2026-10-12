/**
 * Pure helpers for the schema.org Person built from an author profile. No I/O —
 * safe to import anywhere (form preview, archive page, JSON-LD builder) so the
 * shape never drifts between the admin preview and the emitted markup.
 */

export const MAX_KNOWS_ABOUT = 12;

/**
 * Parse the freeform `expertise` field (one topic per line) into a deduped,
 * trimmed, capped list → schema.org Person.knowsAbout. Empty in → empty out.
 */
export function parseKnowsAbout(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/[\r\n]+/)) {
    const topic = line.trim();
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(topic);
    if (out.length >= MAX_KNOWS_ABOUT) break;
  }
  return out;
}
