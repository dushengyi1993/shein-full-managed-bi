import { createHash } from 'node:crypto';

/**
 * Deterministic canonical JSON for hashing.
 *
 * Object keys are sorted, arrays keep their (already normalized) order, and
 * every non-finite number is rejected so a hash can never depend on `NaN`,
 * `Infinity` or a platform-specific float rendering.
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonical JSON cannot encode a non-finite number');
    }
    if (!Number.isInteger(value)) {
      throw new TypeError('canonical JSON only encodes integers; use decimal strings');
    }
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function canonicalHash(value) {
  return sha256Hex(canonicalJson(value));
}
