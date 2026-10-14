import { SAMPLE_KEYS } from './samples.js';

// The inline script avoids backticks and ${} so the whole page can live in one template literal.
export const renderPage = (bucket) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Neon Object Storage + Cloudflare CDN demo</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fafafa; --card: #fff; --line: #ddd; --mute: #666; --hit: #0a7d36; --miss: #b45309; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --bg: #151515; --card: #1f1f1f; --line: #333; --mute: #aaa; --hit: #4ade80; --miss: #fbbf24; } }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; color: var(--fg); background: var(--bg); }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-top: 16px; }
  .tile { background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .tile img { width: 100%; height: 150px; object-fit: cover; display: block; background: var(--line); }
  .meta { display: flex; justify-content: space-between; gap: 8px; padding: 6px 8px; font-size: 12px; color: var(--mute); }
  .badge { font-weight: 600; }
  .HIT { color: var(--hit); } .MISS, .EXPIRED, .REVALIDATED { color: var(--miss); }
  code, pre { font-family: ui-monospace, monospace; font-size: 12.5px; }
  pre { overflow-x: auto; margin: 8px 0 0; }
</style>
</head>
<body>
<main>
  <h1>Neon Object Storage behind a Cloudflare CDN</h1>
  <div>Six sample images in a public_read bucket, served through a Cloudflare Worker that caches them at the edge.</div>

  <div id="grid" class="grid"></div>
  <p style="color:var(--mute)">Each badge shows the <code>cf-cache-status</code> of that image request and its load time. Reload the page: the first view of an image is a MISS at your nearest Cloudflare location, later views are HITs.</p>

  <div class="card">
    <strong>How it works</strong>
<pre>browser --GET /${bucket}/&lt;key&gt;--&gt; Worker (cache: cf.cacheEverything) --&gt; Neon Object Storage (public_read bucket)</pre>
    The Worker is the proxy from the Neon guide "Serve objects through a CDN (Cloudflare)". It only serves this bucket, forwards just <code>Range</code> and <code>If-None-Match</code>, and keeps the upstream host fixed. Repeat requests are answered from Cloudflare's cache without touching Neon.
  </div>
</main>
<script>
var BUCKET = ${JSON.stringify(bucket)};
var KEYS = ${JSON.stringify(SAMPLE_KEYS)};
var grid = document.getElementById('grid');

function tile(key) {
  var el = document.createElement('div'); el.className = 'tile';
  var img = document.createElement('img'); img.alt = key;
  var meta = document.createElement('div'); meta.className = 'meta';
  var name = document.createElement('span'); name.textContent = key.split('/').pop();
  var badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = '...';
  meta.append(name, badge); el.append(img, meta);
  var t0 = performance.now();
  // no-store keeps the browser cache out of the way so the badge reflects the Cloudflare cache.
  fetch('/' + BUCKET + '/' + key, { cache: 'no-store' }).then(function (r) {
    var cs = r.headers.get('cf-cache-status') || 'n/a';
    return r.blob().then(function (b) {
      img.src = URL.createObjectURL(b);
      badge.textContent = cs + ' ' + Math.round(performance.now() - t0) + ' ms';
      badge.classList.add(cs);
    });
  }).catch(function () { badge.textContent = 'error'; });
  return el;
}

grid.replaceChildren.apply(grid, KEYS.map(tile));
</script>
</body>
</html>`;
