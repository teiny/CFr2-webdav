import { Resource, listObjects } from './resources';
import { copyProperties, propertyKey } from './properties';
import { measureR2 } from './logger';

export interface Failure { key: string; status: number }

export async function resourceTree(bucket: R2Bucket, resource: Resource): Promise<Resource[]> {
  const entries = new Map<string, Resource>([[resource.key, resource]]);
  if (resource.collection) {
    for await (const object of listObjects(bucket, resource.key)) {
      entries.set(object.key, { key: object.key, collection: object.key.endsWith('/') || object.customMetadata?.resourcetype === 'collection', object });
      let parent = object.key.replace(/\/$/, '');
      while (parent.lastIndexOf('/') >= resource.key.length) {
        parent = parent.slice(0, parent.lastIndexOf('/'));
        const key = parent + '/';
        if (!entries.has(key)) entries.set(key, { key, collection: true, object: null });
      }
    }
  }
  return [...entries.values()].sort((a, b) => a.key.split('/').length - b.key.split('/').length ||
    Number(b.collection) - Number(a.collection) || a.key.localeCompare(b.key));
}

export async function deleteTree(bucket: R2Bucket, entries: Resource[], expected?: Map<string, R2Object>): Promise<Failure[]> {
  const failures: Failure[] = [];
  const files = entries.filter(entry => !entry.collection);
  for (let offset = 0; offset < files.length; offset += 1000) {
    const batch = files.slice(offset, offset + 1000);
    const ready: Resource[] = [];
    for (const entry of batch) {
      const original = expected?.get(entry.key);
      if (original) {
        const current = await measureR2('head', () => bucket.head(entry.key));
        if (!current || current.version !== original.version) {
          failures.push({ key: entry.key, status: 409 });
          continue;
        }
      }
      ready.push(entry);
    }
    if (!ready.length) continue;
    try {
      await measureR2('delete', () => bucket.delete(ready.map(entry => entry.key)));
      const properties = await Promise.all(ready.map(entry => propertyKey(entry.key)));
      await measureR2('delete', () => bucket.delete(properties));
    } catch {
      failures.push(...ready.map(entry => ({ key: entry.key, status: 500 })));
    }
  }
  for (const entry of entries.filter(entry => entry.collection).reverse()) {
    if (failures.some(failure => failure.key === entry.key || failure.key.startsWith(entry.key))) continue;
    try {
      const original = expected?.get(entry.key);
      if (original) {
        const current = await measureR2('head', () => bucket.head(entry.key));
        if (!current || current.version !== original.version) {
          failures.push({ key: entry.key, status: 409 });
          continue;
        }
      }
      const remaining = await measureR2('list', () => bucket.list({ prefix: entry.key, limit: 2 }));
      if (remaining.objects.some(object => object.key !== entry.key)) {
        failures.push({ key: entry.key, status: 409 });
        continue;
      }
      if (entry.object) await measureR2('delete', () => bucket.delete(entry.key));
      await measureR2('delete', async () => bucket.delete(await propertyKey(entry.key)));
    } catch {
      failures.push({ key: entry.key, status: 500 });
    }
  }
  return failures;
}

export async function copyTree(bucket: R2Bucket, entries: Resource[], source: string, target: string,
  overwrite: boolean): Promise<Failure[]> {
  const failures: Failure[] = [];
  const blocked: string[] = [];
  for (const entry of entries) {
    if (blocked.some(prefix => entry.key.startsWith(prefix))) continue;
    const key = target + entry.key.slice(source.length);
    try {
      const input = entry.collection ? null : await measureR2('get', () => bucket.get(entry.key, {
        onlyIf: entry.object ? { etagMatches: entry.object.etag } : undefined
      }));
      if (!entry.collection && (!input || !('body' in input))) {
        failures.push({ key: entry.key, status: input ? 412 : 404 });
        continue;
      }
      const creationdate = entry.object?.customMetadata?.creationdate || entry.object?.uploaded.toISOString() || new Date().toISOString();
      const saved = await measureR2('put', () => bucket.put(key, input && 'body' in input ? input.body : new Uint8Array(), {
        onlyIf: overwrite ? undefined : { etagDoesNotMatch: '*' },
        httpMetadata: entry.object?.httpMetadata,
        customMetadata: { ...entry.object?.customMetadata, creationdate,
          ...(entry.collection ? { resourcetype: 'collection' } : {}) }
      }));
      if (!saved) {
        if (input && 'body' in input) await input.body.cancel().catch(() => {});
        failures.push({ key, status: 412 });
        if (entry.collection) blocked.push(entry.key);
        continue;
      }
      await copyProperties(bucket, entry.key, key, creationdate);
    } catch {
      failures.push({ key, status: 500 });
      if (entry.collection) blocked.push(entry.key);
    }
  }
  return failures;
}
