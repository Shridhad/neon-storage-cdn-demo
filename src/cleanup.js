import { deleteObject, listObjects } from './s3.js';

export const MAX_AGE_MS = 24 * 3600_000;
// Free-plan Workers allow 50 subrequests per invocation: one list plus this many deletes. Hourly runs drain any backlog.
const MAX_DELETES = 40;

export function selectExpired(objects, now = Date.now()) {
  return objects.filter((o) => o.key.startsWith('uploads/') && now - Date.parse(o.lastModified) > MAX_AGE_MS);
}

export async function cleanup(env, now = Date.now()) {
  const expired = selectExpired(await listObjects(env, 'uploads/'), now).slice(0, MAX_DELETES);
  for (const o of expired) await deleteObject(env, o.key);
  return expired.length;
}
