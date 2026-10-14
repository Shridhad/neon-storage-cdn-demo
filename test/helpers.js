export const env = {
  NEON_STORAGE_ORIGIN: 'https://br-demo-1.storage.c-2.us-east-2.aws.neon.tech',
  BUCKET: 'cdn-demo',
  REGION: 'us-east-2',
  NEON_STORAGE_ACCESS_KEY_ID: 'nak_live_0123456789abcdef0123456789abcdef',
  NEON_STORAGE_SECRET_ACCESS_KEY: 'nsk_live_test_secret',
};

export function listXml(items) {
  const contents = items
    .map((o) => `<Contents><Key>${o.key}</Key><LastModified>${o.lastModified}</LastModified><Size>${o.size ?? 10}</Size></Contents>`)
    .join('');
  return `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
}

// Shaped like the values setup-auth.sh writes: the auth URL carries /<db>/auth, while iss/aud are its bare origin
// (verified against a live Neon Auth token).
export const AUTH_ORIGIN = 'https://ep-test-1234.neonauth.c-2.us-east-2.aws.neon.tech';
export const authEnv = {
  ...env,
  NEON_AUTH_URL: `${AUTH_ORIGIN}/neondb/auth`,
  NEON_AUTH_JWKS_URL: `${AUTH_ORIGIN}/neondb/auth/.well-known/jwks.json`,
  NEON_AUTH_ISSUER: AUTH_ORIGIN,
  NEON_AUTH_AUDIENCE: AUTH_ORIGIN,
};
