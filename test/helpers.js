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
