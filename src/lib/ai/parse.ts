/**
 * Pure AI run helpers — NO server-only / DB / network imports, so they are unit
 * testable in isolation and safe to import from anywhere (server actions,
 * runners, the client is welcome too). Three things every AI flow needs:
 *
 *  • extractJson  — recover a JSON value from a model reply (code fences, prose
 *    around it, trailing junk after the value).
 *  • htmlToText   — flatten a product's HTML description into a prompt-friendly
 *    plain-text block, clamped.
 *  • mapWithConcurrency — drive a work list at bounded concurrency.
 *  • buildUserMessage — render a context map into a "Clé: valeur" prompt block.
 *
 * This is the single source of truth: auto-assign/ai.ts, related-products.ts,
 * ai-generate.ts, and the client-side product-ai-context.ts all import from here
 * (each previously carried its own copy).
 */

/**
 * Recover the first complete JSON value from a model reply. Strips ```json
 * fences, finds the first `{`/`[`, then walks with a string-aware depth counter
 * to the MATCHING close — so trailing prose after the value (a common model
 * habit) no longer breaks the parse. Falls back to a greedy first-open…last-close
 * slice for the odd shape the balanced walk misses. Returns null on any failure.
 */
export function extractJson<T>(text: string): T | null {
  if (!text) return null;
  let s = text.trim();
  s = s
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const opens = ["{", "["].map((c) => s.indexOf(c)).filter((i) => i !== -1);
  if (opens.length === 0) return null;
  const start = Math.min(...opens);
  const open = s[start];
  const close = open === "{" ? "}" : "]";

  // Walk from the first opening bracket, tracking nesting depth while ignoring
  // brackets that appear inside string literals (and escaped quotes).
  let depth = 0;
  let inStr = false;
  let escaped = false;
  let balancedEnd = -1;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        balancedEnd = i;
        break;
      }
    }
  }

  // Try the balanced slice first, then the greedy slice as a fallback.
  const candidates: string[] = [];
  if (balancedEnd !== -1) candidates.push(s.slice(start, balancedEnd + 1));
  const greedyEnd = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (greedyEnd >= start) candidates.push(s.slice(start, greedyEnd + 1));

  for (const slice of candidates) {
    try {
      return JSON.parse(slice) as T;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Strip HTML tags + entities, collapse whitespace, then clamp — product
 *  descriptions are HTML and prompts want plain text. */
export function htmlToText(html: string | null | undefined, max = 600): string {
  if (!html) return "";
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Render a context map as a readable "Clé: valeur" block, skipping null/empty
 *  values. Shared by the one-click generate action and the auto-assign runner so
 *  the prompt grounding is built identically everywhere. */
export function buildUserMessage(
  context: Record<string, string | number | null | undefined> | undefined,
): string {
  if (!context) return "";
  const lines: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value == null) continue;
    const str = String(value).trim();
    if (!str) continue;
    lines.push(`${key}: ${str}`);
  }
  return lines.join("\n");
}

/** Bounded-concurrency map: run `fn(index)` for every index in [0, count),
 *  at most `limit` in flight. Resolves when all complete. */
export async function mapWithConcurrency<T>(
  count: number,
  limit: number,
  fn: (index: number) => Promise<T>,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    // `cursor++` is atomic on JS's single thread — no lock needed.
    while (cursor < count) {
      const i = cursor++;
      await fn(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(count, 1)) }, () => worker()));
}
