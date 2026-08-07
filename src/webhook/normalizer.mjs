const MAX_EMBEDDED_JSON_BYTES = 256 * 1024;
const MAX_VISITED_OBJECTS = 256;
const MAX_DEPTH = 5;

function text(value) {
  return String(value ?? '').trim();
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeIdentifier(value, maximum = 160) {
  const result = text(value).slice(0, maximum);
  if (!result || /[\u0000-\u001f\u007f]/.test(result)) return '';
  return /^[\p{L}\p{N}._:/@+\-# ]+$/u.test(result) ? result : '';
}

function safeToken(value, maximum = 80) {
  const result = text(value).slice(0, maximum);
  if (!result || /[\u0000-\u001f\u007f]/.test(result)) return '';
  return /^[\p{L}\p{N}._:/+\- ]+$/u.test(result) ? result : '';
}

function unpack(value, depth = 0) {
  let current = value;
  if (typeof current === 'string') {
    if (Buffer.byteLength(current, 'utf8') > MAX_EMBEDDED_JSON_BYTES) {
      throw Object.assign(new Error('Embedded webhook JSON is too large.'), {
        code: 'WEBHOOK_PAYLOAD_LIMIT',
      });
    }
    try {
      current = JSON.parse(current);
    } catch {
      throw Object.assign(new Error('Embedded webhook data is invalid JSON.'), {
        code: 'WEBHOOK_PAYLOAD_INVALID',
      });
    }
  }
  if (Array.isArray(current)) {
    if (current.length !== 1) {
      throw Object.assign(new Error('Webhook array payload must contain exactly one event.'), {
        code: 'WEBHOOK_PAYLOAD_INVALID',
      });
    }
    return unpack(current[0], depth + 1);
  }
  if (!object(current)) {
    throw Object.assign(new Error('Webhook payload must resolve to an object.'), {
      code: 'WEBHOOK_PAYLOAD_INVALID',
    });
  }
  if (typeof current.data === 'string' && depth < MAX_DEPTH) {
    return { ...current, data: unpack(current.data, depth + 1) };
  }
  return current;
}

function nodes(payload) {
  const result = [];
  const queue = [{ value: unpack(payload), depth: 0 }];
  const visited = new Set();
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!object(value) || visited.has(value)) continue;
    visited.add(value);
    result.push(value);
    if (result.length > MAX_VISITED_OBJECTS) {
      throw Object.assign(new Error('Webhook payload has too many objects.'), {
        code: 'WEBHOOK_PAYLOAD_LIMIT',
      });
    }
    if (depth >= MAX_DEPTH) continue;
    for (const child of Object.values(value)) {
      if (object(child)) queue.push({ value: child, depth: depth + 1 });
      else if (Array.isArray(child)) {
        for (const item of child.slice(0, 64)) {
          if (object(item)) queue.push({ value: item, depth: depth + 1 });
        }
      }
    }
  }
  return result;
}

function firstField(sources, names, sanitizer = safeIdentifier) {
  for (const source of sources) {
    for (const name of names) {
      if (!Object.hasOwn(source, name)) continue;
      const result = sanitizer(source[name]);
      if (result) return result;
    }
  }
  return '';
}

function numericField(sources, names) {
  const raw = firstField(sources, names, (value) => text(value).slice(0, 40));
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
  const result = Number(raw);
  return Number.isFinite(result) ? result : null;
}

