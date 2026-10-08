// 文件名：src/handlers/webdavHandler.ts
import { listAll, fromR2Object, make_resource_path, generatePropfindResponse, parsePropfind, resourceHref, PropfindSelection } from '../utils/webdavUtils';
import { logger, measureR2 } from '../utils/logger';
import { generateHTML, generateErrorHTML } from '../utils/templates';
import { WebDAVProps, Env } from '../types';
import { conditionalHeaders, preconditionStatus, validConditions } from '../utils/conditions';

const SUPPORT_METHODS = ["OPTIONS", "PROPFIND", "MKCOL", "GET", "HEAD", "PUT", "COPY", "MOVE", "DELETE"];
const DAV_CLASS = "1";

export async function handleWebDAV(request: Request, env: Env): Promise<Response> {
  const { BUCKET } = env;

  try {
    switch (request.method) {
      case "OPTIONS":
        return handleOptions();
      case "HEAD":
        return await handleHead(request, BUCKET);
      case "GET":
        return await handleGet(request, BUCKET);
      case "PUT":
        return await handlePut(request, BUCKET);
      case "DELETE":
        return await handleDelete(request, BUCKET);
      case "MKCOL":
        return await handleMkcol(request, BUCKET);
      case "PROPFIND":
        return await handlePropfind(request, BUCKET);
      case "COPY":
      case "MOVE":
        return await handleCopyMove(request, BUCKET);
      default:
        return new Response("Method Not Allowed", {
          status: 405,
          headers: {
            Allow: SUPPORT_METHODS.join(", "),
            DAV: DAV_CLASS
          }
        });
    }
  } catch (error) { 
    if (error instanceof URIError) return new Response('Invalid resource path', { status: 400 });
    const err = error as Error;
    logger.error("Error in WebDAV handling:", err.message);
    return new Response(generateErrorHTML("Internal Server Error", err.message), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
}

function handleOptions(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      Allow: SUPPORT_METHODS.join(", "),
      DAV: DAV_CLASS,
      "Access-Control-Allow-Methods": SUPPORT_METHODS.join(", "),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Depth, Overwrite, Destination, Range, If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since",
      "Access-Control-Expose-Headers": "Content-Type, Content-Length, DAV, ETag, Last-Modified, Location, Date, Content-Range",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400"
    }
  });
}

async function handleHead(request: Request, bucket: R2Bucket): Promise<Response> {
  if (!validConditions(request)) return new Response(null, { status: 400 });
  const resource_path = make_resource_path(request);
  const object = await measureR2('head', () => bucket.head(resource_path));

  if (!object) {
    return new Response(null, { status: 404 });
  }

  const status = preconditionStatus(request, object) || 200;
  return new Response(null, { status, headers: fileHeaders(object, status === 200) });
}

function fileHeaders(object: R2Object, includeContent: boolean): Headers {
  const headers = new Headers({
    ETag: object.httpEtag,
    'Last-Modified': object.uploaded.toUTCString(),
    'Cache-Control': 'private, no-cache'
  });
  if (includeContent) {
    headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
    headers.set('Content-Length', object.size.toString());
  }
  return headers;
}

async function handleGet(request: Request, bucket: R2Bucket): Promise<Response> {
  const resource_path = make_resource_path(request);

  if (resource_path === '' || resource_path.endsWith('/')) {
    return await handleDirectory(bucket, resource_path);
  } else {
    return await handleFile(request, bucket, resource_path);
  }
}

