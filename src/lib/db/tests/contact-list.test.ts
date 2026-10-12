/**
 * Multi-value contact lists (phones / emails / addresses) — pure model (no DB).
 * Parsing is tolerant (JSON {v,f} canonical, legacy plain string, junk → []),
 * the primary single key is the first entry, the footer shows only flagged
 * entries, and the form round-trips through one hidden input per row.
 *
 * Run: pnpm exec tsx src/lib/db/tests/contact-list.test.ts
 */
import {
  parseContactList,
  serializeContactList,
  resolveContactList,
  getSiteContacts,
  footerEntries,
  readContactListFromForm,
} from "@/lib/cms/contact-list";

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
  console.log("parseContactList:");
  check("empty / null → []", parseContactList("").length === 0 && parseContactList(null).length === 0);
  check("non-JSON string → single legacy entry; broken array → []", parseContactList("not json").length === 1 && parseContactList("[bad").length === 0);
  const legacy = parseContactList("+216 54 666 006");
  check("legacy plain string → one footer-visible entry", legacy.length === 1 && legacy[0].value === "+216 54 666 006" && legacy[0].footer === true);
  const parsed = parseContactList('[{"v":"a","f":true},{"v":"b","f":false},{"v":"  ","f":true},{"v":"c"}]');
  check("JSON {v,f}: drops blank values", parsed.length === 3);
  check("f=false honoured, missing f defaults true", parsed[1].footer === false && parsed[2].footer === true);
  check("values trimmed", parseContactList('[{"v":" a "}]')[0].value === "a");
  check("non-array JSON → []", parseContactList('{"v":"a"}').length === 0);

  console.log("serializeContactList:");
  check("round-trips", serializeContactList([{ value: "a", footer: true }, { value: "b", footer: false }]) === '[{"v":"a","f":true},{"v":"b","f":false}]');
  check("drops empty values", serializeContactList([{ value: " ", footer: true }, { value: "x", footer: true }]) === '[{"v":"x","f":true}]');
  check("all-empty → ''", serializeContactList([{ value: "", footer: true }]) === "");

  console.log("resolveContactList (array wins, single fallback):");
  const withArray = { "site.contact_phones": '[{"v":"a","f":true}]', "site.contact_phone": "legacy" };
  check("array present → array", resolveContactList(withArray, "site.contact_phones", "site.contact_phone")[0].value === "a");
  const singleOnly = { "site.contact_phone": "+216 1" } as Record<string, string | null>;
  const fb = resolveContactList(singleOnly, "site.contact_phones", "site.contact_phone");
  check("array unset → single key as one footer entry", fb.length === 1 && fb[0].value === "+216 1" && fb[0].footer === true);
  check("both unset → []", resolveContactList({}, "site.contact_phones", "site.contact_phone").length === 0);

  console.log("getSiteContacts + footerEntries:");
  const sc = getSiteContacts({
    "site.addresses": '[{"v":"Sfax","f":true},{"v":"Tunis","f":false}]',
    "site.contact_phones": '[{"v":"+216 1","f":true}]',
    "site.hours": "Lun-Sam",
  });
  check("reads each list", sc.addresses.length === 2 && sc.phones.length === 1 && sc.emails.length === 0);
  check("hours single", sc.hours === "Lun-Sam");
  check("footerEntries filters f=false", footerEntries(sc.addresses).length === 1 && footerEntries(sc.addresses)[0].value === "Sfax");

  console.log("readContactListFromForm:");
  const fd = new FormData();
  fd.append("site.contact_phones[]", '{"v":"+216 1","f":true}');
  fd.append("site.contact_phones[]", '{"v":"+216 2","f":false}');
  const fromForm = readContactListFromForm(fd, "site.contact_phones");
  check("reads each row (order preserved)", fromForm.length === 2 && fromForm[0].value === "+216 1" && fromForm[1].footer === false);
  check("primary = first entry's value", (fromForm[0]?.value ?? "") === "+216 1");

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
