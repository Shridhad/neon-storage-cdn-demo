// Same-origin proxy to Neon Auth so the session cookie is first-party: a cross-site cookie from
// *.neonauth.*.neon.tech would be third-party to *.workers.dev and is blocked or partitioned by Safari (ITP).
// Only the endpoints the page uses are reachable; admin and plugin routes on the auth server are not.
const ROUTES = {
  'get-session': 'GET',
  'sign-up/email': 'POST',
  'sign-in/email': 'POST',
  'sign-out': 'POST',
};

const PASS_HEADERS = ['content-type', 'set-auth-jwt', 'x-neon-ret-request-id'];
const PREFIX = '/api/auth/';

// Neon Auth cookies are named __Secure-neon-auth.*; nothing else the browser holds for this origin is forwarded.
const authCookies = (header) =>
  (header ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c.includes('neon-auth'))
    .join('; ');

// Upstream sends SameSite=None; Partitioned for third-party use. Proxied cookies are first-party, and Safari does
// not send Partitioned cookies on top-level navigations, so those attributes are replaced with SameSite=Lax.
function firstParty(setCookie) {
  const attrs = setCookie
    .split(';')
    .map((a) => a.trim())
    .filter((a) => a && !/^(partitioned|domain=|samesite=|secure$)/i.test(a));
  return [...attrs, 'Secure', 'SameSite=Lax'].join('; ');
}

export async function authProxy(request, env) {
  const path = new URL(request.url).pathname.slice(PREFIX.length);
  const method = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
  if (!method) return new Response('Not Found', { status: 404 });
  if (request.method !== method) return new Response('Method Not Allowed', { status: 405, headers: { Allow: method } });

  const headers = new Headers({ Origin: request.headers.get('origin') ?? new URL(request.url).origin });
  for (const name of ['content-type', 'user-agent']) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  const cookie = authCookies(request.headers.get('cookie'));
  if (cookie) headers.set('Cookie', cookie);

  let upstream;
  try {
    upstream = await fetch(`${env.NEON_AUTH_URL}/${path}${new URL(request.url).search}`, {
      method,
      headers,
      body: method === 'POST' ? await request.text() : undefined,
      redirect: 'manual',
    });
  } catch {
    return Response.json({ error: 'Sign-in is temporarily unavailable' }, { status: 502 });
  }

  const out = new Headers({ 'Cache-Control': 'no-store' });
  for (const name of PASS_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  for (const c of upstream.headers.getSetCookie()) out.append('Set-Cookie', firstParty(c));
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
