export const LIMIT = 5;
const WINDOW_MS = 60_000;

// Per-isolate fallback for when the Rate Limiting binding is absent (local dev, or a plan without it).
// Isolates are not shared across Cloudflare locations, so this only slows a single client down.
const windows = new Map();

export const resetFallback = () => windows.clear();

export async function allow(env, ip, now = Date.now()) {
  if (env.UPLOAD_LIMITER) return (await env.UPLOAD_LIMITER.limit({ key: ip })).success;

  const w = windows.get(ip);
  if (!w || now - w.start >= WINDOW_MS) {
    windows.set(ip, { start: now, count: 1 });
    return true;
  }
  return ++w.count <= LIMIT;
}
