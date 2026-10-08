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
