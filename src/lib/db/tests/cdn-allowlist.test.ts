/**
 * PURE build-time media host allow-list — NO database, NO network.
 *
 * Guards src/modules/media/cdn-allowlist.ts and the gate in cdn-base.ts. The
 * served CSP + next/image remotePatterns are COMPILED from the build's
 * S3_PUBLIC_URL / MEDIA_CDN_URL; a CDN base (admin `cdn_base_url` or runtime
 * MEDIA_CDN_URL) outside that baked list broke every storefront image. Pins:
 *   - host + bucket-prefix matching (mirrors the settings-workflow guard);
 *   - the BUILD_* snapshot (next.config `env`) wins over the runtime env, even
 *     when it is empty; without it (tsx) the runtime env is used;
 *   - getCdnBaseSync() drops a runtime MEDIA_CDN_URL the build never saw
 *     (→ same-origin /cdn proxy) and keeps one it did.
 *
 * cdn-base.ts transitively imports the DB client, whose pool is built at import
 * (no connection is opened) — a dummy DATABASE_URL + secret satisfy the lazy
 * env validator, and it is imported dynamically AFTER they are set.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/cdn-allowlist.test.ts
 */
import {
  bakedMediaHostEntries,
  bakedMediaHostSources,
  describeMediaHostEntry,
  isCdnBaseAllowed,
  parseMediaHostEntries,
} from "@/modules/media/cdn-allowlist";

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

const KEYS = ["BUILD_S3_PUBLIC_URL", "BUILD_MEDIA_CDN_URL", "S3_PUBLIC_URL", "MEDIA_CDN_URL"] as const;
type Key = (typeof KEYS)[number];

