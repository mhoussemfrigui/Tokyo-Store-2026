import "server-only";

/**
 * Phase 2 — unsubscribe-token + flow-resolver + marketing-consent regression
 * test, plus a static FLOW-GATE coverage check: every automation declared in
 * EMAIL_FLOWS must be gated by `isFlowEnabled` in its sender, so its admin
 * toggle actually stops the mail (a sender that forgets the gate — as
 * business_invite once did — keeps mailing while the UI shows it disabled).
 * Self-cleaning (rows tagged `__mailtest…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/mailing-flows-consent.test.ts
 */

// Guarantee a signing key so token sign/verify works even when the dev env hasn't
// provisioned PAYMENT_ENCRYPTION_KEY (set BEFORE importing the signer).
process.env.PAYMENT_ENCRYPTION_KEY =
  process.env.PAYMENT_ENCRYPTION_KEY || "test-unsub-key-do-not-use-in-prod";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { signUnsubToken, verifyUnsubToken } from "@/lib/crypto/sign";
import { canSendMarketingTo } from "@/lib/email/consent";
import { EMAIL_FLOWS, emailFlowService, isFlowEnabled, invalidateFlowCache } from "@/modules/mailing";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { newsletterService } from "@/modules/newsletter/service";

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

type Row = Record<string, unknown>;
function rowsOf(res: unknown): Row[] {
  const r = res as { rows?: Row[] };
  return r.rows ?? (res as Row[]);
}

async function cleanup() {
  await db.execute(sql`delete from email_suppressions where email like '__mailtest%'`);
  await db.execute(sql`delete from newsletter_subscriptions where email like '__mailtest%'`);
  await db.execute(sql`delete from customer_user_links where user_id like '__mailtest%'`);
  await db.execute(sql`delete from customer_profiles where first_name = '__mailtest'`);
  await db.execute(sql`delete from users where id like '__mailtest%'`);
}

/** Every .ts/.tsx source under src/, minus the tests and the flow registry /
 *  resolver themselves (which name every key without gating anything). */
function senderSources(): string[] {
  const root = join(process.cwd(), "src");
  const skip = [
    join("src", "lib", "db", "tests") + sep,
    join("src", "modules", "mailing", "flows.registry.ts"),
    join("src", "modules", "mailing", "flows.resolver.ts"),
  ];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry) && !skip.some((s) => p.includes(s))) {
        out.push(readFileSync(p, "utf8"));
      }
    }
  };
  walk(root);
  return out;
}

/** Relative paths of every src .ts/.tsx file (minus tests) that CALLS sendEmail(…)
 *  — i.e. writes to the transport directly. Imports don't match (no `(`). */
function sendEmailCallerPaths(): string[] {
  const root = join(process.cwd(), "src");
  const testsDir = join("src", "lib", "db", "tests") + sep;
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry) && !p.includes(testsDir)) {
        if (/\bsendEmail\s*\(/.test(readFileSync(p, "utf8"))) {
          out.push(p.slice(process.cwd().length + 1));
        }
      }
    }
  };
  walk(root);
  return out;
}

async function mkCustomer(id: string, optIn: boolean): Promise<void> {
  await authService.insert({ id, email: `${id}@example.test`, name: id, role: "customer" } as never);
  const profile = await customerService.insertProfile({
    first_name: "__mailtest",
    last_name: "x",
    marketing_opt_in: optIn,
  } as never);
  await customerUserLink.create({ customer_profile_id: profile.id, user_id: id } as never);
}

