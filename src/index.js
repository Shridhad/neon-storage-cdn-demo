import { authenticate } from './auth.js';
import { authProxy } from './authproxy.js';
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
  let user;
  try {
    user = await authenticate(request, env);
  } catch {
    return json({ error: 'Sign-in is temporarily unavailable' }, 503);
  }
  if (!user) return json({ error: 'Sign in to upload' }, 401);

  // The user limit stops one account from rotating IPs; the IP limit stops one client from minting accounts.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!(await allow(env, `ip:${ip}`)) || !(await allow(env, `user:${user.id}`))) {
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
    return json(await buildUploadPolicy(env, body.contentType, user.id));
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
    if (pathname.startsWith('/api/auth/')) return authProxy(request, env);
    if (pathname === '/api/upload-url') return request.method === 'POST' ? uploadUrl(request, env) : notAllowed('POST');

    return proxy(request, env);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};
