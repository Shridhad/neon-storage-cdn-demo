import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { env } from './helpers.js';

const call = (path, init) => worker.fetch(new Request('https://demo.example.workers.dev' + path, init), env, {});

afterEach(() => vi.restoreAllMocks());

describe('proxy guards', () => {
  it('rejects non-GET/HEAD with 405 and Allow', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await call('/cdn-demo/samples/a.png', { method: 'PUT', body: 'x' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, HEAD');
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps the upstream host fixed when the path starts with //host', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'));
    const res = await call('//evil.example/cdn-demo/a.png');
    expect(res.status).toBe(403);
    for (const [url] of spy.mock.calls) expect(new URL(url).host).toBe('br-demo-1.storage.c-2.us-east-2.aws.neon.tech');
  });

  it('keeps //host inside the key after the bucket on the origin host', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'));
    await call('/cdn-demo//evil.example/a.png');
    const [url] = spy.mock.calls[0];
    expect(new URL(url).host).toBe('br-demo-1.storage.c-2.us-east-2.aws.neon.tech');
    expect(url).toBe(env.NEON_STORAGE_ORIGIN + '/cdn-demo//evil.example/a.png');
  });

  it('forwards only Range and If-None-Match and drops the query', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'));
    await call('/cdn-demo/samples/a.png?bust=1', {
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'sid=1',
        Range: 'bytes=0-9',
        'If-None-Match': '"abc"',
        'X-Other': 'nope',
      },
    });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(env.NEON_STORAGE_ORIGIN + '/cdn-demo/samples/a.png');
    expect([...init.headers.keys()].sort()).toEqual(['if-none-match', 'range']);
    expect(init.cf).toMatchObject({ cacheEverything: true });
  });

  it('blocks other buckets, including dot-segment and encoded escapes', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'));
    for (const p of ['/other/a.png', '/cdn-demo-evil/a.png', '/cdn-demo/../other/a.png', '/cdn-demo/%2e%2e/other/a.png', '/cdn-demo%2Fa.png', '/cdn-demo']) {
      expect((await call(p)).status, p).toBe(403);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('adds nosniff and leaves origin Cache-Control alone', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x', { headers: { 'Cache-Control': 'public, max-age=60' } }));
    const res = await call('/cdn-demo/samples/a.png');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(spy.mock.calls[0][1].cf).toEqual({ cacheEverything: true });
  });
});
