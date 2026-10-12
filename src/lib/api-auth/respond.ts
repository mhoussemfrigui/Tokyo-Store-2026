import "server-only";

import { NextResponse } from "next/server";

import type { WorkflowResult } from "@/workflows/shared";
import { workflowErrorStatus } from "./enforce";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Parse a JSON request body, enforcing a plain object. Returns the body or a
 * ready-to-send 400. Used by every write handler.
 */
export async function readJsonObject(
  req: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Corps JSON invalide." }, { status: 400, headers: NO_STORE }) };
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Un objet JSON est attendu." }, { status: 400, headers: NO_STORE }),
    };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/** Translate a workflow result into the standard API JSON response. */
export function workflowResponse<T>(result: WorkflowResult<T>, successStatus = 200): NextResponse {
  if (result.ok) {
    return NextResponse.json({ data: result.data }, { status: successStatus, headers: NO_STORE });
  }
  return NextResponse.json(
    { error: result.message, code: result.error, ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}) },
    { status: workflowErrorStatus(result.error), headers: NO_STORE },
  );
}

/**
 * Hand a parsed JSON body to a workflow whose signature expects a typed Zod
 * input. The body is genuinely untrusted `unknown` data; the workflow validates
 * it with `safeParse` at runtime (returning a structured `validation` fail on
 * mismatch), so that runtime guard — not the compiler — is the real contract.
 * `T` is inferred from the call site (the workflow's parameter type).
 */
export function workflowInput<T>(body: Record<string, unknown>): T {
  return body as T;
}

/** Resolve a target id from `?id=`/`?productId=`-style query first, else body. */
export function pickId(req: Request, body: Record<string, unknown>, ...keys: string[]): string | null {
  const url = new URL(req.url);
  for (const k of keys) {
    const q = url.searchParams.get(k);
    if (q && q.trim()) return q.trim();
    const b = body[k];
    if (typeof b === "string" && b.trim()) return b.trim();
  }
  return null;
}
