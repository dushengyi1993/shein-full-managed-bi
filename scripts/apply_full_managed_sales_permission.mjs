#!/usr/bin/env node

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const siblingRoot = path.resolve(projectRoot, '..', 'Shein销售统计');
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
  path.join(
    process.env.USERPROFILE || '',
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'node',
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
if (!chromium) throw new Error('Playwright is unavailable in the workspace dependency runtimes.');

const LIST_URL = 'https://open.sheincorp.com/backstage/mange-applictions';
const LIST_PATH = '/backstage/mange-applictions';
const DETAIL_PATH = `${LIST_PATH}/detail`;

function parseArgs(argv) {
  const args = { submit: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--submit') {
      args.submit = true;
      continue;
    }
    if (token === '--store' || token === '--port') {
      args[token.slice(2)] = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.store = String(args.store || '').trim().toUpperCase();
  args.port = Number(args.port);
  if (!/^[A-Z0-9]+$/.test(args.store)) throw new Error('Missing or invalid --store.');
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error('Missing or invalid --port.');
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
  if (!new URL(page.url()).pathname.includes('/login')) return false;

  await page.waitForFunction(() => (
    Boolean(document.querySelector('input[placeholder="请输入登录密码"]'))
      || [...document.querySelectorAll('button,a,div,span')]
        .some((element) => element.textContent?.trim() === '使用密码登录')
  ), null, { timeout: 15_000 });

  const passwordInput = page.locator('input[placeholder="请输入登录密码"]');
  if (!(await passwordInput.isVisible().catch(() => false))) {
    await clickFirstVisible(
      page.getByText('使用密码登录', { exact: true }),
      'password login switch',
    );
  }

  await page.waitForFunction(() => {
    const phone = document.querySelector('input[placeholder="手机号"]');
    const password = document.querySelector('input[placeholder="请输入登录密码"]');
    return Boolean(phone?.value?.length && password?.value?.length);
  }, null, { timeout: 10_000 });

  await clickFirstVisible(page.getByRole('button', { name: '登 录', exact: true }), 'login button');
  await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === LIST_PATH, { timeout: 45_000 });
  return true;
}

async function openApplicationList(page) {
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForFunction(() => (
    location.pathname.includes('/login')
      || Boolean(document.querySelector('span.mr-1.text-sm'))
  ), null, { timeout: 25_000 });
  await loginIfNeeded(page);
  await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === LIST_PATH, { timeout: 45_000 });
  await page.locator('span.mr-1.text-sm').waitFor({ state: 'visible', timeout: 25_000 });
  await page.locator('h3').first().waitFor({ state: 'visible', timeout: 25_000 });
}

async function findApplicationCard(page, appName) {
  const headings = page.locator('h3').filter({ hasText: appName });
  const count = await headings.count();
  for (let index = 0; index < count; index += 1) {
    const heading = headings.nth(index);
    if ((await heading.innerText()).trim() !== appName) continue;
    const card = heading.locator('xpath=../../..');
    const cardText = (await card.innerText()).trim();
    return { card, cardText };
  }
  return null;
}

async function findSalesPermissionRow(page) {
  const row = page.locator('tr').filter({ hasText: /^销量查询/ }).first();
  await row.waitFor({ state: 'visible', timeout: 25_000 });
  const text = (await row.innerText()).trim();
  if (/^销量查询(?:\s|$)/.test(text)) return row;
  throw new Error(`Unexpected 销量查询 permission row: ${text}`);
}

