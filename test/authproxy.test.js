import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { authEnv } from './helpers.js';

const ORIGIN = 'https://demo.example.workers.dev';
const call = (path, init) => worker.fetch(new Request(ORIGIN + path, init), authEnv, { waitUntil() {} });

// Set-Cookie exactly as Neon Auth sends it (captured from a live sign-up).
const UPSTREAM_COOKIE = '__Secure-neon-auth.session_token=abc123; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=None; Partitioned';

afterEach(() => vi.restoreAllMocks());

function mockUpstream() {
  const seen = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    seen.push({ url: req.url, method: req.method, headers: req.headers, body: await req.text() });
    const headers = new Headers({ 'content-type': 'application/json', 'set-auth-jwt': 'jwt-value', 'x-secret-internal': 'nope' });
    headers.append('set-cookie', UPSTREAM_COOKIE);
    headers.append('set-cookie', '__Secure-neon-auth.other=1; Domain=neon.tech; Path=/; Secure; SameSite=None; Partitioned');
    return new Response('{"ok":true}', { headers });
  });
  return seen;
}

describe('/api/auth/* proxy', () => {
  it('forwards sign-in to the Neon Auth URL with the browser Origin and only neon-auth cookies', async () => {
    const seen = mockUpstream();
    const res = await call('/api/auth/sign-in/email?x=1', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: 'a=1; __Secure-neon-auth.session_token=tok; tracking=zzz', authorization: 'Bearer leak' },
      body: '{"email":"a@b.c","password":"p"}',
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${authEnv.NEON_AUTH_URL}/sign-in/email?x=1`);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].body).toBe('{"email":"a@b.c","password":"p"}');
    expect(seen[0].headers.get('origin')).toBe(ORIGIN);
    expect(seen[0].headers.get('cookie')).toBe('__Secure-neon-auth.session_token=tok');
    expect(seen[0].headers.get('authorization')).toBeNull();
  });

  it('falls back to the Worker origin when the request has none', async () => {
    const seen = mockUpstream();
    await call('/api/auth/get-session');
    expect(seen[0].headers.get('origin')).toBe(ORIGIN);
  });

  it('makes cookies first-party: no Partitioned, no Domain, SameSite=Lax, still Secure and HttpOnly', async () => {
    mockUpstream();
    const res = await call('/api/auth/get-session');
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    for (const c of cookies) {
      expect(c).not.toMatch(/partitioned/i);
      expect(c).not.toMatch(/domain=/i);
      expect(c).not.toMatch(/samesite=none/i);
      expect(c).toMatch(/SameSite=Lax/);
      expect(c).toMatch(/Secure/);
    }
    expect(cookies[0]).toContain('__Secure-neon-auth.session_token=abc123');
    expect(cookies[0]).toMatch(/HttpOnly/);
    expect(cookies[0]).toMatch(/Max-Age=604800/);
  });

  it('passes set-auth-jwt through, drops other upstream headers and disables caching', async () => {
    mockUpstream();
    const res = await call('/api/auth/get-session');
    expect(res.headers.get('set-auth-jwt')).toBe('jwt-value');
    expect(res.headers.get('x-secret-internal')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it.each(['/api/auth/admin/list-users', '/api/auth/oauth2/token', '/api/auth/', '/api/auth/get-session/../admin/x'])('404s a path outside the allowlist: %s', async (p) => {
    const seen = mockUpstream();
    expect((await call(p)).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('405s a wrong method on an allowed path', async () => {
    const seen = mockUpstream();
    expect((await call('/api/auth/sign-in/email')).status).toBe(405);
    expect((await call('/api/auth/get-session', { method: 'POST', body: '{}' })).status).toBe(405);
    expect(seen).toHaveLength(0);
  });

  it('502s when Neon Auth is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('connect timeout'));
    expect((await call('/api/auth/get-session')).status).toBe(502);
  });
});
