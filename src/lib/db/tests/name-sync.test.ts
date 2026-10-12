/**
 * decideNameSync — the PURE gate for the profile→users.name mirror. Locks the
 * conditions under which an edited customer name rewrites the linked users.name
 * (the Utilisateurs list reads users.name; without this it goes stale). No DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/name-sync.test.ts
 */
import { decideNameSync } from "@/lib/users/name-sync";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

const base = {
  userId: "user-1",
  firstName: "Aymen",
  lastName: "Trabelsi",
  currentName: "Old Name",
};

function main() {
  // No name field in the change set → skip (a phone/optin edit must not touch name).
  check(
    "['phone'] → skip",
    decideNameSync({ ...base, changedFields: ["phone"] }).action === "skip",
  );
  check(
    "['marketing_opt_in'] → skip",
    decideNameSync({ ...base, changedFields: ["marketing_opt_in"] }).action === "skip",
  );

  // Name changed but no linked user → skip (guest/unlinked profile).
  check(
    "first_name changed + empty userId → skip",
    decideNameSync({ ...base, userId: "", changedFields: ["first_name"] }).action === "skip",
  );
  check(
    "first_name changed + null userId → skip",
    decideNameSync({ ...base, userId: null, changedFields: ["first_name"] }).action === "skip",
  );

  // Name changed + linked user + actually different → update with composed name.
  const upd = decideNameSync({ ...base, changedFields: ["first_name", "last_name"] });
  check("name changed + different → update", upd.action === "update");
  check(
    "composed name is 'First Last'",
    upd.action === "update" && upd.name === "Aymen Trabelsi",
  );

  // Idempotent: composed name equals the current users.name → skip (no write).
  check(
    "name changed but equals current → skip",
    decideNameSync({
      ...base,
      currentName: "Aymen Trabelsi",
      changedFields: ["last_name"],
    }).action === "skip",
  );

  // One-name customer (blank last) → trimmed to "First", never "First ".
  const oneName = decideNameSync({
    ...base,
    lastName: "",
    changedFields: ["last_name"],
  });
  check("blank last name → trimmed 'First'", oneName.action === "update" && oneName.name === "Aymen");

  // Fully blank name → skip (never wipe the NOT NULL users.name).
  check(
    "both names blank → skip (never blanks users.name)",
    decideNameSync({
      ...base,
      firstName: "",
      lastName: "",
      changedFields: ["first_name", "last_name"],
    }).action === "skip",
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
