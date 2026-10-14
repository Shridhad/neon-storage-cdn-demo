#!/usr/bin/env bash
# End-to-end checks against the deployed demo.
# Usage: ./e2e.sh https://<name>.<subdomain>.workers.dev [bucket]
# Needs curl and jq. One run makes 3 /api/upload-url calls; the limiter allows 5 per minute per location,
# so wait a minute between back-to-back runs.
set -u

BASE=${1:?usage: e2e.sh <worker-url> [bucket]}
BASE=${BASE%/}
BUCKET=${2:-cdn-demo}
MAX=$((2 * 1024 * 1024))

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0
ok()  { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1"; fail=$((fail + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi; }
status_of() { head -n1 "$1" | tr -d '\r' | awk '{print $2}'; }
header_of() { grep -i "^$2:" "$1" | tail -n1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }

# upload_url TYPE SIZE: writes the response to $tmp/up.json and prints the HTTP status. Waits out a 429 once.
upload_url() {
  local code
  for _ in 1 2; do
    code=$(curl -sS -o "$tmp/up.json" -w '%{http_code}' -X POST "$BASE/api/upload-url" \
      -H 'Content-Type: application/json' -d "{\"contentType\":\"$1\",\"size\":$2}")
    [ "$code" = 429 ] || break
    echo "      rate limited, waiting 61s" >&2; sleep 61
  done
  echo "$code"
}

# post_form FILE TYPE [OVERRIDE_TYPE]: multipart POST of the policy in $tmp/up.json straight to storage.
post_form() {
  local args=() k v
  while IFS=$'\t' read -r k v; do
    [ "$k" = Content-Type ] && [ -n "${3:-}" ] && v=$3
    args+=(--form-string "$k=$v")
  done < <(jq -r '.fields | to_entries[] | [.key, .value] | @tsv' "$tmp/up.json")
  curl -sS -o "$tmp/post.out" -w '%{http_code}' "${args[@]}" -F "file=@$1;type=$2" "$(jq -r .url "$tmp/up.json")"
}

# 1. Gallery.
code=$(curl -sS -o "$tmp/index.html" -w '%{http_code}' "$BASE/")
check "GET / gallery" "$code" 200
grep -q 'deleted after 24h' "$tmp/index.html" && ok "gallery shows the demo notice" || bad "gallery is missing the demo notice"

# 2. Listing returns the samples, newest first.
curl -sS "$BASE/api/list" >"$tmp/list.json"
samples=$(jq '[.objects[] | select(.key | startswith("samples/"))] | length' "$tmp/list.json" 2>/dev/null || echo 0)
[ "${samples:-0}" -ge 1 ] && ok "GET /api/list returns $samples sample(s)" || bad "GET /api/list returned no samples"
sample=$(jq -r '[.objects[] | select(.key | startswith("samples/"))][0].key' "$tmp/list.json")

# 3. Upload through a presigned POST policy, then read it back through the CDN path.
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' | base64 -d >"$tmp/pixel.png"
check "POST /api/upload-url (image/png)" "$(upload_url image/png "$(wc -c <"$tmp/pixel.png")")" 200
key=$(jq -r .key "$tmp/up.json")
case "$key" in uploads/*.png) ok "server chose the key ($key)";; *) bad "unexpected key '$key'";; esac
code=$(post_form "$tmp/pixel.png" image/png)
case "$code" in 201|204) ok "multipart POST to storage ($code)";; *) bad "multipart POST to storage: $code $(head -c 200 "$tmp/post.out")";; esac

URL="$BASE/$BUCKET/$key"
curl -sS -D "$tmp/h1" -o "$tmp/got.png" "$URL"
check "GET uploaded object via proxy" "$(status_of "$tmp/h1")" 200
cmp -s "$tmp/got.png" "$tmp/pixel.png" && ok "bytes match the upload" || bad "bytes differ from the upload"
check "content-type" "$(header_of "$tmp/h1" content-type)" image/png
hit=""
for _ in 1 2 3 4 5; do
  sleep 1
  curl -sS -D "$tmp/h2" -o /dev/null "$URL"
  hit=$(header_of "$tmp/h2" cf-cache-status)
  [ "$hit" = HIT ] && break
done
check "second GET cf-cache-status" "$hit" HIT

# 4. Range and conditional requests on a sample (ones from setup.sh are a few KB).
SURL="$BASE/$BUCKET/$sample"
curl -sS -D "$tmp/h3" -o "$tmp/range.bin" -H 'Range: bytes=0-99' "$SURL"
check "Range bytes=0-99" "$(status_of "$tmp/h3")" 206
check "range length" "$(wc -c <"$tmp/range.bin" | tr -d ' ')" 100
curl -sS -D "$tmp/h4" -o /dev/null "$SURL"
etag=$(header_of "$tmp/h4" etag)
code=$(curl -sS -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "$SURL")
check "If-None-Match $etag" "$code" 304

# 5. Rejections.
check "oversize declared size is refused by the Worker" "$(upload_url image/png $((MAX + 1)))" 400
check "non-image type is refused by the Worker" "$(upload_url text/html 100)" 400

# Reuse one valid policy for direct-to-storage abuse attempts.
upload_url image/png 100 >/dev/null
head -c $((MAX + 1)) /dev/zero >"$tmp/big.png"
code=$(post_form "$tmp/big.png" image/png)
[ "$code" -ge 400 ] && ok "oversize body is refused by storage ($code)" || bad "oversize body accepted by storage ($code)"
printf '<script>1</script>' >"$tmp/x.html"
code=$(post_form "$tmp/x.html" text/html text/html)
[ "$code" -ge 400 ] && ok "non-image Content-Type is refused by storage ($code)" || bad "non-image Content-Type accepted by storage ($code)"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT --data x "$URL")
check "PUT through the proxy" "$code" 405

# 6. The proxy only serves the demo bucket.
for p in "/other-bucket/x.png" "//example.com/$BUCKET/x.png" "/$BUCKET/../other/x.png"; do
  code=$(curl -sS --path-as-is -o /dev/null -w '%{http_code}' "$BASE$p")
  case "$code" in 403|404) ok "GET $p blocked ($code)";; *) bad "GET $p returned $code";; esac
done

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
