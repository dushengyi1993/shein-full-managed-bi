import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);
const experimentDir = new URL('src/webapi-experiment/', projectRoot);

async function experimentSources() {
  const names = (await readdir(experimentDir)).filter((name) => name.endsWith('.mjs')).sort();
  const entries = [];
  for (const name of names) {
    entries.push([name, await readFile(new URL(name, experimentDir), 'utf8')]);
  }
  return entries;
}

async function scriptSources() {
  const entries = [];
  for (const name of [
    'scripts/plan_full_managed_webapi_experiment.mjs',
    'scripts/run_full_managed_webapi_experiment.mjs',
  ]) {
    entries.push([name, await readFile(new URL(name, projectRoot), 'utf8')]);
  }
  return entries;
}

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('the experiment layer contains the expected modules and nothing stray', async () => {
  const names = (await experimentSources()).map(([name]) => name);
  assert.deepEqual(names, [
    'adapter.mjs',
    'browser-session.mjs',
    'cdp-client.mjs',
    'decimal.mjs',
    'endpoint-allowlist.mjs',
    'linux-runtime.mjs',
    'observation.mjs',
    'page-transport.mjs',
    'profile-guard.mjs',
    'profile-lock.mjs',
    'redaction.mjs',
    'repository.mjs',
    'run-plan.mjs',
    'schema.mjs',
  ]);
});

test('no experiment source reads, exports or logs a credential store', async () => {
  for (const [name, source] of [...(await experimentSources()), ...(await scriptSources())]) {
    const executable = withoutComments(source);
    // Cookie and storage access is impossible anywhere in this layer.
    assert.doesNotMatch(executable, /getAllCookies/, name);
    assert.doesNotMatch(executable, /document\s*\.\s*cookie/, name);
    assert.doesNotMatch(executable, /\blocalStorage\b/, name);
    assert.doesNotMatch(executable, /\bsessionStorage\b/, name);
    assert.doesNotMatch(executable, /\bindexedDB\s*\./i, name);
    assert.doesNotMatch(executable, /setCookie|deleteCookies|clearDataForOrigin/i, name);
    // No cookie or session file is ever written.
    assert.doesNotMatch(executable, /writeFile[^\n]*(cookie|session|storage)/i, name);
    // Nothing in this layer prints to the console; the CLI uses printSafeJson.
    assert.doesNotMatch(executable, /console\s*\.\s*(log|info|warn|error|debug|dir|table)/, name);
  }
});

