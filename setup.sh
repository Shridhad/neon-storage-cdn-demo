#!/usr/bin/env bash
# Provisions the Neon side (public_read bucket + sample images) and deploys the Worker.
# Needs NEON_API_KEY, NEON_PROJECT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (from .env), plus curl, jq, node, python3.
# Safe to re-run. The Worker holds no storage credential; a short-lived one is issued only to upload the samples
# and is revoked when the script exits.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/scripts/common.sh"
cd "$ROOT"

echo "1/4 resolving default branch and storage endpoint"
resolve_branch
storage=$(api GET "$BP/storage")
S3_ENDPOINT=$(jq -r '.s3_endpoint' <<<"$storage")
S3_REGION=$(jq -r '.region' <<<"$storage")
echo "    branch $BRANCH_ID, endpoint $S3_ENDPOINT, region $S3_REGION"
sed -i -E "s|^NEON_STORAGE_ORIGIN *=.*|NEON_STORAGE_ORIGIN = \"$S3_ENDPOINT\"|" wrangler.toml

echo "2/4 creating public_read bucket $BUCKET"
if api POST "$BP/buckets" "{\"name\":\"$BUCKET\",\"access_level\":\"public_read\"}" >/dev/null 2>"$TMP/err"; then
  echo "    created"
elif api GET "$BP/buckets" | jq -e --arg b "$BUCKET" '.buckets[] | select(.name == $b)' >/dev/null 2>&1; then
  echo "    already exists (access level unchanged; delete it first if it is not public_read)"
else
  cat "$TMP/err" >&2; exit 1
fi

echo "3/4 uploading sample images with a temporary credential"
cred=$(api POST "$BP/credentials" "{\"name\":\"$CRED_NAME\",\"scopes\":[\"storage:write\"],\"principal_type\":\"user\"}")
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY S3_ENDPOINT S3_REGION BUCKET
AWS_ACCESS_KEY_ID=$(jq -r '.token_id' <<<"$cred")
AWS_SECRET_ACCESS_KEY=$(jq -r '.s3_secret_access_key' <<<"$cred")
unset cred
trap 'api DELETE "$BP/credentials/$AWS_ACCESS_KEY_ID" >/dev/null || true; rm -rf "$TMP"' EXIT
mkdir "$TMP/samples"
python3 -I scripts/gen_samples.py "$TMP/samples"
for f in "$TMP"/samples/*.png; do node scripts/s3.mjs put "samples/$(basename "$f")" "$f" image/png; done

echo "4/4 deploying the Worker"
npx wrangler deploy

echo
echo "Done. Worker: $(worker_origin)"
echo "Next: ./e2e.sh <that URL>"
