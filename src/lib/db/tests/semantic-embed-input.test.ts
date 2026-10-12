/**
 * PURE embedding-input construction (embed-input.ts) — the string we embed per
 * product and its change-detection fingerprint (which gates re-embedding, so it
 * governs both cost and freshness). No DB / no network.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/semantic-embed-input.test.ts
 */
import {
  buildEmbeddingInput,
  hashEmbeddingInput,
  embeddingHashPrefix,
  EMBEDDING_INPUT_VERSION,
} from "@/modules/search/embed-input";

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
  console.log("buildEmbeddingInput — composition:");
  const full = buildEmbeddingInput({
    name: "Montre de plongée automatique",
    brandName: "Seiko",
    categoryNames: ["Montres", "Plongée"],
    shortDesc: "Une montre robuste et étanche.",
  });
  check("name is first", full.startsWith("Montre de plongée automatique"));
  check("brand line present", full.includes("Marque : Seiko"));
  check("category line present + joined", full.includes("Catégorie : Montres, Plongée"));
  check("short description present", full.includes("Une montre robuste et étanche."));

  console.log("buildEmbeddingInput — caractéristiques (attributes) + full description:");
  const enriched = buildEmbeddingInput({
    name: "Montre",
    attributes: ["Mouvement : Automatique", "Matière : Acier", "Mouvement : Automatique"],
    description: "Une longue description marketing riche en détails.",
  });
  check(
    "caractéristiques line present + deduped (insertion order preserved)",
    enriched.includes("Caractéristiques : Mouvement : Automatique, Matière : Acier"),
  );
  check("full description present", enriched.includes("Une longue description marketing"));
  check(
    "description sub-capped to 800 chars",
    (() => {
      const out = buildEmbeddingInput({ name: "N", description: "z".repeat(5000) });
      // The description part is capped at 800 even though the total cap is higher.
      return !out.includes("z".repeat(801));
    })(),
  );
  check(
    "full description omitted when identical to short desc (no duplication)",
    buildEmbeddingInput({ name: "N", shortDesc: "same text", description: "same text" }) === "N\nsame text",
  );

  console.log("buildEmbeddingInput — omission + hygiene:");
  const nameOnly = buildEmbeddingInput({ name: "SKX007" });
  check("name-only omits brand/category/desc lines", nameOnly === "SKX007");
  check(
    "blank fields omitted (no dangling labels)",
    buildEmbeddingInput({ name: "X", brandName: "  ", shortDesc: null, categoryNames: [null, ""] }) === "X",
  );
  check("whitespace collapsed", buildEmbeddingInput({ name: "  A   B  " }) === "A B");
  check(
    "duplicate category labels deduped",
    buildEmbeddingInput({ name: "X", categoryNames: ["Montres", "Montres", "Montres "] }) ===
      "X\nCatégorie : Montres",
  );
  check(
    "input is capped (very long text truncated)",
    buildEmbeddingInput({ name: "N", shortDesc: "a".repeat(5000) }).length <= 3000,
  );

  console.log("hashEmbeddingInput — fingerprint semantics (governs re-embed cost + freshness):");
  const model = "text-embedding-3-small";
  const inA = buildEmbeddingInput({ name: "Alpha" });
  const inB = buildEmbeddingInput({ name: "Beta" });
  check("stable: same input+model → same hash", hashEmbeddingInput(inA, model) === hashEmbeddingInput(inA, model));
  check("text change → different hash", hashEmbeddingInput(inA, model) !== hashEmbeddingInput(inB, model));
  check(
    "model change → different hash (forces re-embed)",
    hashEmbeddingInput(inA, model) !== hashEmbeddingInput(inA, "text-embedding-3-large"),
  );
  check(
    "hash is prefixed with the model + '|' (SQL LIKE anchor)",
    hashEmbeddingInput(inA, model).startsWith(`${model}|`),
  );
  check(
    "embeddingHashPrefix == '<model>|<version>|'",
    embeddingHashPrefix(model) === `text-embedding-3-small|${EMBEDDING_INPUT_VERSION}|`,
  );
  check(
    "prefix carries the input version so a schema bump re-selects every product",
    embeddingHashPrefix(model).includes(`|${EMBEDDING_INPUT_VERSION}|`),
  );
  check(
    "prefix strips '|' from the model so the delimiter is unambiguous",
    embeddingHashPrefix("weird|model") === `weirdmodel|${EMBEDDING_INPUT_VERSION}|`,
  );
  check(
    "the stored hash's prefix matches embeddingHashPrefix (backfill LIKE test holds)",
    hashEmbeddingInput(inA, model).startsWith(embeddingHashPrefix(model)),
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
