import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFullHomePageTransport,
} from '../../src/webapi-history/page-transport.mjs';

function sessionReturning(value) {
  return {
    async evaluate(expression) {
      assert.match(expression, /https:\/\/sso\.geiwohuo\.com\/sbn\/index/);
      assert.match(expression, /credentials: 'include'/);
      assert.doesNotMatch(expression, /Cookie|Authorization/);
      return value;
    },
  };
}

test('homepage transport runs only a fixed same-origin endpoint and returns JSON', async () => {
  const transport = createFullHomePageTransport({
    session: sessionReturning({
      sameOrigin: true,
      status: 200,
      byteLength: 32,
      bodyText: '{"code":"0","info":[]}',
    }),
  });
  const result = await transport('STORE_DAILY_HISTORY', {
    areaCd: 'cn',
    startDate: '2026-07-01',
    endDate: '2026-07-29',
  });
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.body, { code: '0', info: [] });
});

test('homepage transport rejects arbitrary endpoints, auth expiry and oversized bodies', async () => {
  const transport = createFullHomePageTransport({
    session: sessionReturning({
      sameOrigin: true,
      status: 401,
      byteLength: 2,
      bodyText: '{}',
    }),
  });
  await assert.rejects(
    transport('NOT_ALLOWED', {}),
    { code: 'HOME_ENDPOINT_NOT_ALLOWED' },
  );
  await assert.rejects(
    transport('STORE_DAILY_HISTORY', {}),
    { code: 'HOME_AUTH_EXPIRED' },
  );

  const oversized = createFullHomePageTransport({
    session: sessionReturning({
      sameOrigin: true,
      status: 200,
      byteLength: 9 * 1024 * 1024,
      bodyText: null,
    }),
  });
  await assert.rejects(
    oversized('STORE_DAILY_HISTORY', {}),
    { code: 'HOME_RESPONSE_TOO_LARGE' },
  );
});
