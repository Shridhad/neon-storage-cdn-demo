import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { env, listXml } from './helpers.js';

const call = (path, init, e = env) => worker.fetch(new Request('https://demo.example.workers.dev' + path, init), e, { waitUntil() {} });
const post = (body, headers = {}) =>
  call('/api/upload-url', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.9', ...headers }, body: JSON.stringify(body) });
const limiterOk = { UPLOAD_LIMITER: { limit: async () => ({ success: true }) } };

afterEach(() => vi.restoreAllMocks());

function mockStorage({ uploads = 0 } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = new URL(new Request(input, init).url);
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
  it('returns a presigned POST for an allowed image', async () => {
    mockStorage();
    const res = await post({ contentType: 'image/png', size: 1000 }, { 'cf-connecting-ip': '1.1.1.1' }).then((r) => r);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toMatch(/^uploads\//);
    expect(body.url).toBe(env.NEON_STORAGE_ORIGIN + '/cdn-demo');
  });

  it('rejects non-images and oversize requests before signing', async () => {
    mockStorage();
    expect((await post({ contentType: 'text/html', size: 10 })).status).toBe(400);
    expect((await post({ contentType: 'image/png', size: 3 * 1024 * 1024 })).status).toBe(400);
    expect((await post({ contentType: 'image/png', size: 0 })).status).toBe(400);
  });

  it('refuses when uploads/ already holds more than 200 objects', async () => {
    mockStorage({ uploads: 201 });
    const res = await post({ contentType: 'image/png', size: 10 }, { 'cf-connecting-ip': '2.2.2.2' });
    expect(res.status).toBe(503);
  });

  it('returns 429 when the limiter denies', async () => {
    mockStorage();
    const res = await call('/api/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/png', size: 10 }),
    }, { ...env, UPLOAD_LIMITER: { limit: async () => ({ success: false }) } });
    expect(res.status).toBe(429);
  });

  it('only accepts POST', async () => {
    expect((await call('/api/upload-url')).status).toBe(405);
  });
});
