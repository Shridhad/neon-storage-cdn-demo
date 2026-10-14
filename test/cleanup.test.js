import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, selectExpired } from '../src/cleanup.js';
import { env, listXml } from './helpers.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const H = 3600_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

afterEach(() => vi.restoreAllMocks());

describe('selectExpired', () => {
  it('selects only uploads/ objects older than 24h', () => {
    const objs = [
      { key: 'uploads/old.png', lastModified: iso(25 * H) },
      { key: 'uploads/new.png', lastModified: iso(1 * H) },
      { key: 'uploads/edge.png', lastModified: iso(24 * H - 1000) },
      { key: 'samples/ancient.png', lastModified: iso(900 * H) },
    ];
    expect(selectExpired(objs, NOW).map((o) => o.key)).toEqual(['uploads/old.png']);
  });
});

describe('cleanup', () => {
  it('lists uploads/ and deletes only the expired keys', async () => {
    const calls = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      calls.push(req.method + ' ' + new URL(req.url).pathname + new URL(req.url).search);
      if (req.method === 'GET') {
        return new Response(listXml([
          { key: 'uploads/old.png', lastModified: iso(30 * H) },
          { key: 'uploads/fresh.png', lastModified: iso(2 * H) },
        ]));
      }
      return new Response(null, { status: 204 });
    });
    const n = await cleanup(env, NOW);
    expect(n).toBe(1);
    expect(calls[0]).toContain('GET /cdn-demo');
    expect(calls[0]).toContain('prefix=uploads%2F');
    expect(calls.slice(1)).toEqual(['DELETE /cdn-demo/uploads/old.png']);
  });

  it('stays under the free-plan subrequest limit', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ key: `uploads/${i}.png`, lastModified: iso(48 * H) }));
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) =>
      new Request(input, init).method === 'GET' ? new Response(listXml(many)) : new Response(null, { status: 204 }),
    );
    expect(await cleanup(env, NOW)).toBe(40);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(49);
  });
});
