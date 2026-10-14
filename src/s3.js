import { AwsClient } from 'aws4fetch';

const originOf = (env) => new URL(env.NEON_STORAGE_ORIGIN).origin;

function client(env) {
  return new AwsClient({
    accessKeyId: env.NEON_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.NEON_STORAGE_SECRET_ACCESS_KEY,
    service: 's3',
    region: env.REGION,
  });
}

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function parseListXml(xml) {
  const tag = (block, name) => unescapeXml(block.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? '');
  return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, b]) => ({
    key: tag(b, 'Key'),
    lastModified: tag(b, 'LastModified'),
    size: Number(tag(b, 'Size')),
  }));
}

// A single page (max-keys=1000) is enough: uploads/ is capped at a few hundred keys.
export async function listObjects(env, prefix) {
  const url = `${originOf(env)}/${env.BUCKET}?list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}`;
  const res = await client(env).fetch(url);
  if (!res.ok) throw new Error(`ListObjectsV2 ${prefix}: ${res.status}`);
  return parseListXml(await res.text());
}

export async function deleteObject(env, key) {
  const path = key.split('/').map(encodeURIComponent).join('/');
  const res = await client(env).fetch(`${originOf(env)}/${env.BUCKET}/${path}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`DeleteObject ${key}: ${res.status}`);
}

// Short-lived Cache API entry so a burst of page loads or upload-url calls shares one ListObjectsV2.
export async function listCached(env, prefix, ttl = 5) {
  const cache = caches.default;
  const cacheKey = new Request(`https://list.invalid/${env.BUCKET}/${prefix}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();
  const objects = await listObjects(env, prefix);
  await cache.put(cacheKey, new Response(JSON.stringify(objects), { headers: { 'Cache-Control': `max-age=${ttl}` } }));
  return objects;
}
