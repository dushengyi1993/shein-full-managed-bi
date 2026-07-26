export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

function text(value) {
  return String(value ?? '').trim();
}

function parseContentType(value) {
  const [mediaType, ...parameters] = text(value).split(';');
  const values = new Map();
  for (const parameter of parameters) {
    const separator = parameter.indexOf('=');
    if (separator < 1) continue;
    const key = parameter.slice(0, separator).trim().toLowerCase();
    let item = parameter.slice(separator + 1).trim();
    if (item.startsWith('"') && item.endsWith('"')) item = item.slice(1, -1);
    values.set(key, item);
  }
  return { mediaType: mediaType.toLowerCase(), parameters: values };
}

function parseDisposition(value) {
  const [kind, ...parameters] = String(value ?? '').split(';');
  if (kind.trim().toLowerCase() !== 'form-data') return null;
  const values = new Map();
  for (const parameter of parameters) {
    const separator = parameter.indexOf('=');
    if (separator < 1) continue;
    const key = parameter.slice(0, separator).trim().toLowerCase();
    let item = parameter.slice(separator + 1).trim();
    if (item.startsWith('"') && item.endsWith('"')) item = item.slice(1, -1);
    values.set(key, item);
  }
  return values;
}

function multipartEventData(body, boundaryValue) {
  const boundary = text(boundaryValue);
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) {
    throw new Error('Webhook multipart boundary is invalid.');
  }
  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  if (!body.subarray(0, delimiter.length).equals(delimiter)) {
    throw new Error('Webhook multipart body is malformed.');
  }
  const crlf = Buffer.from('\r\n');
  const headerSeparator = Buffer.from('\r\n\r\n');
  const nextBoundary = Buffer.from(`\r\n--${boundary}`);
  let offset = delimiter.length;
  let eventData;
  let partCount = 0;

  while (true) {
    if (body.subarray(offset, offset + 2).equals(Buffer.from('--'))) {
      offset += 2;
      const remainder = body.subarray(offset);
      if (remainder.length && !remainder.equals(crlf)) {
        throw new Error('Webhook multipart closing boundary is malformed.');
      }
      break;
    }
    if (!body.subarray(offset, offset + 2).equals(crlf)) {
      throw new Error('Webhook multipart boundary must use CRLF.');
    }
    offset += 2;
    const headerEnd = body.indexOf(headerSeparator, offset);
    if (headerEnd < 0) throw new Error('Webhook multipart headers are malformed.');
    const headers = new Map();
    for (const line of body.subarray(offset, headerEnd).toString('utf8').split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon < 1) throw new Error('Webhook multipart header is malformed.');
      const name = line.slice(0, colon).trim().toLowerCase();
      if (headers.has(name)) throw new Error('Webhook multipart header is duplicated.');
      headers.set(name, line.slice(colon + 1).trim());
    }
    const contentStart = headerEnd + headerSeparator.length;
    const contentEnd = body.indexOf(nextBoundary, contentStart);
    if (contentEnd < 0) throw new Error('Webhook multipart part is unterminated.');
    partCount += 1;
    if (partCount > 32) throw new Error('Webhook multipart body has too many parts.');
    const disposition = parseDisposition(headers.get('content-disposition'));
    if (!disposition?.get('name')) throw new Error('Webhook multipart part has no name.');
    if (disposition.get('name') === 'eventData') {
      if (disposition.has('filename') || eventData !== undefined) {
        throw new Error('Webhook eventData must occur once as a scalar.');
      }
      eventData = body.subarray(contentStart, contentEnd).toString('utf8');
    }
    offset = contentEnd + 2 + delimiter.length;
  }
  if (!text(eventData)) throw new Error('Webhook eventData is required.');
  return eventData;
}

export function normalizeWebhookHeaders(headers) {
  const output = {};
  const add = (key, value) => {
    const name = text(key).toLowerCase();
    if (!name) return;
    const item = Array.isArray(value) ? value.map(String).join(', ') : String(value ?? '');
    output[name] = Object.hasOwn(output, name) ? `${output[name]}, ${item}` : item;
  };
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((value, key) => add(key, value));
  } else if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) add(key, value);
  } else {
    throw new TypeError('Webhook headers must be an object.');
  }
  return output;
}

export function assertSingletonSecurityHeaders(headers) {
  const required = [
    'x-lt-eventcode',
    'x-lt-timestamp',
    'x-lt-signature',
  ];
  const optionalIdentity = ['x-lt-appid', 'x-lt-openkeyid'];
  for (const name of required) {
    if (!text(headers[name])) throw new Error(`Webhook header ${name} is required.`);
    if (String(headers[name]).includes(',')) throw new Error(`Webhook header ${name} is duplicated.`);
  }
  for (const name of optionalIdentity) {
    if (String(headers[name] ?? '').includes(',')) {
      throw new Error(`Webhook header ${name} is duplicated.`);
    }
  }
  if (!text(headers['x-lt-appid']) && !text(headers['x-lt-openkeyid'])) {
    throw new Error('Webhook application identity is required.');
  }
}

export function extractEncryptedEventData({
  contentType,
  rawBody,
  maxBodyBytes = WEBHOOK_MAX_BODY_BYTES,
} = {}) {
  const body = Buffer.isBuffer(rawBody)
    ? Buffer.from(rawBody)
    : rawBody instanceof Uint8Array
      ? Buffer.from(rawBody)
      : typeof rawBody === 'string'
        ? Buffer.from(rawBody, 'utf8')
        : null;
  if (!body) throw new TypeError('Webhook rawBody must be bytes or text.');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new RangeError('maxBodyBytes must be a positive safe integer.');
  }
  if (!body.length) throw new Error('Webhook body is empty.');
  if (body.length > maxBodyBytes) {
    throw Object.assign(new Error('Webhook body exceeds the configured limit.'), {
      code: 'WEBHOOK_BODY_TOO_LARGE',
      statusCode: 413,
    });
  }

  const parsed = parseContentType(contentType);
  let eventData;
  if (parsed.mediaType === 'multipart/form-data') {
    eventData = multipartEventData(body, parsed.parameters.get('boundary'));
  } else if (parsed.mediaType === 'application/json') {
    let value;
    try {
      value = JSON.parse(body.toString('utf8'));
    } catch {
      throw new Error('Webhook JSON body is invalid.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Webhook JSON body must be an object.');
    }
    if (typeof value.eventData !== 'string') {
      throw new Error('Webhook JSON eventData must be a string.');
    }
    eventData = value.eventData;
  } else if (parsed.mediaType === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams(body.toString('utf8'));
    const values = form.getAll('eventData');
    if (values.length !== 1) throw new Error('Webhook form eventData must occur once.');
    eventData = values[0];
  } else {
    throw new Error('Webhook content type is unsupported.');
  }
  if (!text(eventData)) throw new Error('Webhook eventData is required.');
  return eventData;
}

export function readWebhookBody(request, maxBodyBytes = WEBHOOK_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBodyBytes) {
        fail(Object.assign(new Error('Webhook body exceeds the configured limit.'), {
          code: 'WEBHOOK_BODY_TOO_LARGE',
          statusCode: 413,
        }));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.on('aborted', () => fail(new Error('Webhook request was aborted.')));
    request.on('error', fail);
  });
}
