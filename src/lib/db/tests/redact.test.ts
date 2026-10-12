/**
 * Telemetry redaction (src/lib/telemetry/redact.ts). server-only, so run under
 * the react-server condition. Locks the existing masking rules AND the new
 * growth caps (array / object-key / depth / total-size) that keep the 365-day
 * audit metadata column from being bloated by one fat event.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/redact.test.ts
 */
import { redact, redactForStorage } from "@/lib/telemetry/redact";

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

function main() {
  console.log("existing behaviour lock-in:");
  const r = redact({ password: "hunter2", token: "abc", email: "alice@example.com", name: "Alice" }) as Record<
    string,
    unknown
  >;
  check("drops password", !("password" in r));
  check("drops token", !("token" in r));
  check("masks email local part", r.email === "ali***@example.com");
  check("keeps ordinary string", r.name === "Alice");

  console.log("substring / snake_case secret-key matching:");
  const s = redact({
    access_token: "a",
    refresh_token: "b",
    client_secret: "c",
    api_key: "d",
    password_hash: "e",
    Authorization: "Bearer x",
    cookie: "sid=1",
    sessionId: "s",
    private_key: "-----",
    keyId: "kid-123", // NOT secret — must survive
    scopes: ["orders.read"], // NOT secret — must survive
    label: "My key", // NOT secret — must survive
  }) as Record<string, unknown>;
  for (const k of [
    "access_token",
    "refresh_token",
    "client_secret",
    "api_key",
    "password_hash",
    "Authorization",
    "cookie",
    "sessionId",
    "private_key",
  ]) {
    check(`drops ${k}`, !(k in s));
  }
  check("keeps keyId", s.keyId === "kid-123");
  check("keeps scopes", Array.isArray(s.scopes));
  check("keeps label", s.label === "My key");
  check(
    "string >200 chars → <TRUNCATED:len>",
    redact("x".repeat(250)) === "<TRUNCATED:250>",
  );
  check("Date → ISO string", redact(new Date("2026-01-02T03:04:05.000Z")) === "2026-01-02T03:04:05.000Z");
  check("number/boolean pass through", (redact({ a: 1, b: true }) as Record<string, unknown>).a === 1);
  check("function value dropped", (redact({ f: () => 1 }) as Record<string, unknown>).f === undefined);
  check("small bigint → number", redact(42n) === 42);
  check(
    "huge bigint → string",
    redact(9007199254740993n) === "9007199254740993",
  );

  console.log("array cap:");
  const bigArr = redact(Array.from({ length: 120 }, (_, i) => i)) as unknown[];
  check("array capped to 50 + sentinel", bigArr.length === 51);
  check("sentinel reports overflow", bigArr[50] === "<+70 more>");
  check("array under cap untouched", (redact([1, 2, 3]) as unknown[]).length === 3);

  console.log("object key cap:");
  const bigObj: Record<string, number> = {};
  for (let i = 0; i < 70; i++) bigObj[`k${i}`] = i;
  const ro = redact(bigObj) as Record<string, unknown>;
  check("object capped to 50 kept keys (+__more)", Object.keys(ro).length === 51);
  check("__more counts dropped keys", ro.__more === 20);

  console.log("depth cap:");
  // 10 levels deep — beyond MAX_DEPTH(8) collapses to a sentinel.
  let nested: Record<string, unknown> = { leaf: "end" };
  for (let i = 0; i < 10; i++) nested = { child: nested };
  const stringified = JSON.stringify(redact(nested));
  check("deep nesting collapses to <DEPTH_LIMIT>", stringified.includes("<DEPTH_LIMIT>"));

  console.log("redactForStorage:");
  check(
    "wraps non-object in {value}",
    JSON.stringify(redactForStorage("hello")) === JSON.stringify({ value: "hello" }),
  );
  check(
    "object passes through (small)",
    (redactForStorage({ a: 1 }) as Record<string, unknown>).a === 1,
  );
  // A payload that's huge AFTER the per-leaf caps: nested breadth survives them.
  // 50 keys × an inner object of 50 keys × ~150-char strings ≈ 375KB > 16KB.
  const fat: Record<string, Record<string, string>> = {};
  for (let i = 0; i < 50; i++) {
    const inner: Record<string, string> = {};
    for (let j = 0; j < 50; j++) inner[`k${j}`] = "y".repeat(150);
    fat[`g${i}`] = inner;
  }
  const stored = redactForStorage(fat) as Record<string, unknown>;
  check(
    "over-size blob collapses to {__truncated}",
    typeof stored.__truncated === "number" && (stored.__truncated as number) > 16384,
  );
  check("small blob NOT truncated", !("__truncated" in (redactForStorage({ a: "ok" }) as object)));
  // A bigint anywhere in the payload used to make JSON.stringify throw, collapsing
  // the ENTIRE blob to {__truncated:-1} (data loss). It must now survive intact.
  const withBigint = redactForStorage({ id: 9007199254740993n, count: 7n }) as Record<string, unknown>;
  check("bigint payload NOT collapsed to {__truncated:-1}", withBigint.__truncated !== -1);
  check("bigint payload preserves huge id as string", withBigint.id === "9007199254740993");
  check("bigint payload preserves small count as number", withBigint.count === 7);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
