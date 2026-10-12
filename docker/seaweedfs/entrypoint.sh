#!/bin/sh
# SeaweedFS S3 gateway entrypoint.
#
# Renders the S3 identities config from ENV at container start (so the
# access/secret keys can come from Coolify's generated SERVICE_* secrets and
# never have to be committed), then starts a single-node SeaweedFS
# (master + volume + filer + S3 gateway) with that config.
#
# Two identities:
#   - "app"        : the access/secret key the Next app uses for PUT/DELETE
#                    (SigV4, path-style). Admin so it can create the bucket.
#   - "anonymous"  : UNAUTHENTICATED read on the one bucket, so the same-origin
#                    `/cdn/[...path]` proxy (which fetches the object without
#                    signing) works — mirrors the old MinIO anonymous
#                    GetObject-only policy. No public LIST/WRITE.
set -eu

CONFIG_DIR="${SEAWEED_CONFIG_DIR:-/etc/seaweedfs}"
CONFIG_FILE="${CONFIG_DIR}/s3.json"
DATA_DIR="${SEAWEED_DATA_DIR:-/data}"
S3_PORT="${SEAWEED_S3_PORT:-8333}"
VOLUME_LIMIT_MB="${SEAWEED_VOLUME_SIZE_LIMIT_MB:-1024}"

: "${S3_BUCKET:=tokyo}"
if [ -z "${S3_ACCESS_KEY:-}" ] || [ -z "${S3_SECRET_KEY:-}" ]; then
  echo "[seaweedfs] S3_ACCESS_KEY and S3_SECRET_KEY must be set" >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR" "$DATA_DIR"

# Written fresh every boot from ENV (static config file — the reliable path;
# runtime `s3.configure` has known bugs with anonymous identities + does not
# survive an S3-gateway restart).
cat > "$CONFIG_FILE" <<JSON
{
  "identities": [
    {
      "name": "app",
      "credentials": [
        { "accessKey": "${S3_ACCESS_KEY}", "secretKey": "${S3_SECRET_KEY}" }
      ],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    },
    {
      "name": "anonymous",
      "actions": ["Read:${S3_BUCKET}"]
    }
  ]
}
JSON

echo "[seaweedfs] wrote ${CONFIG_FILE} (anonymous Read:${S3_BUCKET}); starting gateway on :${S3_PORT}"

exec weed server \
  -dir="$DATA_DIR" \
  -master.volumeSizeLimitMB="$VOLUME_LIMIT_MB" \
  -volume.max="${SEAWEED_VOLUME_MAX:-100}" \
  -s3 \
  -s3.port="$S3_PORT" \
  -s3.config="$CONFIG_FILE"