async function handleDirectory(bucket: R2Bucket, resource_path: string): Promise<Response> {
  let items = [];

  if (resource_path !== "") {
    items.push({ name: "📁 ..", href: "../" });
  }

  try {
    for await (const prop of listAll(bucket, resource_path)) {
      if (prop.href === resourceHref(resource_path)) continue;
      const isDirectory = prop.resourcetype === 'collection';
      items.push({ name: `${isDirectory ? '📁 ' : '📄 '}${prop.displayname || prop.href}`, href: prop.href });
    }
  } catch (error) { 
    const err = error as Error;
    logger.error("Error listing objects:", err.message);
    return new Response(generateErrorHTML("Error listing directory contents", err.message), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }

  const page = generateHTML("WebDAV File Browser", items);
  return new Response(page, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

async function handleFile(request: Request, bucket: R2Bucket, resource_path: string): Promise<Response> {
  if (!validConditions(request)) return new Response(null, { status: 400 });
  try {
    const object = await measureR2('get', () => bucket.get(resource_path, { onlyIf: conditionalHeaders(request) }));
    if (!object) {
      return new Response("Not Found", { status: 404 });
    }
    const status = preconditionStatus(request, object);
    if (status || !('body' in object)) {
      if ('body' in object) await object.body.cancel();
      return new Response(null, { status: status || 412, headers: fileHeaders(object, false) });
    }
    return new Response(object.body, { status: 200, headers: fileHeaders(object, true) });
  } catch (error) { 
    const err = error as Error;
    logger.error("Error getting object:", err.message);
    return new Response(generateErrorHTML("Error retrieving file", err.message), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
}

async function handlePut(request: Request, bucket: R2Bucket): Promise<Response> {
  if (!validConditions(request)) return new Response(null, { status: 400 });
  const resource_path = make_resource_path(request);

  try {
    const existing = await measureR2('head', () => bucket.head(resource_path));
    const status = preconditionStatus(request, existing);
    if (status) return new Response(null, { status });
    const object = await measureR2('put', () => bucket.put(resource_path, request.body, {
      onlyIf: conditionalHeaders(request),
      httpMetadata: {
        contentType: request.headers.get("Content-Type") || "application/octet-stream",
      },
    }));
    if (!object) return new Response(null, { status: 412 });
    return new Response(null, { status: existing ? 204 : 201, headers: fileHeaders(object, false) });
  } catch (error) { 
    const err = error as Error;
    logger.error("Error uploading file:", err.message);
    return new Response(generateErrorHTML("Error uploading file", err.message), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
}

async function handleDelete(request: Request, bucket: R2Bucket): Promise<Response> {
  // R2 delete has no atomic conditional operation; do not silently ignore a requested guard.
  if ([...conditionalHeaders(request)].length) return new Response('Conditional DELETE is not supported', { status: 501 });
  const resource_path = make_resource_path(request);

  try {
    await measureR2('delete', () => bucket.delete(resource_path));
    return new Response("No Content", { status: 204 });
  } catch (error) { 
    const err = error as Error;
    logger.error("Error deleting object:", err.message);
    return new Response(generateErrorHTML("Error deleting file", err.message), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
}

async function handleMkcol(request: Request, bucket: R2Bucket): Promise<Response> {
  const resource_path = make_resource_path(request);

  if (resource_path === "") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const key = resource_path.endsWith('/') ? resource_path : resource_path + '/';
    const object = await measureR2('put', () => bucket.put(key, new Uint8Array(), {
      onlyIf: new Headers({ 'If-None-Match': '*' }),
      customMetadata: { resourcetype: "collection" }
    }));
    if (!object) return new Response('Collection already exists', { status: 405 });
    return new Response("Created", { status: 201 });
  } catch (error) { 
    const err = error as Error;
    logger.error("Error creating collection:", err.message);
    return new Response(generateErrorHTML("Error creating collection", err.message), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
}

async function handlePropfind(request: Request, bucket: R2Bucket): Promise<Response> {
  const resource_path = make_resource_path(request);
  const depth = request.headers.get("Depth") || "infinity";
  if (!['0', '1', 'infinity'].includes(depth)) return new Response('Invalid Depth', { status: 400 });
  let selection: PropfindSelection;
  try {
    selection = parsePropfind(await request.text());
  } catch {
    return new Response('Invalid PROPFIND body', { status: 400 });
  }

  try {
    const collectionPath = resource_path === '' || resource_path.endsWith('/') ? resource_path : resource_path + '/';
    let key = resource_path;
    let object = key === '' ? null : await measureR2('head', () => bucket.head(key));
    if (!object && key !== '' && key !== collectionPath) {
      key = collectionPath;
      object = await measureR2('head', () => bucket.head(key));
    }
    if (!object && resource_path !== '') {
      const children = await measureR2('list', () => bucket.list({ prefix: collectionPath, limit: 1 }));
      if (!children.objects.length) return new Response('Not Found', { status: 404 });
      key = collectionPath;
    }
    const target = fromR2Object(object, key);
    const props: WebDAVProps[] = [target];
    if (target.resourcetype === 'collection') {
      if (depth === 'infinity') {
        return new Response('<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>', {
          status: 403, headers: { 'Content-Type': 'application/xml; charset=utf-8' }
        });
      }
      if (depth === '1') {
        for await (const prop of listAll(bucket, collectionPath)) {
          if (prop.href !== target.href) props.push(prop);
        }
      }
    }

    const xml = generatePropfindResponse(props, selection);
    logger.info('PROPFIND completed', { depth, resources: props.length, bytes: new TextEncoder().encode(xml).length });
    return new Response(xml, {
      status: 207,
      headers: { "Content-Type": "application/xml; charset=utf-8" }
    });
  } catch (error) { 
    const err = error as Error;
    logger.error("Error in PROPFIND:", err.message);
    return new Response(generateErrorHTML("Error in PROPFIND", err.message), {
      status: 500,
      headers: { "Content-Type": "application/xml; charset=utf-8" }
    });
  }
}

async function handleCopyMove(request: Request, bucket: R2Bucket): Promise<Response> {
  if (!validConditions(request)) return new Response(null, { status: 400 });
  const sourcePath = make_resource_path(request);
  const destinationHeader = request.headers.get("Destination");
  if (!destinationHeader) {
    return new Response("Bad Request: Destination header is missing", { status: 400 });
  }
  let destinationPath: string;
  try {
    const destinationUrl = new URL(destinationHeader, request.url);
    if (destinationUrl.origin !== new URL(request.url).origin) {
      return new Response('Cross-server destination is not supported', { status: 502 });
    }
    destinationPath = make_resource_path(new Request(destinationUrl));
  } catch {
    return new Response('Invalid destination', { status: 400 });
  }
  if (sourcePath === destinationPath) return new Response('Source equals destination', { status: 403 });
  if (!destinationPath || destinationPath.endsWith('/')) {
    return new Response('Collection COPY/MOVE is not supported', { status: 501 });
  }
  const overwrite = request.headers.get('Overwrite') || 'T';
  if (overwrite !== 'T' && overwrite !== 'F') return new Response('Invalid Overwrite', { status: 400 });
  try {
    const sourceObject = await measureR2('get', () => bucket.get(sourcePath, { onlyIf: conditionalHeaders(request) }));
    if (!sourceObject) {
      return new Response("Not Found", { status: 404 });
    }
    const condition = preconditionStatus(request, sourceObject);
    if (condition || !('body' in sourceObject)) {
      if ('body' in sourceObject) await sourceObject.body.cancel();
      return new Response(null, { status: condition || 412 });
    }
    if (sourcePath.endsWith('/') || sourceObject.customMetadata?.resourcetype === 'collection') {
      await sourceObject.body.cancel();
      return new Response('Collection COPY/MOVE is not supported', { status: 501 });
    }
    const existing = await measureR2('head', () => bucket.head(destinationPath));
    if (overwrite === 'F' && existing) {
      await sourceObject.body.cancel();
      return new Response(null, { status: 412 });
    }
    const object = await measureR2('put', () => bucket.put(destinationPath, sourceObject.body, {
      onlyIf: overwrite === 'F' ? new Headers({ 'If-None-Match': '*' }) : undefined,
      httpMetadata: sourceObject.httpMetadata,
      customMetadata: sourceObject.customMetadata
    }));
    if (!object) return new Response(null, { status: 412 });
    if (request.method === 'MOVE') {
      await measureR2('delete', () => bucket.delete(sourcePath));
    }
    return new Response(null, { status: existing ? 204 : 201, headers: fileHeaders(object, false) });
  } catch (error) { 
    const err = error as Error;
    logger.error("Error copying/moving object:", err.message);
    return new Response(generateErrorHTML("Error copying/moving file", err.message), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
}
