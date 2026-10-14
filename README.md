# Neon Object Storage image gallery behind a Cloudflare Worker

**Live demo: https://neon-storage-cdn-demo.shridhar-deshmukh3.workers.dev**

A one-Worker demo of the proxy from the ["Serve objects through a CDN (Cloudflare)"](https://github.com/neondatabase/website/pull/6133) guide (`content/docs/storage/cdn-cloudflare.md`). It shows six sample images from a `public_read` Neon Object Storage bucket, served through a Worker that caches them at Cloudflare's edge. There are no uploads and no sign-in.

```
 browser ── GET /cdn-demo/<key> ──►  Worker  ── fetch + cf.cacheEverything ──►  Neon Object Storage
                                       │                                        (public_read bucket)
                                       └── repeat requests answered from Cloudflare's cache
```

| Route | What it does |
| --- | --- |
| `GET /` | Gallery page. Each tile shows the `cf-cache-status` (MISS, then HIT on reload) and load time. The image list is a static manifest in `src/samples.js`. |
| `GET\|HEAD /cdn-demo/<key>` | The guide's cached proxy, restricted to the demo bucket. |

`src/proxy.js` is the guide's Worker: the upstream is built by string concatenation onto the fixed origin (a `//host` path can't replace it), only `Range`, `If-None-Match` and `If-Modified-Since` are forwarded, the query string is dropped, `x-amz-*` response headers are stripped, and `X-Content-Type-Options: nosniff` is added. It also rejects any path outside the demo bucket. The Worker holds no credentials.

## Setup, deploy, teardown

Requirements: Node 20+, `curl`, `jq`, `python3`, a Neon project with Object Storage, a Cloudflare account with a workers.dev subdomain.

```bash
cp .env.example .env     # fill in the four values; the Cloudflare token needs "Edit Cloudflare Workers"
npm install
set -a; . ./.env; set +a
./setup.sh               # bucket, sample images (temporary credential, revoked on exit), wrangler deploy
./e2e.sh https://neon-storage-cdn-demo.<subdomain>.workers.dev
```

`setup.sh` writes `NEON_STORAGE_ORIGIN` into `wrangler.toml`. Sample uploads go through the S3 API (`PutObject`, with `Cache-Control: public, max-age=31536000, immutable`), which has no management-API equivalent, so the script issues a short-lived storage credential for that and revokes it on exit.

Teardown:

```bash
set -a; . ./.env; set +a
./teardown.sh     # deletes the Worker, the sample objects and the bucket
```

## Tests

```bash
npm test          # vitest: proxy guards (405, //host, headers, other buckets) and the gallery page
./e2e.sh <url>    # against the deployed Worker: gallery, sha256 vs origin, HIT, Range 206, 304, 405, bucket guard
./test.sh <origin-object-url> <worker-object-url>   # the guide's original check
```

The unit tests run in plain Node, not workerd, so they don't exercise `cf.*` fetch options; `e2e.sh` covers caching on the deployed Worker.