function withEnv(vars: Partial<Record<Key, string | undefined>>, fn: () => void) {
  const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) {
    const v = vars[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of KEYS) {
      const v = prev[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function main() {
  console.log("isCdnBaseAllowed — host AND path prefix:");
  const entries = parseMediaHostEntries([
    "https://minio.example.com/tokyo",
    " https://CDN.example.com/ ",
    "not a url",
  ]);
  check("malformed source skipped, others parsed", entries.length === 2);
  check("trailing slash normalised (bare origin → empty prefix)", entries[1]?.prefix === "");
  check("host lowercased", entries[1]?.host === "cdn.example.com");
  check("S3 base with bucket → allowed", isCdnBaseAllowed("https://minio.example.com/tokyo", entries));
  check("S3 base with bucket + trailing slash → allowed", isCdnBaseAllowed("https://minio.example.com/tokyo/", entries));
  check("S3 sub-path under the bucket → allowed", isCdnBaseAllowed("https://minio.example.com/tokyo/media", entries));
  check("S3 host WITHOUT the bucket → refused (404s every image)", !isCdnBaseAllowed("https://minio.example.com", entries));
  check("bucket-name prefix trick → refused", !isCdnBaseAllowed("https://minio.example.com/tokyox", entries));
  check("bare CDN origin allows any path", isCdnBaseAllowed("https://cdn.example.com/assets/v2", entries));
  check("host compare is case-insensitive", isCdnBaseAllowed("https://Cdn.Example.com", entries));
  check("look-alike host → refused", !isCdnBaseAllowed("https://cdn.example.com.evil.tld", entries));
  check("unknown host → refused", !isCdnBaseAllowed("https://other.example.com", entries));
  check("unparseable base → refused", !isCdnBaseAllowed("cdn.example.com", entries));
  check("empty allow-list refuses everything", !isCdnBaseAllowed("https://cdn.example.com", []));
  check("describe → host + prefix", describeMediaHostEntry({ protocol: "https:", host: "m.x", prefix: "/tokyo" }) === "m.x/tokyo");

  console.log("isCdnBaseAllowed — SCHEME + port are pinned (next/image + CSP pin them):");
  check("http base on an https-baked host → refused (next/image 400 + CSP block)", !isCdnBaseAllowed("http://minio.example.com/tokyo", entries));
  check("http base on an https bare-origin host → refused", !isCdnBaseAllowed("http://cdn.example.com/assets", entries));
  {
    const httpEntries = parseMediaHostEntries(["http://plainhost.local/x"]);
    check("scheme parsed onto the entry", httpEntries[0]?.protocol === "http:");
    check("matching http base → allowed", isCdnBaseAllowed("http://plainhost.local/x", httpEntries));
    check("https base on an http-baked host → refused", !isCdnBaseAllowed("https://plainhost.local/x", httpEntries));
  }
  {
    const portEntries = parseMediaHostEntries(["http://localhost:9100/tokyo"]);
    check("host carries the port", portEntries[0]?.host === "localhost:9100");
    check("same host:port → allowed", isCdnBaseAllowed("http://localhost:9100/tokyo", portEntries));
    check("same host, missing port → refused", !isCdnBaseAllowed("http://localhost/tokyo", portEntries));
  }

  console.log("bakedMediaHostSources — the BUILD snapshot wins over the runtime env:");
  withEnv(
    { S3_PUBLIC_URL: "https://minio.example.com/tokyo", MEDIA_CDN_URL: "https://cdn.a.com, https://cdn.b.com" },
    () => {
      const s = bakedMediaHostSources();
      check(
        "no BUILD_* (tsx / scripts) → runtime S3 + every MEDIA_CDN_URL entry",
        JSON.stringify(s) === JSON.stringify(["https://minio.example.com/tokyo", "https://cdn.a.com", "https://cdn.b.com"]),
      );
    },
  );
  withEnv(
    {
      BUILD_S3_PUBLIC_URL: "https://minio.example.com/tokyo",
      BUILD_MEDIA_CDN_URL: "",
      S3_PUBLIC_URL: "https://minio.example.com/tokyo",
      MEDIA_CDN_URL: "https://cdn.new.com",
    },
    () => {
      const s = bakedMediaHostSources();
      check(
        "BUILD_MEDIA_CDN_URL='' (built without the CDN arg) → runtime MEDIA_CDN_URL NOT trusted",
        JSON.stringify(s) === JSON.stringify(["https://minio.example.com/tokyo"]),
      );
      check("…so the runtime CDN host is outside the baked list", !isCdnBaseAllowed("https://cdn.new.com", bakedMediaHostEntries()));
    },
  );
  withEnv({ BUILD_S3_PUBLIC_URL: "https://minio.example.com/tokyo", BUILD_MEDIA_CDN_URL: "https://cdn.new.com" }, () => {
    check("CDN baked at build → allowed", isCdnBaseAllowed("https://cdn.new.com", bakedMediaHostEntries()));
  });
  withEnv({ BUILD_S3_PUBLIC_URL: "https://minio.example.com/tokyo", BUILD_MEDIA_CDN_URL: "" }, () => {
    check("memo re-keys when the sources change", !isCdnBaseAllowed("https://cdn.new.com", bakedMediaHostEntries()));
  });

  console.log("getCdnBaseSync — runtime MEDIA_CDN_URL gated by the build list:");
  process.env.BETTER_AUTH_SECRET =
    process.env.BETTER_AUTH_SECRET ?? "test_cdn_allowlist_secret_at_least_32_chars_long_0";
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://x:x@localhost:5432/x";
  const { getCdnBaseSync } = await import("@/modules/media/cdn-base");
  withEnv({ S3_PUBLIC_URL: "https://minio.example.com/tokyo", MEDIA_CDN_URL: "https://cdn.new.com/" }, () => {
    check("no BUILD_* → runtime value used (trailing slash stripped)", getCdnBaseSync() === "https://cdn.new.com");
  });
  withEnv(
    { BUILD_S3_PUBLIC_URL: "https://minio.example.com/tokyo", BUILD_MEDIA_CDN_URL: "", MEDIA_CDN_URL: "https://cdn.new.com" },
    () => {
      check("host the build never saw → '' (same-origin /cdn proxy, images keep working)", getCdnBaseSync() === "");
    },
  );
  withEnv(
    {
      BUILD_S3_PUBLIC_URL: "https://minio.example.com/tokyo",
      BUILD_MEDIA_CDN_URL: "https://cdn.new.com",
      MEDIA_CDN_URL: "https://cdn.new.com",
    },
    () => {
      check("host baked at build → used", getCdnBaseSync() === "https://cdn.new.com");
    },
  );
  withEnv({ BUILD_S3_PUBLIC_URL: "https://minio.example.com/tokyo", BUILD_MEDIA_CDN_URL: "" }, () => {
    check("no MEDIA_CDN_URL at all → ''", getCdnBaseSync() === "");
  });

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
