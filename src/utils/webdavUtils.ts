// 文件名：src/utils/webdavUtils.ts
import { SaxesParser } from 'saxes';
import { WebDAVProps } from '../types';
import { measureR2 } from './logger';

export function make_resource_path(request: Request): string {
  const url = new URL(request.url);
  return decodeURIComponent(url.pathname.slice(1));
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
      if (!seen.has(object.key)) {
        seen.add(object.key);
        yield fromR2Object(object);
      }
    }
    for (const key of result.delimitedPrefixes) {
      if (!seen.has(key)) {
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
    creationdate: object.uploaded.toISOString(),
    displayname: key.replace(/\/$/, '').split('/').pop(),
    getcontentlanguage: object.httpMetadata?.contentLanguage,
    getcontentlength: object.size.toString(),
    getcontenttype: object.httpMetadata?.contentType,
    getetag: object.httpEtag,
    getlastmodified: object.uploaded.toUTCString(),
    resourcetype: object.customMetadata?.resourcetype || (key.endsWith('/') ? 'collection' : '')
  };
}

interface RequestedProp {
  name: string;
  namespace: string;
}

export interface PropfindSelection {
  mode: 'allprop' | 'propname' | 'prop';
  properties: RequestedProp[];
}

export function parsePropfind(body: string): PropfindSelection {
  if (!body.trim()) return { mode: 'allprop', properties: [] };
  const selection: PropfindSelection = { mode: 'allprop', properties: [] };
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  let modes = 0;
  parser.on('doctype', () => { throw new Error('DOCTYPE is not supported'); });
  parser.on('error', error => { throw error; });
  parser.on('opentag', tag => {
    depth++;
    if (depth === 1 && (tag.uri !== 'DAV:' || tag.local !== 'propfind')) {
      throw new Error('Expected DAV:propfind');
    }
    if (depth === 2) {
      if (tag.uri !== 'DAV:' || !['allprop', 'propname', 'prop'].includes(tag.local)) {
        throw new Error('Unsupported property selection');
      }
      selection.mode = tag.local as PropfindSelection['mode'];
      modes++;
    }
    if (depth === 3 && selection.mode === 'prop') {
      selection.properties.push({ name: tag.local, namespace: tag.uri });
    } else if (depth > 2) {
      throw new Error('Invalid property selection');
    }
  });
  parser.on('closetag', () => { depth--; });
  parser.write(body).close();
  if (modes !== 1) throw new Error('Expected one property selection');
  return selection;
}

const propertyNames = ['creationdate', 'displayname', 'getcontentlanguage', 'getcontentlength', 'getcontenttype',
  'getetag', 'getlastmodified', 'resourcetype'] as const;

function escapeXML(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function generatePropfindResponse(props: WebDAVProps[], selection: PropfindSelection): string {
  const responses = props.map(prop => generatePropResponse(prop, selection)).join("\n");
  return `<?xml version="1.0" encoding="utf-8" ?>
  <D:multistatus xmlns:D="DAV:">
${responses}
  </D:multistatus>`;
}

function generatePropResponse(prop: WebDAVProps, selection: PropfindSelection): string {
  const requested = selection.mode === 'prop' ? selection.properties : propertyNames
    .filter(name => prop[name] !== undefined).map(name => ({ name, namespace: 'DAV:' }));
  const found: string[] = [];
  const missing: string[] = [];
  for (const property of requested) {
    const supported = property.namespace === 'DAV:' && propertyNames.some(name => name === property.name);
    const value = supported ? prop[property.name as typeof propertyNames[number]] : undefined;
    const prefix = property.namespace === 'DAV:' ? 'D' :
      property.namespace === 'http://www.w3.org/XML/1998/namespace' ? 'xml' : property.namespace ? 'P' : '';
    const tag = prefix ? `${prefix}:${property.name}` : property.name;
    const namespace = prefix === 'P' ?
      ` xmlns:P="${escapeXML(property.namespace)}"` : '';
    if (value === undefined) {
      missing.push(`<${tag}${namespace}/>`);
    } else if (selection.mode === 'propname') {
      found.push(`<${tag}${namespace}/>`);
    } else {
      const content = property.name === 'resourcetype' ? (value ? '<D:collection/>' : '') : escapeXML(value);
      found.push(`<${tag}${namespace}>${content}</${tag}>`);
    }
  }
  const propstat = (properties: string[], status: string) => properties.length || (!requested.length && status === '200 OK') ? `
    <D:propstat><D:prop>${properties.join('')}</D:prop>
      <D:status>HTTP/1.1 ${status}</D:status></D:propstat>` : '';
  return `  <D:response>
    <D:href>${escapeXML(prop.href)}</D:href>${propstat(found, '200 OK')}${propstat(missing, '404 Not Found')}
  </D:response>`;
}
