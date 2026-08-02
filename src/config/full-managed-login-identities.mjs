import fssync from 'node:fs';

import {
  normalizeFullManagedStoreCode,
} from './full-managed-stores.mjs';

export const DEFAULT_FULL_MANAGED_LOGIN_IDENTITY_ALIASES_FILE =
  '/srv/shein-fm/secrets/store-login/identity-aliases.secret.json';

export function parseFullManagedLoginIdentityAliases(raw) {
  if (
    !raw
    || raw.schemaVersion !== 1
    || !raw.aliases
    || typeof raw.aliases !== 'object'
    || Array.isArray(raw.aliases)
  ) {
    throw new Error('STORE_LOGIN_IDENTITY_ALIASES_INVALID');
  }
  const result = {};
  const seenAliases = new Set();
  for (const [storeCode, rawAliases] of Object.entries(raw.aliases)) {
    const canonical = normalizeFullManagedStoreCode(storeCode);
    if (canonical !== storeCode || !Array.isArray(rawAliases) || rawAliases.length > 4) {
      throw new Error('STORE_LOGIN_IDENTITY_ALIASES_INVALID');
    }
    const aliases = [];
    for (const rawAlias of rawAliases) {
      const alias = String(rawAlias || '').trim();
      if (
        !/^[A-Za-z0-9._@-]{3,64}$/.test(alias)
        || seenAliases.has(alias)
        || aliases.includes(alias)
      ) {
        throw new Error('STORE_LOGIN_IDENTITY_ALIASES_INVALID');
      }
      seenAliases.add(alias);
      aliases.push(alias);
    }
    result[canonical] = Object.freeze(aliases);
  }
  return Object.freeze(result);
}

export function loadFullManagedLoginIdentityAliases(file) {
  if (!file || !fssync.existsSync(file)) return Object.freeze({});
  try {
    return parseFullManagedLoginIdentityAliases(
      JSON.parse(fssync.readFileSync(file, 'utf8')),
    );
  } catch {
    throw new Error('STORE_LOGIN_IDENTITY_ALIASES_INVALID');
  }
}

export function fullManagedLoginIdentityMarkers(storeCode, aliases = {}) {
  const canonical = normalizeFullManagedStoreCode(storeCode);
  if (!canonical) throw new Error('STORE_INVALID');
  return Object.freeze([
    canonical.slice(-4),
    ...(aliases[canonical] || []),
  ]);
}
