#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const siblingRoot = path.resolve(projectRoot, '..', 'Shein销售统计');
const defaultOutput = path.join(projectRoot, 'config', 'full_managed_onboarding.secret.json');
const require = createRequire(import.meta.url);
const playwrightCandidates = [
  path.join(projectRoot, 'node_modules', 'playwright'),
  path.join(siblingRoot, 'node_modules', 'playwright'),
  path.join(
    process.env.USERPROFILE || '',
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'node',
    'node_modules',
    '.pnpm',
    'playwright@1.61.1',
    'node_modules',
    'playwright',
  ),
];

let chromium;
for (const candidate of playwrightCandidates) {
  try {
    ({ chromium } = require(candidate));
    break;
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
}
if (!chromium) throw new Error('Playwright is unavailable.');

const LIST_URL = 'https://open.sheincorp.com/backstage/mange-applictions';
const LIST_PATH = '/backstage/mange-applictions';
const DETAIL_PATH = `${LIST_PATH}/detail`;

function parseArgs(argv) {
  const args = { output: defaultOutput, headed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--headed') {
      args.headed = true;
      continue;
    }
    if (['--store', '--port', '--output', '--profile-root'].includes(token)) {
      args[token === '--profile-root' ? 'profileRoot' : token.slice(2)] = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  args.store = String(args.store || '').trim().toUpperCase();
  args.output = path.resolve(args.output);
  if (!/^[A-Z0-9]+$/.test(args.store)) throw new Error('Missing or invalid --store.');
  if (args.profileRoot) {
    args.profileRoot = path.resolve(args.profileRoot);
    const expected = `persistent-${args.store.toLowerCase()}-profile`;
    if (path.basename(args.profileRoot).toLowerCase() !== expected) {
      throw new Error('Profile root does not match the requested store.');
    }
    if (args.port !== undefined) throw new Error('Use either --port or --profile-root, not both.');
  } else {
    args.port = Number(args.port);
    if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
      throw new Error('Missing or invalid --port.');
    }
  }
  if (!args.output.endsWith('.secret.json')) {
    throw new Error('Credential output must use an ignored *.secret.json path.');
  }
  return args;
}

async function clickFirstVisible(locator, description) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      return;
    }
  }
  throw new Error(`No visible element found for ${description}.`);
}

async function loginIfNeeded(page) {
  if (!new URL(page.url()).pathname.includes('/login')) return;
  await page.waitForFunction(() => (
    Boolean(document.querySelector('input[type="password"]'))
    || /使用密码登录|Login with password/i.test(document.body?.innerText || '')
  ), null, { timeout: 25_000 });
  const passwordInput = page.locator(
    'input[type="password"], input[placeholder="请输入登录密码"], input[placeholder="Password"]',
  ).first();
  if (!(await passwordInput.isVisible().catch(() => false))) {
    await clickFirstVisible(
      page.getByText(/使用密码登录|Login with password/i),
      'password login switch',
    );
  }
  await page.waitForFunction(() => {
    const password = document.querySelector('input[type="password"]');
    const identity = [...document.querySelectorAll('input')]
      .find((input) => input !== password && input.value?.length);
    return Boolean(identity && password?.value?.length);
  }, null, { timeout: 10_000 });
  await clickFirstVisible(
    page.getByRole('button', { name: /登\s*录|Log In/i }),
    'login button',
  );
  await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === LIST_PATH, { timeout: 45_000 });
}

async function openApplicationList(page) {
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForFunction(() => (
    location.pathname.includes('/login') || Boolean(document.querySelector('span.mr-1.text-sm'))
  ), null, { timeout: 25_000 });
  await loginIfNeeded(page);
  await page.locator('h3').first().waitFor({ state: 'visible', timeout: 25_000 });
}

async function findApplicationCard(page, store) {
  const headings = page.locator('h3');
  const names = await headings.allInnerTexts();
  const appName = names.map((value) => value.trim()).find((value) => (
    value.startsWith(`${store}-`) && value.includes('SHEIN全托运营中台')
  ));
  if (!appName) throw new Error(`Full-managed app is missing for ${store}.`);

  const matching = headings.filter({ hasText: appName });
  for (let index = 0; index < await matching.count(); index += 1) {
    const heading = matching.nth(index);
    if ((await heading.innerText()).trim() !== appName) continue;
    const card = heading.locator('xpath=../../..');
    const cardText = await card.innerText();
    if (!cardText.includes('全托管') || !cardText.includes('审核通过')) {
      throw new Error(`Full-managed app is not approved for ${store}.`);
    }
    return { appName, card };
  }
  throw new Error(`Full-managed app card readback failed for ${store}.`);
}

