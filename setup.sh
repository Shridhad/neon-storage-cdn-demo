#!/usr/bin/env bash
# Provisions the Neon side (bucket, credential, CORS, samples) and pushes the credential to the Worker.
# Needs NEON_API_KEY, NEON_PROJECT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (from .env), plus curl, jq, node, python3.
# Safe to re-run: it replaces the credential and overwrites the samples.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/scripts/common.sh"
cd "$ROOT"

echo "1/6 resolving default branch and storage endpoint"
resolve_branch
storage=$(api GET "$BP/storage")
S3_ENDPOINT=$(jq -r '.s3_endpoint' <<<"$storage")
S3_REGION=$(jq -r '.region' <<<"$storage")
echo "    branch $BRANCH_ID, endpoint $S3_ENDPOINT, region $S3_REGION"
sed -i -E "s|^NEON_STORAGE_ORIGIN *=.*|NEON_STORAGE_ORIGIN = \"$S3_ENDPOINT\"|; s|^REGION *=.*|REGION = \"$S3_REGION\"|" wrangler.toml

SUBDOMAIN=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" | jq -r '.result.subdomain // empty')
[ -n "$SUBDOMAIN" ] || { echo "No workers.dev subdomain on this account yet. Open Workers & Pages in the Cloudflare dashboard once to create it, then re-run." >&2; exit 1; }
WORKER_ORIGIN="https://$WORKER_NAME.$SUBDOMAIN.workers.dev"

echo "2/6 creating public_read bucket $BUCKET"
if api POST "$BP/buckets" "{\"name\":\"$BUCKET\",\"access_level\":\"public_read\"}" >/dev/null 2>"$TMP/err"; then
  echo "    created"
elif api GET "$BP/buckets" | jq -e --arg b "$BUCKET" '.buckets[] | select(.name == $b)' >/dev/null 2>&1; then
  echo "    already exists (access level unchanged; delete it first if it is not public_read)"
else
  cat "$TMP/err" >&2; exit 1
fi

echo "3/6 issuing a storage:read + storage:write credential"
old=$(api GET "$BP/credentials" | jq -r --arg n "$CRED_NAME" '.credentials[] | select(.name == $n and (.revoked_at | not)) | .token_id')
for id in $old; do api DELETE "$BP/credentials/$id" >/dev/null && echo "    revoked previous credential ${id:0:16}..."; done
cred=$(api POST "$BP/credentials" "{\"name\":\"$CRED_NAME\",\"scopes\":[\"storage:read\",\"storage:write\"],\"principal_type\":\"user\"}")
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY S3_ENDPOINT S3_REGION BUCKET
AWS_ACCESS_KEY_ID=$(jq -r '.token_id' <<<"$cred")
AWS_SECRET_ACCESS_KEY=$(jq -r '.s3_secret_access_key' <<<"$cred")
unset cred
echo "    issued ${AWS_ACCESS_KEY_ID:0:16}..."

echo "4/6 allowing browser POST from $WORKER_ORIGIN"
node scripts/s3.mjs cors "$WORKER_ORIGIN"

echo "5/6 uploading sample images"
mkdir "$TMP/samples"
python3 -I scripts/gen_samples.py "$TMP/samples"
for f in "$TMP"/samples/*.png; do node scripts/s3.mjs put "samples/$(basename "$f")" "$f" image/png; done

echo "6/6 deploying the Worker and storing the credential as secrets"
# Deploying first lets `wrangler secret put` target an existing Worker without an interactive prompt.
npx wrangler deploy >/dev/null
printf '%s' "$AWS_ACCESS_KEY_ID" | npx wrangler secret put NEON_STORAGE_ACCESS_KEY_ID >/dev/null
printf '%s' "$AWS_SECRET_ACCESS_KEY" | npx wrangler secret put NEON_STORAGE_SECRET_ACCESS_KEY >/dev/null

echo
echo "Done. Worker: $WORKER_ORIGIN"
echo "Next: npx wrangler deploy && ./e2e.sh $WORKER_ORIGIN"
