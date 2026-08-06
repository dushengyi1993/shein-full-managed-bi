const RETRYABLE_CDP_CODES = Object.freeze(new Set([
  'CDP_COMMAND_TIMEOUT',
  'CDP_OPEN_TIMEOUT',
  'CDP_OPEN_FAILED',
  'CDP_SOCKET_CLOSED',
  'CDP_SOCKET_ERROR',
  'CDP_COMMAND_SEND_FAILED',
  // The scheduled production transport is browserless HTTP. These failures
  // are transient transport/server conditions and are safe to retry with the
  // same read-only request. Authentication and business-status failures are
  // deliberately absent so they go to targeted session recovery instead.
  'HOME_FETCH_FAILED',
  'HOME_HTTP_STATUS_FAILED',
]));

export function retryableCdpCode(value) {
  return RETRYABLE_CDP_CODES.has(String(value ?? '').trim().toUpperCase());
}

export function retryableHistoryResultCode(row) {
  const source = row && typeof row === 'object' ? row : {};
  return [
    source.sessionErrorCode,
    source.storeDaily?.errorCode,
    source.shopDaily?.errorCode,
    source.productDaily?.firstErrorCode,
    source.tradeDaily?.firstErrorCode,
    source.regionDaily?.firstErrorCode,
    source.realtime?.errorCode,
  ].find(retryableCdpCode) ?? null;
}
