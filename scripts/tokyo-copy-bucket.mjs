/**
 * One-off: copy every object from the old "tokyo" S3 bucket into a new "tokyo"
 * bucket on the local SeaweedFS, so the infra rebrand keeps the uploaded /cdn
 * media without a re-import. SeaweedFS forbids bucket rename and cross-collection
 * moves, so we copy via the S3 API (server-side CopyObject). Run with the dev
 * stack UP.  node scripts/tokyo-copy-bucket.mjs
 */
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";

const SRC = "tokyo";
const DST = "tokyo";
const s3 = new S3Client({
  region: "us-east-1",
  endpoint: "http://localhost:8333",
  forcePathStyle: true,
  credentials: { accessKeyId: "seaweedfs", secretAccessKey: "seaweedfs_dev_secret" },
});

const chunk = (arr, n) => arr.reduce((a, _, i) => (i % n ? a : [...a, arr.slice(i, i + n)]), []);

async function main() {
  await s3.send(new CreateBucketCommand({ Bucket: DST })).catch(() => {});
  let token;
  let copied = 0;
  let failed = 0;
  const errors = [];
  do {
    const r = await s3.send(
      new ListObjectsV2Command({ Bucket: SRC, ContinuationToken: token, MaxKeys: 1000 }),
    );
    const objs = r.Contents ?? [];
    for (const batch of chunk(objs, 24)) {
      await Promise.all(
        batch.map(async (o) => {
          try {
            const got = await s3.send(new GetObjectCommand({ Bucket: SRC, Key: o.Key }));
            const bytes = await got.Body.transformToByteArray();
            await s3.send(
              new PutObjectCommand({
                Bucket: DST,
                Key: o.Key,
                Body: bytes,
                ContentType: got.ContentType,
              }),
            );
            copied++;
          } catch (e) {
            failed++;
            if (errors.length < 5) errors.push(`${o.Key}: ${e.name || e.message}`);
          }
        }),
      );
      process.stdout.write(`\rcopied ${copied}  failed ${failed}`);
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  process.stdout.write("\n");
  if (errors.length) console.log("sample errors:", errors);
  console.log(`DONE: copied ${copied}, failed ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => {
  console.error("fatal:", e);
  process.exit(2);
});
