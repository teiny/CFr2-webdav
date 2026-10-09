import { measureR2 } from './logger';

export const INTERNAL_PREFIX = '.webdav-internal/';

export function internalKey(key: string): boolean {
  return key === INTERNAL_PREFIX.slice(0, -1) || key.startsWith(INTERNAL_PREFIX);
}

export interface Resource {
  key: string;
  collection: boolean;
  object: R2Object | null;
}

export async function resolveResource(bucket: R2Bucket, key: string): Promise<Resource | null> {
  if (internalKey(key)) return null;
  if (!key) return { key: '', collection: true, object: null };
  const object = await measureR2('head', () => bucket.head(key));
  if (object) return { key, collection: key.endsWith('/') || object.customMetadata?.resourcetype === 'collection', object };
  const collectionKey = key.endsWith('/') ? key : key + '/';
  if (collectionKey !== key) {
    const marker = await measureR2('head', () => bucket.head(collectionKey));
    if (marker) return { key: collectionKey, collection: true, object: marker };
  }
  const children = await measureR2('list', () => bucket.list({ prefix: collectionKey, limit: 1 }));
  return children.objects.length ? { key: collectionKey, collection: true, object: null } : null;
}

export async function parentExists(bucket: R2Bucket, key: string): Promise<boolean> {
  const name = key.replace(/\/$/, '');
  const index = name.lastIndexOf('/');
  if (index < 0) return true;
  const parent = await resolveResource(bucket, name.slice(0, index));
  return parent?.collection === true;
}

export async function collectionExists(bucket: R2Bucket, key: string): Promise<boolean> {
  const prefix = key.endsWith('/') ? key : key + '/';
  const result = await measureR2('list', () => bucket.list({ prefix, limit: 1 }));
  return result.objects.length > 0;
}

export async function* listObjects(bucket: R2Bucket, prefix: string): AsyncGenerator<R2Object> {
  let cursor: string | undefined;
  do {
    const page = await measureR2('list', () => bucket.list({ prefix, cursor, include: ['httpMetadata', 'customMetadata'] }));
    for (const object of page.objects) if (!internalKey(object.key)) yield object;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function usedBytes(bucket: R2Bucket): Promise<string> {
  let bytes = 0n;
  for await (const object of listObjects(bucket, '')) bytes += BigInt(object.size);
  return bytes.toString();
}
