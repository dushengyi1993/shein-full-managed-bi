import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchPageSequence } from '../../src/openapi/paginated-fetch.mjs';

test('an exact multiple requires one explicit extra empty page', async () => {
  const calls = [];
  const rows = new Map([
    [1, [{ id: 1 }, { id: 2 }]],
    [2, [{ id: 3 }, { id: 4 }]],
    [3, []],
  ]);
  const result = await fetchPageSequence({
    pageSize: 2,
    async fetchPage({ page }) {
      calls.push(page);
      return { rows: rows.get(page) ?? [] };
    },
    getItems: ({ rows: pageRows }) => pageRows,
  });

  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(result.items.map(({ id }) => id), [1, 2, 3, 4]);
  assert.equal(result.terminalReason, 'EMPTY_PAGE');
});

test('a short page is terminal', async () => {
  const calls = [];
  const result = await fetchPageSequence({
    pageSize: 3,
    async fetchPage({ page }) {
      calls.push(page);
      return { rows: [{ id: 1 }, { id: 2 }] };
    },
    getItems: ({ rows }) => rows,
  });
  assert.deepEqual(calls, [1]);
  assert.equal(result.terminalReason, 'SHORT_PAGE');
});

test('repeated non-empty page fingerprints fail closed', async () => {
  await assert.rejects(
    () => fetchPageSequence({
      pageSize: 2,
      async fetchPage() {
        return { rows: [{ id: 1 }, { id: 2 }] };
      },
      getItems: ({ rows }) => rows,
    }),
    (error) => error.code === 'PAGINATION_REPEATED_PAGE',
  );
});

test('a terminal page before the advertised count fails closed', async () => {
  await assert.rejects(
    () => fetchPageSequence({
      pageSize: 2,
      async fetchPage() {
        return { rows: [{ id: 1 }], count: 2 };
      },
      getItems: ({ rows }) => rows,
      getAdvertisedCount: ({ count }) => count,
    }),
    (error) => error.code === 'PAGINATION_COUNT_MISMATCH',
  );
});