function normalizedInstant(value) {
  const raw = text(value);
  if (!raw) return null;
  let milliseconds;
  if (/^\d{10,16}$/.test(raw)) {
    const number = Number(raw);
    if (!Number.isFinite(number)) return null;
    milliseconds = raw.length <= 10
      ? number * 1_000
      : raw.length <= 13
        ? number
        : number / (10 ** (raw.length - 13));
  } else {
    const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(raw)
      ? `${raw.replace(' ', 'T')}+08:00`
      : raw;
    milliseconds = Date.parse(normalized);
  }
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function productIdentity(sources) {
  return {
    spu: firstField(sources, [
      'spuName', 'spu_name', 'spuCode', 'spu_code', 'spuId', 'spu_id',
    ]),
    skc: firstField(sources, [
      'skcName', 'skc_name', 'skcCode', 'skc_code', 'skcId', 'skc_id',
    ]),
    sku: firstField(sources, [
      'skuCode', 'sku_code', 'skuName', 'sku_name', 'skuId', 'sku_id', 'sku',
    ]),
    document: firstField(sources, [
      'documentSn', 'document_sn', 'documentNo', 'document_no',
      'documentId', 'document_id',
    ]),
  };
}

function firstIdentity(identifiers) {
  return identifiers.document || identifiers.skc || identifiers.spu || identifiers.sku || '';
}

function baseBusinessKey(event, sources, identifiers) {
  switch (event.family) {
    case 'purchase_order':
      return firstField(sources, [
        'purchaseOrderNo', 'purchase_order_no', 'purchaseOrderSn',
        'purchase_order_sn', 'poNo', 'po_no', 'orderNo', 'order_no',
      ]);
    case 'delivery':
      return firstField(sources, [
        'deliveryNo', 'delivery_no', 'deliveryOrderNo', 'delivery_order_no',
        'deliveryCode', 'delivery_code',
      ]);
    case 'logistics_forecast':
      return firstField(sources, [
        'forecastNo', 'forecast_no', 'logisticsNo', 'logistics_no',
        'deliveryNo', 'delivery_no',
      ]);
    case 'purchase_return_application':
      return firstField(sources, [
        'returnApplicationNo', 'return_application_no', 'returnApplyNo',
        'return_apply_no', 'applicationNo', 'application_no',
      ]);
    case 'purchase_return':
      return firstField(sources, [
        'purchaseReturnNo', 'purchase_return_no', 'returnOrderNo',
        'return_order_no', 'returnNo', 'return_no',
      ]);
    case 'shortage':
      return firstField(sources, [
        'shortageDemandNo', 'shortage_demand_no', 'demandNo', 'demand_no',
      ]) || firstIdentity(identifiers);
    case 'authorization_change':
      return '';
    default:
      return firstIdentity(identifiers);
  }
}

function severityFor(event, status, quota) {
  if (event.family === 'authorization_change') return 'P0';
  if (event.family === 'product_quota' && quota !== null && quota <= 0) return 'P0';
  if (['shortage', 'product_compliance', 'purchase_return_application', 'purchase_return'].includes(event.family)) {
    return 'P1';
  }
  if (
    ['product_audit', 'product_audit_all_channels', 'product_delete_audit', 'rrp_review'].includes(event.family)
    && /(?:fail|reject|denied|invalid|delete|remove|^3$|^5$)/i.test(status)
  ) {
    return 'P1';
  }
  if (['purchase_order', 'delivery', 'logistics_forecast'].includes(event.family)) return 'P2';
  return 'P3';
}

function lookupFor(event, businessKey, identifiers) {
  if (event.businessType === 'STORE') return {};
  const lookup = {};
  if (businessKey) lookup.businessKey = businessKey;
  for (const [key, value] of Object.entries(identifiers)) {
    if (value) lookup[key] = value;
  }
  return lookup;
}

export function normalizeFullManagedWebhookEvent({
  event,
  payload,
  storeCode,
  deliveryScope,
  receivedAt,
} = {}) {
  if (!event || event.family === 'unknown') {
    throw new TypeError('A known full-managed webhook event is required.');
  }
  const sourceNodes = nodes(payload);
  const identifiers = productIdentity(sourceNodes);
  const status = firstField(sourceNodes, [
    'status', 'state', 'auditState', 'audit_state', 'auditStatus', 'audit_status',
    'resultStatus', 'result_status', 'type', 'authType', 'auth_type',
  ], safeToken);
  const action = firstField(sourceNodes, [
    'action', 'operationType', 'operation_type', 'operateType', 'operate_type',
    'changeType', 'change_type',
  ], safeToken) || event.family;
  const eventTime = firstField(sourceNodes, [
    'eventTime', 'event_time', 'changeTime', 'change_time', 'updateTime',
    'update_time', 'auditTime', 'audit_time', 'sendTimeStamp', 'time',
  ], (value) => text(value).slice(0, 80));
  const quota = event.family === 'product_quota'
    ? numericField(sourceNodes, [
      'availableLimit', 'available_limit', 'availableQuota', 'available_quota',
      'remainingQuota', 'remaining_quota', 'quota',
    ])
    : null;
  const appScopedOnly = deliveryScope === 'APP_ONLY';
  const businessKey = appScopedOnly ? '' : baseBusinessKey(event, sourceNodes, identifiers);
  const safeIdentifiers = appScopedOnly
    ? {}
    : Object.fromEntries(Object.entries(identifiers).filter(([, value]) => Boolean(value)));
  const normalized = {
    schemaVersion: 1,
    eventCode: event.eventCode,
    eventPath: event.eventPath,
    eventFamily: event.family,
    eventLabel: event.label,
    businessType: event.businessType,
    businessKey: businessKey || null,
    storeCode: storeCode ?? null,
    deliveryScope,
    appScopedOnly,
    occurredAt: normalizedInstant(eventTime),
    receivedAt: normalizedInstant(receivedAt) ?? new Date().toISOString(),
    action,
    status: status || null,
    identifiers: safeIdentifiers,
    metrics: quota === null || appScopedOnly ? {} : { availableQuota: quota },
    severity: appScopedOnly ? 'P3' : severityFor(event, status, quota),
  };
  const hydrationDirective = appScopedOnly || !event.hydrationType
    ? null
    : {
      directiveType: event.hydrationType,
      capabilityCode: event.hydrationType,
      lookup: lookupFor(event, businessKey, identifiers),
    };
  return Object.freeze({
    normalized: Object.freeze(normalized),
    hydrationDirective: hydrationDirective ? Object.freeze(hydrationDirective) : null,
    closeAuthorizationGate: !appScopedOnly && event.family === 'authorization_change',
  });
}

export function createUnknownWebhookAuditEvent({
  event,
  storeCode,
  deliveryScope,
  receivedAt,
} = {}) {
  return Object.freeze({
    schemaVersion: 1,
    eventCode: event?.eventCode || null,
    eventPath: event?.eventPath || null,
    eventFamily: 'unknown',
    eventLabel: '未知事件',
    businessType: 'UNKNOWN',
    businessKey: null,
    storeCode: storeCode ?? null,
    deliveryScope,
    appScopedOnly: deliveryScope === 'APP_ONLY',
    occurredAt: null,
    receivedAt: normalizedInstant(receivedAt) ?? new Date().toISOString(),
    action: 'quarantined',
    status: null,
    identifiers: {},
    metrics: {},
    severity: 'P3',
  });
}
