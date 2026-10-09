// 文件名：src/handlers/webdavHandler.ts
import { listAll, fromR2Object, make_resource_path, generatePropfindResponse, resourceHref, parsePropfind, PropfindSelection } from '../utils/webdavUtils';
import { logger, measureR2 } from '../utils/logger';
import { generateHTML } from '../utils/templates';
import { Env } from '../types';
import { conditionalHeaders, preconditionStatus, validConditions, parseDAVIf } from '../utils/conditions';
import { internalKey, resolveResource, parentExists, collectionExists, usedBytes, Resource } from '../utils/resources';
import { copyTree, deleteTree, resourceTree, Failure } from '../utils/collections';
import { readProperties, parseProppatch, updateProperties } from '../utils/properties';
import { davError, multiStatus, readXMLBody } from '../utils/xml';
import { ifRangeMatches, parseRange } from '../utils/ranges';

const SUPPORT_METHODS = ['OPTIONS', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'GET', 'HEAD', 'PUT', 'COPY', 'MOVE', 'DELETE'];
const DAV_CLASS = '1';

export async function handleWebDAV(request: Request, env: Env): Promise<Response> {
  const { BUCKET } = env;
  try {
    if (internalKey(make_resource_path(request))) return davError(404, 'Not Found');
    if (!validConditions(request)) return davError(400, 'Invalid conditional header');
    if (request.headers.has('If')) {
      const guarded = await guardDAVIf(request, BUCKET);
      if (guarded instanceof Response) return guarded;
      request = guarded;
    }
    switch (request.method) {
      case 'OPTIONS':
        return new Response(null, { status: 200, headers: { Allow: SUPPORT_METHODS.join(', '), DAV: DAV_CLASS } });
      case 'HEAD': return await handleHead(request, BUCKET);
      case 'GET': return await handleGet(request, BUCKET);
      case 'PUT': return await handlePut(request, BUCKET);
      case 'DELETE': return await handleDelete(request, BUCKET);
      case 'MKCOL': return await handleMkcol(request, BUCKET);
      case 'PROPFIND': return await handlePropfind(request, BUCKET);
      case 'PROPPATCH': return await handleProppatch(request, BUCKET);
      case 'COPY':
      case 'MOVE': return await handleCopyMove(request, BUCKET);
      default: {
        const response = davError(405, 'Method Not Allowed');
        response.headers.set('Allow', SUPPORT_METHODS.join(', '));
        response.headers.set('DAV', DAV_CLASS);
        return response;
      }
    }
  } catch (error) {
    if (error instanceof URIError) return davError(400, 'Invalid resource path');
    logger.error('Error in WebDAV handling:', (error as Error).message);
    return davError(500, 'Storage operation failed');
  }
}