async function readSalesPermissionState(page) {
  const row = await findSalesPermissionRow(page);
  const rowText = (await row.innerText()).trim();
  let permissionStatus = '';
  if (rowText.includes('已订阅')) permissionStatus = '已订阅';
  else if (rowText.includes('审核中')) permissionStatus = '审核中';
  else if (rowText.includes('申请权限包')) permissionStatus = '可申请';
  return { row, rowText, permissionStatus };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${args.port}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error(`No browser context on CDP port ${args.port}.`);
  const pages = context.pages();
  const page = pages.find((candidate) => candidate.url().includes('open.sheincorp.com')) || pages[0];
  if (!page) throw new Error(`No browser page on CDP port ${args.port}.`);

  await page.bringToFront();
  await openApplicationList(page);

  const subject = (await page.locator('span.mr-1.text-sm').innerText()).trim();
  const appNames = (await page.locator('h3').allInnerTexts()).map((name) => name.trim());
  const appName = appNames.find((name) => (
    name.startsWith(`${args.store}-`) && name.includes('SHEIN全托运营中台')
  ));
  if (!appName) throw new Error(`Full-managed app is missing for ${args.store}.`);

  const application = await findApplicationCard(page, appName);
  if (!application) throw new Error(`Full-managed app card readback failed for ${args.store}.`);
  if (!application.cardText.includes('全托管')) {
    throw new Error(`The target app is not full-managed for ${args.store}.`);
  }
  if (!application.cardText.includes('审核通过')) {
    throw new Error(`The full-managed app is not approved for ${args.store}.`);
  }

  await clickFirstVisible(
    application.card.getByRole('button', { name: '查看详情', exact: true }),
    'full-managed app details button',
  );
  await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === DETAIL_PATH, { timeout: 30_000 });

  const apiTab = page.getByRole('tab', { name: 'API权限包', exact: true });
  await apiTab.waitFor({ state: 'visible', timeout: 25_000 });
  if ((await apiTab.getAttribute('aria-selected')) !== 'true') await apiTab.click();

  const initial = await readSalesPermissionState(page);
  if (initial.permissionStatus === '已订阅' || initial.permissionStatus === '审核中') {
    console.log(JSON.stringify({
      storeKey: args.store,
      port: args.port,
      action: initial.permissionStatus === '已订阅' ? 'already-subscribed' : 'already-pending',
      subject,
      appName,
      appStatus: '审核通过',
      permissionPackage: '销量查询',
      permissionStatus: initial.permissionStatus,
      verifiedAt: new Date().toISOString(),
    }, null, 2));
    return;
  }
  if (initial.permissionStatus !== '可申请') {
    throw new Error(`Unexpected 销量查询 permission state for ${args.store}: ${initial.rowText}`);
  }

  if (!args.submit) {
    console.log(JSON.stringify({
      storeKey: args.store,
      port: args.port,
      action: 'prepared',
      subject,
      appName,
      appStatus: '审核通过',
      permissionPackage: '销量查询',
      permissionStatus: initial.permissionStatus,
      verifiedAt: new Date().toISOString(),
    }, null, 2));
    return;
  }

  await clickFirstVisible(
    initial.row.getByRole('button', { name: '申请权限包', exact: true }),
    'sales permission application button',
  );
  const confirmDialog = page.getByRole('dialog').filter({ hasText: '是否确认申请权限包？' });
  await confirmDialog.waitFor({ state: 'visible', timeout: 10_000 });
  await clickFirstVisible(
    confirmDialog.getByRole('button', { name: '确 认', exact: true }),
    'sales permission confirmation button',
  );

  await page.waitForFunction(() => (
    [...document.querySelectorAll('tr')].some((row) => {
      const text = row.innerText.trim();
      return /^销量查询(?:\s|$)/.test(text) && (text.includes('审核中') || text.includes('已订阅'));
    })
  ), null, { timeout: 30_000 });

  const successDialog = page.getByRole('dialog').filter({ hasText: '订阅申请已提交' });
  if (await successDialog.isVisible().catch(() => false)) {
    await clickFirstVisible(
      successDialog.getByRole('button', { name: '知道了', exact: true }),
      'permission submission acknowledgement button',
    );
  }

  const readback = await readSalesPermissionState(page);
  if (!['审核中', '已订阅'].includes(readback.permissionStatus)) {
    throw new Error(`Sales permission submission readback failed for ${args.store}.`);
  }

  console.log(JSON.stringify({
    storeKey: args.store,
    port: args.port,
    action: 'submitted',
    subject,
    appName,
    appStatus: '审核通过',
    permissionPackage: '销量查询',
    permissionStatus: readback.permissionStatus,
    verifiedAt: new Date().toISOString(),
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  });
