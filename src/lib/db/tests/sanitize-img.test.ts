/**
 * Rich-text sanitizer image-guard regression (VULN-2).
 *
 * The /cdn/-only <img src> rule must survive an embedded '>' in an attribute
 * value (title/alt), which the old tag-text regex post-pass let bypass — an
 * external src then loaded for every storefront visitor (tracking pixel / IP
 * leak). Pure function, no DB. Run via `pnpm test` or:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/sanitize-img.test.ts
 */
import { sanitizeRichHtml } from "@/lib/sanitize/rich-html";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

const EXT = "https://evil-tracker.example/pixel.gif?u=victim";
const has = (h: string, s: string) => h.includes(s);

function main() {
  // The bypass: '>' inside title closes the old regex early, hiding the src.
  const bypass = sanitizeRichHtml(`<p>x</p><img title=">" src="${EXT}">`);
  check("embedded-'>' title does NOT smuggle an external src", !has(bypass, EXT));

  for (const carrier of [`alt="a>b"`, `title='>'`, `title=">" alt="y"`]) {
    const out = sanitizeRichHtml(`<img ${carrier} src="${EXT}">`);
    check(`external src stripped despite ${carrier}`, !has(out, EXT));
  }

  // Plain external image still stripped (baseline).
  const plain = sanitizeRichHtml(`<img src="${EXT}">`);
  check("plain external src stripped", !has(plain, EXT));

  // Our own /cdn/ image survives.
  const cdn = sanitizeRichHtml(`<img src="/cdn/media/abc.webp" alt="ok">`);
  check("/cdn/ image src preserved", has(cdn, "/cdn/media/abc.webp"));

  // The leak class is NOT just <img> — every remote-fetching surface must be
  // covered (VULN-2 re-verify follow-up).
  check("video src external stripped", !has(sanitizeRichHtml(`<video src="${EXT}"></video>`), EXT));
  check("video poster external stripped", !has(sanitizeRichHtml(`<video poster="${EXT}"></video>`), EXT));
  check("source src external stripped", !has(sanitizeRichHtml(`<video><source src="${EXT}"></video>`), EXT));
  check("audio src external stripped", !has(sanitizeRichHtml(`<audio src="${EXT}"></audio>`), EXT));
  check("style url() external stripped", !has(sanitizeRichHtml(`<div style="background:url(${EXT})">x</div>`), EXT));
  // /cdn/ media still allowed through these tags.
  check("video /cdn/ poster preserved", has(sanitizeRichHtml(`<video poster="/cdn/m/p.jpg"></video>`), "/cdn/m/p.jpg"));

  // Scripts/handlers still stripped (DOMPurify core intact).
  const xss = sanitizeRichHtml(`<img src=x onerror="alert(1)"><script>alert(2)</script>`);
  check("onerror handler stripped", !has(xss, "onerror"));
  check("<script> stripped", !has(xss, "alert(2)"));

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
process.exit(0);
