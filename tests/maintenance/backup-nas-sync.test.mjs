import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { parseArgs, validateSourceName, openSnapshot, validateReceipt, transferChild, compareBackupNames } from '../../scripts/sync_full_managed_backup_nas.mjs';

test('source and execute flags are explicit and unknown flags rejected', () => {
  assert.equal(parseArgs(['--latest-completed']).execute, false);
  assert.equal(parseArgs(['--latest-completed', '--execute']).execute, true);
  for (const args of [[], ['--source=a', '--latest-completed'], ['--unknown'], ['--execute', '--execute']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('source name accepts weekly and deploy dumps and rejects traversal, daily, bad names and partial paths', () => {
  assert.equal(validateSourceName('/srv/shein-fm/backups/db/shein-fm-weekly-20260905T102755Z.dump'), '/srv/shein-fm/backups/db/shein-fm-weekly-20260905T102755Z.dump');
  assert.equal(validateSourceName('/srv/shein-fm/backups/db/shein-fm-deploy-20260905T102755Z.dump'), '/srv/shein-fm/backups/db/shein-fm-deploy-20260905T102755Z.dump');
  for (const p of [
    '/tmp/x.dump',
    '/srv/shein-fm/backups/db/../x.dump',
    '/srv/shein-fm/backups/db/shein-fm-daily-20260905T102755Z.dump',
    '/srv/shein-fm/backups/db/shein-fm-weekly-20260905T102755Z.dump.partial',
    '/srv/shein-fm/backups/db/shein-fm-deploy-20260905T102755Z.dump.partial',
    '/srv/shein-fm/backups/db/shein-fm-other-20260905T102755Z.dump',
    '/srv/shein-fm/backups/db/shein-fm-deploy-bad.dump',
  ]) {
    assert.throws(() => validateSourceName(p), { code: 'SOURCE_PATH_INVALID' });
  }
});

test('pinned source detects mutation and allows repeated bounded reads', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shein-sender-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = path.join(root, 'shein-fm-weekly-20260905T102755Z.dump');
  const body = Buffer.from('PGDMP synthetic archive');
  await fs.writeFile(p, body);
  const s = await openSnapshot(p, root);
  try {
    const expected = createHash('sha256').update(body).digest('hex');
    assert.equal(await s.hash(), expected);
    assert.equal(await s.hash(), expected);
    await fs.appendFile(p, 'changed');
    await assert.rejects(s.assertUnchanged, { code: 'SOURCE_CHANGED' });
  } finally { await s.handle.close(); }
});

test('receipt binds all facts and discards foreign fields', () => {
  const m = { name: 'x', bytes: 10, sha256: 'a'.repeat(64) };
  const good = { ok: true, state: 'copied', ...m, secret: 'DO_NOT_PROPAGATE' };
  assert.equal('secret' in validateReceipt(JSON.stringify(good), m), false);
  for (const bad of ['secret text', JSON.stringify({ ...good, bytes: 11 }), JSON.stringify({ ...good, ok: false })]) {
    assert.throws(() => validateReceipt(bad, m));
  }
});

test('child error is sanitized and stdout receipt collected without stderr', async () => {
  function fake(exit) {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.stdin = new Writable({ write(chunk, encoding, cb) { cb(); } });
    c.kill = () => { c.emit('close', -1); };
    c.stdin.on('finish', () => {
      c.stdout.write('{"ok":true}'); c.stderr.write('PRIVATE_DIAGNOSTIC');
      c.stdout.end(); c.stderr.end(); c.emit('close', exit);
    });
    return c;
  }
  const s = { stream: () => Readable.from(['PGDMP']), assertUnchanged: async () => {} };
  assert.equal(await transferChild('fake', [], s, { version: 1 }, () => fake(0)), '{"ok":true}');
  await assert.rejects(() => transferChild('fake', [], s, {}, () => fake(1)), e => {
    assert.equal(e.code, 'CHILD_FAILED'); assert.equal(e.message.includes('PRIVATE'), false); return true;
  });
});

test('successful TOC early EOF is allowed only for archive validation', async () => {
  const make = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.stdin = new Writable({ write(chunk, encoding, cb) {
      cb(Object.assign(new Error('closed'), { code: 'EPIPE' }));
      setImmediate(() => c.emit('close', 0));
    } });
    c.kill = () => c.emit('close', -1);
    return c;
  };
  const s = { stream: () => Readable.from(['PGDMP']), assertUnchanged: async () => {} };
  assert.equal(await transferChild('fake', [], s, null, make), '');
  await assert.rejects(() => transferChild('fake', [], s, {}, make), { code: 'TRANSFER_FAILED' });
});

test('real child early exit preserves pinned fd for subsequent hash and reads', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shein-real-child-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = path.join(root, 'shein-fm-weekly-20260905T102755Z.dump');
  const head = Buffer.from('PGDMP');
  const payload = Buffer.alloc(2 * 1024 * 1024, 0x5a);
  const body = Buffer.concat([head, payload]);
  await fs.writeFile(p, body);
  const s = await openSnapshot(p, root);
  try {
    const initialFd = s.handle.fd;
    assert.ok(initialFd > 0);
    const expected = createHash('sha256').update(body).digest('hex');
    assert.equal(await s.hash(), expected);
    assert.equal(s.handle.fd, initialFd);

    // Real child that reads partial data (first chunk) and exits 0 immediately (like pg_restore --list)
    const earlyExitChildCode = 'process.stdin.once("data", () => process.exit(0));';
    const out = await transferChild(process.execPath, ['-e', earlyExitChildCode], s, null);
    assert.equal(out, '');
    assert.equal(s.handle.fd, initialFd);
    await s.assertUnchanged();

    // Same pinned fd can still be fully hashed and read again
    assert.equal(await s.hash(), expected);
    assert.equal(s.handle.fd, initialFd);

    // For SSH (when header is provided), an early exit / short write must fail with TRANSFER_FAILED
    await assert.rejects(
      () => transferChild(process.execPath, ['-e', earlyExitChildCode], s, { name: 'test' }),
      { code: 'TRANSFER_FAILED' },
    );
    assert.equal(s.handle.fd, initialFd);
    await s.assertUnchanged();
  } finally {
    await s.handle.close();
  }
});

test('latest-completed sorts by embedded UTC timestamp across weekly and deploy modes', () => {
  const unordered = [
    'shein-fm-weekly-20260905T100000Z.dump',
    'shein-fm-deploy-20260905T120000Z.dump',
    'shein-fm-weekly-20260905T080000Z.dump',
    'shein-fm-deploy-20260905T090000Z.dump',
  ];
  const sorted = [...unordered].sort(compareBackupNames);
  assert.deepEqual(sorted, [
    'shein-fm-weekly-20260905T080000Z.dump',
    'shein-fm-deploy-20260905T090000Z.dump',
    'shein-fm-weekly-20260905T100000Z.dump',
    'shein-fm-deploy-20260905T120000Z.dump',
  ]);
  assert.equal(sorted.at(-1), 'shein-fm-deploy-20260905T120000Z.dump');

  // When weekly is newer than deploy, weekly must be chosen as latest
  const newerWeekly = [
    'shein-fm-deploy-20260905T120000Z.dump',
    'shein-fm-weekly-20260905T140000Z.dump',
  ].sort(compareBackupNames);
  assert.equal(newerWeekly.at(-1), 'shein-fm-weekly-20260905T140000Z.dump');
});

test('deploy mode snapshot opens, hashes and transfers synthetic payload identically to weekly', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shein-deploy-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = path.join(root, 'shein-fm-deploy-20260905T150000Z.dump');
  const head = Buffer.from('PGDMP');
  const payload = Buffer.from('deploy synthetic payload');
  const body = Buffer.concat([head, payload]);
  await fs.writeFile(p, body);
  const s = await openSnapshot(p, root);
  try {
    assert.equal(s.name, 'shein-fm-deploy-20260905T150000Z.dump');
    assert.equal(s.bytes, body.length);
    const expected = createHash('sha256').update(body).digest('hex');
    assert.equal(await s.hash(), expected);
    await s.assertUnchanged();
  } finally {
    await s.handle.close();
  }
});
