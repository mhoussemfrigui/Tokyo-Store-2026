/**
 * SSRF-hardened outbound request (src/lib/net/ssrf-fetch.ts) — the webhook
 * drain's only transport. Guards the "response body > 64 KiB hangs forever"
 * regression: `readCapped` used to `res.destroy()` past the cap and then wait
 * for an 'end'/'error' that a bare destroy never emits, so the awaiting drain
 * worker (and the whole cron run) never settled.
 *
 * Drives the HTTP/read phase against a LOOPBACK server through the explicit
 * `__testing.requestPinned` seam — the public `ssrfSafeRequest` still refuses
 * loopback (asserted below), so the IP guard is not loosened for the test.
 * No DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/ssrf-fetch.test.ts
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import { __testing, ssrfSafeRequest, SsrfError, type SsrfResponse } from "@/lib/net/ssrf-fetch";

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

const CAP = 64 * 1024;
const LOOPBACK = [{ address: "127.0.0.1", family: 4 }];
/** A settle that takes longer than this is treated as a hang. */
const HANG_MS = 5_000;

let hits = 0;

/** Test server. Every "big" route keeps streaming AFTER the cap is crossed, so
 *  the client can never see 'end' before it destroys — the hang condition. */
function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  hits++;
  const path = req.url ?? "/";
  if (path === "/small") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("a".repeat(1024));
    return;
  }
  if (path === "/echo") {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, body: Buffer.concat(parts).toString("utf8") }));
    });
    return;
  }
  if (path === "/big-fixed" || path === "/big-500") {
    // Fixed content-length, sent in two bursts: 80 KiB now (crosses the cap), the
    // remaining ~220 KiB later — 'end' cannot have been parsed when we destroy.
    const total = 300 * 1024;
    res.writeHead(path === "/big-500" ? 500 : 200, {
      "content-type": "text/html",
      "content-length": String(total),
    });
    res.write("b".repeat(80 * 1024));
    const t = setTimeout(() => res.end("b".repeat(total - 80 * 1024)), 300);
    res.on("close", () => clearTimeout(t));
    return;
  }
  if (path === "/endless") {
    // Chunked stream that never ends on its own (a runaway debug page / echo).
    res.writeHead(200, { "content-type": "text/plain" });
    const iv = setInterval(() => res.write("c".repeat(16 * 1024)), 5);
    res.on("close", () => clearInterval(iv));
    return;
  }
  if (path === "/drip") {
    // Headers, then a trickle that never reaches the cap nor ends → only the
    // request timeout can stop it; the read must still settle.
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("d");
    const iv = setInterval(() => res.write("d"), 50);
    res.on("close", () => clearInterval(iv));
    return;
  }
  res.writeHead(404);
  res.end();
}

/** Settle-or-hang: resolves `{ hung: true }` if `p` doesn't settle in time. */
async function settle(
  p: Promise<SsrfResponse>,
): Promise<{ hung: boolean; res?: SsrfResponse; err?: unknown; ms: number }> {
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const out = await Promise.race([
      p.then(
        (res) => ({ hung: false, res }),
        (err: unknown) => ({ hung: false, err }),
      ),
      new Promise<{ hung: true }>((r) => {
        timer = setTimeout(() => r({ hung: true }), HANG_MS);
      }),
    ]);
    return { ...out, ms: Date.now() - t0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main() {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const url = (path: string) => new URL(`http://127.0.0.1:${port}${path}`);
  const get = (path: string, extra: { timeoutMs?: number; maxResponseBytes?: number } = {}) =>
    __testing.requestPinned(url(path), LOOPBACK, { method: "GET", ...extra });

  try {
    console.log("small body — read in full:");
    const small = await settle(get("/small"));
    check("settles", !small.hung && !small.err);
    check("status 200", small.res?.status === 200);
    check("full 1 KiB body", small.res?.bodyText === "a".repeat(1024));

    console.log("POST body + headers reach the receiver:");
    const echo = await settle(
      __testing.requestPinned(url("/echo"), LOOPBACK, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "monde" }),
      }),
    );
    check("settles", !echo.hung && !echo.err);
    check("receiver's real status is returned (201)", echo.res?.status === 201);
    const echoed = echo.res ? (JSON.parse(echo.res.bodyText) as { method: string; body: string }) : null;
    check("method POST", echoed?.method === "POST");
    check("body delivered intact", echoed?.body === JSON.stringify({ hello: "monde" }));

    console.log("fixed-length 300 KiB body (tail arrives after the cap) — no hang:");
    const big = await settle(get("/big-fixed"));
    check(`settles (${big.ms} ms)`, !big.hung && !big.err);
    check("status 200", big.res?.status === 200);
    check("body capped to exactly 64 KiB", big.res?.bodyText.length === CAP);

    console.log("5xx with a large error page — status still surfaces (retry path):");
    const e500 = await settle(get("/big-500"));
    check(`settles (${e500.ms} ms)`, !e500.hung && !e500.err);
    check("status 500", e500.res?.status === 500);
    check("body capped", e500.res?.bodyText.length === CAP);

    console.log("endless chunked stream — no hang:");
    const endless = await settle(get("/endless"));
    check(`settles (${endless.ms} ms)`, !endless.hung && !endless.err);
    check("status 200", endless.res?.status === 200);
    check("body capped to exactly 64 KiB", endless.res?.bodyText.length === CAP);

    console.log("custom maxResponseBytes:");
    const tiny = await settle(get("/endless", { maxResponseBytes: 1000 }));
    check("settles", !tiny.hung && !tiny.err);
    check("body capped to 1000 bytes", tiny.res?.bodyText.length === 1000);

    console.log("slow drip body — the request timeout still settles the read:");
    const drip = await settle(get("/drip", { timeoutMs: 400 }));
    check(`settles (${drip.ms} ms)`, !drip.hung && !drip.err);
    check("status 200 kept", drip.res?.status === 200);
    check("partial body returned", (drip.res?.bodyText.length ?? 0) > 0);

    console.log("public ssrfSafeRequest still refuses loopback (guard intact):");
    const before = hits;
    for (const target of [`http://127.0.0.1:${port}/small`, `http://localhost:${port}/small`]) {
      const r = await settle(ssrfSafeRequest({ url: target, method: "GET" }));
      check(
        `${target} → SsrfError blocked_host`,
        !r.hung && r.err instanceof SsrfError && r.err.code === "blocked_host",
      );
    }
    check("the loopback server was never contacted", hits === before);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
