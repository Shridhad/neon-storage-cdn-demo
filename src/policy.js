export const MAX_BYTES = 2 * 1024 * 1024;
export const EXPIRES_SECONDS = 300;

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}

// The storage service accepts the SigV4 POST form: x-amz-signature = hex(HMAC-SHA256(signingKey, base64(policy))).
// It checks bucket, key, Content-Type and content-length-range against the submitted form and rejects any
// submitted field that no condition names. It does not store a Cache-Control form field, so none is sent.
export async function buildUploadPolicy(env, contentType, now = new Date()) {
  const ext = EXTENSIONS[contentType];
  if (!ext) throw new Error(`unsupported content type: ${contentType}`);

  const key = `uploads/${crypto.randomUUID()}.${ext}`;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const day = amzDate.slice(0, 8);
  const credential = `${env.NEON_STORAGE_ACCESS_KEY_ID}/${day}/${env.REGION}/s3/aws4_request`;
  const expiration = new Date(now.getTime() + EXPIRES_SECONDS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const policy = btoa(
    JSON.stringify({
      expiration,
      conditions: [
        { bucket: env.BUCKET },
        ['eq', '$key', key],
        ['eq', '$Content-Type', contentType],
        ['content-length-range', 1, MAX_BYTES],
        ['eq', '$success_action_status', '201'],
        ['eq', '$x-amz-algorithm', 'AWS4-HMAC-SHA256'],
        ['eq', '$x-amz-credential', credential],
        ['eq', '$x-amz-date', amzDate],
      ],
    }),
  );

  let signingKey = enc.encode('AWS4' + env.NEON_STORAGE_SECRET_ACCESS_KEY);
  for (const part of [day, env.REGION, 's3', 'aws4_request']) signingKey = await hmac(signingKey, part);

  return {
    url: `${new URL(env.NEON_STORAGE_ORIGIN).origin}/${env.BUCKET}`,
    key,
    expiresAt: expiration,
    fields: {
      key,
      'Content-Type': contentType,
      success_action_status: '201',
      'x-amz-algorithm': 'AWS4-HMAC-SHA256',
      'x-amz-credential': credential,
      'x-amz-date': amzDate,
      policy,
      'x-amz-signature': hex(await hmac(signingKey, policy)),
    },
  };
}