async function guardDAVIf(request: Request, bucket: R2Bucket): Promise<Request | Response> {
  let lists;
  try { lists = parseDAVIf(request.headers.get('If')!); }
  catch { return davError(400, 'Invalid If header'); }
  const resources = new Map<string, Resource | null>();
  let matched = false;
  for (const list of lists) {
    let url: URL;
    try { url = new URL(list.uri || request.url, request.url); }
    catch { return davError(400, 'Invalid If resource'); }
    const key = make_resource_path(new Request(url));
    let resource: Resource | null = null;
    if (url.origin === new URL(request.url).origin && !internalKey(key)) {
      if (!resources.has(key)) resources.set(key, await resolveResource(bucket, key));
      resource = resources.get(key)!;
    }
    if (list.conditions.every(condition => {
      // This service has no lock or other state tokens.
      const equal = condition.etag && !!resource?.object &&
        condition.value.replace(/^W\//, '') === resource.object.httpEtag;
      return condition.not ? !equal : equal;
    })) matched = true;
  }
  if (!matched) return davError(412, 'If condition failed');
  if (!['PUT', 'COPY', 'MOVE', 'MKCOL', 'DELETE', 'PROPPATCH'].includes(request.method)) return request;
  const key = make_resource_path(request);
  const current = resources.has(key) ? resources.get(key)! : await resolveResource(bucket, key);
  const status = resourceCondition(request, current);
  if (status) return new Response(null, { status });
  // Fence changes to the request resource with R2's single-object condition.
  // Conditions on other resources cannot be committed atomically with it.
  const headers = new Headers(request.headers);
  if (current?.object) headers.set('If-Match', current.object.httpEtag);
  else if (!current) headers.set('If-None-Match', '*');
  return new Request(request, { headers });
}

function resourceCondition(request: Request, resource: Resource | null): number | null {
  if (!resource?.collection) return preconditionStatus(request, resource?.object || null);
  if (!['GET', 'HEAD'].includes(request.method) && resource.object) return preconditionStatus(request, resource.object);
  const headers = new Headers(request.headers);
  headers.delete('If-Modified-Since'); headers.delete('If-Unmodified-Since');
  return preconditionStatus(new Request(request.url, { method: request.method, headers }), {
    httpEtag: '', uploaded: new Date(0)
  } as R2Object);
}

function fileHeaders(object: R2Object, includeContent: boolean): Headers {
  const headers = new Headers({ ETag: object.httpEtag, 'Last-Modified': object.uploaded.toUTCString(),
    'Cache-Control': 'private, no-cache', 'Accept-Ranges': 'bytes' });
  if (includeContent) {
    headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
    headers.set('Content-Length', object.size.toString());
    if (object.httpMetadata?.contentLanguage) headers.set('Content-Language', object.httpMetadata.contentLanguage);
    if (object.httpMetadata?.contentDisposition) headers.set('Content-Disposition', object.httpMetadata.contentDisposition);
  }
  return headers;
}

function directoryHeaders(): Headers {
  return new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-cache' });
}

async function handleHead(request: Request, bucket: R2Bucket): Promise<Response> {
  const resource = await resolveResource(bucket, make_resource_path(request));
  if (!resource) return new Response(null, { status: 404 });
  const status = resourceCondition(request, resource) || 200;
  return new Response(null, { status, headers: resource.collection ? directoryHeaders() : fileHeaders(resource.object!, status === 200) });
}

async function handleGet(request: Request, bucket: R2Bucket): Promise<Response> {
  const key = make_resource_path(request);
  if (!key || key.endsWith('/')) {
    const resource = await resolveResource(bucket, key);
    if (!resource) return davError(404, 'Not Found');
    return handleDirectory(request, bucket, resource);
  }
  return handleFile(request, bucket, key);
}

async function handleDirectory(request: Request, bucket: R2Bucket, resource: Resource): Promise<Response> {
  const status = resourceCondition(request, resource);
  if (status) return new Response(null, { status, headers: directoryHeaders() });
  const items: { name: string; href: string }[] = [];
  if (resource.key) items.push({ name: '📁 ..', href: resourceHref(resource.key.replace(/[^/]+\/$/, '')) });
  for await (const prop of listAll(bucket, resource.key)) {
    if (prop.href !== resourceHref(resource.key)) items.push({
      name: `${prop.resourcetype === 'collection' ? '📁 ' : '📄 '}${prop.displayname || prop.href}`, href: prop.href
    });
  }
  return new Response(generateHTML('WebDAV File Browser', items), { status: 200, headers: directoryHeaders() });
}

async function handleFile(request: Request, bucket: R2Bucket, key: string): Promise<Response> {
  const rangeHeader = request.headers.get('Range');
  const singleRange = rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader.trim());
  let range: { offset: number; length: number } | undefined;
  let snapshot: R2Object | null = null;
  if (singleRange) {
    snapshot = await measureR2('head', () => bucket.head(key));
    if (snapshot && snapshot.customMetadata?.resourcetype !== 'collection') {
      const status = preconditionStatus(request, snapshot);
      if (status) return new Response(null, { status, headers: fileHeaders(snapshot, false) });
      if (ifRangeMatches(request.headers.get('If-Range'), snapshot)) {
        const parsed = parseRange(rangeHeader, snapshot.size);
        if (parsed === 'unsatisfiable') {
          const headers = fileHeaders(snapshot, false);
          headers.set('Content-Range', `bytes */${snapshot.size}`);
          return new Response(null, { status: 416, headers });
        }
        if (parsed) range = parsed;
      }
    }
  }
  const conditions = conditionalHeaders(request);
  if (range && snapshot) conditions.set('If-Match', snapshot.httpEtag);
  const object = await measureR2('get', () => bucket.get(key, { onlyIf: conditions, range }));
  if (!object) {
    const resource = await resolveResource(bucket, key);
    return resource?.collection ? handleDirectory(request, bucket, resource) : davError(404, 'Not Found');
  }
  if (object.customMetadata?.resourcetype === 'collection') {
    if ('body' in object) await object.body.cancel();
    return handleDirectory(request, bucket, { key: object.key.endsWith('/') ? object.key : object.key + '/', collection: true, object });
  }
  const status = preconditionStatus(request, object);
  if (status || !('body' in object)) {
    if ('body' in object) await object.body.cancel();
    if (range && !status) {
      const headers = new Headers(request.headers); headers.delete('Range');
      return handleFile(new Request(request, { headers }), bucket, key);
    }
    return new Response(null, { status: status || 412, headers: fileHeaders(object, false) });
  }
  const headers = fileHeaders(object, true);
  if (range) {
    headers.set('Content-Length', range.length.toString());
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

async function handlePut(request: Request, bucket: R2Bucket): Promise<Response> {
  if (request.headers.has('Content-Range')) return davError(400, 'Partial PUT is not supported');
  const key = make_resource_path(request);
  if (!key || key.endsWith('/')) return davError(405, 'Cannot PUT a collection');
  const existing = await measureR2('head', () => bucket.head(key));
  if (existing?.customMetadata?.resourcetype === 'collection') return davError(405, 'Cannot PUT a collection');
  const status = preconditionStatus(request, existing);
  if (status) return new Response(null, { status });
  if (await collectionExists(bucket, key)) return davError(409, 'A collection occupies this path');
  if (!await parentExists(bucket, key)) return davError(409, 'Parent collection does not exist');
  const object = await measureR2('put', () => bucket.put(key, request.body, {
    onlyIf: conditionalHeaders(request),
    httpMetadata: { contentType: request.headers.get('Content-Type') || existing?.httpMetadata?.contentType || 'application/octet-stream' },
    customMetadata: { ...existing?.customMetadata,
      creationdate: existing?.customMetadata?.creationdate || existing?.uploaded.toISOString() || new Date().toISOString() }
  }));
  if (!object) return new Response(null, { status: 412 });
  return new Response(null, { status: existing ? 204 : 201, headers: fileHeaders(object, false) });
}

async function handleDelete(request: Request, bucket: R2Bucket): Promise<Response> {
  if ([...conditionalHeaders(request)].length || request.headers.has('If')) return davError(501, 'Conditional DELETE is not supported');
  const key = make_resource_path(request);
  if (!key) return davError(403, 'Cannot delete the root collection');
  const resource = await resolveResource(bucket, key);
  if (!resource) return new Response(null, { status: 204 });
  if (resource.collection && request.headers.has('Depth') && request.headers.get('Depth') !== 'infinity') {
    return davError(400, 'Collection DELETE requires Depth: infinity');
  }
  const failures = await deleteTree(bucket, await resourceTree(bucket, resource));
  return operationResult(resource, failures, 204);
}

async function handleMkcol(request: Request, bucket: R2Bucket): Promise<Response> {
  const key = make_resource_path(request);
  if (!key || await resolveResource(bucket, key.replace(/\/$/, ''))) return davError(405, 'Resource already exists');
  if ((await request.arrayBuffer()).byteLength) return davError(415, 'MKCOL request body is not supported');
  if (!await parentExists(bucket, key)) return davError(409, 'Parent collection does not exist');
  const condition = preconditionStatus(request, null);
  if (condition) return new Response(null, { status: condition });
  const path = key.endsWith('/') ? key : key + '/';
  const saved = await measureR2('put', () => bucket.put(path, new Uint8Array(), {
    onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { resourcetype: 'collection', creationdate: new Date().toISOString() }
  }));
  return saved ? new Response(null, { status: 201 }) : davError(405, 'Resource already exists');
}

async function handlePropfind(request: Request, bucket: R2Bucket): Promise<Response> {
  const depth = request.headers.get('Depth') || 'infinity';
  if (!['0', '1', 'infinity'].includes(depth)) return davError(400, 'Invalid Depth');
  let selection: PropfindSelection;
  try { selection = parsePropfind(await readXMLBody(request)); }
  catch { return davError(400, 'Invalid PROPFIND body'); }
  const resource = await resolveResource(bucket, make_resource_path(request));
  if (!resource) return davError(404, 'Not Found');
  if (resource.collection && depth === 'infinity') return davError(403, 'Finite depth required', 'propfind-finite-depth');
  const props = [fromR2Object(resource.object, resource.key)];
  if (resource.collection && depth === '1') {
    for await (const prop of listAll(bucket, resource.key)) {
      if (prop.href === props[0].href) continue;
      if (prop.resourcetype === 'collection') {
        const path = make_resource_path(new Request(new URL(prop.href, request.url)));
        const marker = await measureR2('head', () => bucket.head(path));
        props.push(marker ? fromR2Object(marker, path) : prop);
      } else props.push(prop);
    }
  }
  const wantsQuota = selection.properties.some(prop => prop.namespace === 'DAV:' && prop.name === 'quota-used-bytes');
  const quota = wantsQuota && props.some(prop => prop.resourcetype === 'collection') ? await usedBytes(bucket) : undefined;
  for (const prop of props) {
    const path = make_resource_path(new Request(new URL(prop.href, request.url)));
    const stored = await readProperties(bucket, path);
    // A recreated resource must not inherit an old failed-cleanup record.
    if (!prop.creationdate || !stored.state.creationdate || prop.creationdate === stored.state.creationdate) {
      prop.deadProperties = stored.state.properties;
      prop.creationdate = stored.state.creationdate || prop.creationdate;
    }
    if (prop.resourcetype === 'collection') {
      prop.quotaSupported = true; prop.quotaUsedBytes = quota;
    }
  }
  const xml = generatePropfindResponse(props, selection);
  logger.info('PROPFIND completed', { depth, resources: props.length, bytes: new TextEncoder().encode(xml).length });
  return new Response(xml, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}

async function handleProppatch(request: Request, bucket: R2Bucket): Promise<Response> {
  let changes;
  try { changes = parseProppatch(await readXMLBody(request)); }
  catch { return davError(400, 'Invalid PROPPATCH body'); }
  const resource = await resolveResource(bucket, make_resource_path(request));
  if (!resource) return davError(404, 'Not Found');
  const status = resourceCondition(request, resource);
  if (status) return new Response(null, { status });
  return updateProperties(bucket, resource.key, resourceHref(resource.key),
    resource.object?.customMetadata?.creationdate || resource.object?.uploaded.toISOString(), changes);
}

async function handleCopyMove(request: Request, bucket: R2Bucket): Promise<Response> {
  const header = request.headers.get('Destination');
  if (!header) return davError(400, 'Destination header is missing');
  let key: string;
  try {
    const url = new URL(header, request.url);
    if (url.origin !== new URL(request.url).origin) return davError(502, 'Cross-server destination is not supported');
    if (url.search || url.hash) return davError(400, 'Invalid destination');
    key = make_resource_path(new Request(url));
  } catch { return davError(400, 'Invalid destination'); }
  if (!key || internalKey(key)) return davError(403, 'Invalid destination');
  const overwrite = request.headers.get('Overwrite') || 'T';
  if (!['T', 'F'].includes(overwrite)) return davError(400, 'Invalid Overwrite');
  const source = await resolveResource(bucket, make_resource_path(request));
  if (!source) return davError(404, 'Not Found');
  const status = resourceCondition(request, source);
  if (status) return new Response(null, { status });
  const depth = request.headers.get('Depth') || 'infinity';
  if (source.collection && (request.method === 'MOVE' ? depth !== 'infinity' : !['0', 'infinity'].includes(depth))) {
    return davError(400, 'Invalid collection Depth');
  }
  const targetKey = source.collection ? key.replace(/\/$/, '') + '/' : key;
  if (!source.collection && targetKey.endsWith('/')) return davError(409, 'File destination cannot end in a slash');
  const target = await resolveResource(bucket, key.replace(/\/$/, ''));
  if (source.key.replace(/\/$/, '') === targetKey.replace(/\/$/, '') ||
    (source.collection && targetKey.startsWith(source.key)) ||
    (target?.collection && source.key.startsWith(target.key))) return davError(403, 'Source and destination overlap');
  if (target && overwrite === 'F') return new Response(null, { status: 412 });
  if (!await parentExists(bucket, targetKey)) return davError(409, 'Parent collection does not exist');
  const entries = source.collection && depth === '0' ? [source] : await resourceTree(bucket, source);
  if (target && (target.collection || source.collection)) {
    const failures = await deleteTree(bucket, await resourceTree(bucket, target));
    if (failures.length) return operationResult(target, failures, 204);
  }
  const failures = await copyTree(bucket, entries, source.key, targetKey, overwrite === 'T');
  if (failures.length) return operationResult(source, failures, 204);
  if (request.method === 'MOVE') {
    // R2 has no transaction or conditional delete. Detect observed source changes,
    // but the remaining check/delete race is an explicit limitation.
    const expected = new Map(entries.filter(entry => entry.object).map(entry => [entry.key, entry.object!]));
    const deleted = await deleteTree(bucket, entries, expected);
    if (deleted.length) return operationResult(source, deleted, 204);
  }
  const copied = await measureR2('head', () => bucket.head(targetKey));
  return new Response(null, { status: target ? 204 : 201, headers: copied && !source.collection ? fileHeaders(copied, false) : undefined });
}

function operationResult(resource: Resource, failures: Failure[], success: number): Response {
  if (!failures.length) return new Response(null, { status: success });
  if (!resource.collection && failures.length === 1) return davError(failures[0].status, 'Operation did not complete');
  return multiStatus(failures, resourceHref);
}
