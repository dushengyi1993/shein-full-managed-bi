import { resolveFullManagedWebhookEvent } from '../webhook/event-registry.mjs';

const STORE_PATTERN = /^[A-Z0-9]{2,12}$/;
const OWNER_PATTERN = /^[\p{L}\p{N}._:-]{1,64}$/u;
const CODE_PATTERN = /^[\p{L}\p{N}._:/-]{1,120}$/u;
const INTEGER_PATTERN = /^[1-9][0-9]*$/;
const QUERY_PARAMETERS = Object.freeze(new Set([
  'owner',
  'store',
  'q',
  'view',
  'severity',
  'family',
  'status',
  'sort',
  'page',
  'pageSize',
]));

const VIEWS = Object.freeze(['URGENT', 'ATTENTION', 'BUSINESS', 'ALL']);
const SEVERITIES = Object.freeze(['ALL', 'P0', 'P1', 'P2', 'P3']);
const SORTS = Object.freeze(['PRIORITY', 'LATEST']);
const PAGE_SIZES = Object.freeze([25, 50, 100]);
const PRIORITY_RANK = Object.freeze({
  P0: 4,
  CRITICAL: 4,
  P1: 3,
  HIGH: 3,
  P2: 2,
  MEDIUM: 2,
  P3: 1,
  LOW: 1,
});
const FAILURE_PATTERN = /(FAIL|ERROR|DEAD|BLOCK|EXPIRE|DENY|REJECT|INVALID|CANCEL)/i;

export class PlatformQueryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlatformQueryError';
    this.code = code;
    this.statusCode = 400;
  }
}

