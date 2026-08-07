export const FULL_MANAGED_STORE_CODES = Object.freeze([
  'CX4412',
  'XL2801',
  'QY8886',
  'DX0571',
  'NM7397',
  'LQ7173',
  'TS8263',
  'DL5477',
  'FY4021',
  'GJ8989',
  'QH8028',
  'JY8060',
  'ZL3133',
  'MZ2406',
  'YJ8177',
  'RH0099',
  'WY9025',
  'RH2848',
  'CX2816',
  'YJ4042',
  'NM4977',
  'NM8787',
  'NM8831',
  'NM7418',
  'DX2420',
]);

const STORE_SET = new Set(FULL_MANAGED_STORE_CODES);

export function normalizeFullManagedStoreCode(value) {
  const storeCode = String(value ?? '').trim().toUpperCase();
  return STORE_SET.has(storeCode) ? storeCode : null;
}

export function fullManagedProfileKey(value) {
  const storeCode = normalizeFullManagedStoreCode(value);
  if (!storeCode) return null;
  return `persistent-${storeCode.toLowerCase()}-profile`;
}

export function fullManagedRuntimeSlot(value) {
  const storeCode = normalizeFullManagedStoreCode(value);
  if (!storeCode) return null;
  // Keep fixed CDP listeners outside Linux's default ephemeral port range
  // (32768-60999). Otherwise an unrelated outbound loopback connection can
  // occupy the same local port before Chrome binds it.
  const allocationOrder = [
    'DL5477',
    'MZ2406',
    ...FULL_MANAGED_STORE_CODES.filter((code) => !['DL5477', 'MZ2406'].includes(code)),
  ];
  const index = allocationOrder.indexOf(storeCode);
  return Object.freeze({
    debuggingPort: 62_041 + index,
    display: `:${941 + index}`,
  });
}
