// 文件名：src/utils/webdavUtils.ts
import { WebDAVProps } from '../types';
import { measureR2 } from './logger';
import { internalKey } from './resources';
import { elements, escapeXML, parseXML, propertyElement } from './xml';
import { liveProperties } from './properties';

export function make_resource_path(request: Request): string {
  const url = new URL(request.url);
  return url.pathname.slice(1).split('/').map(segment => {
    const decoded = decodeURIComponent(segment);
    if (decoded.includes('/') || decoded === '.' || decoded === '..' || decoded.includes('\u0000')) {
      throw new URIError('Invalid path segment');
    }
    return decoded;
  }).join('/');
}

export function resourceHref(key: string): string {
  return '/' + key.split('/').map(encodeURIComponent).join('/');
}

export async function* listAll(bucket: R2Bucket, prefix: string): AsyncGenerator<WebDAVProps> {
  const options: R2ListOptions & { include: ('httpMetadata' | 'customMetadata')[] } = {
    prefix, delimiter: '/', include: ['httpMetadata', 'customMetadata']
  };
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await measureR2('list', () => bucket.list({ ...options, cursor }));
    for (const object of result.objects) {
      if (!internalKey(object.key) && !seen.has(object.key)) {
        seen.add(object.key);
        yield fromR2Object(object);
      }
    }
    for (const key of result.delimitedPrefixes) {
      if (!internalKey(key) && !seen.has(key)) {
        seen.add(key);
        yield fromR2Object(null, key);
      }
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
}

export function fromR2Object(object: R2Object | null, key = object?.key || ''): WebDAVProps {
  if (!object) {
    return {
      href: resourceHref(key),
      creationdate: undefined,
      displayname: key.replace(/\/$/, '').split('/').pop(),
      getcontentlanguage: undefined,
      getcontentlength: "0",
      getcontenttype: undefined,
      getetag: undefined,
      getlastmodified: undefined,
      resourcetype: "collection"
    };
  }
  return {
    href: resourceHref(key),
    creationdate: object.customMetadata?.creationdate || object.uploaded.toISOString(),
    displayname: key.replace(/\/$/, '').split('/').pop(),
    getcontentlanguage: object.httpMetadata?.contentLanguage,
    getcontentlength: object.size.toString(),
    getcontenttype: object.httpMetadata?.contentType,
    getetag: object.httpEtag,
    getlastmodified: object.uploaded.toUTCString(),
    resourcetype: object.customMetadata?.resourcetype || (key.endsWith('/') ? 'collection' : '')
  };
}

export interface RequestedProp {
  name: string;
  namespace: string;
}

export interface PropfindSelection {
  mode: 'allprop' | 'propname' | 'prop';
  properties: RequestedProp[];
}

export function parsePropfind(body: string): PropfindSelection {
  if (!body.trim()) return { mode: 'allprop', properties: [] };
  const root = parseXML(body);
  if (root.namespace !== 'DAV:' || root.name !== 'propfind') throw new Error('Expected DAV:propfind');
  const children = elements(root).filter(node => node.namespace === 'DAV:');
  const modes = children.filter(node => ['allprop', 'propname', 'prop'].includes(node.name));
  const includes = children.filter(node => node.name === 'include');
  if (modes.length !== 1 || includes.length > 1 || (includes.length && modes[0].name !== 'allprop')) {
    throw new Error('Expected one property selection');
  }
  const mode = modes[0].name as PropfindSelection['mode'];
  if (mode !== 'prop' && elements(modes[0]).length) throw new Error('Expected empty selection');
  const requested = mode === 'prop' ? elements(modes[0]) : includes.flatMap(elements);
  if (requested.some(node => node.children.some(child => typeof child !== 'string' || child.trim()))) {
    throw new Error('Property names must be empty');
  }
  return { mode, properties: requested.map(node => ({ name: node.name, namespace: node.namespace })) };
}

export function generatePropfindResponse(props: WebDAVProps[], selection: PropfindSelection): string {
  const responses = props.map(prop => generatePropResponse(prop, selection)).join("\n");
  return `<?xml version="1.0" encoding="utf-8" ?>
  <D:multistatus xmlns:D="DAV:">
${responses}
  </D:multistatus>`;
}

function generatePropResponse(prop: WebDAVProps, selection: PropfindSelection): string {
  const defaults: RequestedProp[] = liveProperties
    .filter(name => prop[name] !== undefined).map(name => ({ name, namespace: 'DAV:' }));
  for (const property of prop.deadProperties || []) {
    if (!defaults.some(item => item.name === property.name && item.namespace === property.namespace)) defaults.push(property);
  }
  if (selection.mode === 'propname' && prop.quotaSupported) defaults.push({ name: 'quota-used-bytes', namespace: 'DAV:' });
  const selected = selection.mode === 'prop' ? selection.properties : [...defaults, ...selection.properties];
  const requested = selected.filter((property, index) => selected.findIndex(other => other.name === property.name && other.namespace === property.namespace) === index);
  const found: string[] = [];
  const missing: string[] = [];
  for (const property of requested) {
    const stored = prop.deadProperties?.find(item => item.name === property.name && item.namespace === property.namespace);
    const supported = property.namespace === 'DAV:' && liveProperties.some(name => name === property.name);
    const value = supported ? prop[property.name as typeof liveProperties[number]] :
      property.namespace === 'DAV:' && property.name === 'quota-used-bytes' ? prop.quotaUsedBytes : undefined;
    if (value === undefined && !stored && !(selection.mode === 'propname' && property.name === 'quota-used-bytes' && prop.quotaSupported)) {
      missing.push(propertyElement(property.name, property.namespace));
    } else if (selection.mode === 'propname') {
      found.push(propertyElement(property.name, property.namespace));
    } else if (stored) {
      found.push(stored.xml);
    } else {
      const content = property.name === 'resourcetype' ? (value ? '<D:collection/>' : '') : escapeXML(value ?? '');
      found.push(propertyElement(property.name, property.namespace, content));
    }
  }
  const propstat = (properties: string[], status: string) => properties.length || (!requested.length && status === '200 OK') ? `
    <D:propstat><D:prop>${properties.join('')}</D:prop>
      <D:status>HTTP/1.1 ${status}</D:status></D:propstat>` : '';
  return `  <D:response>
    <D:href>${escapeXML(prop.href)}</D:href>${propstat(found, '200 OK')}${propstat(missing, '404 Not Found')}
  </D:response>`;
}
