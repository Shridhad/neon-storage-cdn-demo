import { renderPage } from './page.js';
import { proxy } from './proxy.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      }
      return new Response(request.method === 'HEAD' ? null : renderPage(env.BUCKET), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return proxy(request, env);
  },
};