async function main() {
  await cleanup();

  // ── 1) Unsubscribe token round-trip + tamper rejection ──
  const tok = signUnsubToken("Foo@Example.test");
  check("token signs (non-empty)", tok.length > 0);
  check("token verifies to lowercased email", verifyUnsubToken(tok) === "foo@example.test");
  check("tampered token rejected", verifyUnsubToken(tok + "x") === null);
  check("garbage token rejected", verifyUnsubToken("not.a.real.token") === null);
  check("empty token rejected", verifyUnsubToken("") === null);
  const tok2 = signUnsubToken("foo@example.test");
  check("same email → same token (deterministic)", tok === tok2);

  // ── 2) Flow resolver: DB override beats registry default; unknown → false ──
  const priorRows = rowsOf(
    await db.execute(sql`select is_enabled from email_flows where flow_key = 'welcome'`),
  );
  const priorWelcome = priorRows.length ? (priorRows[0].is_enabled as boolean) : undefined;

  check("unknown flow → false", (await isFlowEnabled("__mailtest_nope")) === false);

  await emailFlowService.upsert("welcome", false);
  invalidateFlowCache();
  check("welcome override=false → disabled", (await isFlowEnabled("welcome")) === false);

  await emailFlowService.upsert("welcome", true);
  invalidateFlowCache();
  check("welcome override=true → enabled", (await isFlowEnabled("welcome")) === true);

  // restore the prior override state
  if (priorWelcome === undefined) {
    await db.execute(sql`delete from email_flows where flow_key = 'welcome'`);
  } else {
    await emailFlowService.upsert("welcome", priorWelcome);
  }
  invalidateFlowCache();
  if (priorWelcome === undefined) {
    check("welcome with no override → registry default (true)", (await isFlowEnabled("welcome")) === true);
  }

  // ── 3) Marketing consent gate ──
  await db.execute(
    sql`insert into email_suppressions (email, reason) values ('__mailtest-supp@example.test','bounce')`,
  );
  check(
    "suppressed address → NOT marketing-sendable",
    (await canSendMarketingTo("__mailtest-supp@example.test")) === false,
  );

  await mkCustomer("__mailtest-optout", false);
  check(
    "opted-out customer → NOT sendable",
    (await canSendMarketingTo("__mailtest-optout@example.test")) === false,
  );

  await mkCustomer("__mailtest-optin", true);
  check(
    "opted-in customer → sendable",
    (await canSendMarketingTo("__mailtest-optin@example.test")) === true,
  );

  await newsletterService.insert({ email: "__mailtest-nl@example.test", source: "test" } as never);
  check(
    "active newsletter subscriber → sendable",
    (await canSendMarketingTo("__mailtest-nl@example.test")) === true,
  );

  const nlUnsub = await newsletterService.insert({
    email: "__mailtest-nlunsub@example.test",
    source: "test",
  } as never);
  await newsletterService.unsubscribe(nlUnsub.id);
  check(
    "unsubscribed newsletter → NOT sendable",
    (await canSendMarketingTo("__mailtest-nlunsub@example.test")) === false,
  );

  check(
    "unknown address → sendable (pasted-list / positive-selection upstream)",
    (await canSendMarketingTo("__mailtest-unknown@example.test")) === true,
  );

  // ── 4) Flow-gate coverage: each flow key is named in a sender that calls
  //    isFlowEnabled (literal key, or a FLOW constant / status→flow map). ──
  const gatedSources = senderSources().filter((src) => /\bisFlowEnabled\s*\(/.test(src));
  check("found the gated senders", gatedSources.length > 0);
  for (const flow of EMAIL_FLOWS) {
    check(
      `flow "${flow.key}" is gated by isFlowEnabled in its sender`,
      gatedSources.some((src) => src.includes(`"${flow.key}"`)),
    );
  }

  // ── 5) "Centre of all mailing": sendEmail(...) — the only write to the transport
  //    — may be CALLED only by its own definition, the two dispatch/drain
  //    chokepoints, and the admin test-send (itself logged). Every real sender must
  //    go through dispatchEmail (brand + consent + logging). A new direct caller
  //    (e.g. a subscriber or automation bypassing dispatch) fails this. ──
  const ALLOWED_SENDEMAIL = new Set([
    join("src", "lib", "email", "client.ts"), // defines sendEmail
    join("src", "modules", "mailing", "dispatch.ts"),
    join("src", "lib", "mailing", "drain.ts"),
    join("src", "lib", "actions", "mailing.ts"), // the logged admin test-send
  ]);
  const callers = sendEmailCallerPaths();
  const rogue = callers.filter((p) => !ALLOWED_SENDEMAIL.has(p));
  check("found the sendEmail definition/callers", callers.length >= 4);
  check(
    "no sendEmail() bypass — only transport/dispatch/drain/test call it directly",
    rogue.length === 0,
  );
  if (rogue.length > 0) console.error("    rogue sendEmail callers:", rogue.join(", "));

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
