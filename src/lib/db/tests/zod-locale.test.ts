/**
 * PURE zod locale (src/workflows/shared.ts) — NO database.
 *
 * The admin and storefront are French-only, but most workflow schemas carry no
 * custom message (`name: z.string().trim().min(1).max(120)`), so zod's built-in
 * English ("Too big: expected string to have <=120 characters") used to reach
 * the operator through flattenZodError → TabbedFormError. shared.ts now sets a
 * process-wide French error map. Pin:
 *   - a bare parse (no per-parse `error`) reads in French;
 *   - hand-written schema copy and a per-parse `error` still win;
 *   - the map survives another zod instance loading (its `config(en())` only
 *     resets `localeError`, which is why shared.ts sets `customError`);
 *   - flattenZodError / zodValidationFail carry the French text.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/zod-locale.test.ts
 */
import { z } from "zod";

import { flattenZodError, zodValidationFail } from "@/workflows/shared";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

/** First issue message of a failed parse ("" when the parse unexpectedly passed). */
function msg(schema: z.ZodType, value: unknown, opts?: Parameters<z.ZodType["safeParse"]>[1]): string {
  const res = schema.safeParse(value, opts);
  return res.success ? "" : (res.error.issues[0]?.message ?? "");
}

const looksEnglish = (m: string) => /too big|too small|invalid input|expected/i.test(m);

// ── bare parses read in French ───────────────────────────────────────────────
{
  const tooLong = msg(z.string().trim().min(1).max(120), "x".repeat(130));
  check(`max(120) → French "Trop grand" (${tooLong})`, tooLong.startsWith("Trop grand") && !looksEnglish(tooLong));
  check("max(120) message names the limit", tooLong.includes("120"));

  const empty = msg(z.string().trim().min(1), "   ");
  check(`min(1) → French "Trop petit" (${empty})`, empty.startsWith("Trop petit") && !looksEnglish(empty));

  const wrongType = msg(z.number(), "abc");
  check(`invalid type → French "Entrée invalide" (${wrongType})`, wrongType.startsWith("Entrée invalide"));

  const badEmail = msg(z.email(), "pas-un-email");
  check(`z.email() → French (${badEmail})`, /invalide/i.test(badEmail) && !looksEnglish(badEmail));

  const badEnum = msg(z.enum(["a", "b"]), "c");
  check(`z.enum → French "Option invalide" (${badEnum})`, badEnum.startsWith("Option invalide"));

  const refined = msg(z.string().refine((s) => s === "ok"), "ko");
  check(`message-less refine → French (${refined})`, refined === "Entrée invalide");
}

// ── hand-written copy still wins ─────────────────────────────────────────────
{
  check(
    "schema's own message wins over the locale",
    msg(z.string().min(1, "Le nom est requis."), "") === "Le nom est requis.",
  );
  check(
    "per-parse `error` wins over the locale",
    msg(z.string().min(1), "", { error: () => "Message d'appel." }) === "Message d'appel.",
  );
}

// ── survives another zod instance resetting the locale to English ───────────
{
  // Each evaluation of the zod package runs `config(en())` on the SHARED
  // globalThis config (Next.js loads several instances: RSC / SSR / routes).
  z.config(z.locales.en());
  const after = msg(z.string().max(3), "abcd");
  check(`still French after an en() locale reset (${after})`, after.startsWith("Trop grand"));
}

// ── the workflow helpers carry the French text ───────────────────────────────
{
  const brandLike = z.object({
    name: z.string().trim().min(1).max(120),
    metaDescription: z.string().trim().max(300),
  });
  const parsed = brandLike.safeParse({ name: "n".repeat(130), metaDescription: "m".repeat(301) });
  check("brand-like parse fails", !parsed.success);
  if (!parsed.success) {
    const fields = flattenZodError(parsed.error);
    check("flattenZodError: name in French", (fields.name ?? "").startsWith("Trop grand"));
    check("flattenZodError: metaDescription in French", (fields.metaDescription ?? "").startsWith("Trop grand"));

    const fail = zodValidationFail(parsed.error, { name: "Nom" });
    check(`zodValidationFail banner is labelled + French (${fail.message})`, fail.message.startsWith("Nom : Trop grand"));
    check("zodValidationFail is a validation fail", fail.ok === false && fail.error === "validation");
  }
}

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
