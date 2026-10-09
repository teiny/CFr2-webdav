const tagList = /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"(?:[ \t]*,[ \t]*(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*")*$/;

export function validConditions(request: Request): boolean {
	return ['If-Match', 'If-None-Match'].every((name) => {
		const value = request.headers.get(name)?.trim();
		return value === undefined || value === '*' || tagList.test(value);
	});
}

export function conditionalHeaders(request: Request): Headers {
	const headers = new Headers();
	for (const name of ['If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since']) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	if (headers.has('If-Match')) headers.delete('If-Unmodified-Since');
	if (headers.has('If-None-Match')) headers.delete('If-Modified-Since');
	if (request.method !== 'GET' && request.method !== 'HEAD') headers.delete('If-Modified-Since');
	for (const name of ['If-Modified-Since', 'If-Unmodified-Since']) {
		if (!headers.has(name)) continue;
		const date = Date.parse(headers.get(name)!);
		if (Number.isNaN(date)) {
			headers.delete(name);
		} else if (name === 'If-Unmodified-Since') {
			// R2's uploadedBefore is exclusive; HTTP accepts the entire stated second.
			headers.set(name, new Date(date + 1000).toUTCString());
		}
	}
	return headers;
}

export function preconditionStatus(request: Request, object: R2Object | null): number | null {
	const ifMatch = request.headers.get('If-Match');
	const ifNoneMatch = request.headers.get('If-None-Match');
	const matches = (value: string, weak: boolean) => {
		if (!object) return false;
		if (value.trim() === '*') return true;
		return (value.match(/(?:W\/)?"[^"]*"/g) || []).some(
			(tag) => tag === object.httpEtag || (weak && tag === `W/${object.httpEtag}`),
		);
	};
	const modified = object ? Math.floor(object.uploaded.getTime() / 1000) * 1000 : 0;
	if (ifMatch !== null) {
		if (!matches(ifMatch, false)) return 412;
	} else if (object) {
		const unmodifiedSince = Date.parse(request.headers.get('If-Unmodified-Since') || '');
		if (modified > unmodifiedSince) return 412;
	}
	if (ifNoneMatch !== null) {
		if (matches(ifNoneMatch, true)) {
			return request.method === 'GET' || request.method === 'HEAD' ? 304 : 412;
		}
	} else if (object && (request.method === 'GET' || request.method === 'HEAD')) {
		const modifiedSince = Date.parse(request.headers.get('If-Modified-Since') || '');
		if (modified <= modifiedSince) return 304;
	}
	return null;
}

interface DAVCondition { value: string; etag: boolean; not: boolean }
interface DAVList { uri?: string; conditions: DAVCondition[] }

export function parseDAVIf(value: string): DAVList[] {
  let rest = value.trim();
  let uri: string | undefined;
  let tagged: boolean | undefined;
  const lists: DAVList[] = [];
  while (rest) {
    if (rest.startsWith('<')) {
      const match = /^<([^<>\s]+)>\s*/.exec(rest);
      if (!match || tagged === false) throw new Error('Invalid If header');
      uri = match[1]; tagged = true; rest = rest.slice(match[0].length);
      if (!rest.startsWith('(')) throw new Error('Expected condition list');
    } else if (tagged === undefined) tagged = false;
    if (!rest.startsWith('(')) throw new Error('Expected condition list');
    rest = rest.slice(1).trimStart();
    const conditions: DAVCondition[] = [];
    while (!rest.startsWith(')')) {
      const match = /^(Not\s+)?(?:\[((?:W\/)?"[\x21\x23-\x7e\x80-\xff]*")\]|<([^<>\s]+)>)\s*/.exec(rest);
      if (!match) throw new Error('Invalid If condition');
      conditions.push({ value: match[2] ?? match[3], etag: match[2] !== undefined, not: !!match[1] });
      rest = rest.slice(match[0].length);
    }
    if (!conditions.length) throw new Error('Empty condition list');
    lists.push({ uri, conditions });
    rest = rest.slice(1).trimStart();
  }
  if (!lists.length) throw new Error('Empty If header');
  return lists;
}
