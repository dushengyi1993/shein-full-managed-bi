import crypto from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  FULL_MANAGED_OPENAPI_BASE_URL,
  SheinOpenApiClient,
  buildAuthorizationUrl,
} from '../openapi/shein-client.mjs';
import { AuthorizationStoreError, sha256 } from './file-store.mjs';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STORE_CODE_PATTERN = /^[A-Z0-9_-]{1,24}$/;
const TEMP_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{8,1024}$/;
const CALLBACK_PATH = '/openapi/authorize/callback';
const STORE_INFO_PATH = '/open-api/openapi-business-backend/query-store-info';

export class AuthorizationServiceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'AuthorizationServiceError';
    this.code = code;
  }
}

function fail(code, message, options = {}) {
  throw new AuthorizationServiceError(code, message, options);
}

function assertPrivateFile(file, label) {
  return stat(file).then((metadata) => {
    if (!metadata.isFile()) fail('AUTHORIZATION_CONFIGURATION_ERROR', `${label} is not a file`);
    if (process.platform !== 'win32' && (metadata.mode & 0o007) !== 0) {
      fail('AUTHORIZATION_CONFIGURATION_ERROR', `${label} must not be accessible by other users`);
    }
  }).catch((error) => {
    if (error instanceof AuthorizationServiceError) throw error;
    fail('AUTHORIZATION_CONFIGURATION_ERROR', `${label} could not be inspected`, { cause: error });
  });
}

async function loadApplication(file, ownerStoreCode) {
  if (!file) fail('AUTHORIZATION_CONFIGURATION_ERROR', 'application credential file is required');
  await assertPrivateFile(file, 'application credential file');
  let config;
  try {
    config = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    fail('AUTHORIZATION_CONFIGURATION_ERROR', 'application credential file could not be read', {
      cause: error,
    });
  }
  if (
    config?.schemaVersion !== 1 ||
    config?.cooperationMode !== 'FULL_MANAGED' ||
    !Array.isArray(config.applications)
  ) {
    fail('AUTHORIZATION_CONFIGURATION_ERROR', 'application credential file is incompatible');
  }
  const application = config.applications.find(
    (candidate) => String(candidate?.storeCode || '').toUpperCase() === ownerStoreCode,
  );
  const appId = String(application?.appId || '').trim();
  const appSecretKey = String(application?.appSecretKey || '').trim();
  if (!appId || !appSecretKey) {
    fail('AUTHORIZATION_CONFIGURATION_ERROR', 'application credentials are incomplete');
  }
  return Object.freeze({
    ownerStoreCode,
    appId,
    appSecretKey,
    appName: String(application.appName || '').trim() || `${ownerStoreCode} 全托应用`,
  });
}

function cleanIdentityValue(value, maximum = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function collectStoreIdentity(value, maximumDepth = 8) {
  const supplierIds = new Set();
  const storeNames = new Set();
  const businessModes = new Set();
  const visit = (node, depth = 0) => {
    if (!node || depth > maximumDepth) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    for (const [rawKey, rawValue] of Object.entries(node)) {
      if (rawValue && typeof rawValue === 'object') {
        visit(rawValue, depth + 1);
        continue;
      }
      const key = rawKey.toLowerCase();
      const text = cleanIdentityValue(rawValue);
      if (!text) continue;
      if (/(supplierid|supplier_id|merchantid|merchant_id)/.test(key)) supplierIds.add(text);
      if (/(storename|store_name|shopname|shop_name|suppliername|supplier_name)/.test(key)) {
        storeNames.add(text);
      }
      if (/(supplierbusinessmode|supplier_business_mode|businessmode|business_mode)/.test(key)) {
        businessModes.add(text);
      }
    }
  };
  visit(value);
  return {
    supplierIds: [...supplierIds],
    storeNames: [...storeNames],
    businessModes: [...businessModes],
  };
}

export function verifiedIdentity(exchange, storeInfo) {
  const candidates = collectStoreIdentity(storeInfo);
  if (candidates.supplierIds.length === 0) {
    fail('STORE_IDENTITY_MISSING', 'query-store-info did not return a supplier id');
  }
  if (
    candidates.supplierIds.length !== 1 ||
    candidates.supplierIds[0] !== exchange.supplierId
  ) {
    fail('STORE_IDENTITY_MISMATCH', 'query-store-info supplier id does not match get-by-token');
  }
  return Object.freeze({
    supplierId: exchange.supplierId,
    platformStoreName: candidates.storeNames[0] || null,
    supplierBusinessMode: exchange.supplierBusinessMode || candidates.businessModes[0] || null,
  });
}

async function writeReceipt(directory, receipt) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  const safeBatchId = receipt.batchId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  const filename = `${safeBatchId}-${receipt.storeCode}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.secret.json`;
  const destination = path.join(directory, filename);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, destination);
  await chmod(destination, 0o600).catch(() => {});
  return destination;
}