test('forbidden CDP domains appear only as rejection data, never as a call', async () => {
  for (const [name, source] of await experimentSources()) {
    // A protocol call is always a quoted 'Domain.method' string; the allow-list
    // module lists bare domain names for rejection, which is not a call.
    for (const domain of ['Network', 'Storage', 'Browser', 'DOMStorage', 'Fetch']) {
      assert.doesNotMatch(
        source,
        new RegExp(`['"\`]${domain}\\.[A-Za-z]`),
        `${name} must not reference a ${domain} protocol method`,
      );
    }
    if (name !== 'cdp-client.mjs') {
      assert.doesNotMatch(source, /send\(\s*['"`](?:Network|Storage|Browser)/, name);
    }
  }
  const client = await readFile(new URL('cdp-client.mjs', experimentDir), 'utf8');
  // The four allow-listed methods are the complete reachable protocol surface.
  const quoted = [...client.matchAll(/'([A-Z][A-Za-z]+\.[A-Za-z]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(quoted)].sort(), [
    'Page.getNavigationHistory',
    'Page.navigate',
    'Runtime.enable',
    'Runtime.evaluate',
  ]);
});

test('endpoints and origins are constructed only inside the allow-list module', async () => {
  for (const [name, source] of [...(await experimentSources()), ...(await scriptSources())]) {
    if (name === 'endpoint-allowlist.mjs') continue;
    // No module may embed the origin or a platform path segment of its own.
    assert.doesNotMatch(source, /https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]*(geiwohuo|shein)/i, name);
    assert.doesNotMatch(source, /['"`]\/sso\//, name);
    assert.doesNotMatch(source, /\/homePage\//, name);
    // No template-built request URL: only resolveEndpointUrl may produce one.
    assert.doesNotMatch(source, /`\$\{WEBAPI_ORIGIN\}/, name);
    assert.doesNotMatch(source, /WEBAPI_ORIGIN\s*\+/, name);
  }
  const allowlist = await readFile(new URL('endpoint-allowlist.mjs', experimentDir), 'utf8');
  assert.equal((allowlist.match(/https:\/\//g) || []).length, 1);
  assert.equal((allowlist.match(/path: '/g) || []).length, 5);
});

test('processes are only ever signalled by tracked pid, never by name or pattern', async () => {
  for (const [name, source] of [...(await experimentSources()), ...(await scriptSources())]) {
    assert.doesNotMatch(source, /pkill|killall|taskkill/, name);
    assert.doesNotMatch(source, /exec\(|execSync|execFile|spawnSync/, name);
    // No module imports a process or socket library directly: everything is
    // injected, which is what keeps the Windows test run inert.
    if (name === 'linux-runtime.mjs') {
      assert.match(source, /import \{ spawn as spawnChildProcess \} from 'node:child_process'/);
      assert.match(source, /process\.kill\(pid, 0\)/);
      assert.doesNotMatch(source, /process\.kill\([^,]+,\s*['"]SIG/);
    } else {
      assert.doesNotMatch(source, /from\s+'node:child_process'/, name);
      assert.doesNotMatch(source, /process\.kill\(/, name);
    }
    assert.doesNotMatch(source, /from\s+'node:net'/, name);
    assert.doesNotMatch(source, /require\(\s*'(ws|puppeteer|playwright)'/, name);
    assert.doesNotMatch(source, /from\s+'(ws|puppeteer|playwright)'/, name);
  }
  const session = await readFile(new URL('browser-session.mjs', experimentDir), 'utf8');
  // Termination targets a tracked child pid only.
  assert.match(session, /await terminate\(child\.pid, \{ graceMs/);
  assert.match(session, /for \(const child of \[browserProcess, displayProcess\]\)/);
});

test('the in-page credential include is the only credential mention and exposes no value', async () => {
  const transport = await readFile(new URL('page-transport.mjs', experimentDir), 'utf8');
  // `credentials: 'include'` is the mechanism that keeps the secret in the
  // browser; it names no credential and reads no value.
  const executable = withoutComments(transport);
  const includes = executable.match(/credentials: 'include'/g) || [];
  assert.equal(includes.length, 1);
  const expressionStart = executable.indexOf('buildPageFetchExpression');
  assert.ok(executable.indexOf("credentials: 'include'") > expressionStart);
  assert.doesNotMatch(transport, /Authorization|Bearer|['"`]Cookie['"`]/i);
  // Only a content type may be set, and no response header is ever read.
  assert.doesNotMatch(transport, /response\.headers|getAllResponseHeaders|headers\.get/);

  for (const [name, source] of await experimentSources()) {
    if (name === 'page-transport.mjs') continue;
    assert.doesNotMatch(source, /credentials\s*:/, name);
  }
});

test('experiment sources never emit a secret-shaped string', async () => {
  for (const [name, source] of [...(await experimentSources()), ...(await scriptSources())]) {
    // A database URL or password must never be interpolated into output.
    assert.doesNotMatch(source, /\$\{[^}]*(?:password|secret|token|databaseUrl|DATABASE_URL)[^}]*\}/i, name);
  }
  const runner = await readFile(
    new URL('scripts/run_full_managed_webapi_experiment.mjs', projectRoot),
    'utf8',
  );
  // The database URL is read only after authorization and never printed.
  assert.match(runner, /DATABASE_URL_VARIABLE = 'FULL_BI_WEBAPI_DATABASE_URL'/);
  assert.match(runner, /const databaseUrl = process\.env\[DATABASE_URL_VARIABLE\]/);
  assert.match(runner, /if \(!databaseUrl\)/);
  assert.doesNotMatch(runner, /printSafeJson\([^)]*process\.env/);
  const dryRunExitIndex = runner.indexOf('if (request.mode === EXPERIMENT_MODES.DRY_RUN)');
  assert.ok(dryRunExitIndex !== -1);
  assert.ok(runner.indexOf('process.env[DATABASE_URL_VARIABLE]') > dryRunExitIndex);
});

test('the experiment still refuses formal promotion and invents no metric meaning', async () => {
  for (const [name, source] of [...(await experimentSources()), ...(await scriptSources())]) {
    assert.doesNotMatch(source, /INSERT INTO\s+fact\./i, name);
    assert.doesNotMatch(source, /INSERT INTO\s+mart\./i, name);
    // No code path writes a metric definition: that stays a reviewed process.
    assert.doesNotMatch(source, /INSERT INTO\s+dim\.webapi_metric_definition/i, name);
    // No invented Chinese business label.
    assert.doesNotMatch(source, /pageLabelZh\s*:\s*['"`]\S/, name);
  }
  const adapter = await readFile(new URL('adapter.mjs', experimentDir), 'utf8');
  // Discovered ids are integers only; no label, caliber or value is exposed.
  assert.match(adapter, /function discoveredMetaIndexIdsFor\(endpoint, validatedResponse\)/);
  assert.match(adapter, /endpoint\.carriesMetricValues !== false\) return NO_DISCOVERED_IDS/);
  assert.match(adapter, /Number\.isSafeInteger\(value\) && value > 0/);
  assert.doesNotMatch(adapter, /discovered[A-Za-z]*(?:Label|Value|Count|Currency)/);
});
