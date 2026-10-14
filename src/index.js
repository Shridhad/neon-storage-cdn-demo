import { cleanup } from './cleanup.js';
import { PAGE } from './page.js';
import { buildUploadPolicy, MAX_BYTES } from './policy.js';
import { proxy } from './proxy.js';
import { allow } from './ratelimit.js';
import { listCached } from './s3.js';

const MAX_UPLOADS = 200;
const LIST_CAP = 50;

const json = (body, status = 200) => Response.json(body, { status });
const notAllowed = (allow) => new Response('Method Not Allowed', { status: 405, headers: { Allow: allow } });

async function list(env) {
  const [uploads, samples] = await Promise.all([listCached(env, 'uploads/'), listCached(env, 'samples/')]);
  const objects = [...uploads, ...samples].sort((a, b) => b.lastModified.localeCompare(a.lastModified)).slice(0, LIST_CAP);
  return json({ bucket: env.BUCKET, objects });
}

async function uploadUrl(request, env) {
  if (!(await allow(env, request.headers.get('cf-connecting-ip') ?? 'unknown'))) {
    return json({ error: 'Too many upload requests, try again in a minute' }, 429);
  }

  const body = await request.json().catch(() => null);
  if (!body || !Number.isInteger(body.size) || body.size < 1 || body.size > MAX_BYTES) {
    return json({ error: `size must be 1..${MAX_BYTES} bytes` }, 400);
  }

  // Approximate: the list is cached for a few seconds, so a burst can overshoot the cap slightly.
  if ((await listCached(env, 'uploads/')).length > MAX_UPLOADS) {
    return json({ error: 'The demo is full. Uploads are cleared hourly once they are older than 24h.' }, 503);
  }

  try {
    return json(await buildUploadPolicy(env, body.contentType));
  } catch {
    return json({ error: 'contentType must be image/png, image/jpeg, image/webp or image/gif' }, 400);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/') {
      return request.method === 'GET' ? new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : notAllowed('GET');
    }
    if (pathname === '/api/list') return request.method === 'GET' ? list(env) : notAllowed('GET');
    if (pathname === '/api/upload-url') return request.method === 'POST' ? uploadUrl(request, env) : notAllowed('POST');

    return proxy(request, env);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};
