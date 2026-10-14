#!/usr/bin/env bash
# End-to-end checks against the deployed demo.
# Usage: ./e2e.sh https://<name>.<subdomain>.workers.dev [bucket]
# Needs curl, jq and sha256sum. Origin comparison uses the storage origin from wrangler.toml.
set -u

BASE=${1:?usage: e2e.sh <worker-url> [bucket]}
BASE=${BASE%/}
BUCKET=${2:-cdn-demo}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ORIGIN=$(sed -n 's/^NEON_STORAGE_ORIGIN *= *"\(.*\)"/\1/p' "$ROOT/wrangler.toml")

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0
ok()  { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1"; fail=$((fail + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi; }
status_of() { head -n1 "$1" | tr -d '\r' | awk '{print $2}'; }
header_of() { grep -i "^$2:" "$1" | tail -n1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }

# 1. Gallery lists the six samples.
code=$(curl -sS -o "$tmp/index.html" -w '%{http_code}' "$BASE/")
check "GET / gallery" "$code" 200
n=$(grep -o 'samples/sample-[0-9]\.png' "$tmp/index.html" | sort -u | wc -l | tr -d ' ')
check "gallery references 6 sample images" "$n" 6

# 2. Each sample matches the origin byte for byte.
for i in 1 2 3 4 5 6; do
  key="samples/sample-$i.png"
  curl -sS -o "$tmp/w.bin" -w '%{http_code}' "$BASE/$BUCKET/$key" >"$tmp/code"
  curl -sS -o "$tmp/o.bin" "$ORIGIN/$BUCKET/$key"
  check "GET $key" "$(cat "$tmp/code")" 200
  [ "$(sha256sum <"$tmp/w.bin")" = "$(sha256sum <"$tmp/o.bin")" ] && ok "$key sha256 matches the origin" || bad "$key differs from the origin"
done

# 3. A repeat request is served from the edge cache.
URL="$BASE/$BUCKET/samples/sample-1.png"
hit=""
for _ in 1 2 3 4 5; do
  sleep 1
  curl -sS -D "$tmp/h2" -o /dev/null "$URL"
  hit=$(header_of "$tmp/h2" cf-cache-status)
  [ "$hit" = HIT ] && break
done
check "repeat GET cf-cache-status" "$hit" HIT

# 4. Range and conditional requests.
curl -sS -D "$tmp/h3" -o "$tmp/range.bin" -H 'Range: bytes=0-99' "$URL"
check "Range bytes=0-99" "$(status_of "$tmp/h3")" 206
check "range length" "$(wc -c <"$tmp/range.bin" | tr -d ' ')" 100
curl -sS -D "$tmp/h4" -o /dev/null "$URL"
etag=$(header_of "$tmp/h4" etag)
check "If-None-Match $etag" "$(curl -sS -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "$URL")" 304
check "nosniff header" "$(header_of "$tmp/h4" x-content-type-options)" nosniff

# 5. Guards.
check "POST through the proxy" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST --data x "$URL")" 405
for p in "/other-bucket/x.png" "/$BUCKET/../other/x.png"; do
  code=$(curl -sS --path-as-is -o /dev/null -w '%{http_code}' "$BASE$p")
  case "$code" in 403|404) ok "GET $p blocked ($code)";; *) bad "GET $p returned $code";; esac
done
# //evil.com/x must not reach evil.com: the Worker answers 403 itself (not under the bucket).
check "GET //evil.com/x stays on the Worker" "$(curl -sS --path-as-is -o /dev/null -w '%{http_code}' "$BASE//evil.com/x")" 403

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
