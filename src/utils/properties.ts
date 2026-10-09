import { StoredProperty } from '../types';
import { INTERNAL_PREFIX } from './resources';
import { measureR2 } from './logger';
import { elements, escapeXML, parseXML, propertyElement, serializeXML } from './xml';

interface PropertyState {
  format: 1;
  path: string;
  revision: string;
  creationdate?: string;
  properties: StoredProperty[];
}

export interface PropertyChange {
  remove: boolean;
  property: StoredProperty;
}

export const liveProperties = ['creationdate', 'displayname', 'getcontentlanguage', 'getcontentlength',
  'getcontenttype', 'getetag', 'getlastmodified', 'resourcetype'] as const;
const protectedProperties = [...liveProperties.filter(name => name !== 'displayname'),
  'quota-used-bytes', 'quota-available-bytes', 'supportedlock', 'lockdiscovery'];
const identity = (property: { name: string; namespace: string }) => JSON.stringify([property.namespace, property.name]);

export async function propertyKey(path: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path)));
  return INTERNAL_PREFIX + 'properties/' + Array.from(digest, value => value.toString(16).padStart(2, '0')).join('') + '.json';
}

export async function readProperties(bucket: R2Bucket, path: string): Promise<{ object: R2Object | null; state: PropertyState }> {
  const object = await measureR2('get', async () => bucket.get(await propertyKey(path)));
  if (!object) return { object: null, state: { format: 1, path, revision: '', properties: [] } };
  const state = await object.json<PropertyState>();
  if (state.format !== 1 || state.path !== path || !Array.isArray(state.properties)) {
    throw new Error('Invalid internal property record');
  }
  return { object, state };
}

export async function deleteProperties(bucket: R2Bucket, path: string): Promise<void> {
  await measureR2('delete', () => propertyKey(path).then(key => bucket.delete(key)));
}

export async function copyProperties(bucket: R2Bucket, source: string, target: string, creationdate: string): Promise<void> {
  const { object, state } = await readProperties(bucket, source);
  if (!object || (state.creationdate && state.creationdate !== creationdate)) {
    await deleteProperties(bucket, target);
    return;
  }
  const copied = { ...state, path: target, creationdate, revision: crypto.randomUUID() };
  await measureR2('put', () => propertyKey(target).then(key => bucket.put(key, JSON.stringify(copied), {
    httpMetadata: { contentType: 'application/json' }
  })));
}

export function parseProppatch(body: string): PropertyChange[] {
  const root = parseXML(body);
  if (root.namespace !== 'DAV:' || root.name !== 'propertyupdate') throw new Error('Expected DAV:propertyupdate');
  const changes: PropertyChange[] = [];
  for (const action of elements(root)) {
    if (action.namespace !== 'DAV:') continue;
    if (!['set', 'remove'].includes(action.name)) continue;
    const containers = elements(action).filter(node => node.namespace === 'DAV:' && node.name === 'prop');
    if (containers.length !== 1) throw new Error('Expected DAV:prop');
    for (const node of elements(containers[0])) {
      if (action.name === 'remove' && node.children.some(child => typeof child !== 'string' || child.trim())) {
        throw new Error('Remove requires an empty property');
      }
      changes.push({ remove: action.name === 'remove', property: {
        name: node.name, namespace: node.namespace, xml: serializeXML(node)
      } });
    }
  }
  if (!changes.length) throw new Error('Missing property changes');
  return changes;
}

function patchResponse(href: string, changes: PropertyChange[], statuses: number[]): Response {
  const groups = new Map<number, StoredProperty[]>();
  changes.forEach((change, index) => {
    const status = statuses[index];
    groups.set(status, [...(groups.get(status) || []), change.property]);
  });
  const reasons: Record<number, string> = { 200: 'OK', 403: 'Forbidden', 409: 'Conflict', 412: 'Precondition Failed', 424: 'Failed Dependency', 507: 'Insufficient Storage' };
  const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${escapeXML(href)}</D:href>${Array.from(groups, ([status, props]) =>
    `<D:propstat><D:prop>${props.map(prop => propertyElement(prop.name, prop.namespace)).join('')}</D:prop><D:status>HTTP/1.1 ${status} ${reasons[status]}</D:status>${status === 403 ? '<D:error><D:cannot-modify-protected-property/></D:error>' : ''}</D:propstat>`).join('')}</D:response></D:multistatus>`;
  return new Response(xml, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}

export async function updateProperties(bucket: R2Bucket, path: string, href: string,
  creationdate: string | undefined, changes: PropertyChange[]): Promise<Response> {
  const invalid = changes.map(change => {
    const prop = change.property;
    if (prop.namespace === 'DAV:' && protectedProperties.includes(prop.name)) return 403;
    if (prop.namespace === 'DAV:' && prop.name === 'displayname' && !change.remove && elements(parseXML(prop.xml)).length) return 409;
    return 200;
  });
  if (invalid.some(status => status !== 200)) return patchResponse(href, changes, invalid.map(status => status === 200 ? 424 : status));
  const { object, state } = await readProperties(bucket, path);
  const stale = creationdate && state.creationdate && creationdate !== state.creationdate;
  const properties = new Map((stale ? [] : state.properties).map(prop => [identity(prop), prop]));
  for (const change of changes) {
    if (change.remove) properties.delete(identity(change.property));
    else properties.set(identity(change.property), change.property);
  }
  const updated: PropertyState = { format: 1, path, revision: crypto.randomUUID(),
    creationdate: creationdate ?? state.creationdate, properties: [...properties.values()] };
  const body = JSON.stringify(updated);
  if (new TextEncoder().encode(body).length > 1024 * 1024) {
    return patchResponse(href, changes, changes.map(() => 507));
  }
  const saved = await measureR2('put', () => propertyKey(path).then(key => bucket.put(key, body, {
    onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' }
  })));
  return saved ? patchResponse(href, changes, changes.map(() => 200)) :
    new Response(null, { status: 412 });
}
