import { SaxesParser } from 'saxes';

export interface XMLNode {
  name: string;
  namespace: string;
  qualifiedName: string;
  attributes: Record<string, string>;
  namespaces: Record<string, string>;
  language?: string;
  children: (XMLNode | string)[];
}

export function escapeXML(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function parseXML(body: string): XMLNode {
  const parser = new SaxesParser({ xmlns: true });
  const stack: XMLNode[] = [];
  let root: XMLNode | undefined;
  parser.on('doctype', () => { throw new Error('DOCTYPE is not supported'); });
  parser.on('error', error => { throw error; });
  parser.on('opentag', tag => {
    const parent = stack[stack.length - 1];
    const attributes = Object.fromEntries(Object.values(tag.attributes).map(attr => [attr.name, attr.value]));
    const node: XMLNode = {
      name: tag.local, namespace: tag.uri, qualifiedName: tag.name, attributes,
      namespaces: { ...parent?.namespaces, ...tag.ns },
      language: attributes['xml:lang'] ?? parent?.language, children: []
    };
    if (parent) parent.children.push(node);
    else root = node;
    stack.push(node);
  });
  const appendText = (value: string) => { stack[stack.length - 1]?.children.push(value); };
  parser.on('text', appendText);
  parser.on('cdata', appendText);
  parser.on('closetag', () => { stack.pop(); });
  parser.write(body).close();
  if (!root) throw new Error('Missing XML document');
  return root;
}

export function elements(node: XMLNode): XMLNode[] {
  return node.children.filter((child): child is XMLNode => typeof child !== 'string');
}

export function serializeXML(node: XMLNode, standalone = true): string {
  const attributes = { ...node.attributes };
  if (standalone) {
    for (const [prefix, namespace] of Object.entries(node.namespaces)) {
      if (prefix !== 'xml') attributes[prefix ? `xmlns:${prefix}` : 'xmlns'] = namespace;
    }
    if (node.language !== undefined) attributes['xml:lang'] = node.language;
  }
  const attrs = Object.entries(attributes).map(([name, value]) => ` ${name}="${escapeXML(value)}"`).join('');
  const content = node.children.map(child => typeof child === 'string' ? escapeXML(child) : serializeXML(child, false)).join('');
  return `<${node.qualifiedName}${attrs}>${content}</${node.qualifiedName}>`;
}

export function propertyElement(name: string, namespace: string, content = ''): string {
  const prefix = namespace === 'DAV:' ? 'D' : namespace === 'http://www.w3.org/XML/1998/namespace' ? 'xml' : namespace ? 'P' : '';
  const tag = prefix ? `${prefix}:${name}` : name;
  const declaration = prefix === 'P' ? ` xmlns:P="${escapeXML(namespace)}"` : prefix === '' ? ' xmlns=""' : '';
  return `<${tag}${declaration}>${content}</${tag}>`;
}

export async function readXMLBody(request: Request): Promise<string> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' :
    bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' :
    bytes[0] === 0 && bytes[1] === 0x3c ? 'utf-16be' : bytes[0] === 0x3c && bytes[1] === 0 ? 'utf-16le' : 'utf-8';
  return new TextDecoder(utf16, { fatal: true, ignoreBOM: false }).decode(bytes);
}

export function davError(status: number, message: string, condition?: string): Response {
  return new Response(`<D:error xmlns:D="DAV:">${condition ? `<D:${condition}/>` : ''}<D:responsedescription>${escapeXML(message)}</D:responsedescription></D:error>`, {
    status, headers: { 'Content-Type': 'application/xml; charset=utf-8' }
  });
}

export function multiStatus(failures: { key: string; status: number }[], href: (key: string) => string): Response {
  const reasons: Record<number, string> = { 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 412: 'Precondition Failed', 500: 'Internal Server Error', 503: 'Service Unavailable' };
  return new Response(`<D:multistatus xmlns:D="DAV:">${failures.map(failure =>
    `<D:response><D:href>${escapeXML(href(failure.key))}</D:href><D:status>HTTP/1.1 ${failure.status} ${reasons[failure.status] || 'Error'}</D:status></D:response>`).join('')}</D:multistatus>`, {
    status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' }
  });
}
