# Neon Object Storage image gallery behind a Cloudflare Worker

A one-Worker demo built on the proxy from the ["Serve objects through a CDN (Cloudflare)"](https://github.com/neondatabase/website/pull/6133) guide (`content/docs/storage/cdn-cloudflare.md`). It serves a gallery, takes browser uploads and caches images at Cloudflare's edge.

```
                 GET /cdn-demo/<key>                     fetch + cf.cacheEverything
 browser  ───────────────────────────────►  Worker  ────────────────────────────────►  Neon Object Storage
    │                                         ▲  │                                     (public_read bucket)
    │  POST /api/upload-url  {type,size}      │  │ GET /api/list  (SigV4, cached 5s)         ▲
    ├────────────────────────────────────────┘  │ cron, hourly: delete uploads/ > 24h        │
    │          signed POST policy                └────────────────────────────────────────────┤
    └────────────────────  multipart POST (bucket CORS allows the Worker origin)  ────────────┘
```

| Route | What it does |
| --- | --- |
| `GET /` | Gallery page. Each tile shows `cf-cache-status` and load time. |
| `GET /api/list` | Newest 50 objects under `uploads/` and `samples/` (ListObjectsV2, SigV4, cached 5 s). |
| `POST /api/upload-url` | Returns a presigned POST policy for one image. |
| `GET\|HEAD /cdn-demo/<key>` | The guide's cached proxy, restricted to the demo bucket. |

Code: `src/proxy.js` is the guide's Worker (host-safe origin concat, only `Range`/`If-None-Match` forwarded, `cf.cacheEverything`) plus a bucket check. `src/policy.js` builds the POST policy, `src/s3.js` lists and deletes with `aws4fetch`, `src/cleanup.js` is the cron job.

## Upload policy

The policy signs these conditions. Each one is enforced by `platform/internal/storage/s3api/postobject.go` on `origin/main` (`validatePostConditions`, `matchPostCondition`):

- `bucket` equals the demo bucket (the server requires a bucket condition).
- `key` equals `uploads/<uuid>.<ext>`, chosen by the Worker.
- `Content-Type` equals one of `image/png|jpeg|webp|gif`. `eq` rather than `starts-with image/`, so SVG and others are out.
- `content-length-range` 1..2 MiB, checked against the received file size.
- Expiry 5 minutes.
- Any other submitted form field is rejected, so the form can't add metadata or tags.

Not enforced, so not relied on:

- A `Cache-Control` form field is accepted but never stored (only `x-amz-meta-*` fields are kept). Objects uploaded by browsers therefore have no `Cache-Control`; the Worker gives `uploads/` keys a 24 h edge TTL and adds `Cache-Control: public, max-age=86400, immutable` to the response.
- The server doesn't inspect file bytes, so a file can claim `image/png` and contain anything. The proxy sets `X-Content-Type-Options: nosniff`.

## Abuse limits

- Per-IP limit on `/api/upload-url`: the Workers Rate Limiting binding (5 per 60 s). It counts per Cloudflare location, so it is permissive rather than exact. The Cloudflare docs don't list a plan restriction for the binding; if it is missing the Worker falls back to a per-isolate in-memory counter, which only slows one client on one isolate.
- Global cap: no new upload URLs while `uploads/` has more than 200 objects. The count comes from a list cached for 5 s, so a burst can overshoot slightly.
- 2 MiB, four image types, 5-minute policies.
- Neon storage stores lifecycle rules but doesn't enforce them, so a Cron Trigger (`0 * * * *`) deletes `uploads/` objects older than 24 h. Each run deletes at most 40 objects to stay under the 50-subrequest free-plan limit.
- The page says uploads are public and deleted after 24 h.

Cost: Workers free plan (100k requests/day, one cron, one rate-limit binding) and whatever the Neon project's storage plan includes. Public image bytes are served from Cloudflare's cache, so repeat views don't hit Neon.

## Setup and deploy

Requirements: Node 20+, `curl`, `jq`, `python3`, a Neon project with Object Storage, a Cloudflare account with a workers.dev subdomain.

```bash
cp .env.example .env     # fill in the four values; the Cloudflare token needs "Edit Cloudflare Workers"
npm install
set -a; . ./.env; set +a
./setup.sh               # bucket, credential, CORS, samples, Worker secrets
npx wrangler deploy
./e2e.sh https://neon-storage-cdn-demo.<subdomain>.workers.dev
```

`setup.sh` edits `NEON_STORAGE_ORIGIN` and `REGION` in `wrangler.toml`, and deploys once so `wrangler secret put` has a Worker to attach to. The credential is only ever piped to `wrangler secret put`; it is never printed or written to disk by these scripts. Secrets: `NEON_STORAGE_ACCESS_KEY_ID`, `NEON_STORAGE_SECRET_ACCESS_KEY`. Vars: `NEON_STORAGE_ORIGIN`, `BUCKET`, `REGION`.

Neon API calls used (from `public-v2.yaml`): `GET /projects/{id}/branches`, `GET .../branches/{id}/storage`, `POST .../buckets`, `POST .../credentials`, `DELETE .../credentials/{token_id}`, `DELETE .../buckets/{name}/objects-by-prefix`, `DELETE .../buckets/{name}`. CORS and the sample uploads go through the S3 API (`PutBucketCors`, `PutObject`), which has no management-API equivalent.

## Tests

```bash
npm test          # vitest: proxy guards, policy, rate limiter, cron selection, API routes
./e2e.sh <url>    # against the deployed Worker
./test.sh <origin-object-url> <worker-object-url>   # the guide's original check
```

The unit tests run in plain Node with a stub for the Cache API, not in workerd, so they don't exercise `cf.*` fetch options or the Rate Limiting binding. `e2e.sh` covers those on the deployed Worker.

## Teardown

```bash
set -a; . ./.env; set +a
./teardown.sh     # deletes the Worker, the objects, the bucket and the credential
```
