#!/usr/bin/env bash
# Enables Neon Auth on the default branch, trusts the Worker origin, and writes the auth settings to wrangler.toml [vars].
# Needs NEON_API_KEY, NEON_PROJECT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (from .env), plus curl and jq.
# Idempotent: re-running changes nothing once Neon Auth is enabled and the origin is trusted.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/scripts/common.sh"
cd "$ROOT"

echo "1/3 enabling Neon Auth (better_auth)"
resolve_branch
if auth=$(api GET "$BP/auth" 2>/dev/null); then
  echo "    already enabled on $BRANCH_ID"
else
  auth=$(api POST "$BP/auth" '{"auth_provider":"better_auth"}')
  echo "    enabled on $BRANCH_ID"
fi
AUTH_URL=$(jq -r '.base_url // empty' <<<"$auth")
JWKS_URL=$(jq -r '.jwks_url // empty' <<<"$auth")
unset auth
[ -n "$AUTH_URL" ] && [ -n "$JWKS_URL" ] || { echo "Neon Auth did not return base_url and jwks_url" >&2; exit 1; }
echo "    auth url $AUTH_URL"

WORKER_ORIGIN=$(worker_origin)
echo "2/3 trusting $WORKER_ORIGIN"
if api GET "$BP/auth/domains" | jq -e --arg d "$WORKER_ORIGIN" '.domains[] | select(.domain == $d)' >/dev/null; then
  echo "    already trusted"
else
  api POST "$BP/auth/domains" "{\"domain\":\"$WORKER_ORIGIN\",\"auth_provider\":\"better_auth\"}" >/dev/null
  echo "    added"
fi

echo "3/3 writing wrangler.toml [vars]"
# The jwt plugin signs iss = aud = the origin of the auth URL (no /<db>/auth path), checked against a live token.
AUTH_ORIGIN=$(jq -rn --arg u "$AUTH_URL" '$u | capture("^(?<o>https?://[^/]+)").o')
set_var NEON_AUTH_AUDIENCE "$AUTH_ORIGIN"
set_var NEON_AUTH_ISSUER "$AUTH_ORIGIN"
set_var NEON_AUTH_JWKS_URL "$JWKS_URL"
set_var NEON_AUTH_URL "$AUTH_URL"

echo
echo "Done. Next: npx wrangler deploy && ./e2e.sh $WORKER_ORIGIN"
