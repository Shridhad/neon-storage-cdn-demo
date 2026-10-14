// S3 calls that need SigV4 with the demo credential: PutBucketCors and PutObject.
// Reads S3_ENDPOINT, S3_REGION, BUCKET, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from the environment.
import { readFileSync } from 'node:fs';
import { AwsClient } from 'aws4fetch';

const { S3_ENDPOINT, S3_REGION, BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = process.env;
const aws = new AwsClient({ accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY, service: 's3', region: S3_REGION });
const base = `${new URL(S3_ENDPOINT).origin}/${BUCKET}`;

async function send(label, url, init) {
  const res = await aws.fetch(url, init);
  if (!res.ok) {
    console.error(`${label} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`${label}: ${res.status}`);
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'cors') {
  const [origin] = args;
  const xml = `<CORSConfiguration><CORSRule><AllowedOrigin>${origin}</AllowedOrigin><AllowedMethod>POST</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>`;
  await send('PutBucketCors', `${base}?cors`, { method: 'PUT', headers: { 'Content-Type': 'application/xml' }, body: xml });
} else if (cmd === 'put') {
  const [key, file, contentType] = args;
  await send(`PutObject ${key}`, `${base}/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' },
    body: readFileSync(file),
  });
} else {
  console.error('usage: s3.mjs cors <origin> | put <key> <file> <content-type>');
  process.exit(2);
}
