# Neon Object Storage image gallery behind a Cloudflare Worker

**Live demo: https://neon-storage-cdn-demo.shridhar-deshmukh3.workers.dev**

A one-Worker demo built on the proxy from the ["Serve objects through a CDN (Cloudflare)"](https://github.com/neondatabase/website/pull/6133) guide (`content/docs/storage/cdn-cloudflare.md`). It serves a public gallery, caches images at Cloudflare's edge, and takes browser uploads from signed-in users (Neon Auth, email + password).

```
                      GET /cdn-demo/<key>  (public)                 fetch + cf.cacheEverything
 browser  ─────────────────────────────────────────►  Worker  ──────────────────────────────►  Neon Object Storage
    │  GET /api/list (public)                          ▲ │ │                                    (public_read bucket)
    │                                                  │ │ │ GET /api/list (SigV4, cached 5s)         ▲
    │  /api/auth/*  (sign-up, sign-in, get-session)    │ │ └ cron, hourly: delete uploads/ > 24h      │
    ├──────────────────────────────────────────────────┘ │                                           │
    │      same-origin proxy, cookie rewritten            └──►  Neon Auth  (better-auth, per branch)  │
    │      to first-party; returns a JWT in set-auth-jwt        JWKS: <auth-url>/.well-known/jwks.json │
    │                                                                  ▲ cached key set, no secret     │
    │  POST /api/upload-url  Authorization: Bearer <JWT>               │                               │
    ├────────────────────────────────────────────►  Worker verifies the JWT with jose (EdDSA, iss, aud, exp),
    │           signed POST policy                  rate-limits per IP and per user, signs uploads/<userId>/<uuid>.<ext>
    └──────────────  multipart POST (bucket CORS allows the Worker origin)  ──────────────────────────────┘
```

| Route | What it does |
| --- | --- |
| `GET /` | Gallery page. Each tile shows `cf-cache-status` and load time. |
| `GET /api/list` | Newest 50 objects under `uploads/` and `samples/` (ListObjectsV2, SigV4, cached 5 s). |
| `POST /api/upload-url` | **Needs a Neon Auth JWT** (`Authorization: Bearer`). Returns a presigned POST policy for one image. 401 without a valid token. |
| `GET /api/auth/get-session`, `POST /api/auth/{sign-up,sign-in}/email`, `POST /api/auth/sign-out` | Same-origin proxy to Neon Auth. Nothing else on the auth server is reachable. |
| `GET\|HEAD /cdn-demo/<key>` | The guide's cached proxy, restricted to the demo bucket. |

Code: `src/auth.js` verifies the JWT, `src/authproxy.js` is the auth proxy, `src/proxy.js` is the guide's Worker (host-safe origin concat, only `Range`/`If-None-Match` forwarded, `cf.cacheEverything`) plus a bucket check. `src/policy.js` builds the POST policy, `src/s3.js` lists and deletes with `aws4fetch`, `src/cleanup.js` is the cron job.

## Upload policy

The policy signs these conditions. Each one is enforced by `platform/internal/storage/s3api/postobject.go` on `origin/main` (`validatePostConditions`, `matchPostCondition`):

- `bucket` equals the demo bucket (the server requires a bucket condition).
- `key` equals `uploads/<userId>/<uuid>.<ext>`, chosen by the Worker from the verified token's `sub`. The uploader is recorded in the key rather than in an `x-amz-meta-uploader` field: `postobject.go` stores `x-amz-meta-*` form fields but denies any submitted field that no policy condition covers (`validatePostConditions`), and the key is already pinned by an `eq` condition. Object keys are public, so the opaque user id is visible in the gallery listing.
- `Content-Type` equals one of `image/png|jpeg|webp|gif`. `eq` rather than `starts-with image/`, so SVG and others are out.
- `content-length-range` 1..2 MiB, checked against the received file size.
- Expiry 5 minutes.
- Any other submitted form field is rejected, so the form can't add metadata or tags.

Not enforced, so not relied on:

- A `Cache-Control` form field is accepted but never stored (only `x-amz-meta-*` fields are kept). Objects uploaded by browsers therefore have no `Cache-Control`; the Worker gives `uploads/` keys a 24 h edge TTL and adds `Cache-Control: public, max-age=86400, immutable` to the response.
- The server doesn't inspect file bytes, so a file can claim `image/png` and contain anything. The proxy sets `X-Content-Type-Options: nosniff`.

## Authentication (Neon Auth)

Only `POST /api/upload-url` requires a session. The page signs users up and in with email + password (Neon Auth's default for a new project: enabled, no email verification required; email OTP needs an email provider, so it isn't offered).

**Why a same-origin proxy.** Neon Auth sets its session cookie as `SameSite=None; Partitioned` on `*.neonauth.<cell>.neon.tech`. For a page on `*.workers.dev` that is a third-party cookie: Safari/ITP blocks those, and Safari doesn't send `Partitioned` cookies on top-level navigations either. So the Worker proxies `/api/auth/*` to Neon Auth and rewrites `Set-Cookie` to `Secure; HttpOnly; SameSite=Lax` without `Domain` or `Partitioned`, the same normalization `@neondatabase/neon-js` applies in its Next.js proxy (`packages/auth/src/server/proxy/response.ts`). The browser only ever talks to its own origin, so sign-in works in Safari. The page uses plain `fetch` against better-auth's REST endpoints, so there is no client bundle to ship.

**Token flow.** After sign-in the page calls `GET /api/auth/get-session`; the response carries a JWT in the `set-auth-jwt` header (15 minute lifetime). The page fetches a fresh one before each upload and sends it as `Authorization: Bearer <jwt>`. The Worker verifies it with `jose` (`createRemoteJWKSet`, cached per isolate, refetched on an unknown `kid`) and pins `alg` to `EdDSA`, `iss`, `aud`, `exp` and `sub`. No secret is involved. If the JWKS is unreachable or auth isn't configured the Worker answers 503, never 200.

Values, all produced by Neon Auth and written to `wrangler.toml` by `setup-auth.sh`:

| Var | Value | Source on `neon-cloud` `origin/main` |
| --- | --- | --- |
| `NEON_AUTH_URL` | `base_url` from `GET /projects/{id}/branches/{id}/auth`, `https://<ep>.neonauth.<cell>.<region>.aws.neon.tech/<db>/auth` | `goapp/console/apispec/public-v2.yaml` (`NeonAuthCreateIntegrationResponse.base_url`, line 22439), URL built by `neon-auth/src/util/templates.ts:61-73` |
| `NEON_AUTH_JWKS_URL` | `jwks_url` from the same call, `<auth-url>/.well-known/jwks.json` | `public-v2.yaml` (`jwks_url`), `neon-auth/src/auth/config/jwt.ts:75` |
| `NEON_AUTH_ISSUER`, `NEON_AUTH_AUDIENCE` | the **origin** of the auth URL (no `/<db>/auth` path) | better-auth jwt plugin defaults, set up at `neon-auth/src/auth/auth.ts:64`; confirmed against a live token, because `baseURL` itself includes the path |

Claims in the token (`neon-auth/src/auth/config/jwt.ts:82-117`): the user's fields (`id`, `email`, `name`, `emailVerified`, ...), `role: "authenticated"`, `sub` = user id, `iss`, `aud`, `iat`, `exp`. `setup-auth.sh` also adds the Worker origin as a trusted domain (`POST .../auth/domains`) because better-auth rejects a state-changing request whose `Origin` isn't trusted (`neon-auth/src/auth/auth.ts:152`, `getTrustedOrigins`).

## Abuse limits

- Uploads need an account, and the limit applies twice: per IP (`ip:<addr>`) and per user id (`user:<id>`), 5 per 60 s each, through the Workers Rate Limiting binding. The user key stops one account rotating IPs; the IP key slows one client minting accounts. Both count per Cloudflare location, so they are permissive rather than exact. Neon Auth applies its own rate limits to sign-up and sign-in. The Cloudflare docs don't list a plan restriction for the binding; if it is missing the Worker falls back to a per-isolate in-memory counter, which only slows one client on one isolate.
- Global cap: no new upload URLs while `uploads/` has more than 200 objects. The count comes from a list cached for 5 s, so a burst can overshoot slightly.
- 2 MiB, four image types, 5-minute policies.
- Neon storage stores lifecycle rules but doesn't enforce them, so a Cron Trigger (`0 * * * *`) deletes `uploads/` objects older than 24 h. Each run deletes at most 40 objects to stay under the 50-subrequest free-plan limit.
- The page says uploads are public and deleted after 24 h.

Cost: Workers free plan (100k requests/day, one cron, one rate-limit binding) and whatever the Neon project's storage plan includes. Public image bytes are served from Cloudflare's cache, so repeat views don't hit Neon.

## Setup, deploy, teardown

Requirements: Node 20+, `curl`, `jq`, `python3`, a Neon project with Object Storage, a Cloudflare account with a workers.dev subdomain.

```bash
cp .env.example .env     # fill in the four values; the Cloudflare token needs "Edit Cloudflare Workers"
npm install
set -a; . ./.env; set +a
./setup.sh               # bucket, credential, CORS, samples; deploys once and stores the credential as Worker secrets
./setup-auth.sh          # enables Neon Auth on the branch, trusts the Worker origin, writes the auth vars to wrangler.toml
npx wrangler deploy
./e2e.sh https://neon-storage-cdn-demo.<subdomain>.workers.dev
```

`setup.sh` edits `NEON_STORAGE_ORIGIN` and `REGION` in `wrangler.toml`. The storage credential is only ever piped to `wrangler secret put`; it is never printed or written to disk. Secrets: `NEON_STORAGE_ACCESS_KEY_ID`, `NEON_STORAGE_SECRET_ACCESS_KEY`. Vars: `NEON_STORAGE_ORIGIN`, `BUCKET`, `REGION`, `NEON_AUTH_URL`, `NEON_AUTH_JWKS_URL`, `NEON_AUTH_ISSUER`, `NEON_AUTH_AUDIENCE`.

`setup-auth.sh` is idempotent: it reuses Neon Auth if the branch already has it, skips the trusted domain if present, and rewrites the same four vars. It needs no secrets of its own beyond the Neon API key.

Neon API calls used (from `public-v2.yaml`): `GET|POST /projects/{id}/branches/{id}/auth`, `GET|POST .../auth/domains`, `GET /projects/{id}/branches`, `GET .../branches/{id}/storage`, `POST .../buckets`, `POST .../credentials`, `DELETE .../credentials/{token_id}`, `DELETE .../buckets/{name}/objects-by-prefix`, `DELETE .../buckets/{name}`. CORS and the sample uploads go through the S3 API (`PutBucketCors`, `PutObject`), which has no management-API equivalent.

Teardown:

```bash
set -a; . ./.env; set +a
./teardown.sh     # deletes the Worker, the objects, the bucket and the credential
```

`teardown.sh` leaves Neon Auth enabled on the branch (it may hold other users). Disable it with `DELETE /projects/{id}/branches/{id}/auth` if you want it gone.

## Tests

```bash
npm test          # vitest: JWT verification, auth proxy, proxy guards, policy, rate limiter, cron selection, API routes
./e2e.sh <url>    # against the deployed Worker, including a throwaway sign-up and an authenticated upload
./test.sh <origin-object-url> <worker-object-url>   # the guide's original check
```

The unit tests run in plain Node with a stub for the Cache API, not in workerd, so they don't exercise `cf.*` fetch options or the Rate Limiting binding. JWT tests sign with a locally generated Ed25519 key and a mocked JWKS response; the issuer/audience values were checked separately against a live Neon Auth token. `e2e.sh` covers those on the deployed Worker.
