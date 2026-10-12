import "server-only";

/**
 * AI admin & AI safety invariants (A–Z audit 2026-09-23, unit p5-ai-admin):
 *
 *  Pure
 *   • base-URL block-list: AWS IMDS over IPv6 (fd00:ec2::254) and Alibaba
 *     (100.100.100.200) join 169.254/16 + fe80::/10, incl. the WHATWG-normalised
 *     decimal / IPv4-mapped forms; private + public hosts stay allowed.
 *   • normalizeAiBaseUrl strips trailing slashes (no more `…/v1//chat/completions`).
 *   • aiBaseUrlChangeRefusal — the owner gate (env key → owner-only unless back
 *     to the provider default; stored key → re-key in the same save).
 *   • embedding-settings split (semantic search): a plain provider save never
 *     touches ai.embedding_* (can't blank it); a dedicated save action owns both
 *     keys, gated on system_ai:update, keeps EMBEDDING_CAPABLE_PROVIDERS
 *     normalisation, and never writes provider rows.
 *
 *  DB (isolated test DB only)
 *   • provider settings: trailing slash stripped on save; a delegate cannot move
 *     an env-keyed / stored-key provider's base URL; an owner can; the audit event
 *     fires only when something changed.
 *   • feature prompts: a submitted prompt equal to the code default (CRLF too) is
 *     stored as NULL; an untouched all-defaults task writes no row; real changes
 *     emit `ai.feature_prompts_updated`, identical re-saves emit nothing.
 *   • search aliases go through workflows that emit `search_alias.*`.
 *
 * Self-cleaning. Run (isolated DB):
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… EMAIL_PROVIDER=console \
 *     pnpm exec tsx --conditions=react-server src/lib/db/tests/ai-admin.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { and, eq, like, or, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { rbacService } from "@/modules/rbac/service";
import { users } from "@/modules/auth/schema";
import { ai_feature_prompts, ai_provider_settings } from "@/modules/ai/schema";
import { search_aliases } from "@/modules/search/schema";
import { getAiTask } from "@/lib/ai/tasks";
import { getAiProvider } from "@/lib/ai/providers";
import {
  aiBaseUrlChangeRefusal,
  isLinkLocalOrMetadataHost,
  normalizeAiBaseUrl,
  validateAiBaseUrl,
} from "@/lib/ai/validate-base-url";
import { upsertAiProviderSettingsWorkflow } from "@/workflows/ai/upsert-provider-settings";
import { upsertAiFeaturePromptsWorkflow } from "@/workflows/ai/upsert-feature-prompts";
import {
  createSearchAliasWorkflow,
  deleteSearchAliasWorkflow,
  updateSearchAliasWorkflow,
} from "@/workflows/search/aliases";

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

const TAG = "zztest-aiadm";
const DELEGATE = `__${TAG}-delegate`; // no users row → no permissions (non-owner)
const OWNER = `__${TAG}-owner`; // super_admin role → '*'
const APPLIER = `__${TAG}-applier`;
const PROVIDER = "deepseek" as const;
const FEATURE = "categories";
const TASK = "description";

/** Loosely-typed capture (the envelope payload is a union over every event). */
type Captured = { name: string; payload: Record<string, unknown>; actorUserId?: string | null };
const emitted: Captured[] = [];
const countOf = (name: string) => emitted.filter((e) => e.name === name).length;
const lastOf = (name: string) => emitted.filter((e) => e.name === name).at(-1);

/* ───────────────────────────────── pure ───────────────────────────────── */

