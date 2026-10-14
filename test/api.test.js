import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { resetJwks } from '../src/auth.js';
import { authEnv as env, listXml } from './helpers.js';
import { makeIssuer, otherKey, USER_ID } from './jwt.js';

const call = (path, init, e = env) => worker.fetch(new Request('https://demo.example.workers.dev' + path, init), e, { waitUntil() {} });
const post = (body, { token, ip = '9.9.9.9', env: e = env } = {}) =>
  call('/api/upload-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }, e);
const limiter = (verdicts = () => true) => {
  const keys = [];
  return { keys, binding: { limit: async ({ key }) => (keys.push(key), { success: verdicts(key) }) } };
};

let issuer;
beforeEach(async () => {
  resetJwks();
  issuer = await makeIssuer();
});
afterEach(() => vi.restoreAllMocks());

function mockStorage({ uploads = 0 } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = new URL(new Request(input, init).url);
    if (u.href === env.NEON_AUTH_JWKS_URL) return Response.json(issuer.jwks);
    const prefix = u.searchParams.get('prefix');
    const rows = prefix === 'uploads/'
      ? Array.from({ length: uploads }, (_, i) => ({ key: `uploads/${i}.png`, lastModified: new Date(Date.UTC(2026, 9, 14, 0, 0, i)).toISOString() }))
      : [{ key: 'samples/a.png', lastModified: '2026-10-01T00:00:00.000Z' }];
    return new Response(listXml(rows));
  });
}

describe('GET /', () => {
  it('serves the gallery with the demo notice', async () => {
    const res = await call('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('deleted after 24h');
  });
});

describe('GET /api/list', () => {
  it('returns uploads and samples newest first, capped at 50', async () => {
    mockStorage({ uploads: 60 });
    const res = await call('/api/list');
    const { objects } = await res.json();
    expect(objects).toHaveLength(50);
    expect(objects[0].key).toBe('uploads/59.png');
    const sorted = [...objects].sort((a, b) => b.lastModified.localeCompare(a.lastModified));
    expect(objects).toEqual(sorted);
  });
});

describe('POST /api/upload-url', () => {
  const body = { contentType: 'image/png', size: 1000 };

  describe('authentication', () => {
    it('401s without a token, before any rate limiting or storage access', async () => {
      const spy = mockStorage();
      const l = limiter();
      const res = await post(body, { env: { ...env, UPLOAD_LIMITER: l.binding } });
      expect(res.status).toBe(401);
      expect(l.keys).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    });

    it.each([
      ['a bad signature', async () => issuer.sign({ key: await otherKey() })],
      ['the wrong issuer', async () => issuer.sign({ iss: 'https://evil.example' })],
      ['the wrong audience', async () => issuer.sign({ aud: 'https://evil.example' })],
      ['an expired token', async () => issuer.sign({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ])('401s with %s', async (_n, mint) => {
      mockStorage();
      const res = await post(body, { token: await mint() });
      expect(res.status).toBe(401);
      expect((await res.json()).error).toMatch(/sign in/i);
    });

    it('503s, not 200, when auth is not configured', async () => {
      mockStorage();
      const res = await post(body, { token: await issuer.sign(), env: { ...env, NEON_AUTH_JWKS_URL: '' } });
      expect(res.status).toBe(503);
    });

    it('503s when the JWKS cannot be fetched', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
      expect((await post(body, { token: await issuer.sign() })).status).toBe(503);
    });
  });

  describe('with a valid token', () => {
    it('returns a presigned POST whose key is under the caller\'s user id', async () => {
      mockStorage();
      const res = await post(body, { token: await issuer.sign() });
      expect(res.status).toBe(200);
      const out = await res.json();
      expect(out.key).toMatch(new RegExp(`^uploads/${USER_ID}/[0-9a-f-]{36}\\.png$`));
      expect(out.fields.key).toBe(out.key);
      expect(JSON.parse(atob(out.fields.policy)).conditions).toContainEqual(['eq', '$key', out.key]);
      expect(out.url).toBe(env.NEON_STORAGE_ORIGIN + '/cdn-demo');
    });

    it('rate limits by IP and by user id', async () => {
      mockStorage();
      const l = limiter();
      await post(body, { token: await issuer.sign(), ip: '1.1.1.1', env: { ...env, UPLOAD_LIMITER: l.binding } });
      expect(l.keys).toEqual(['ip:1.1.1.1', `user:${USER_ID}`]);
    });

    it('429s when only the user limit denies, so rotating IPs does not help', async () => {
      mockStorage();
      const l = limiter((k) => !k.startsWith('user:'));
      const res = await post(body, { token: await issuer.sign(), env: { ...env, UPLOAD_LIMITER: l.binding } });
      expect(res.status).toBe(429);
    });

    it('429s when only the IP limit denies', async () => {
      mockStorage();
      const l = limiter((k) => !k.startsWith('ip:'));
      const res = await post(body, { token: await issuer.sign(), env: { ...env, UPLOAD_LIMITER: l.binding } });
      expect(res.status).toBe(429);
    });

    it('rejects non-images and oversize requests before signing', async () => {
      mockStorage();
      const token = await issuer.sign();
      expect((await post({ contentType: 'text/html', size: 10 }, { token })).status).toBe(400);
      expect((await post({ contentType: 'image/png', size: 3 * 1024 * 1024 }, { token })).status).toBe(400);
      expect((await post({ contentType: 'image/png', size: 0 }, { token })).status).toBe(400);
    });

    it('refuses when uploads/ already holds more than 200 objects', async () => {
      mockStorage({ uploads: 201 });
      expect((await post({ contentType: 'image/png', size: 10 }, { token: await issuer.sign() })).status).toBe(503);
    });
  });

  it('only accepts POST', async () => {
    expect((await call('/api/upload-url')).status).toBe(405);
  });
});

describe('everything except upload-url stays anonymous', () => {
  it('serves the gallery, the listing and bucket objects without a token', async () => {
    const spy = mockStorage();
    spy.mockImplementationOnce(async () => new Response(listXml([]))).mockImplementationOnce(async () => new Response(listXml([])));
    expect((await call('/')).status).toBe(200);
    expect((await call('/api/list')).status).toBe(200);
    spy.mockImplementation(async () => new Response('png-bytes', { headers: { 'content-type': 'image/png' } }));
    const obj = await call('/cdn-demo/samples/a.png');
    expect(obj.status).toBe(200);
    expect(await obj.text()).toBe('png-bytes');
  });
});

describe('GET / sign-in UI', () => {
  it('offers sign-in against the same-origin auth proxy and sends the JWT as a bearer token', async () => {
    const html = await (await call('/')).text();
    expect(html).toContain('Sign in to upload');
    expect(html).toContain("'/api/auth/' + path");
    expect(html).toContain("'sign-in/email'");
    expect(html).toContain("'sign-up/email'");
    expect(html).toContain("Authorization: 'Bearer ' + jwt");
    expect(html).not.toMatch(/https:\/\/[^'" ]*neonauth/);
  });
});
