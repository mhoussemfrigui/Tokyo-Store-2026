/**
 * Entity editors keep the operator's input when a save FAILS — the guard for
 * React 19's automatic form reset.
 *
 * React 19 resets every `<form action={fn}>` once its action settles, and the
 * reset is queued BEFORE the action runs — so a save answering `{ ok: false }`
 * (slug conflict, bad video URL, meta too long…) snapped every uncontrolled
 * `defaultValue` field of the product / brand / category editor
 * back to its saved value (or to empty in create mode). `useNoResetSubmit`
 * (form-tabs.tsx) dispatches imperatively inside `startTransition` instead,
 * which never resets, and resets explicitly only after a SUCCESSFUL save.
 *
 * The React/DOM behaviour itself needs a browser DOM (jsdom is not a declared
 * devDependency), so this pure scan pins the two things that silently regress:
 *   1. the helper ignores submits bubbled from a portaled child form, still
 *      preventDefault()s, dispatches in a transition with the submitter-aware
 *      FormData, and resets ONLY on `state.ok`;
 *   2. each entity editor's MAIN form is wired through it (onSubmit), while
 *      keeping `action={formAction}` for the pre-hydration fallback.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/form-no-reset.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const ADMIN = join(process.cwd(), "src", "components", "admin");
const read = (...p: string[]) => readFileSync(join(ADMIN, ...p), "utf8");

// ─── 1. The helper ─────────────────────────────────────────────────────────
console.log("useNoResetSubmit (form-tabs.tsx)");
const tabs = read("_components", "form-tabs.tsx");
const start = tabs.indexOf("export function useNoResetSubmit(");
check("form-tabs.tsx exports useNoResetSubmit", start >= 0);
// The helper body runs up to the next top-level declaration.
const nextDecl = tabs.indexOf("\nexport function ", start + 1);
const helper = start >= 0 ? tabs.slice(start, nextDecl > start ? nextDecl : undefined) : "";
check("cancels the native submit (React then skips the action + its reset)", /event\.preventDefault\(\)/.test(helper));
// React bubbles `submit` through portals: without this guard the product
// editor's portaled PromotionForm submit was swallowed (preventDefault + a
// FormData built with a submitter the outer form does not own → throws).
const guardAt = helper.search(/if\s*\(event\.target\s*!==\s*event\.currentTarget\)\s*return;/);
check("ignores submits bubbled from a portaled child <form>", guardAt >= 0);
check("…and checks that BEFORE preventDefault()", guardAt >= 0 && guardAt < helper.indexOf("event.preventDefault()"));
check("dispatches inside startTransition (keeps isPending)", /startTransition\(\(\)\s*=>\s*dispatch\(formData\)\)/.test(helper));
check("builds FormData with the submitter", /new FormData\(form,\s*submitter\)/.test(helper));
check("resets only after a successful save", /if\s*\(state\?\.ok\)\s*formRef\.current\?\.reset\(\)/.test(helper));
check("startTransition is imported from react", /import\s*\{[^}]*\bstartTransition\b[^}]*\}\s*from\s*"react"/.test(tabs));

// ─── 2. Entity editors ─────────────────────────────────────────────────────
const EDITORS: ReadonlyArray<{ file: string; formId: string }> = [
  { file: "product-form.tsx", formId: "PRODUCT_FORM_ID" },
  { file: "brand-form.tsx", formId: "BRAND_FORM_ID" },
  { file: "category-form.tsx", formId: "CATEGORY_FORM_ID" },
];

for (const { file, formId } of EDITORS) {
  console.log(file);
  const src = read(file);
  check("calls useNoResetSubmit(formAction, state)", /useNoResetSubmit\(formAction,\s*state\)/.test(src));
  const tag = src.match(new RegExp(`<form\\b[^>]*\\bid=\\{${formId}\\}[^>]*>`, "s"))?.[0] ?? "";
  check(`main <form id={${formId}}> found`, tag.length > 0);
  check("main form submits through onSubmit={onSubmit}", /\bonSubmit=\{onSubmit\}/.test(tag));
  check("main form keeps action={formAction} (pre-hydration fallback)", /\baction=\{formAction\}/.test(tag));
  // No other form in the file may bind the main action without the helper.
  const bare = [...src.matchAll(/<form\b[^>]*>/gs)]
    .map((m) => m[0])
    .filter((t) => /\baction=\{formAction\}/.test(t) && !/\bonSubmit=/.test(t));
  check("no <form action={formAction}> left without onSubmit", bare.length === 0);
}

// ─── 3. Banner editor (inline submit button, no external form id) ───────────
{
  console.log("banner-form.tsx");
  const src = read("banner-form.tsx");
  check("calls useNoResetSubmit(formAction, state)", /useNoResetSubmit\(formAction,\s*state\)/.test(src));
  const bare = [...src.matchAll(/<form\b[^>]*>/gs)]
    .map((m) => m[0])
    .filter((t) => /\baction=\{formAction\}/.test(t) && !/\bonSubmit=/.test(t));
  check("no <form action={formAction}> left without onSubmit", bare.length === 0);
}

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
