export async function proxy(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  const { pathname } = new URL(request.url);
  // Without this check the Worker would serve every bucket on the branch.
  if (!pathname.startsWith(`/${env.BUCKET}/`)) return new Response('Forbidden', { status: 403 });

  // Append the path to the fixed origin as a string. Resolving it with new URL(path, origin)
  // would let a path like //example.com replace the host. The query string is dropped so it
  // can't be used to bypass the cache.
  const upstream = new URL(env.NEON_STORAGE_ORIGIN).origin + pathname;

  // Forward only what is needed for partial and conditional requests.
  // Authorization and cookies are never sent to the origin.
  const headers = new Headers();
  for (const name of ['Range', 'If-None-Match']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  // Browser POST uploads are stored without Cache-Control, so uploads/ keys (random, never rewritten) get an explicit TTL.
  const isUpload = pathname.startsWith(`/${env.BUCKET}/uploads/`);
  const cf = { cacheEverything: true };
  if (isUpload) cf.cacheTtlByStatus = { '200-299': 86400 };

  const upstreamRes = await fetch(upstream, { method: request.method, headers, cf });

  // Object bytes are user-supplied, so stop browsers from sniffing them into something other than the stored image type.
  const res = new Response(upstreamRes.body, upstreamRes);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  if (isUpload && !res.headers.has('Cache-Control')) res.headers.set('Cache-Control', 'public, max-age=86400, immutable');
  return res;
}
