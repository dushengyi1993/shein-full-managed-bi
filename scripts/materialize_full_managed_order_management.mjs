#!/usr/bin/env node

import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

import { atomicWriteJson } from '../src/warehouse/dashboard-materializer.mjs';
import {
  materializeOrderManagement,
} from '../src/warehouse/order-management-materializer.mjs';

export function parseArgs(argv) {
  const result = {
    databaseUrl: null,
    output: null,
    sessionSnapshot: null,
  };
  const tokens = [...argv];
  while (tokens.length > 0) {
    const token = tokens.shift();
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) throw new Error(`ORDER_MANAGEMENT_ARGUMENT_INVALID: ${token}`);
    const [, name, inlineValue] = match;
    const value = inlineValue !== undefined
      ? inlineValue
      : tokens.shift();
    if (!value) throw new Error('ORDER_MANAGEMENT_ARGUMENT_MISSING_VALUE');
    if (name === 'database-url') result.databaseUrl = value;
    else if (name === 'out') result.output = value;
    else if (name === 'session-snapshot') result.sessionSnapshot = value;
    else throw new Error(`ORDER_MANAGEMENT_ARGUMENT_INVALID: ${token}`);
  }
  return result;
}

export async function loadSnapshot(filePath) {
  if (!filePath) return null;
  const text = await readFile(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('ORDER_MANAGEMENT_SESSION_SNAPSHOT_INVALID_JSON');
  }
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1) {
    throw new Error('ORDER_MANAGEMENT_SESSION_SNAPSHOT_SCHEMA_UNSUPPORTED');
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = args.databaseUrl
    ?? process.env.FULL_BI_DATABASE_URL
    ?? process.env.DATABASE_URL;
  const output = args.output ?? process.env.FULL_BI_ORDER_MANAGEMENT_FILE;
  if (!databaseUrl) throw new Error('FULL_BI_DATABASE_URL is required.');
  if (!output) throw new Error('--out or FULL_BI_ORDER_MANAGEMENT_FILE is required.');
  const sessionSnapshot = args.sessionSnapshot
    ?? process.env.FULL_BI_ORDER_MANAGEMENT_SESSION_SNAPSHOT
    ?? null;
  const snapshot = await loadSnapshot(sessionSnapshot);

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const index = await materializeOrderManagement({
      pool,
      sessionSnapshot: snapshot,
    });
    const written = await atomicWriteJson(output, index);
    console.log(JSON.stringify({
      ok: true,
      output: written,
      updatedAt: index.updatedAt,
      coverage: index.coverage,
      promotable: index.promotable,
      rowCount: Object.values(index.pages)
        .reduce((sum, page) => sum + page.rows.length, 0),
      pages: Object.fromEntries(
        Object.entries(index.pages).map(([pageId, page]) => [
          pageId,
          { status: page.status, rows: page.rows.length, reason: page.reason },
        ]),
      ),
    }, null, 2));
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/materialize_full_managed_order_management.mjs')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Order-management materialization failed.');
    process.exitCode = 1;
  });
}
