import { describe, expect, it } from 'vitest';
import { buildUploadPolicy, MAX_BYTES } from '../src/policy.js';
import { env } from './helpers.js';

const NOW = new Date('2026-10-14T12:00:00Z');
const decode = (b64) => JSON.parse(atob(b64));

describe('buildUploadPolicy', () => {
  it('picks the key server-side under uploads/ with an extension from the type', async () => {
    const a = await buildUploadPolicy(env, 'image/png', NOW);
    const b = await buildUploadPolicy(env, 'image/png', NOW);
    expect(a.key).toMatch(/^uploads\/[0-9a-f-]{36}\.png$/);
    expect(a.key).not.toBe(b.key);
    expect(a.fields.key).toBe(a.key);
    expect((await buildUploadPolicy(env, 'image/jpeg', NOW)).key).toMatch(/\.jpg$/);
  });

  it('rejects types outside the allowlist', async () => {
    for (const t of ['text/html', 'image/svg+xml', 'image/', 'application/octet-stream', '']) {
      await expect(buildUploadPolicy(env, t, NOW), t).rejects.toThrow(/unsupported/);
    }
  });

  it('signs every condition the server enforces and expires in 5 minutes', async () => {
    const p = await buildUploadPolicy(env, 'image/webp', NOW);
    const policy = decode(p.fields.policy);
    expect(policy.expiration).toBe('2026-10-14T12:05:00Z');
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        { bucket: 'cdn-demo' },
        ['eq', '$key', p.key],
        ['eq', '$Content-Type', 'image/webp'],
        ['content-length-range', 1, MAX_BYTES],
      ]),
    );
    expect(MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it('has a condition for every submitted field, because the server denies uncovered ones', async () => {
    const p = await buildUploadPolicy(env, 'image/gif', NOW);
    const policy = decode(p.fields.policy);
    const covered = new Set(
      policy.conditions.flatMap((c) => (Array.isArray(c) ? [String(c[1]).replace('$', '')] : Object.keys(c))).map((s) => s.toLowerCase()),
    );
    const control = new Set(['policy', 'x-amz-signature']);
    for (const f of Object.keys(p.fields)) expect(covered.has(f.toLowerCase()) || control.has(f.toLowerCase()), f).toBe(true);
  });

  it('does not send Cache-Control, which POST uploads do not persist', async () => {
    const p = await buildUploadPolicy(env, 'image/png', NOW);
    expect(Object.keys(p.fields).map((f) => f.toLowerCase())).not.toContain('cache-control');
  });

  it('produces a SigV4 POST signature that a verifier recomputes from the secret', async () => {
    const p = await buildUploadPolicy(env, 'image/png', NOW);
    const [akid, date, region, service, term] = p.fields['x-amz-credential'].split('/');
    expect([akid, date, region, service, term]).toEqual([env.NEON_STORAGE_ACCESS_KEY_ID, '20261014', 'us-east-2', 's3', 'aws4_request']);
    const hmac = async (key, msg) => {
      const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
    };
    let k = new TextEncoder().encode('AWS4' + env.NEON_STORAGE_SECRET_ACCESS_KEY);
    for (const part of [date, region, service, term]) k = await hmac(k, part);
    const want = [...(await hmac(k, p.fields.policy))].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(p.fields['x-amz-signature']).toBe(want);
    expect(p.url).toBe(env.NEON_STORAGE_ORIGIN + '/cdn-demo');
    expect(p.fields['x-amz-algorithm']).toBe('AWS4-HMAC-SHA256');
    expect(p.fields['x-amz-date']).toBe('20261014T120000Z');
  });
});
