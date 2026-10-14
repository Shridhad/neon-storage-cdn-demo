#!/usr/bin/env bash
# Removes everything setup.sh created: the Worker, all bucket objects, the bucket and the credential.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/scripts/common.sh"
cd "$ROOT"
resolve_branch

echo "deleting Worker $WORKER_NAME"
npx wrangler delete --force || echo "    (Worker already gone)"

echo "deleting objects in $BUCKET"
for prefix in uploads/ samples/; do
  api DELETE "$BP/buckets/$BUCKET/objects-by-prefix?prefix=$prefix" | jq -r --arg p "$prefix" '"    \($p): \(.deleted) deleted"' || true
done

echo "deleting bucket $BUCKET"
api DELETE "$BP/buckets/$BUCKET" >/dev/null || echo "    (bucket missing or not empty)"

echo "revoking credential $CRED_NAME"
for id in $(api GET "$BP/credentials" | jq -r --arg n "$CRED_NAME" '.credentials[] | select(.name == $n and (.revoked_at | not)) | .token_id'); do
  api DELETE "$BP/credentials/$id" >/dev/null && echo "    revoked ${id:0:16}..."
done
