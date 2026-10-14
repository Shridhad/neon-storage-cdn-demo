import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate, resetJwks } from '../src/auth.js';
import { authEnv } from './helpers.js';
import { makeIssuer, otherKey, USER_ID } from './jwt.js';

let issuer;
let jwksFetches;

beforeEach(async () => {
  resetJwks();
  issuer = await makeIssuer();
  jwksFetches = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    if (url !== authEnv.NEON_AUTH_JWKS_URL) throw new Error('unexpected fetch ' + url);
    jwksFetches++;
    return Response.json(issuer.jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

const req = (token) => new Request('https://demo.example/api/upload-url', { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('authenticate', () => {
  it('returns the user for a valid token', async () => {
    expect(await authenticate(req(await issuer.sign()), authEnv)).toEqual({ id: USER_ID, email: 'probe@example.com' });
  });

  it('caches the JWKS across calls', async () => {
    await authenticate(req(await issuer.sign()), authEnv);
    await authenticate(req(await issuer.sign()), authEnv);
    expect(jwksFetches).toBe(1);
  });

  it.each([
    ['no header', async () => req()],
    ['not a bearer header', async () => new Request('https://x', { headers: { authorization: 'Basic abc' } })],
    ['garbage token', async () => req('not.a.jwt')],
    ['bad signature', async () => req(await issuer.sign({ key: await otherKey() }))],
    ['wrong issuer', async () => req(await issuer.sign({ iss: 'https://evil.example' }))],
    ['wrong audience', async () => req(await issuer.sign({ aud: 'https://evil.example' }))],
    ['expired', async () => req(await issuer.sign({ exp: Math.floor(Date.now() / 1000) - 60 }))],
    ['subject unsafe for an object key', async () => req(await issuer.sign({ sub: '../../samples' }))],
  ])('rejects: %s', async (_name, build) => {
    expect(await authenticate(await build(), authEnv)).toBeNull();
  });

  it('throws when auth is not configured, so callers fail closed', async () => {
    await expect(authenticate(req(await issuer.sign()), { ...authEnv, NEON_AUTH_JWKS_URL: undefined })).rejects.toThrow(/not configured/);
  });
});
