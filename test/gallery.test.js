import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { env } from './helpers.js';

const call = (path, init) => worker.fetch(new Request('https://demo.example.workers.dev' + path, init), env, {});

describe('gallery', () => {
  it('serves HTML listing the six sample keys through the bucket path', async () => {
    const res = await call('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('"cdn-demo"');
    for (let i = 1; i <= 6; i++) expect(html).toContain(`samples/sample-${i}.png`);
  });

  it('rejects POST on / with 405', async () => {
    const res = await call('/', { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
