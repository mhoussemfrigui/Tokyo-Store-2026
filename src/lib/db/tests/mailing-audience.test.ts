import "server-only";

/**
 * Phase 5 — campaign audience-resolver regression test. Verifies each audience
 * kind returns a DE-DUPED recipient list plus a correct `truncated` flag.
 * Consent/suppression gating is applied one layer up (resolveSendableAudience)
 * and at send time (the drain) — the parse-layer resolver only excludes via the
 * SQL opt-in/active filters. Self-cleaning (`__mailtest…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/mailing-audience.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { resolveCampaignAudience } from "@/lib/mailing/audience";
import { filterMarketableEmails } from "@/lib/email/consent";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { newsletterService } from "@/modules/newsletter/service";
import { segmentService } from "@/modules/customer/segment.service";

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

async function cleanup() {
  await db.execute(
    sql`delete from customer_segment_members where segment_id in (select id from customer_segments where name like '__mailtest%')`,
  );
  await db.execute(sql`delete from customer_segments where name like '__mailtest%'`);
  await db.execute(sql`delete from email_suppressions where email like '__mailtest%'`);
  await db.execute(sql`delete from newsletter_subscriptions where email like '__mailtest%'`);
  await db.execute(sql`delete from customer_user_links where user_id like '__mailtest%'`);
  await db.execute(sql`delete from customer_profiles where first_name = '__mailtest'`);
  await db.execute(sql`delete from users where id like '__mailtest%'`);
}

async function mkCustomer(id: string, optIn: boolean): Promise<string> {
  await authService.insert({ id, email: `${id}@example.test`, name: id, role: "customer" } as never);
  const profile = await customerService.insertProfile({
    first_name: "__mailtest",
    last_name: "x",
    marketing_opt_in: optIn,
  } as never);
  await customerUserLink.create({ customer_profile_id: profile.id, user_id: id } as never);
  return profile.id;
}

function has(list: { email: string }[], email: string): boolean {
  return list.some((r) => r.email === email);
}

async function main() {
  await cleanup();

  const inProfile = await mkCustomer("__mailtest-in", true);
  const outProfile = await mkCustomer("__mailtest-out", false);

  // 1) marketing_optin: includes opted-in, excludes opted-out (SQL opt-in filter).
  const { recipients: optin } = await resolveCampaignAudience("marketing_optin", {});
  check("optin → includes opted-in customer", has(optin, "__mailtest-in@example.test"));
  check("optin → excludes opted-out customer", !has(optin, "__mailtest-out@example.test"));

  // 2) newsletter: active included, unsubscribed excluded.
  await newsletterService.insert({ email: "__mailtest-nl@example.test", source: "test" } as never);
  const nlUnsub = await newsletterService.insert({
    email: "__mailtest-nlx@example.test",
    source: "test",
  } as never);
  await newsletterService.unsubscribe(nlUnsub.id);
  const { recipients: nl } = await resolveCampaignAudience("newsletter", {});
  check("newsletter → includes active subscriber", has(nl, "__mailtest-nl@example.test"));
  check("newsletter → excludes unsubscribed", !has(nl, "__mailtest-nlx@example.test"));

  // 3) segment (manual): members who are opted-in.
  const seg = await segmentService.insert({ name: "__mailtest-seg", kind: "manual" } as never);
  await segmentService.addMember(seg.id, inProfile);
  const { recipients: segAud } = await resolveCampaignAudience("segment", { segmentId: seg.id });
  check("segment → includes opted-in member", has(segAud, "__mailtest-in@example.test"));

  // 3b) segment (DYNAMIC rule tree): resolved via the SQL compiler, NOT member rows —
  //     the gap where a dynamic segment used to mail to nobody. Give both customers a
  //     very old birthday so the age tree matches either (and nobody else); the opt-in
  //     gate must still drop the opted-out one.
  await db.execute(sql`update customer_profiles set birthday = '1900-01-01' where id in (${inProfile}, ${outProfile})`);
  const dynSeg = await segmentService.insert({
    name: "__mailtest-dynseg",
    kind: "dynamic",
    rule_tree: { kind: "age_gte", years: 100 },
  } as never);
  const { recipients: dynAud } = await resolveCampaignAudience("segment", { segmentId: dynSeg.id });
  check("dynamic segment → resolves matching member via rule tree", has(dynAud, "__mailtest-in@example.test"));
  check("dynamic segment → opt-in gate still excludes opted-out match", !has(dynAud, "__mailtest-out@example.test"));

  // 3c) INLINE rule (audience_kind='rule'): an ad-hoc tree (no saved segment) resolves
  //     through the SAME shared SQL engine as a dynamic segment, opt-in gated. This is
  //     the full-parity targeting path (démographie / panier / commandes).
  const { recipients: ruleAud } = await resolveCampaignAudience("rule", {
    ruleTree: { op: "and", children: [{ kind: "age_gte", years: 100 }] },
  });
  check("inline rule → resolves matching opted-in customer", has(ruleAud, "__mailtest-in@example.test"));
  check("inline rule → opt-in gate excludes opted-out match", !has(ruleAud, "__mailtest-out@example.test"));
  // An absent/empty rule resolves to nobody (the composer disables send; this is the backstop).
  const { recipients: noRule } = await resolveCampaignAudience("rule", {});
  check("inline rule → no tree resolves to an empty audience", noRule.length === 0);

  // 4) addresses: parsed + de-duped at this layer (consent/suppression is applied
  //    one layer up by resolveSendableAudience + at send time by the drain, NOT
  //    here — so a suppressed address survives the parse but the shared consent
  //    gate excludes it).
  await db.execute(
    sql`insert into email_suppressions (email, reason) values ('__mailtest-supp@example.test','bounce')`,
  );
  const { recipients: addr } = await resolveCampaignAudience("addresses", {
    addresses:
      "__mailtest-unknown@example.test, __mailtest-supp@example.test\n__mailtest-unknown@example.test",
  });
  check("addresses → includes unknown pasted address", has(addr, "__mailtest-unknown@example.test"));
  check(
    "addresses → de-duped (one row for the repeated address)",
    addr.filter((r) => r.email === "__mailtest-unknown@example.test").length === 1,
  );
  // The shared consent gate (used by resolveSendableAudience + the drain) drops
  // the suppressed address and keeps the unknown one.
  const marketable = await filterMarketableEmails(addr.map((r) => r.email));
  check("consent gate → excludes suppressed address", !marketable.has("__mailtest-supp@example.test"));
  check("consent gate → keeps unknown address", marketable.has("__mailtest-unknown@example.test"));

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
