// The inline script avoids backticks and ${} so the whole page can live in one template literal.
export const PAGE = `<!doctype html>
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
  .notice { background: #fef3c7; color: #78350f; border-radius: 6px; padding: 8px 12px; margin: 12px 0; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .tile { background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .tile img { width: 100%; height: 150px; object-fit: cover; display: block; background: var(--line); }
  .meta { display: flex; justify-content: space-between; gap: 8px; padding: 6px 8px; font-size: 12px; color: var(--mute); }
  .badge { font-weight: 600; }
  .HIT { color: var(--hit); } .MISS, .EXPIRED, .REVALIDATED { color: var(--miss); }
  code, pre { font-family: ui-monospace, monospace; font-size: 12.5px; }
  pre { overflow-x: auto; margin: 8px 0 0; }
  #status { color: var(--mute); margin-left: 8px; }
</style>
</head>
<body>
<main>
  <h1>Neon Object Storage behind a Cloudflare CDN</h1>
  <div>One Worker serves this page, lists the bucket, signs uploads and caches images at the edge.</div>
  <div class="notice">Demo: uploads are public and deleted after 24h. Images only (PNG, JPEG, WebP, GIF), 2 MiB max.</div>

  <div class="card">
    <input id="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
    <button id="upload">Upload</button><span id="status"></span>
  </div>

  <div id="grid" class="grid"></div>
  <p style="color:var(--mute)">Each badge shows the <code>cf-cache-status</code> of that image request and its load time. Reload the page: the first view of an image is a MISS at your nearest Cloudflare location, later views are HITs.</p>

  <div class="card">
    <strong>How it works</strong>
<pre>browser --GET /bucket/key--&gt; Worker (cache: cf.cacheEverything) --&gt; Neon Object Storage (public_read bucket)
browser --POST /api/upload-url--&gt; Worker signs a POST policy (key, type, size, 5 min)
browser --multipart POST--------&gt; Neon Object Storage directly (bucket CORS allows this origin)
cron (hourly) Worker deletes uploads/ older than 24h</pre>
    Reads go through the Worker so repeat requests are answered from Cloudflare's edge. Uploads skip the Worker so image bytes never count against its limits. The storage credential only exists as a Worker secret.
  </div>
</main>
<script>
var grid = document.getElementById('grid');
var statusEl = document.getElementById('status');
var MAX = 2 * 1024 * 1024;
var TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function tile(bucket, obj) {
  var el = document.createElement('div'); el.className = 'tile';
  var img = document.createElement('img'); img.alt = obj.key;
  var meta = document.createElement('div'); meta.className = 'meta';
  var name = document.createElement('span'); name.textContent = obj.key.split('/').pop().slice(0, 18);
  var badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = '...';
  meta.append(name, badge); el.append(img, meta);
  var t0 = performance.now();
  // no-store keeps the browser cache out of the way so the badge reflects the Cloudflare cache.
  fetch('/' + bucket + '/' + obj.key, { cache: 'no-store' }).then(function (r) {
    var cs = r.headers.get('cf-cache-status') || 'n/a';
    return r.blob().then(function (b) {
      img.src = URL.createObjectURL(b);
      badge.textContent = cs + ' ' + Math.round(performance.now() - t0) + ' ms';
      badge.classList.add(cs);
    });
  }).catch(function () { badge.textContent = 'error'; });
  return el;
}

function load(extra) {
  return fetch('/api/list').then(function (r) { return r.json(); }).then(function (d) {
    var objects = d.objects;
    if (extra && !objects.some(function (o) { return o.key === extra; })) objects = [{ key: extra }].concat(objects);
    grid.replaceChildren.apply(grid, objects.map(function (o) { return tile(d.bucket, o); }));
  });
}

document.getElementById('upload').onclick = function () {
  var f = document.getElementById('file').files[0];
  if (!f) { statusEl.textContent = 'Choose an image first.'; return; }
  if (TYPES.indexOf(f.type) < 0) { statusEl.textContent = 'Only PNG, JPEG, WebP or GIF.'; return; }
  if (f.size > MAX) { statusEl.textContent = 'Max 2 MiB.'; return; }
  statusEl.textContent = 'Uploading...';
  fetch('/api/upload-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentType: f.type, size: f.size }) })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); })
    .then(function (p) {
      var form = new FormData();
      Object.keys(p.fields).forEach(function (k) { form.append(k, p.fields[k]); });
      form.append('file', f); // must be the last field
      return fetch(p.url, { method: 'POST', body: form }).then(function (r) {
        if (!r.ok) throw new Error('storage returned ' + r.status);
        statusEl.textContent = 'Uploaded.';
        return load(p.key);
      });
    })
    .catch(function (e) { statusEl.textContent = 'Failed: ' + e.message; });
};

load();
</script>
</body>
</html>`;