function fail(code, message) {
  throw new PlatformQueryError(code, message);
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function assertKnownParameters(params) {
  for (const name of params.keys()) {
    if (!QUERY_PARAMETERS.has(name)) {
      fail('QUERY_PARAMETER_UNKNOWN', `不支持参数 ${name}`);
    }
  }
}

function textParam(params, name, { maximum, pattern, fallback = '' } = {}) {
  const values = params.getAll(name);
  if (values.length > 1) fail('QUERY_PARAMETER_DUPLICATED', `参数 ${name} 不能重复`);
  if (values.length === 0) return fallback;
  const value = values[0].trim();
  if (value.length > maximum) fail('QUERY_PARAMETER_TOO_LONG', `参数 ${name} 过长`);
  if (pattern && value !== '' && !pattern.test(value)) {
    fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
  }
  return value;
}

function enumParam(params, name, allowed, fallback) {
  const value = textParam(params, name, { maximum: 40, fallback }).toUpperCase();
  if (!allowed.includes(value)) fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
  return value;
}

function integerParam(params, name, { fallback, minimum, maximum }) {
  const value = textParam(params, name, { maximum: 8, fallback: String(fallback) });
  if (!INTEGER_PATTERN.test(value)) fail('QUERY_PARAMETER_INVALID', `参数 ${name} 必须是整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('QUERY_PARAMETER_OUT_OF_RANGE', `参数 ${name} 超出范围`);
  }
  return parsed;
}

function pageSizeParam(params) {
  const value = integerParam(params, 'pageSize', {
    fallback: 25,
    minimum: 1,
    maximum: 100,
  });
  if (!PAGE_SIZES.includes(value)) {
    fail('QUERY_PARAMETER_OUT_OF_RANGE', '参数 pageSize 只能是 25、50 或 100');
  }
  return value;
}

function searchable(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function safeProjectionText(event) {
  const projection = record(event.safeProjection);
  const identifiers = record(projection.identifiers);
  const metrics = record(projection.metrics);
  return [
    projection.eventLabel,
    projection.deliveryScope,
    ...Object.values(identifiers),
    ...Object.keys(metrics),
    ...Object.values(metrics),
  ].filter((value) => value !== null && value !== undefined).join(' ');
}

function containsQuery(event, query) {
  if (query === '') return true;
  return [
    event.eventCode,
    event.eventPath,
    event.eventFamily,
    event.businessType,
    event.businessKey,
    event.storeCode,
    event.action,
    event.status,
    event.severity,
    safeProjectionText(event),
  ].some((value) => searchable(value).includes(query));
}

function ownerStoreSet(dashboard, ownerKey) {
  if (ownerKey === 'ALL') return null;
  const owner = rows(dashboard.owners).find((item) => item.key === ownerKey);
  if (!owner) fail('QUERY_OWNER_UNKNOWN', '负责人不在当前数据范围内');
  return new Set(rows(owner.storeCodes).map((code) => String(code).toUpperCase()));
}

function matchesScope(event, { store, ownerStores }) {
  const storeCode = String(event.storeCode ?? '').toUpperCase();
  if (store !== 'ALL') return storeCode === store;
  if (ownerStores) return ownerStores.has(storeCode);
  return true;
}

function priorityRank(value) {
  return PRIORITY_RANK[String(value ?? '').toUpperCase()] ?? 0;
}

function severityBucket(value) {
  const rank = priorityRank(value);
  return rank === 4 ? 'P0'
    : rank === 3 ? 'P1'
      : rank === 2 ? 'P2'
        : rank === 1 ? 'P3'
          : 'UNKNOWN';
}

function isFailure(event) {
  return FAILURE_PATTERN.test([
    event.status,
    event.action,
  ].filter(Boolean).join(' '));
}

function isOperatorAttention(event) {
  return priorityRank(event.severity) >= 2 || isFailure(event);
}

function isBusinessEvent(event) {
  const projection = record(event.safeProjection);
  return (
    event.deliveryScope === 'STORE'
    && projection.appScopedOnly !== true
  );
}

function matchesView(event, view) {
  if (view === 'URGENT') return priorityRank(event.severity) >= 3 || isFailure(event);
  if (view === 'ATTENTION') return isOperatorAttention(event);
  if (view === 'BUSINESS') return isBusinessEvent(event);
  return true;
}

function comparableInstant(value, fallback = 0) {
  const parsed = new Date(value ?? '').valueOf();
  return Number.isFinite(parsed) ? parsed : fallback;
}

function eventInstant(event) {
  return event.occurredAt
    || record(event.safeProjection).receivedAt
    || event.createdAt
    || null;
}

function latestInstant(inputRows) {
  const values = inputRows
    .map((event) => comparableInstant(eventInstant(event), Number.NaN))
    .filter(Number.isFinite);
  return values.length === 0 ? null : new Date(Math.max(...values)).toISOString();
}

function compareEvents(sort) {
  return (left, right) => {
    if (sort === 'PRIORITY') {
      const priorityDelta = priorityRank(right.severity) - priorityRank(left.severity);
      if (priorityDelta) return priorityDelta;
      const failureDelta = Number(isFailure(right)) - Number(isFailure(left));
      if (failureDelta) return failureDelta;
    }
    const timeDelta = comparableInstant(eventInstant(right)) - comparableInstant(eventInstant(left));
    if (timeDelta) return timeDelta;
    return String(left.eventCode ?? '').localeCompare(String(right.eventCode ?? ''));
  };
}

function eventLabel(event) {
  const projectionLabel = String(record(event.safeProjection).eventLabel ?? '').trim();
  if (projectionLabel) return projectionLabel;
  const definition = resolveFullManagedWebhookEvent(event.eventCode || event.eventPath);
  return definition.label || event.eventFamily || event.eventCode || '平台事件';
}

function countBy(inputRows, keyOf, labelOf = null) {
  const grouped = new Map();
  for (const item of inputRows) {
    const key = String(keyOf(item) ?? '').trim();
    if (!key) continue;
    const current = grouped.get(key) ?? {
      key,
      label: labelOf ? labelOf(item) : key,
      count: 0,
      latestAt: null,
    };
    current.count += 1;
    const itemAt = eventInstant(item);
    if (
      itemAt
      && comparableInstant(itemAt) > comparableInstant(current.latestAt)
    ) current.latestAt = new Date(itemAt).toISOString();
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) => (
    right.count - left.count
    || comparableInstant(right.latestAt) - comparableInstant(left.latestAt)
    || left.key.localeCompare(right.key)
  ));
}

function subscriptionSummary(inputRows) {
  const mismatched = inputRows.filter((row) => (
    row.desiredState
    && row.observedState
    && row.desiredState !== row.observedState
  )).length;
  const callbackFailed = inputRows.filter((row) => row.callbackValidated === false).length;
  const callbackUnknown = inputRows.filter((row) => row.callbackValidated === null).length;
  const checkedAt = inputRows
    .flatMap((row) => [row.checkedAt, row.updatedAt])
    .filter(Boolean);
  return {
    readbackCount: inputRows.length,
    mismatchedCount: mismatched,
    callbackFailedCount: callbackFailed,
    callbackUnknownCount: callbackUnknown,
    latestCheckedAt: checkedAt.length
      ? new Date(Math.max(...checkedAt.map((value) => comparableInstant(value)))).toISOString()
      : null,
  };
}

function evaluatedInstant(dashboard, platform) {
  const candidates = [
    platform.health?.evaluatedAt,
    dashboard.updatedAt,
  ].map((value) => comparableInstant(value, Number.NaN)).filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : null;
}

function last24HourCount(inputRows, evaluatedAt) {
  if (!Number.isFinite(evaluatedAt)) return null;
  const start = evaluatedAt - 24 * 60 * 60 * 1000;
  return inputRows.filter((event) => {
    const value = comparableInstant(eventInstant(event), Number.NaN);
    return Number.isFinite(value) && value >= start && value <= evaluatedAt;
  }).length;
}

export function queryPlatformDashboard(dashboardValue, paramsValue = new URLSearchParams()) {
  const dashboard = record(dashboardValue);
  const params = paramsValue instanceof URLSearchParams
    ? paramsValue
    : new URLSearchParams(paramsValue);
  assertKnownParameters(params);

  const owner = textParam(params, 'owner', {
    maximum: 64,
    pattern: OWNER_PATTERN,
    fallback: 'ALL',
  }) || 'ALL';
  const store = (textParam(params, 'store', {
    maximum: 12,
    pattern: STORE_PATTERN,
    fallback: 'ALL',
  }) || 'ALL').toUpperCase();
  const rawQuery = textParam(params, 'q', { maximum: 120, fallback: '' });
  const query = searchable(rawQuery);
  const view = enumParam(params, 'view', VIEWS, 'URGENT');
  const severity = enumParam(params, 'severity', SEVERITIES, 'ALL');
  const family = (textParam(params, 'family', {
    maximum: 120,
    pattern: CODE_PATTERN,
    fallback: 'ALL',
  }) || 'ALL').toUpperCase();
  const status = (textParam(params, 'status', {
    maximum: 120,
    pattern: CODE_PATTERN,
    fallback: 'ALL',
  }) || 'ALL').toUpperCase();
  const sort = enumParam(params, 'sort', SORTS, 'PRIORITY');
  const page = integerParam(params, 'page', { fallback: 1, minimum: 1, maximum: 10_000 });
  const pageSize = pageSizeParam(params);

  const platform = record(dashboard.platform);
  const allEvents = rows(platform.events);
  const ownerStores = ownerStoreSet(dashboard, owner);
  const scopedEvents = allEvents.filter((event) => matchesScope(event, { store, ownerStores }));
  const attentionEvents = scopedEvents.filter(isOperatorAttention);
  const matchedEvents = scopedEvents
    .filter((event) => (
      matchesView(event, view)
      && containsQuery(event, query)
      && (severity === 'ALL' || severityBucket(event.severity) === severity)
      && (family === 'ALL' || String(event.eventFamily ?? '').toUpperCase() === family)
      && (
        status === 'ALL'
        || String(event.status || event.action || '').toUpperCase() === status
      )
    ))
    .sort(compareEvents(sort));
  const offset = (page - 1) * pageSize;
  const pageRows = matchedEvents.slice(offset, offset + pageSize);
  const pageCount = matchedEvents.length
    ? Math.ceil(matchedEvents.length / pageSize)
    : 0;
  const evaluatedAt = evaluatedInstant(dashboard, platform);
  const highPriority = attentionEvents.filter((event) => priorityRank(event.severity) >= 3);
  const failureEvents = scopedEvents.filter(isFailure);
  const subscriptions = rows(platform.subscriptions);
  const meta = record(platform.eventMeta);
  const materializedLimit = Number.isSafeInteger(meta.limit) && meta.limit > 0
    ? meta.limit
    : 100;
  const materializedTruncated = typeof meta.truncated === 'boolean'
    ? meta.truncated
    : allEvents.length >= materializedLimit;

  return Object.freeze({
    schemaVersion: 1,
    readOnly: true,
    source: Object.freeze({
      dashboardUpdatedAt: dashboard.updatedAt ?? null,
      businessDate: dashboard.businessDate ?? null,
      status: platform.status ?? 'pending',
      eventMaterialization: Object.freeze({
        returned: allEvents.length,
        limit: materializedLimit,
        truncated: materializedTruncated,
      }),
      latestEventAt: latestInstant(scopedEvents),
      healthEvaluatedAt: platform.health?.evaluatedAt ?? null,
    }),
    health: platform.health ?? null,
    queue: platform.queue ?? null,
    subscription: Object.freeze({
      ...subscriptionSummary(subscriptions),
      rows: Object.freeze(subscriptions),
    }),
    summary: Object.freeze({
      scopedEventCount: scopedEvents.length,
      attentionEventCount: attentionEvents.length,
      last24hAttentionCount: last24HourCount(attentionEvents, evaluatedAt),
      highPriorityCount: highPriority.length,
      failureEventCount: failureEvents.length,
      businessEventCount: scopedEvents.filter(isBusinessEvent).length,
      technicalEventCount: scopedEvents.filter((event) => !isBusinessEvent(event)).length,
      impactedStoreCount: new Set(attentionEvents.map((event) => event.storeCode).filter(Boolean)).size,
      attentionByStore: Object.freeze(countBy(
        attentionEvents,
        (event) => event.storeCode,
      )),
      attentionByFamily: Object.freeze(countBy(
        attentionEvents,
        (event) => event.eventFamily || event.eventCode,
        eventLabel,
      )),
    }),
    events: Object.freeze({
      rows: Object.freeze(pageRows),
      pagination: Object.freeze({
        page,
        pageSize,
        pageCount,
        matchedMaterializedRows: matchedEvents.length,
        materializedRows: allEvents.length,
        hasPrevious: page > 1 && pageCount > 0,
        hasNext: page < pageCount,
      }),
    }),
    filters: Object.freeze({
      views: VIEWS,
      severities: SEVERITIES,
      families: Object.freeze(countBy(
        scopedEvents,
        (event) => event.eventFamily || event.eventCode,
        eventLabel,
      ).map(({ key, label }) => ({ code: key, name: label }))),
      statuses: Object.freeze([...new Set(
        scopedEvents
          .map((event) => String(event.status || event.action || '').trim())
          .filter(Boolean),
      )].sort().map((code) => ({ code, name: code }))),
      sorts: SORTS,
      pageSizes: PAGE_SIZES,
    }),
    query: Object.freeze({
      owner,
      store,
      q: rawQuery,
      view,
      severity,
      family,
      status,
      sort,
      page,
      pageSize,
    }),
  });
}