function cookieValue(cookieHeader, name) {
  for (const part of String(cookieHeader || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return '';
}

function mapFailure(error) {
  const known = new Set([
    'AUTHORIZATION_CONFIGURATION_ERROR',
    'AUTHORIZATION_STATE_EXPIRED',
    'AUTHORIZATION_STATE_REPLAYED',
    'AUTHORIZATION_STATE_UNAVAILABLE',
    'BATCH_EXPIRED',
    'INVALID_AUTHORIZATION_STATE',
    'STORE_IDENTITY_MISSING',
    'STORE_IDENTITY_MISMATCH',
    'SUPPLIER_ID_ALREADY_BOUND',
    'CREDENTIAL_ALREADY_BOUND',
  ]);
  if (known.has(error?.code)) return error.code;
  if (
    [
      'HTTP_ERROR',
      'PLATFORM_ERROR',
      'NETWORK_ERROR',
      'REQUEST_TIMEOUT',
      'INVALID_AUTHORIZATION_RESPONSE',
      'SECRET_DECRYPTION_FAILED',
    ].includes(error?.code)
  ) {
    return 'SHEIN_EXCHANGE_FAILED';
  }
  return 'AUTHORIZATION_FAILED';
}

export function createFullManagedAuthorizationService({
  store,
  applicationFile,
  receiptDirectory,
  publicOrigin,
  ownerStoreCode = 'DL',
  stateTtlSeconds = 600,
  maximumStoreAttempts = 6,
  secureCookie,
  baseUrl = FULL_MANAGED_OPENAPI_BASE_URL,
  allowFakeBaseUrl = false,
  platform = process.platform,
  cloudExecution = process.env.SHEIN_FM_CLOUD_EXECUTION,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
} = {}) {
  if (!store) throw new TypeError('authorization store is required');
  if (!receiptDirectory) throw new TypeError('authorization receipt directory is required');
  let origin;
  try {
    origin = new URL(publicOrigin).origin;
  } catch {
    throw new TypeError('authorization publicOrigin must be an absolute URL');
  }
  if (new URL(origin).protocol !== 'https:' && !new URL(origin).hostname.match(/^(localhost|127\.0\.0\.1)$/)) {
    throw new TypeError('authorization publicOrigin must use HTTPS outside local development');
  }
  if (!Number.isSafeInteger(stateTtlSeconds) || stateTtlSeconds < 60 || stateTtlSeconds > 600) {
    throw new RangeError('stateTtlSeconds must be between 60 and 600');
  }
  const callbackUrl = `${origin}${CALLBACK_PATH}`;
  const cookieName = 'fm_full_authz';
  const cookieSecure = secureCookie ?? new URL(origin).protocol === 'https:';

  function tokenFromCookie(header) {
    const token = cookieValue(header, cookieName);
    if (!TOKEN_PATTERN.test(token)) fail('AUTHORIZATION_SESSION_REQUIRED', 'authorization session is missing');
    return token;
  }

  async function batchForToken(token) {
    if (!TOKEN_PATTERN.test(token)) fail('INVALID_BATCH_TOKEN', 'batch token has an invalid format');
    return store.getBatchByTokenHash(sha256(token), now());
  }

  return Object.freeze({
    cookieName,
    callbackUrl,
    publicOrigin: origin,

    async createSession(token) {
      const batch = await batchForToken(token);
      if (batch.status !== 'ACTIVE') fail('BATCH_EXPIRED', 'authorization batch is unavailable');
      const maxAge = Math.max(
        1,
        Math.min(24 * 60 * 60, Math.floor((Date.parse(batch.expiresAt) - now().getTime()) / 1000)),
      );
      return {
        batch,
        setCookie: [
          `${cookieName}=${token}`,
          'Path=/authorize',
          'HttpOnly',
          'SameSite=Lax',
          cookieSecure ? 'Secure' : '',
          `Max-Age=${maxAge}`,
        ].filter(Boolean).join('; '),
      };
    },

    clearCookie() {
      return [
        `${cookieName}=`,
        'Path=/authorize',
        'HttpOnly',
        'SameSite=Lax',
        cookieSecure ? 'Secure' : '',
        'Max-Age=0',
      ].filter(Boolean).join('; ');
    },

    async getBatch(cookieHeader) {
      return batchForToken(tokenFromCookie(cookieHeader));
    },

    async begin(cookieHeader, storeCode) {
      const token = tokenFromCookie(cookieHeader);
      const normalizedStoreCode = String(storeCode || '').toUpperCase();
      if (!STORE_CODE_PATTERN.test(normalizedStoreCode)) {
        fail('INVALID_STORE_CODE', 'store code is invalid');
      }
      const state = randomBytes(32).toString('base64url');
      if (!TOKEN_PATTERN.test(state)) fail('RANDOM_SOURCE_FAILURE', 'state generation failed');
      const startedAt = now();
      const expiresAt = new Date(startedAt.getTime() + stateTtlSeconds * 1000);
      const batch = await batchForToken(token);
      const target = batch.stores.find((candidate) => candidate.storeCode === normalizedStoreCode);
      if (!target) fail('STORE_NOT_IN_BATCH', 'store is not part of this batch');
      const applicationStoreCode = target.applicationStoreCode || ownerStoreCode;
      const application = await loadApplication(applicationFile, applicationStoreCode);
      await store.beginState({
        tokenHash: sha256(token),
        storeCode: normalizedStoreCode,
        stateHash: sha256(state),
        createdAt: startedAt,
        expiresAt,
        maxAttempts: maximumStoreAttempts,
      });
      return {
        storeCode: normalizedStoreCode,
        expiresAt: expiresAt.toISOString(),
        authorizationUrl: buildAuthorizationUrl({
          appId: application.appId,
          redirectUrl: callbackUrl,
          state,
        }),
      };
    },

    async complete({ state, tempToken }) {
      if (!TOKEN_PATTERN.test(String(state || ''))) {
        fail('INVALID_AUTHORIZATION_STATE', 'callback state has an invalid format');
      }
      if (!TEMP_TOKEN_PATTERN.test(String(tempToken || ''))) {
        fail('INVALID_TEMP_TOKEN', 'callback tempToken has an invalid format');
      }
      const stateHash = sha256(state);
      const claimedAt = now();
      const claim = await store.claimState({ stateHash, claimedAt });
      try {
        const application = await loadApplication(
          applicationFile,
          claim.applicationStoreCode || ownerStoreCode,
        );
        const bootstrapClient = new SheinOpenApiClient({
          baseUrl,
          openKeyId: application.appId,
          secretKey: application.appSecretKey,
          allowFakeBaseUrl,
          platform,
          cloudExecution,
          fetchImpl,
        });
        const exchange = await bootstrapClient.getByToken({
          appId: application.appId,
          appSecretKey: application.appSecretKey,
          tempToken,
        });
        if (exchange.appId !== application.appId) {
          fail('APPLICATION_ID_MISMATCH', 'get-by-token returned an unexpected application id');
        }
        if (exchange.state !== state) {
          fail('RETURNED_STATE_MISMATCH', 'get-by-token returned an unexpected state');
        }
        const storeClient = new SheinOpenApiClient({
          baseUrl,
          openKeyId: exchange.openKeyId,
          secretKey: exchange.secretKey,
          allowFakeBaseUrl,
          platform,
          cloudExecution,
          fetchImpl,
        });
        const storeInfo = await storeClient.request(STORE_INFO_PATH, {
          method: 'POST',
          body: {},
        });
        const identity = verifiedIdentity(exchange, storeInfo.data);
        const completedAt = now();
        const receipt = {
          schemaVersion: 1,
          cooperationMode: 'FULL_MANAGED',
          status: 'REVIEW_REQUIRED',
          batchId: claim.batchId,
          storeCode: claim.storeCode,
          applicationStoreCode: application.ownerStoreCode,
          appId: application.appId,
          openKeyId: exchange.openKeyId,
          secretKey: exchange.secretKey,
          encryptedSecretKey: exchange.encryptedSecretKey,
          identity,
          authorizedAt: completedAt.toISOString(),
        };
        const receiptFile = await writeReceipt(receiptDirectory, receipt);
        try {
          const result = await store.completeState({
            stateHash,
            completedAt,
            identity,
            receiptFile,
            credentialFingerprint: sha256(`${application.appId}:${exchange.openKeyId}`),
          });
          return Object.freeze(result);
        } catch (error) {
          await unlink(receiptFile).catch(() => {});
          throw error;
        }
      } catch (error) {
        const failureCode = mapFailure(error);
        await store.failState({ stateHash, failedAt: now(), failureCode }).catch(() => {});
        if (error instanceof AuthorizationServiceError) throw error;
        if (error instanceof AuthorizationStoreError) {
          fail(error.code, error.message, { cause: error });
        }
        fail(failureCode, 'authorization could not be completed', { cause: error });
      }
    },

    async listBatches() {
      return store.listBatches(now());
    },
  });
}

export const AUTHORIZATION_CALLBACK_PATH = CALLBACK_PATH;