function extractLabeledValue(text, label, pattern) {
  const expression = new RegExp(`${label}\\s*[:：]\\s*(${pattern})`, 'i');
  return expression.exec(String(text || ''))?.[1] || '';
}

async function readCredentialPanel(page) {
  const panel = page.getByRole('tabpanel', { name: '基本信息', exact: true });
  await panel.waitFor({ state: 'visible', timeout: 25_000 });
  const before = await panel.innerText();
  const appId = extractLabeledValue(before, 'APP_ID', '[A-Za-z0-9_-]{16,128}')
    || new URL(page.url()).searchParams.get('appid')
    || '';
  if (!appId) throw new Error('APP_ID is missing from the approved application detail.');

  await clickFirstVisible(panel.getByText('查看', { exact: true }), 'APP secret view control');
  let appSecretKey = '';
  const deadline = Date.now() + 15_000;
  while (!appSecretKey && Date.now() < deadline) {
    const revealed = await panel.innerText();
    const candidate = extractLabeledValue(revealed, 'APP_Secretkey', '[A-Za-z0-9_-]{16,256}');
    if (candidate && !candidate.includes('*')) appSecretKey = candidate;
    else await page.waitForTimeout(100);
  }
  if (!appSecretKey || appSecretKey.includes('*')) {
    throw new Error('APP_Secretkey was not revealed.');
  }
  return { appId, appSecretKey };
}

async function readOnboardingFile(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed.schemaVersion !== 1 || parsed.cooperationMode !== 'FULL_MANAGED') {
      throw new Error('Existing onboarding file has an incompatible schema.');
    }
    if (!Array.isArray(parsed.applications)) parsed.applications = [];
    return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {
      schemaVersion: 1,
      cooperationMode: 'FULL_MANAGED',
      applications: [],
    };
  }
}

async function saveCredential(args, application, credentials) {
  const config = await readOnboardingFile(args.output);
  const existing = config.applications.find((entry) => entry.storeCode === args.store);
  const next = {
    storeCode: args.store,
    appName: application.appName,
    appId: credentials.appId,
    appSecretKey: credentials.appSecretKey,
    capturedAt: new Date().toISOString(),
  };
  if (existing) Object.assign(existing, next);
  else config.applications.push(next);
  config.applications.sort((left, right) => left.storeCode.localeCompare(right.storeCode));

  await fs.mkdir(path.dirname(args.output), { recursive: true });
  const temporary = `${args.output}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(temporary, args.output);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let ownedContext = null;
  const browser = args.profileRoot
    ? null
    : await chromium.connectOverCDP(`http://127.0.0.1:${args.port}`);
  const context = args.profileRoot
    ? await chromium.launchPersistentContext(args.profileRoot, {
      channel: 'chrome',
      headless: !args.headed,
      locale: 'zh-CN',
      args: [
        '--profile-directory=Profile 1',
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic',
      ],
    })
    : browser.contexts()[0];
  if (args.profileRoot) ownedContext = context;
  if (!context) throw new Error(`No browser context on CDP port ${args.port}.`);

  try {
    const page = context.pages().find((candidate) => candidate.url().includes('open.sheincorp.com'))
      || context.pages()[0]
      || await context.newPage();

    await page.bringToFront();
    await openApplicationList(page);
    const application = await findApplicationCard(page, args.store);
    await clickFirstVisible(
      application.card.getByRole('button', { name: '查看详情', exact: true }),
      'full-managed app details button',
    );
    await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === DETAIL_PATH, { timeout: 30_000 });
    await clickFirstVisible(page.getByRole('tab', { name: '基本信息', exact: true }), 'basic information tab');
    const credentials = await readCredentialPanel(page);
    await saveCredential(args, application, credentials);

    console.log(JSON.stringify({
      ok: true,
      storeCode: args.store,
      appName: application.appName,
      appIdCaptured: true,
      appSecretKeyCaptured: true,
      savedTo: path.relative(projectRoot, args.output).replace(/\\/g, '/'),
      capturedAt: new Date().toISOString(),
    }, null, 2));
  } finally {
    await ownedContext?.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
