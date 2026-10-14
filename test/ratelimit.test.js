import { describe, expect, it, vi } from 'vitest';
import { allow, LIMIT, resetFallback } from '../src/ratelimit.js';

describe('allow', () => {
  it('delegates to the Workers Rate Limiting binding when present', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    expect(await allow({ UPLOAD_LIMITER: { limit } }, '1.2.3.4')).toBe(false);
    expect(limit).toHaveBeenCalledWith({ key: '1.2.3.4' });
  });

  it('falls back to a per-IP in-memory window', async () => {
    resetFallback();
    const t0 = 1_000_000;
    for (let i = 0; i < LIMIT; i++) expect(await allow({}, 'a', t0 + i)).toBe(true);
    expect(await allow({}, 'a', t0 + LIMIT)).toBe(false);
    expect(await allow({}, 'b', t0 + LIMIT)).toBe(true);
  });

  it('opens a new window after 60 seconds', async () => {
    resetFallback();
    for (let i = 0; i < LIMIT; i++) await allow({}, 'a', 0);
    expect(await allow({}, 'a', 1000)).toBe(false);
    expect(await allow({}, 'a', 60_001)).toBe(true);
  });
});
