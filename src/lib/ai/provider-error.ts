/**
 * Extract a provider's error message from a non-2xx AI response body — SAFE to
 * surface (never the API key, which only rides in the request header). Shared by
 * the chat chokepoint (client.ts) and the embedding chokepoint (embed.ts) so both
 * append the same diagnostic detail to their error strings. Returns a leading
 * " — <message>" (bounded) or "" when the body is empty.
 */
export async function providerErrorDetail(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  if (!body) return "";
  try {
    const j = JSON.parse(body) as { error?: { message?: string }; message?: string };
    const m = j?.error?.message ?? j?.message;
    if (typeof m === "string" && m.trim()) return ` — ${m.trim().slice(0, 300)}`;
  } catch {
    /* not JSON */
  }
  return ` — ${body.replace(/\s+/g, " ").trim().slice(0, 200)}`;
}
