/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) for the gate's context_id.
 *
 * JCS is defined on top of ECMAScript's own JSON serialization: strings and
 * numbers are emitted exactly as `JSON.stringify` emits them (RFC 8785 §3.2.2),
 * and object members are sorted by their names' UTF-16 code units (§3.2.3),
 * which is what the default `Array.prototype.sort` comparison does.
 */

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalizationError(`cannot canonicalize non-finite number ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const members = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`);
    return `{${members.join(',')}}`;
  }
  throw new CanonicalizationError(`cannot canonicalize a value of type ${typeof value}`);
}

/**
 * Whether `value` holds, at any depth, an integral number outside ±(2^53−1).
 * Such a number has no canonical form: JSON.parse may already have rounded it,
 * so an approver would sign off on a value other than the one forwarded.
 */
export function hasUnsafeInteger(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && !Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.some(hasUnsafeInteger);
  if (value !== null && typeof value === 'object') return Object.values(value).some(hasUnsafeInteger);
  return false;
}
