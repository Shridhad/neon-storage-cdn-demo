// Uploads one sample with SigV4 (PutObject has no management-API equivalent).
// Reads S3_ENDPOINT, S3_REGION, BUCKET, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from the environment.
// Usage: s3.mjs put <key> <file> <content-type>
import { readFileSync } from 'node:fs';
import { AwsClient } from 'aws4fetch';

const { S3_ENDPOINT, S3_REGION, BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = process.env;
const aws = new AwsClient({ accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY, service: 's3', region: S3_REGION });

const [cmd, key, file, contentType] = process.argv.slice(2);
if (cmd !== 'put' || !key || !file || !contentType) {
  console.error('usage: s3.mjs put <key> <file> <content-type>');
  process.exit(2);
}

const res = await aws.fetch(`${new URL(S3_ENDPOINT).origin}/${BUCKET}/${key}`, {
  method: 'PUT',
  headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' },
  body: readFileSync(file),
});
if (!res.ok) {
  console.error(`PutObject ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
console.log(`PutObject ${key}: ${res.status}`);
