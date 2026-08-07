#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.env.FULL_BI_COORDINATOR_ROOT
  ?? '/srv/shein-fm/runtime/coordinator';
const DASHBOARD_FILES = Object.freeze([
  '/srv/shein-fm/runtime/dashboard/dashboard.json',
  '/srv/shein-fm/runtime/dashboard/dashboard.home.json',
]);

async function fingerprint(file) {
  const [body, info] = await Promise.all([readFile(file), stat(file)]);
  return Object.freeze({
    file,
    bytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    sha256: createHash('sha256').update(body).digest('hex'),
  });
}

async function stateFiles(root) {
  const result = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return result;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.json')) result.push(path.join(directory, file.name));
    }
  }
  return result;
}

async function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o660 });
  await rename(temporary, file);
}

export async function markReadyCoordinatorsPublished({
  root = ROOT,
  dashboardFiles = DASHBOARD_FILES,
  now = new Date(),
  readyThrough = process.env.FULL_BI_MATERIALIZE_STARTED_AT ?? now,
} = {}) {
  const readyThroughMs = new Date(readyThrough).valueOf();
  if (!Number.isFinite(readyThroughMs)) throw new TypeError('MATERIALIZE_STARTED_AT_INVALID');
  const manifest = await Promise.all(dashboardFiles.map(fingerprint));
  const publishedAt = now.toISOString();
  const marked = [];
  for (const file of await stateFiles(root)) {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (
      value?.status !== 'READY_TO_PUBLISH'
      || !Number.isFinite(Date.parse(value.readyAt))
      || Date.parse(value.readyAt) > readyThroughMs
    ) continue;
    await atomicWrite(file, {
      ...value,
      status: 'PUBLISHED',
      publishedAt,
      updatedAt: publishedAt,
      manifest,
    });
    marked.push(value.runId);
  }
  return Object.freeze({ ok: true, publishedAt, marked, manifest });
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/mark_full_managed_coordinators_published.mjs')) {
  markReadyCoordinatorsPublished().then((result) => {
    console.log(JSON.stringify(result));
  }).catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      errorCode: String(error?.code ?? error?.message ?? 'COORDINATOR_PUBLISH_MARK_FAILED')
        .toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 80),
    }));
    process.exitCode = 1;
  });
}
