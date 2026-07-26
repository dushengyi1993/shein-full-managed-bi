import crypto from 'node:crypto';

export const WEBHOOK_CALLBACK_PATH = '/api/shein/webhook/v1/events';
export const WEBHOOK_AES_IV_SEED = 'space-station-default-iv';
export const WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;

function text(value) {
  return String(value ?? '').trim();
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''), 'utf8');
  const rightBuffer = Buffer.from(String(right ?? ''), 'utf8');
  const length = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);
  const equal = crypto.timingSafeEqual(paddedLeft, paddedRight);
  return equal && leftBuffer.length === rightBuffer.length;
}

function officialCanonical({ appId, openKeyId, timestamp, callbackPath }) {
  const apiKey = text(appId) || text(openKeyId);
  if (!apiKey) throw new Error('Webhook API key is missing.');
  const path = String(callbackPath ?? '');
  if (!path.startsWith('/') || /[?#\r\n]/.test(path)) {
    throw new Error('Webhook callback path is invalid.');
  }
  return `${apiKey}&${timestamp}&${path}`;
}

/**
 * Verify SHEIN's official HMAC contract without ever returning key material.
 *
 * expected = randomKey + Base64(UTF8(lowercase_hex(HMAC-SHA256(
 *   appId + "&" + timestamp + "&" + callbackPath,
 *   appSecretKey + randomKey
 * ))))
 */
export function verifyFullManagedWebhookSignature({
  appId,
  openKeyId,
  timestamp,
  signature,
  appSecretKey,
  callbackPath = WEBHOOK_CALLBACK_PATH,
  nowMs = Date.now(),
  maxSkewMs = WEBHOOK_MAX_SKEW_MS,
} = {}) {
  const timestampText = text(timestamp);
  const suppliedSignature = text(signature);
  if (!/^\d{11,16}$/.test(timestampText)) {
    return Object.freeze({ ok: false, reason: 'timestamp_invalid' });
  }
  if (!text(appSecretKey)) {
    return Object.freeze({ ok: false, reason: 'credential_unavailable' });
  }
  if (suppliedSignature.length < 6 || suppliedSignature.length > 512) {
    return Object.freeze({ ok: false, reason: 'signature_invalid' });
  }
  const platformTimestampMs = Number(timestampText);
  const currentMs = Number(nowMs);
  const allowedSkewMs = Number(maxSkewMs);
  if (
    !Number.isSafeInteger(platformTimestampMs)
    || !Number.isFinite(currentMs)
    || !Number.isSafeInteger(allowedSkewMs)
    || allowedSkewMs < 0
  ) {
    return Object.freeze({ ok: false, reason: 'time_configuration_invalid' });
  }
  const ageMs = currentMs - platformTimestampMs;
  if (Math.abs(ageMs) > allowedSkewMs) {
    return Object.freeze({
      ok: false,
      reason: 'timestamp_outside_allowed_skew',
      platformTimestampMs,
      ageMs,
    });
  }

  let canonical;
  try {
    canonical = officialCanonical({
      appId,
      openKeyId,
      timestamp: timestampText,
      callbackPath,
    });
  } catch {
    return Object.freeze({ ok: false, reason: 'canonicalization_failed' });
  }
  const randomKey = suppliedSignature.slice(0, 5);
  const digestHex = crypto
    .createHmac('sha256', `${appSecretKey}${randomKey}`)
    .update(canonical, 'utf8')
    .digest('hex');
  const expected = `${randomKey}${Buffer.from(digestHex, 'utf8').toString('base64')}`;
  const ok = constantTimeEqual(suppliedSignature, expected);
  return Object.freeze({
    ok,
    reason: ok ? 'verified' : 'signature_mismatch',
    platformTimestampMs,
    ageMs,
  });
}

function aesKey(appSecretKey) {
  const result = Buffer.alloc(16);
  Buffer.from(String(appSecretKey ?? ''), 'utf8').copy(result, 0, 0, 16);
  return result;
}

function strictBase64(value) {
  const source = text(value);
  if (
    !source
    || source.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(source)
  ) {
    throw Object.assign(new Error('Webhook ciphertext is not canonical base64.'), {
      code: 'WEBHOOK_CIPHERTEXT_INVALID',
    });
  }
  const decoded = Buffer.from(source, 'base64');
  if (!decoded.length || decoded.toString('base64') !== source) {
    throw Object.assign(new Error('Webhook ciphertext is not canonical base64.'), {
      code: 'WEBHOOK_CIPHERTEXT_INVALID',
    });
  }
  return decoded;
}

export function assertCanonicalWebhookCiphertext(value) {
  strictBase64(value);
  return true;
}

/** Only the leased asynchronous worker may call this function in production. */
export function decryptFullManagedWebhookEvent(ciphertext, appSecretKey) {
  if (!text(appSecretKey)) {
    throw Object.assign(new Error('Webhook decryption credential is unavailable.'), {
      code: 'WEBHOOK_CREDENTIAL_UNAVAILABLE',
    });
  }
  const encrypted = strictBase64(ciphertext);
  const decipher = crypto.createDecipheriv(
    'aes-128-cbc',
    aesKey(appSecretKey),
    Buffer.from(WEBHOOK_AES_IV_SEED, 'utf8').subarray(0, 16),
  );
  decipher.setAutoPadding(true);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw Object.assign(new Error('Webhook ciphertext could not be decrypted.'), {
      code: 'WEBHOOK_DECRYPT_FAILED',
    });
  }
  let payload;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    throw Object.assign(new Error('Webhook plaintext is not valid JSON.'), {
      code: 'WEBHOOK_PAYLOAD_INVALID',
    });
  } finally {
    plaintext = '';
  }
  if (
    payload === null
    || (typeof payload !== 'object' && typeof payload !== 'string')
    || Array.isArray(payload)
  ) {
    throw Object.assign(new Error('Webhook payload has an unsupported shape.'), {
      code: 'WEBHOOK_PAYLOAD_INVALID',
    });
  }
  return payload;
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

export function computeWebhookIdempotencyKey({
  appKeyHash,
  openKeyHash = '',
  eventCode = '',
  eventPath = '',
  deliveryOccurrence,
  cipherSha256,
} = {}) {
  const occurrence = text(deliveryOccurrence);
  if (!/^\d{1,16}$/.test(occurrence)) {
    throw new Error('Webhook delivery occurrence window is required.');
  }
  const material = [
    text(appKeyHash),
    text(openKeyHash),
    text(eventCode),
    text(eventPath),
    occurrence,
    text(cipherSha256),
  ].join('\u0000');
  return sha256Hex(material);
}
