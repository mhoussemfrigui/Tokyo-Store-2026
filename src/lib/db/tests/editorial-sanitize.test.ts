import "server-only";

/**
 * Editorial HTML sanitization — pure unit test (no DB). Blog post bodies and
 * aid article intro/outro/step bodies are stored RAW and sanitized at render
 * with `sanitizeRichHtml`. This locks in that the dangerous vectors are
 * stripped (stored-XSS defense) while legitimate formatting survives.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/editorial-sanitize.test.ts
 */
import { sanitizeRichHtml } from "@/lib/sanitize/rich-html";

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
  // ── dangerous vectors stripped ──────────────────────────────────────────
  const script = sanitizeRichHtml('<p>hi</p><script>alert(1)</script>');
  check("<script> removed", !/<script/i.test(script) && script.includes("hi"));

  const onerror = sanitizeRichHtml('<img src="x" onerror="alert(1)">');
  check("inline on* handler removed", !/onerror/i.test(onerror));

  const jsHref = sanitizeRichHtml('<a href="javascript:alert(1)">x</a>');
  check("javascript: href neutralized", !/javascript:/i.test(jsHref));

  const iframe = sanitizeRichHtml('<iframe src="https://evil.example"></iframe>');
  check("<iframe> removed", !/<iframe/i.test(iframe));

  const svgOnload = sanitizeRichHtml('<svg><script>alert(1)</script></svg>');
  check("svg-nested script removed", !/<script/i.test(svgOnload));

  // ── legitimate editorial formatting preserved ──────────────────────────
  const ok = sanitizeRichHtml('<p>Salut <strong>monde</strong> <em>!</em></p>');
  check("keeps <strong>", /<strong>/i.test(ok));
  check("keeps <em>", /<em>/i.test(ok));

  const link = sanitizeRichHtml('<a href="https://example.com">lien</a>');
  check("keeps safe https link", /href="https:\/\/example\.com"/i.test(link));

  const list = sanitizeRichHtml("<ul><li>a</li><li>b</li></ul>");
  check("keeps lists", /<ul>/i.test(list) && /<li>/i.test(list));

  const heading = sanitizeRichHtml("<h2>Titre</h2><p>texte</p>");
  check("keeps headings + paragraphs", /<h2>/i.test(heading) && /<p>/i.test(heading));

  // ── plain text is a no-op (no double-escape) ────────────────────────────
  check("plain text passes through", sanitizeRichHtml("juste du texte") === "juste du texte");

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
