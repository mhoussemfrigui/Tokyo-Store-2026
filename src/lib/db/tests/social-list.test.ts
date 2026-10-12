/**
 * Multi-value social links (« Identité & contact » → social.links) — pure model
 * (no DB). The store holds ONE ordered array under `social.links` so many links
 * per platform are allowed. Parsing is tolerant (JSON [{p,u,l?}] canonical, junk
 * → []), resolve treats the key's PRESENCE as authoritative (an explicit clear
 * is not resurrected by the legacy single keys), and the form round-trips through
 * one hidden input per row.
 *
 * Run: pnpm exec tsx src/lib/db/tests/social-list.test.ts
 */
import {
  parseSocialList,
  serializeSocialList,
  resolveSocialList,
  readSocialListFromForm,
  socialUrls,
  firstUrlByPlatform,
  SOCIAL_LINKS_KEY,
  type SocialLink,
} from "@/lib/cms/social-list";

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
  console.log("parseSocialList:");
  check("empty / null → []", parseSocialList("").length === 0 && parseSocialList(null).length === 0);
  check("non-array / broken JSON → []", parseSocialList('{"p":"x"}').length === 0 && parseSocialList("[bad").length === 0);
  const parsed = parseSocialList(
    '[{"p":"instagram","u":"https://ig/a"},{"p":"facebook","u":" https://fb/b ","l":" Tokyo Gaming "},{"p":"nope","u":"x"},{"p":"x","u":"  "}]',
  );
  check("keeps valid, drops unknown platform + empty url", parsed.length === 2);
  check("url trimmed", parsed[0].url === "https://ig/a" && parsed[1].url === "https://fb/b");
  check("label trimmed; absent → null", parsed[1].label === "Tokyo Gaming" && parsed[0].label === null);
  check("two of the SAME platform are both kept", parseSocialList('[{"p":"facebook","u":"https://fb/1"},{"p":"facebook","u":"https://fb/2"}]').length === 2);
  // Scheme guard — non-http(s) urls (stored RAW via the legacy key path) are
  // DROPPED at parse, so no consumer can render a script scheme into <a href>.
  check(
    "drops javascript:/data:/relative/protocol-relative urls (XSS guard)",
    parseSocialList('[{"p":"facebook","u":"javascript:alert(1)"},{"p":"instagram","u":"data:text/html,x"},{"p":"x","u":"/relative"},{"p":"tiktok","u":"//evil.com"}]').length === 0,
  );

  console.log("serializeSocialList:");
  const links: SocialLink[] = [
    { platform: "instagram", url: "https://ig/a", label: null },
    { platform: "facebook", url: "https://fb/b", label: "Tokyo Gaming" },
  ];
  check("round-trips (label only when set)", serializeSocialList(links) === '[{"p":"instagram","u":"https://ig/a"},{"p":"facebook","u":"https://fb/b","l":"Tokyo Gaming"}]');
  check("drops empty url", serializeSocialList([{ platform: "x", url: "  ", label: null }, { platform: "x", url: "https://x/1", label: null }]) === '[{"p":"x","u":"https://x/1"}]');
  check("all-empty → ''", serializeSocialList([{ platform: "x", url: "", label: null }]) === "");
  check("parse∘serialize is stable", parseSocialList(serializeSocialList(links)).length === 2);

  console.log("resolveSocialList (array presence authoritative, legacy fallback):");
  check(
    "array present → array (ignores stale legacy keys)",
    resolveSocialList({ [SOCIAL_LINKS_KEY]: '[{"p":"tiktok","u":"https://tt/a"}]', "social.facebook": "https://fb/legacy" })[0].platform === "tiktok",
  );
  check(
    "array present but empty ('') → [] (an explicit clear is NOT resurrected)",
    resolveSocialList({ [SOCIAL_LINKS_KEY]: "", "social.facebook": "https://fb/legacy" }).length === 0,
  );
  check(
    "array present but null → [] (cleared row)",
    resolveSocialList({ [SOCIAL_LINKS_KEY]: null, "social.instagram": "https://ig/legacy" }).length === 0,
  );
  const fb = resolveSocialList({ "social.instagram": "https://ig/x", "social.facebook": "https://fb/y", "social.x": "  " });
  check("key ABSENT → backfill from legacy keys, canonical order, blanks skipped", fb.length === 2 && fb[0].platform === "instagram" && fb[1].platform === "facebook");
  check("key absent + no legacy → []", resolveSocialList({}).length === 0);
  check(
    "legacy fallback also scheme-checks (a raw javascript: legacy key is dropped)",
    resolveSocialList({ "social.facebook": "javascript:alert(1)", "social.instagram": "https://ig/ok" }).length === 1,
  );

  console.log("socialUrls + firstUrlByPlatform:");
  const many: SocialLink[] = [
    { platform: "facebook", url: "https://fb/1", label: null },
    { platform: "facebook", url: "https://fb/2", label: null },
    { platform: "instagram", url: "https://ig/1", label: null },
  ];
  check("socialUrls = distinct urls, order preserved", JSON.stringify(socialUrls(many)) === JSON.stringify(["https://fb/1", "https://fb/2", "https://ig/1"]));
  const first = firstUrlByPlatform(many);
  check("firstUrlByPlatform keeps the FIRST per platform", first.facebook === "https://fb/1" && first.instagram === "https://ig/1");

  console.log("readSocialListFromForm:");
  const fd = new FormData();
  fd.append(`${SOCIAL_LINKS_KEY}[]`, '{"p":"instagram","u":"https://ig/a"}');
  fd.append(`${SOCIAL_LINKS_KEY}[]`, '{"p":"facebook","u":"https://fb/b","l":"Page 2"}');
  fd.append(`${SOCIAL_LINKS_KEY}[]`, "not json");
  const fromForm = readSocialListFromForm(fd);
  check("reads each valid row (order preserved), junk dropped", fromForm.length === 2 && fromForm[0].platform === "instagram" && fromForm[1].label === "Page 2");

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
