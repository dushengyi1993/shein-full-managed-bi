/**
 * Strict Decimal string validation.
 *
 * Monetary and metric values are never converted to a JavaScript `Number` and
 * never stored in a floating point column. Only an exact, bounded decimal
 * string is accepted; everything else is rejected with a sanitized code.
 */

export const MAX_INTEGER_DIGITS = 28;
export const MAX_FRACTION_DIGITS = 10;

const CANONICAL_DECIMAL_PATTERN = new RegExp(
  `^-?(?:0|[1-9][0-9]{0,${MAX_INTEGER_DIGITS - 1}})(?:\\.[0-9]{1,${MAX_FRACTION_DIGITS}})?$`,
);

export const DECIMAL_REJECT_CODES = Object.freeze({
  NOT_A_STRING: 'DECIMAL_NOT_A_STRING',
  EMPTY: 'DECIMAL_EMPTY',
  NON_CANONICAL: 'DECIMAL_NON_CANONICAL',
});

/**
 * @returns {{ok: true, text: string}|{ok: false, code: string}}
 */
export function parseStrictDecimalString(value) {
  if (typeof value !== 'string') {
    // A JSON number already lost precision before it reached this function.
    return { ok: false, code: DECIMAL_REJECT_CODES.NOT_A_STRING };
  }
  const text = value.trim();
  if (text === '') {
    return { ok: false, code: DECIMAL_REJECT_CODES.EMPTY };
  }
  if (!CANONICAL_DECIMAL_PATTERN.test(text)) {
    // Rejects exponents, '+', leading zeros, spaces, thousands separators,
    // 'NaN', 'Infinity', over-long integer parts and over-precise fractions.
    return { ok: false, code: DECIMAL_REJECT_CODES.NON_CANONICAL };
  }
  // Preserve the platform representation byte-for-byte, including trailing
  // fractional zeroes. Payload fingerprints already distinguish "1.0" from
  // "1.00"; normalizing either string would destroy source evidence.
  return { ok: true, text };
}

export function isStrictDecimalString(value) {
  return parseStrictDecimalString(value).ok === true;
}
