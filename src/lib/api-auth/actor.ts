import "server-only";

import { NextResponse } from "next/server";

/**
 * Writes are attributed to a real user (the API key's owner) — that id flows to
 * every workflow as `actorUserId` and lands in the audit log. A key with no
 * associated user (e.g. created out-of-band) may NOT write. Reads don't call
 * this.
 */
export type ApiActor = { ok: true; actorUserId: string } | { ok: false; response: NextResponse };

export function requireApiActor(gate: { actorUserId: string | null }): ApiActor {
  if (!gate.actorUserId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Cette clé API n'est associée à aucun utilisateur — écriture refusée." },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }
  return { ok: true, actorUserId: gate.actorUserId };
}
