export type ByteRange = { offset: number; length: number } | 'unsatisfiable' | null;

export function parseRange(value: string | null, size: number): ByteRange {
  if (!value || value.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return null;
  if (first === undefined) {
    if (!last || !size) return 'unsatisfiable';
    const length = Math.min(last, size);
    return { offset: size - length, length };
  }
  if (last !== undefined && last < first) return null;
  if (first >= size) return 'unsatisfiable';
  return { offset: first, length: Math.min(last ?? size - 1, size - 1) - first + 1 };
}

export function ifRangeMatches(value: string | null, object: R2Object): boolean {
  if (value === null) return true;
  if (value.startsWith('"') || value.startsWith('W/')) return value === object.httpEtag;
  const date = Date.parse(value);
  return Number.isFinite(date) && Math.floor(object.uploaded.getTime() / 1000) * 1000 <= date;
}
