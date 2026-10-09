// 文件名：src/utils/auth.ts
import { Env } from '../types';

export function authenticate(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return false;
  }

  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(authHeader.trim());
  if (!match) return false;
  try {
    const binary = atob(match[1]);
    const credentials = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
    const separator = credentials.indexOf(':');
    return separator >= 0 && credentials.slice(0, separator) === env.USERNAME && credentials.slice(separator + 1) === env.PASSWORD;
  } catch {
    return false;
  }
}
