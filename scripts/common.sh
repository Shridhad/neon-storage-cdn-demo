# Shared by setup.sh and teardown.sh. Source it; do not execute it.
# shellcheck shell=bash

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BUCKET=cdn-demo
CRED_NAME=cdn-demo-worker
NEON_API=${NEON_API:-https://console.neon.tech/api/v2}

if [ -z "${NEON_API_KEY:-}" ] && [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi
for v in NEON_API_KEY NEON_PROJECT_ID CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  [ -n "${!v:-}" ] || { echo "$v is not set (see .env.example)" >&2; exit 1; }
done
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

WORKER_NAME=$(sed -n 's/^name *= *"\(.*\)"/\1/p' "$ROOT/wrangler.toml" | head -n1)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# api METHOD PATH [JSON_BODY]: prints the response body, returns non-zero on HTTP >= 400.
# Error bodies are printed to stderr; success bodies may hold secrets, so callers must not echo them.
api() {
  local method=$1 path=$2 body=${3:-} code
  local args=(-sS -X "$method" -o "$TMP/resp" -w '%{http_code}' -H "Authorization: Bearer $NEON_API_KEY")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  code=$(curl "${args[@]}" "$NEON_API$path") || return 1
  API_CODE=$code
  if [ "$code" -ge 400 ]; then
    echo "$method $path -> HTTP $code: $(jq -r '.message // empty' "$TMP/resp" 2>/dev/null)" >&2
    return 1
  fi
  cat "$TMP/resp"
  rm -f "$TMP/resp"
}

resolve_branch() {
  BRANCH_ID=$(api GET "/projects/$NEON_PROJECT_ID/branches" | jq -r '[.branches[] | select(.default)][0].id // empty')
  [ -n "$BRANCH_ID" ] || { echo "no default branch found" >&2; exit 1; }
  BP="/projects/$NEON_PROJECT_ID/branches/$BRANCH_ID"
}

# worker_origin: prints https://<worker>.<account subdomain>.workers.dev
worker_origin() {
  local sub
  sub=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" | jq -r '.result.subdomain // empty')
  [ -n "$sub" ] || { echo "No workers.dev subdomain on this account yet." >&2; return 1; }
  echo "https://$WORKER_NAME.$sub.workers.dev"
}

# set_var KEY VALUE: sets a string in wrangler.toml [vars], adding it if missing.
set_var() {
  local k=$1 v=$2
  if grep -q "^$k *=" "$ROOT/wrangler.toml"; then
    sed -i -E "s|^$k *=.*|$k = \"$v\"|" "$ROOT/wrangler.toml"
  else
    sed -i -E "/^\[vars\]/a $k = \"$v\"" "$ROOT/wrangler.toml"
  fi
}
