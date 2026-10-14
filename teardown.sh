#!/usr/bin/env bash
# Removes everything setup.sh created: the Worker, the bucket objects and the bucket.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/scripts/common.sh"
cd "$ROOT"
resolve_branch

echo "deleting Worker $WORKER_NAME"
npx wrangler delete --force || echo "    (Worker already gone)"

echo "deleting objects in $BUCKET"
api DELETE "$BP/buckets/$BUCKET/objects-by-prefix?prefix=samples/" | jq -r '"    \(.deleted) deleted"' || true

echo "deleting bucket $BUCKET"
api DELETE "$BP/buckets/$BUCKET" >/dev/null || echo "    (bucket missing or not empty)"
