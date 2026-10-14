#!/usr/bin/env bash
# Verifies the Cloudflare Worker from content/docs/storage/cdn-cloudflare.md.
#
# Usage: website-cdn-tutorial-test.sh <origin-object-url> <worker-object-url>
#   origin-object-url  public object URL on the Neon storage endpoint
#                      https://<branch>.storage.<cell>.<region>.aws.neon.tech/<bucket>/<key>
#   worker-object-url  the same bucket/key through the Worker
#                      https://<worker>.<subdomain>.workers.dev/<bucket>/<key>
# The object should be at least 100 bytes and live in a public_read bucket.
# Requires only curl and sha256sum.
set -u

if [ $# -ne 2 ]; then
  sed -n '2,11p' "$0"
  exit 2
fi
ORIGIN_URL=$1
WORKER_URL=$2

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

ok()  { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1"; fail=$((fail + 1)); }

status_of()  { head -n1 "$1" | tr -d '\r' | awk '{print $2}'; }
header_of()  { grep -i "^$2:" "$1" | tail -n1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }

# 0. Reference copy straight from the origin.
code=$(curl -sS -o "$tmp/origin.bin" -w '%{http_code}' "$ORIGIN_URL")
if [ "$code" != 200 ]; then
  echo "Origin returned $code for $ORIGIN_URL; is the bucket public_read and the key correct?"
  exit 1
fi
want=$(sha256sum "$tmp/origin.bin" | cut -d' ' -f1)
size=$(wc -c < "$tmp/origin.bin")
if [ "$size" -lt 100 ]; then
  echo "Object is $size bytes; use one that is at least 100 bytes."
  exit 1
fi

# 1. Worker GET returns 200 and identical bytes.
curl -sS -D "$tmp/h1" -o "$tmp/w1.bin" "$WORKER_URL"
got=$(sha256sum "$tmp/w1.bin" | cut -d' ' -f1)
if [ "$(status_of "$tmp/h1")" = 200 ] && [ "$got" = "$want" ]; then
  ok "GET via Worker: 200, sha256 matches origin"
else
  bad "GET via Worker: status=$(status_of "$tmp/h1") sha256=$got (want $want)"
fi

# 2. Repeat GETs until the edge reports a HIT (HITs are per data center, so allow a few tries).
hit=""
for _ in 1 2 3 4 5; do
  sleep 1
  curl -sS -D "$tmp/h2" -o /dev/null "$WORKER_URL"
  hit=$(header_of "$tmp/h2" cf-cache-status)
  [ "$hit" = HIT ] && break
done
if [ "$hit" = HIT ]; then
  ok "repeat GET: cf-cache-status: HIT"
else
  bad "repeat GET: cf-cache-status: '${hit:-<missing>}' (want HIT). Cache-Control from origin: '$(header_of "$tmp/h1" cache-control)'"
fi

# 3. Range request returns 206 and exactly the requested bytes.
curl -sS -D "$tmp/h3" -o "$tmp/range.bin" -H 'Range: bytes=10-49' "$WORKER_URL"
tail -c +11 "$tmp/origin.bin" | head -c 40 > "$tmp/range.want"
if [ "$(status_of "$tmp/h3")" = 206 ] && cmp -s "$tmp/range.bin" "$tmp/range.want"; then
  ok "Range bytes=10-49: 206, 40 correct bytes (Content-Range: $(header_of "$tmp/h3" content-range))"
else
  bad "Range bytes=10-49: status=$(status_of "$tmp/h3") bytes=$(wc -c < "$tmp/range.bin") Content-Range='$(header_of "$tmp/h3" content-range)'"
fi

# 4. If-None-Match with the current ETag returns 304.
etag=$(header_of "$tmp/h1" etag)
if [ -z "$etag" ]; then
  bad "If-None-Match: no ETag header on the Worker response"
else
  code=$(curl -sS -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "$WORKER_URL")
  if [ "$code" = 304 ]; then ok "If-None-Match $etag: 304"; else bad "If-None-Match $etag: got $code (want 304)"; fi
fi

# 5. Writes are rejected.
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST --data 'x' "$WORKER_URL")
if [ "$code" = 405 ]; then ok "POST: 405"; else bad "POST: got $code (want 405)"; fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
