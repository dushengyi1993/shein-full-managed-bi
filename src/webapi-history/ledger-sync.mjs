import {
  buildLedgerDailyRequest,
  historyWindows,
  parseLedgerDailyRows,
  sha256Json,
} from './home-contracts.mjs';

function safeCode(error, fallback = 'HOME_LEDGER_SYNC_FAILED') {
  const direct = String(error?.code ?? '').toUpperCase();
  if (/^[A-Z][A-Z0-9_]{2,80}$/.test(direct)) return direct;
  const message = String(error?.message ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : fallback;
}

function schemaShape(value, prefix = '$', output = []) {
  if (output.length >= 300) return output;
  if (Array.isArray(value)) {
    output.push(`${prefix}:array`);
    if (value.length) schemaShape(value[0], `${prefix}[]`, output);
    return output;
  }
  if (value && typeof value === 'object') {
    output.push(`${prefix}:object`);
    for (const key of Object.keys(value).sort()) schemaShape(value[key], `${prefix}.${key}`, output);
    return output;
  }
  output.push(`${prefix}:${value === null ? 'null' : typeof value}`);
  return output;
}

function nowIso(clock) {
  const current = clock();
  const date = current instanceof Date ? current : new Date(current);
  if (Number.isNaN(date.valueOf())) throw new TypeError('clock returned an invalid date');
  return date.toISOString();
}

async function syncWindow({
  storeCode,
  window,
  transport,
  repository,
  clock,
}) {
  const request = buildLedgerDailyRequest({
    ...window,
    pageNumber: 1,
    pageSize: 100,
  });
  const observedAt = nowIso(clock);
  try {
    const response = await transport('LEDGER_DAILY', request);
    const parsed = parseLedgerDailyRows(response.body, { storeCode, observedAt });
    if (parsed.rows.length !== parsed.count) {
      const error = new Error('ledger page did not contain the complete reviewed window');
      error.code = 'HOME_LEDGER_PAGINATION_MISMATCH';
      throw error;
    }
    await repository.upsertLedgerDaily(parsed.rows);
    const completedAt = nowIso(clock);
    await repository.recordFetchAudit({
      storeCode,
      endpointCode: 'LEDGER_DAILY',
      requestedStartDate: window.startDate,
      requestedEndDate: window.endDate,
      request,
      responseSchemaSha256: sha256Json(schemaShape(response.body)),
      responseBodySha256: sha256Json(response.body),
      httpStatus: response.httpStatus,
      resultStatus: 'SUCCEEDED',
      acceptedRowCount: parsed.rows.length,
      rejectedRowCount: 0,
      observedAt,
      completedAt,
    });
    return {
      storeCode,
      ...window,
      ok: true,
      accepted: parsed.rows.length,
    };
  } catch (error) {
    const completedAt = nowIso(clock);
    const errorCode = safeCode(error);
    await repository.recordFetchAudit({
      storeCode,
      endpointCode: 'LEDGER_DAILY',
      requestedStartDate: window.startDate,
      requestedEndDate: window.endDate,
      request,
      httpStatus: null,
      resultStatus: 'FAILED',
      acceptedRowCount: 0,
      rejectedRowCount: 0,
      observedAt,
      completedAt,
      sanitizedErrorCode: errorCode,
    }).catch(() => {});
    return {
      storeCode,
      ...window,
      ok: false,
      errorCode,
    };
  }
}

export async function runFullHomeLedgerSync({
  storeCodes,
  startDate,
  endDate,
  allowSavedCredentialLogin = true,
  openSession,
  transportFactory,
  repository,
  clock = () => new Date(),
} = {}) {
  if (!Array.isArray(storeCodes) || storeCodes.length === 0) {
    throw new TypeError('storeCodes are required');
  }
  for (const dependency of [openSession, transportFactory]) {
    if (typeof dependency !== 'function') throw new TypeError('ledger sync dependency missing');
  }
  for (const method of ['recordFetchAudit', 'upsertLedgerDaily']) {
    if (typeof repository?.[method] !== 'function') {
      throw new TypeError(`repository.${method} is required`);
    }
  }
  // One row per day and at most 31 rows per request keeps the page complete,
  // bounded and resumable without relying on a private cursor contract.
  const windows = historyWindows({ startDate, endDate, maximumDays: 31 });
  const results = [];
  for (const rawStoreCode of storeCodes) {
    const storeCode = String(rawStoreCode).trim().toUpperCase();
    let session = null;
    try {
      session = await openSession({ storeCode, allowSavedCredentialLogin });
      const transport = transportFactory({ session });
      for (const window of windows) {
        results.push(await syncWindow({
          storeCode,
          window,
          transport,
          repository,
          clock,
        }));
      }
    } catch (error) {
      results.push({
        storeCode,
        startDate,
        endDate,
        ok: false,
        errorCode: safeCode(error, 'HOME_LEDGER_SESSION_FAILED'),
      });
    } finally {
      await session?.close?.().catch(() => {});
    }
  }
  const failedWindows = results.filter(({ ok }) => !ok).length;
  return Object.freeze({
    ok: failedWindows === 0,
    storeCount: storeCodes.length,
    windowCount: windows.length,
    resultCount: results.length,
    failedWindows,
    results: Object.freeze(results),
  });
}
