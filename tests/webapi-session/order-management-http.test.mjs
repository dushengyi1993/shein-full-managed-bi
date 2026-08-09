import assert from 'node:assert/strict';
import test from 'node:test';

import { orderManagementRequestBody } from '../../src/webapi-history/order-management-contracts.mjs';
import {
  OrderManagementTransportError,
  createOrderManagementHttpTransport,
  openOrderManagementHttpSession,
  platformMessageDigest,
  sanitizePlatformCode,
  sanitizePlatformMessage,
} from '../../src/webapi-session/order-management-http.mjs';

const NOW = new Date('2026-08-09T06:00:00.000Z');
const WINDOW = { startDate: '2026-08-01', endDate: '2026-08-08' };

function bundle(storeCode = 'DL5477') {
  return {
    version: 1,
    storeCode,
    origin: 'https://sso.geiwohuo.com',
    userAgent: 'order-management-http-test-agent',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    identityProvenAt: NOW.toISOString(),
    lastVerifiedAt: null,
    cookies: [
      {
        name: 'private_auth',
        value: 'private-value-not-on-disk',
        domain: '.geiwohuo.com',
        path: '/',
        expires: NOW.valueOf() / 1000 + 86_400,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ],
  };
}

function response(body, { status = 200 } = {}) {
  return {
    status,
    headers: { getSetCookie: () => [] },
    async text() {
      return JSON.stringify(body);
    },
  };
}

async function transportFor(body, { status = 200 } = {}) {
  let stored = bundle();
  const store = {
    async read() {
      return stored;
    },
    async write(storeCode, next) {
      stored = next;
    },
  };
  const session = await openOrderManagementHttpSession({
    storeCode: 'DL5477',
    sessionStore: store,
    clock: () => new Date(NOW),
    fetchImpl: async () => response(body, { status }),
  });
  return createOrderManagementHttpTransport({ session });
}

test('business status failure keeps the legacy code and carries a scrubbed platform code and message', async () => {
  const transport = await transportFor({
    code: '10005',
    msg: '操作失败',
    error: { code: '10005' },
  });
  const body = { ...orderManagementRequestBody('EXCEPTIONS_PAGE'), page: 1, perPage: 50 };
  await assert.rejects(
    transport.fetch('EXCEPTIONS_PAGE', body),
    (error) => {
      assert.ok(error instanceof OrderManagementTransportError);
      assert.equal(error.code, 'ORDER_MANAGEMENT_BUSINESS_STATUS_FAILED');
      assert.equal(error.platformCode, '10005');
      assert.equal(error.platformMessage, '操作失败');
      assert.doesNotMatch(error.message, /操作失败|10005/);
      return true;
    },
  );
  await transport.close();
});

test('platform messages resembling PII are dropped entirely before they can reach audit or UI', async () => {
  const piiMessages = [
    '请联系 13912345678 处理',
    '客服邮箱 a@b.com 联系',
    '收货人 张三 已签收',
    '详细地址 广州市天河区体育西路 1 号',
    '联系电话 020-88886666',
    '订单 202608090001234567890 异常',
  ];
  for (const message of piiMessages) {
    const transport = await transportFor({ code: '10005', msg: message });
    const body = { ...orderManagementRequestBody('EXCEPTIONS_PAGE'), page: 1, perPage: 50 };
    await assert.rejects(
      transport.fetch('EXCEPTIONS_PAGE', body),
      (error) => {
        assert.equal(error.code, 'ORDER_MANAGEMENT_BUSINESS_STATUS_FAILED');
        assert.equal(error.platformMessage, null);
        assert.equal(error.platformCode, '10005');
        const serialized = JSON.stringify({
          code: error.code,
          platformCode: error.platformCode,
          platformMessage: error.platformMessage,
          message: error.message,
        });
        for (const fragment of [message, '13912345678', 'a@b.com', '张三', '020-88886666']) {
          assert.ok(!serialized.includes(fragment), `PII fragment leaked for ${message}`);
        }
        return true;
      },
    );
    await transport.close();
  }
});

test('a safe platform message is capped in length and stripped of control characters', async () => {
  assert.equal(
    sanitizePlatformMessage('ok\u0000\u001Ftext'),
    'ok text',
  );
  const long = sanitizePlatformMessage('A'.repeat(500));
  assert.equal(long.length, 200);
  assert.equal(sanitizePlatformMessage('   '), null);
});

test('platform codes are restricted to a short printable character set', () => {
  assert.equal(sanitizePlatformCode('10005'), '10005');
  assert.equal(sanitizePlatformCode('<script>10005'), null);
  assert.equal(sanitizePlatformCode('A'.repeat(64)), null);
  assert.equal(sanitizePlatformCode(''), null);
  assert.equal(sanitizePlatformCode(null), null);
});

test('auth expiry keeps the legacy error code and carries only scrubbed platform evidence', async () => {
  const transport = await transportFor({ code: '20302', msg: '登录失效，请重新登录' });
  const body = { ...orderManagementRequestBody('EXCEPTIONS_PAGE'), page: 1, perPage: 50 };
  await assert.rejects(
    transport.fetch('EXCEPTIONS_PAGE', body),
    (error) => {
      assert.equal(error.code, 'ORDER_MANAGEMENT_AUTH_EXPIRED');
      assert.equal(error.platformCode, '20302');
      assert.equal(error.platformMessage, '登录失效，请重新登录');
      return true;
    },
  );
  await transport.close();
});

test('redirect auth failures retain a safe platform code and message for audit', async () => {
  const transport = await transportFor(
    { code: '100004', msg: '请先登录！' },
    { status: 302 },
  );
  const body = { ...orderManagementRequestBody('EXCEPTIONS_PAGE'), page: 1, perPage: 50 };
  await assert.rejects(
    transport.fetch('EXCEPTIONS_PAGE', body),
    (error) => {
      assert.equal(error.code, 'ORDER_MANAGEMENT_AUTH_EXPIRED');
      assert.equal(error.platformCode, '100004');
      assert.equal(error.platformMessage, '请先登录！');
      assert.doesNotMatch(error.message, /100004|请先登录/);
      return true;
    },
  );
  await transport.close();
});

test('platform message digest is deterministic, bounded and empty-safe', () => {
  assert.equal(platformMessageDigest('单据异常'), platformMessageDigest('单据异常'));
  assert.equal(platformMessageDigest('单据异常').length, 16);
  assert.notEqual(platformMessageDigest('单据异常'), platformMessageDigest('单据正常'));
  assert.equal(platformMessageDigest(''), null);
  assert.equal(platformMessageDigest(null), null);
});

test('successful responses still resolve through the transport unchanged', async () => {
  const transport = await transportFor({
    code: '0',
    msg: 'OK',
    info: { meta: { count: 0 }, data: [] },
  });
  const body = {
    ...orderManagementRequestBody('STOCK_RECORDS_LIST', { window: WINDOW }),
    pageNumber: 1,
    pageSize: 100,
  };
  const result = await transport.fetch('STOCK_RECORDS_LIST', body);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.info.meta.count, 0);
  await transport.close();
});