function pure() {
  console.log("base-URL block-list:");
  check("AWS IMDS IPv6 blocked", validateAiBaseUrl("http://[fd00:ec2::254]/latest") !== null);
  check(
    "AWS IMDS IPv6 long form blocked (URL-normalised)",
    validateAiBaseUrl("http://[fd00:ec2:0:0:0:0:0:254]/") !== null,
  );
  check("Alibaba metadata blocked", validateAiBaseUrl("http://100.100.100.200/latest/meta-data") !== null);
  check("Alibaba metadata, decimal form blocked", validateAiBaseUrl("http://1684301000/") !== null);
  check("IPv4-mapped 169.254 blocked", validateAiBaseUrl("http://[::ffff:169.254.169.254]/") !== null);
  check("IPv4-mapped Alibaba blocked", validateAiBaseUrl("http://[::ffff:100.100.100.200]/") !== null);
  check("fe80::/10 upper range blocked", validateAiBaseUrl("http://[febf::1]/") !== null);
  check("metadata host with trailing dot blocked", validateAiBaseUrl("http://metadata.google.internal./") !== null);
  check("neighbour 100.100.100.201 allowed", validateAiBaseUrl("http://100.100.100.201/v1") === null);
  check("private LAN still allowed (self-hosted model)", validateAiBaseUrl("http://192.168.1.20:8080/v1") === null);
  check("public provider allowed", validateAiBaseUrl("https://api.openai.com/v1") === null);
  check("resolved IP fd00:ec2::254 flagged", isLinkLocalOrMetadataHost("fd00:ec2::254"));
  check("resolved IP 169.254.169.254 flagged", isLinkLocalOrMetadataHost("169.254.169.254"));
  check("resolved IP fec0::1 not flagged (not link-local)", !isLinkLocalOrMetadataHost("fec0::1"));
  check("a DNS name starting with « feb » is not an IP", !isLinkLocalOrMetadataHost("febrile.example.com"));

  console.log("normalizeAiBaseUrl:");
  check("strips one trailing slash", normalizeAiBaseUrl("https://api.openai.com/v1/") === "https://api.openai.com/v1");
  check("strips several + trims", normalizeAiBaseUrl("  https://x.test/v1/// ") === "https://x.test/v1");
  check("blank → empty", normalizeAiBaseUrl(null) === "" && normalizeAiBaseUrl("  ") === "");

  console.log("aiBaseUrlChangeRefusal:");
  const base = {
    isOwner: false,
    newKeySubmitted: false,
    previous: "https://api.deepseek.com",
    next: "https://evil.example",
    providerDefault: "https://api.deepseek.com",
  };
  check("env key + delegate + new host → refused", aiBaseUrlChangeRefusal({ ...base, keySource: "env" }) !== null);
  check("env key + owner → allowed", aiBaseUrlChangeRefusal({ ...base, keySource: "env", isOwner: true }) === null);
  check(
    "env key + delegate back to the provider default → allowed",
    aiBaseUrlChangeRefusal({
      ...base,
      keySource: "env",
      previous: "https://proxy.example",
      next: "https://api.deepseek.com",
    }) === null,
  );
  check(
    "unchanged endpoint → allowed for anyone",
    aiBaseUrlChangeRefusal({ ...base, keySource: "env", next: base.previous }) === null,
  );
  check("stored key + delegate, no re-key → refused", aiBaseUrlChangeRefusal({ ...base, keySource: "admin" }) !== null);
  check(
    "stored key + delegate re-keying in the same save → allowed",
    aiBaseUrlChangeRefusal({ ...base, keySource: "admin", newKeySubmitted: true }) === null,
  );
  check("no key configured → allowed", aiBaseUrlChangeRefusal({ ...base, keySource: "none" }) === null);

  console.log("action guard order (source):");
  const src = (p: string) => readFileSync(join(process.cwd(), "src", "lib", "actions", p), "utf8");
  // Embedding-settings save SPLIT (ai.embedding_provider / ai.embedding_model now
  // live in their OWN action + sub-tab). The invariant that matters: a plain
  // provider save must NOT touch the embedding settings (a copy-paste leftover
  // there would blank them every time Réglages is saved) — and the embedding
  // action must own both keys, stay gated on system_ai:update, keep the
  // EMBEDDING_CAPABLE_PROVIDERS normalisation, and never write provider rows.
  const aiSettings = src("ai-settings.ts");
  const providerAction = aiSettings.slice(
    aiSettings.indexOf("export async function saveAiProviderSettingsAction("),
    aiSettings.indexOf("export async function saveAiEmbeddingSettingsAction("),
  );
  const embeddingAction = aiSettings.slice(
    aiSettings.indexOf("export async function saveAiEmbeddingSettingsAction("),
    aiSettings.indexOf("export async function saveAiFeaturePromptsAction("),
  );
  check(
    "embedding split: the provider save no longer references ai.embedding_* (can't blank it)",
    providerAction.length > 0 &&
      !providerAction.includes("ai.embedding_provider") &&
      !providerAction.includes("ai.embedding_model"),
  );
  check(
    "embedding split: a dedicated saveAiEmbeddingSettingsAction owns both keys + is gated on system_ai:update",
    embeddingAction.includes("ai.embedding_provider") &&
      embeddingAction.includes("ai.embedding_model") &&
      embeddingAction.includes('requirePermission("system_ai", "update")'),
  );
  check(
    "embedding save keeps the provider normalisation + never writes provider rows",
    /EMBEDDING_CAPABLE_PROVIDERS\.has\(/.test(embeddingAction) &&
      !embeddingAction.includes("upsertProviderSettings"),
  );
}

/* ─────────────────────────────── DB checks ────────────────────────────── */

async function providerSettings() {
  console.log("provider settings (base URL owner gate):");
  const def = getAiProvider(PROVIDER)!;
  const envName = def.apiKeyEnv;
  const savedEnv = process.env[envName];
  const savedEncKey = process.env.PAYMENT_ENCRYPTION_KEY;
  const [savedRow] = await db
    .select()
    .from(ai_provider_settings)
    .where(eq(ai_provider_settings.provider, PROVIDER));
  await db.delete(ai_provider_settings).where(eq(ai_provider_settings.provider, PROVIDER));
  const stored = async () =>
    (await db.select().from(ai_provider_settings).where(eq(ai_provider_settings.provider, PROVIDER)))[0];
  try {
    delete process.env[envName];

    // Trailing slash stripped on save (no key configured → nothing to leak, a
    // delegate may set it).
    const slash = await upsertAiProviderSettingsWorkflow(
      { provider: PROVIDER, baseUrl: "https://llm.example.test/v1/", defaultModel: "", enabled: false },
      { actorUserId: DELEGATE },
    );
    check("save ok", slash.ok === true);
    check("trailing slash stripped on save", (await stored())?.base_url === "https://llm.example.test/v1");
    check(
      "the base_url change is audited",
      slash.ok && slash.data.changedFields.includes("base_url") && countOf("ai.provider_settings_updated") === 1,
    );

    const same = await upsertAiProviderSettingsWorkflow(
      { provider: PROVIDER, baseUrl: "https://llm.example.test/v1//", defaultModel: "", enabled: false },
      { actorUserId: DELEGATE },
    );
    check(
      "same endpoint re-saved with slashes → no change, no event",
      same.ok && same.data.changedFields.length === 0 && countOf("ai.provider_settings_updated") === 1,
    );

    // Stored-key provider: a delegate may not move the endpoint without re-keying.
    await db
      .update(ai_provider_settings)
      .set({ api_key_enc: "zz-not-a-real-ciphertext" })
      .where(eq(ai_provider_settings.provider, PROVIDER));
    const noRekey = await upsertAiProviderSettingsWorkflow(
      { provider: PROVIDER, baseUrl: "https://attacker.example.test", defaultModel: "", enabled: false },
      { actorUserId: DELEGATE },
    );
    check("stored key: delegate move without re-key → refused", noRekey.ok === false);
    check("…and the stored URL is untouched", (await stored())?.base_url === "https://llm.example.test/v1");
    if (!(process.env.PAYMENT_ENCRYPTION_KEY ?? "").trim()) {
      process.env.PAYMENT_ENCRYPTION_KEY = "zz-ai-admin-test-encryption-key";
    }
    const rekey = await upsertAiProviderSettingsWorkflow(
      {
        provider: PROVIDER,
        apiKey: "sk-zz-test",
        baseUrl: "https://own-proxy.example.test",
        defaultModel: "",
        enabled: false,
      },
      { actorUserId: DELEGATE },
    );
    check(
      "stored key: delegate re-keying in the same save may move it",
      rekey.ok === true && (await stored())?.base_url === "https://own-proxy.example.test",
    );

    // Env-keyed provider: owner-only.
    process.env[envName] = "sk-zz-env-owner-key";
    const envDelegate = await upsertAiProviderSettingsWorkflow(
      { provider: PROVIDER, baseUrl: "https://attacker.example.test", defaultModel: "", enabled: false },
      { actorUserId: DELEGATE },
    );
    check(
      "env key: delegate move → refused (forbidden)",
      envDelegate.ok === false && envDelegate.error === "forbidden",
    );
    const envKeep = await upsertAiProviderSettingsWorkflow(
      { provider: PROVIDER, baseUrl: "https://own-proxy.example.test/", defaultModel: "zz-model", enabled: false },
      { actorUserId: DELEGATE },
    );
    check(
      "env key: delegate saving other fields with the current URL → ok",
      envKeep.ok === true && (await stored())?.default_model === "zz-model",
    );
    const envDefault = await upsertAiProviderSettingsWorkflow(
      { provider: PROVIDER, baseUrl: "", defaultModel: "zz-model", enabled: false },
      { actorUserId: DELEGATE },
    );
    check(
      "env key: delegate may go back to the provider default",
      envDefault.ok === true && (await stored())?.base_url === null,
    );
    const envOwner = await upsertAiProviderSettingsWorkflow(
      { provider: PROVIDER, baseUrl: "https://owner-proxy.example.test", defaultModel: "zz-model", enabled: false },
      { actorUserId: OWNER },
    );
    check(
      "env key: owner may move it",
      envOwner.ok === true && (await stored())?.base_url === "https://owner-proxy.example.test",
    );

    // No row + env key: unticking « enabled » is a real (audited) change.
    await db.delete(ai_provider_settings).where(eq(ai_provider_settings.provider, PROVIDER));
    const before = countOf("ai.provider_settings_updated");
    const disable = await upsertAiProviderSettingsWorkflow(
      { provider: PROVIDER, baseUrl: "", defaultModel: "", enabled: false },
      { actorUserId: OWNER },
    );
    check(
      "env-only key disabled with no row → written + audited as « enabled »",
      disable.ok &&
        (await stored())?.enabled === false &&
        countOf("ai.provider_settings_updated") === before + 1 &&
        JSON.stringify(lastOf("ai.provider_settings_updated")?.payload.changedFields) === '["enabled"]',
    );
  } finally {
    if (savedEnv === undefined) delete process.env[envName];
    else process.env[envName] = savedEnv;
    if (savedEncKey === undefined) delete process.env.PAYMENT_ENCRYPTION_KEY;
    else process.env.PAYMENT_ENCRYPTION_KEY = savedEncKey;
    await db.delete(ai_provider_settings).where(eq(ai_provider_settings.provider, PROVIDER));
    if (savedRow) await db.insert(ai_provider_settings).values(savedRow);
  }
}

async function featurePrompts() {
  console.log("feature prompts (no pinned defaults + audit):");
  const task = getAiTask(FEATURE, TASK)!;
  const where = and(eq(ai_feature_prompts.feature, FEATURE), eq(ai_feature_prompts.task, TASK));
  const [savedRow] = await db.select().from(ai_feature_prompts).where(where);
  await db.delete(ai_feature_prompts).where(where);
  const row = async () => (await db.select().from(ai_feature_prompts).where(where))[0];
  const save = (systemPrompt: string, extra: { model?: string; enabled?: boolean } = {}) =>
    upsertAiFeaturePromptsWorkflow(
      { feature: FEATURE, task: TASK, provider: "", model: extra.model ?? "", systemPrompt, enabled: extra.enabled ?? true },
      { actorUserId: DELEGATE },
    );
  try {
    const n0 = countOf("ai.feature_prompts_updated");
    const untouched = await save("");
    check("all-defaults save with no row → no row, no event", untouched.ok && !(await row()) && countOf("ai.feature_prompts_updated") === n0);

    const asDefault = await save(task.defaultSystemPrompt.replace(/\n/g, "\r\n"), { model: "zz-model" });
    const r1 = await row();
    check("prompt equal to the code default (CRLF) → stored NULL", asDefault.ok && r1 !== undefined && r1.system_prompt === null);
    check("…while the real change (model) is saved + audited", r1?.model === "zz-model" && countOf("ai.feature_prompts_updated") === n0 + 1);

    const custom = await save("  Mon prompt maison  ", { model: "zz-model" });
    check("custom prompt stored trimmed", custom.ok && (await row())?.system_prompt === "Mon prompt maison");
    const ev = lastOf("ai.feature_prompts_updated");
    check(
      "event carries feature/task/changedFields + actor",
      countOf("ai.feature_prompts_updated") === n0 + 2 &&
        ev?.payload.feature === FEATURE &&
        ev?.payload.task === TASK &&
        JSON.stringify(ev?.payload.changedFields) === '["system_prompt"]' &&
        ev?.actorUserId === DELEGATE,
    );

    const again = await save("Mon prompt maison", { model: "zz-model" });
    check("identical re-save → no event", again.ok && countOf("ai.feature_prompts_updated") === n0 + 2);

    const reset = await save("", { model: "zz-model" });
    check("« Réinitialiser » (blank) → NULL + audited", reset.ok && (await row())?.system_prompt === null && countOf("ai.feature_prompts_updated") === n0 + 3);
  } finally {
    await db.delete(ai_feature_prompts).where(where);
    if (savedRow) await db.insert(ai_feature_prompts).values(savedRow);
  }
}

async function aliases() {
  console.log("search alias workflows (audited):");
  const cleanup = () =>
    db
      .delete(search_aliases)
      .where(or(like(search_aliases.term, "zzaiadm%"), like(search_aliases.expansion, "zzaiadm%")));
  await cleanup();
  try {
    const created = await createSearchAliasWorkflow(
      { term: "ZZAIADM Chrono", expansion: "zzaiadm chronographe" },
      { actorUserId: DELEGATE },
    );
    const c = lastOf("search_alias.created");
    check(
      "create → search_alias.created with the normalised term + actor",
      created.ok && c?.payload.term === "zzaiadm chrono" && c?.actorUserId === DELEGATE,
    );
    const id = created.ok ? created.data.id : "";
    const dup = await createSearchAliasWorkflow(
      { term: "zzaiadm chrono", expansion: "zzaiadm chronographe" },
      { actorUserId: DELEGATE },
    );
    check("duplicate → validation failure, no event", dup.ok === false && countOf("search_alias.created") === 1);

    const off = await updateSearchAliasWorkflow({ id, isActive: false }, { actorUserId: DELEGATE });
    const u = lastOf("search_alias.updated");
    check(
      "toggle → search_alias.updated (isActive false, term)",
      off.ok && u?.payload.isActive === false && u?.payload.term === "zzaiadm chrono",
    );
    const offAgain = await updateSearchAliasWorkflow({ id, isActive: false }, { actorUserId: DELEGATE });
    check("same toggle again → no-op, no event", offAgain.ok && countOf("search_alias.updated") === 1);

    const del = await deleteSearchAliasWorkflow({ id }, { actorUserId: DELEGATE });
    check(
      "delete → search_alias.deleted with the term",
      del.ok && lastOf("search_alias.deleted")?.payload.term === "zzaiadm chrono",
    );
    const delAgain = await deleteSearchAliasWorkflow({ id }, { actorUserId: DELEGATE });
    check("delete again → idempotent, no event", delAgain.ok && countOf("search_alias.deleted") === 1);
  } finally {
    await cleanup();
  }
}

async function main() {
  pure();

  for (const name of [
    "ai.provider_settings_updated",
    "ai.feature_prompts_updated",
    "search_alias.created",
    "search_alias.updated",
    "search_alias.deleted",
    "product.updated",
  ] as const) {
    bus.on(name, (env) => {
      emitted.push(env as unknown as Captured);
    });
  }

  await db.execute(sql`delete from user_roles where user_id = ${OWNER}`);
  await db.delete(users).where(eq(users.id, OWNER));
  await db.insert(users).values({ id: OWNER, email: `${OWNER}@example.test`, name: "AI owner" } as never);
  // Access is role-only: the owner is a full admin via the super_admin ('*') role.
  const superRole = await rbacService.findRoleByKey("super_admin");
  if (superRole) await rbacService.assignRoleToUser(OWNER, superRole.id);
  try {
    await providerSettings();
    await featurePrompts();
    await aliases();
  } finally {
    await db.execute(sql`delete from audit_log where actor_user_id in (${DELEGATE}, ${OWNER}, ${APPLIER})`);
    await db.execute(sql`delete from user_roles where user_id = ${OWNER}`);
    await db.delete(users).where(eq(users.id, OWNER));
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
