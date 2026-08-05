const RETRYABLE_CDP_CODES = Object.freeze(new Set([
  'CDP_COMMAND_TIMEOUT',
  'CDP_OPEN_TIMEOUT',
  'CDP_OPEN_FAILED',
  'CDP_SOCKET_CLOSED',
  'CDP_SOCKET_ERROR',
  'CDP_COMMAND_SEND_FAILED',
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
