import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

test('analysis capability projection exposes status but not raw audit fingerprints', async () => {
  const [migration, verification, reconcile, reconcileVerification] = await Promise.all([
    readFile(
      new URL(
        'db/migrations/0025_full_home_analysis_capability_projection.sql',
        projectRoot,
      ),
      'utf8',
    ),
    readFile(
      new URL(
        'db/verify/0025_full_home_analysis_capability_projection.sql',
        projectRoot,
      ),
      'utf8',
    ),
    readFile(
      new URL('db/migrations/9999_runtime_role_reconcile.sql', projectRoot),
      'utf8',
    ),
    readFile(
      new URL('db/verify/9999_runtime_role_reconcile.sql', projectRoot),
      'utf8',
    ),
  ]);

  for (const sql of [migration, reconcile]) {
    const grant = sql.match(
      /GRANT SELECT \([\s\S]*?\)\s+ON raw\.webapi_home_fetch_audit[\s\S]*?TO sheinfm_materializer_ro;/,
    )?.[0] || '';
    assert.match(grant, /webapi_home_fetch_audit_id/);
    assert.match(grant, /store_code/);
    assert.match(grant, /endpoint_code/);
    assert.match(grant, /result_status/);
    assert.match(grant, /sanitized_error_code/);
    assert.match(grant, /observed_at/);
    assert.doesNotMatch(
      grant,
      /fetch_key|request_sha256|response_schema_sha256|response_body_sha256/,
    );
  }

  for (const sql of [verification, reconcileVerification]) {
    assert.match(sql, /has_column_privilege\(/);
    assert.match(sql, /request_sha256/);
    assert.match(sql, /response_body_sha256/);
    assert.match(sql, /materializer/);
  }
});
