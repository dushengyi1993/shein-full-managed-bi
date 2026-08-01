#!/usr/bin/env node

import fs from 'node:fs/promises';
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

const LIST_PATH = '/backstage/mange-applictions';
const CHECK_PATH = `${LIST_PATH}/check`;
const EXPECTED_BUSINESS = ['商品管理', '商品合规', '备货管理', '库存管理', '财务管理'];

function parseArgs(argv) {
  const args = { submit: false, shortName: '', iconPath: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--submit') {
      args.submit = true;
      continue;
    }
    if (['--store', '--port', '--short-name', '--icon-path'].includes(token)) {
      const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      args[key] = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.store = String(args.store || '').trim().toUpperCase();
  args.port = Number(args.port);
  if (!/^[A-Z0-9]+$/.test(args.store)) {
    throw new Error('Missing or invalid --store.');
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error('Missing or invalid --port.');
  }
  args.shortName = String(args.shortName || '').trim();
  if (args.shortName && (
    args.shortName.length > 20
    || /[\u0000-\u001f\u007f<>]/.test(args.shortName)
  )) {
    throw new Error('Invalid --short-name.');
  }
  args.iconPath = args.iconPath ? path.resolve(args.iconPath) : '';
  return args;
}

function uniqueTokens(value) {
  return [...new Set(String(value || '').split(/\s+/).filter(Boolean))];
}

async function clickFirstVisible(locator, description) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) {
      await candidate.click();
      return;
    }
  }
  throw new Error(`No visible element found for ${description}.`);
}

async function clickVisibleCenter(page, locator, description, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  do {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      await candidate.scrollIntoViewIfNeeded().catch(() => {});
      const box = await candidate.boundingBox().catch(() => null);
      if (!box || box.width <= 0 || box.height <= 0) continue;
      await page.mouse.click(box.x + (box.width / 2), box.y + (box.height / 2));
      return;
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);

  throw new Error(`No visible click target found for ${description}.`);
}

async function waitForApplicationList(page, timeout = 45_000) {
  await page.waitForURL(
    (url) => url.pathname.replace(/\/$/, '') === LIST_PATH,
    { timeout },
  );
}

async function goToApplicationList(page) {
  const currentPath = new URL(page.url()).pathname.replace(/\/$/, '');
  if (currentPath === LIST_PATH) return;
  if (!currentPath.startsWith(`${LIST_PATH}/`)) {
    throw new Error(`Unexpected developer-platform page: ${page.url()}`);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await clickFirstVisible(
    page.getByRole('link', { name: '应用管理', exact: true }),
    'application management link',
  );
  await waitForApplicationList(page);
}

async function finishSuccessfulSubmission(page) {
  const successModal = page
    .locator('.ant-modal:visible')
    .filter({ hasText: '创建成功' });
  const outcome = await Promise.race([
    page.waitForURL(
      (url) => url.pathname.replace(/\/$/, '') === LIST_PATH,
      { timeout: 45_000 },
    ).then(() => 'list'),
    successModal.waitFor({ state: 'visible', timeout: 45_000 }).then(() => 'modal'),
  ]);
  if (outcome === 'modal') {
    await clickFirstVisible(
      successModal.getByRole('button', { name: '确 认', exact: true }),
      'successful submission confirmation',
    );
    await page.waitForURL((url) => {
      const pathname = url.pathname.replace(/\/$/, '');
      return pathname === LIST_PATH || pathname.startsWith(`${LIST_PATH}/detail`);
    }, { timeout: 45_000 });
  }
  await goToApplicationList(page);
}

async function loginIfNeeded(page) {
  if (!new URL(page.url()).pathname.includes('/login')) {
    return false;
  }

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
  await waitForApplicationList(page);
  return true;
}

async function readApplicationCard(page, appName) {
  const heading = page.locator('h3').filter({ hasText: appName }).filter({
    has: page.locator(`xpath=self::*[normalize-space(text())=${JSON.stringify(appName)}]`),
  });

  const exactHeading = page.locator('h3').filter({ hasText: appName });
  const count = await exactHeading.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = exactHeading.nth(index);
    if ((await candidate.innerText()).trim() !== appName) continue;
    const cardText = await candidate.evaluate((element) => (
      element.parentElement?.parentElement?.parentElement?.innerText || ''
    ));
    const lines = uniqueTokens(cardText.replace(/\n/g, ' '));
    const mode = lines.find((line) => ['全托管', '半托管', 'POP', '自运营', 'SHEIN自营'].includes(line)) || '';
    const status = lines.find((line) => ['审核中', '审核通过', '审核驳回', '已驳回'].includes(line)) || '';
    return { appName, mode, status, cardText };
  }
  return null;
}

async function saveExistingAppIcon(page, store) {
  const icon = page.locator('img[src*="ssmp-openapiaws"]').first();
  await icon.waitFor({ state: 'attached', timeout: 25_000 });
  const iconUrl = await icon.getAttribute('src');
  if (!iconUrl) throw new Error(`Existing app icon URL is missing for ${store}.`);

  const parsed = new URL(iconUrl);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'ssmp-openapiaws.s3.us-west-2.amazonaws.com') {
    throw new Error(`Unexpected existing app icon host for ${store}.`);
  }

  const response = await fetch(iconUrl);
  if (!response.ok) {
    throw new Error(`Existing app icon download failed for ${store}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1 || buffer.length >= 10 * 1024 * 1024) {
    throw new Error(`Existing app icon has an invalid size for ${store}: ${buffer.length} bytes.`);
  }

  const iconDirectory = path.join(projectRoot, 'assets', 'store-icons');
  await fs.mkdir(iconDirectory, { recursive: true });
  const iconPath = path.join(iconDirectory, `${store.toLowerCase()}-openapi-app-icon.png`);
  await fs.writeFile(iconPath, buffer);
  return { iconPath, iconBytes: buffer.length };
}

async function selectFullManagedMode(page) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.keyboard.press('Escape').catch(() => {});
    await clickVisibleCenter(
      page,
      page.locator('.ant-form-item:has(#mode) .ant-select-selector'),
      'cooperation mode selector',
    );
    const option = page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="全托管"]');
    await option.waitFor({ state: 'visible', timeout: 10_000 });
    await option.evaluate((element) => element.click());

    // SHEIN's Ant Design form briefly exposes the new value before its dependent
    // business-function field is re-rendered. Let that render settle, then verify.
    await page.waitForTimeout(1_500);
    const state = await page.evaluate(() => ({
      mode: document.querySelector('#mode')?.closest('.ant-select')?.innerText || '',
      business: document.querySelector('#businessFunction')?.closest('.ant-select')?.innerText || '',
    }));
    if (state.mode.includes('全托管')
      && !state.mode.includes('半托管')
      && state.business.includes('先选合作模式')) {
      return;
    }
  }

  throw new Error('Full-managed cooperation mode did not remain selected after three attempts.');
}

async function selectBusinessFunctions(page) {
  await clickVisibleCenter(
    page,
    page.locator('.ant-form-item:has(#businessFunction) .ant-select-selector'),
    'business function selector',
  );

  for (const title of EXPECTED_BUSINESS) {
    const option = page.locator(`.ant-select-dropdown:visible .ant-select-item-option[title="${title}"]`);
    await option.waitFor({ state: 'visible', timeout: 10_000 });
    await option.evaluate((element) => element.click());
  }
}

async function validatePreparedForm(page, expected) {
  const state = await page.evaluate(() => ({
    appName: document.querySelector('#appName')?.value || '',
    mode: [...new Set((document.querySelector('#mode')?.closest('.ant-select')?.innerText || '')
      .split(/\s+/).filter(Boolean))].join(''),
    business: [...new Set((document.querySelector('#businessFunction')?.closest('.ant-select')?.innerText || '')
      .split(/\s+/).filter(Boolean))],
    description: document.querySelector('#appDesc')?.value || '',
    iconPreview: [...document.images].some((image) => (image.currentSrc || image.src).startsWith('data:image/')),
    submitDisabled: [...document.querySelectorAll('button')]
      .find((button) => button.innerText.trim() === '提交审核')?.disabled ?? true,
  }));

  const businessOk = state.business.length === EXPECTED_BUSINESS.length
    && EXPECTED_BUSINESS.every((item) => state.business.includes(item));
  if (state.appName !== expected.appName
    || state.mode !== '全托管'
    || !businessOk
    || state.description !== expected.description
    || !state.iconPreview
    || state.submitDisabled) {
    throw new Error(`Prepared form validation failed for ${expected.store}.`);
  }
  return state;
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
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await loginIfNeeded(page);

  if (new URL(page.url()).pathname.replace(/\/$/, '').startsWith(`${LIST_PATH}/`)) {
    await goToApplicationList(page);
  }

  if (new URL(page.url()).pathname.replace(/\/$/, '') !== LIST_PATH) {
    throw new Error(`Unexpected developer-platform page for ${args.store}: ${page.url()}`);
  }

  await page.locator('span.mr-1.text-sm').waitFor({ state: 'visible', timeout: 25_000 });
  await page.getByRole('button', { name: '创建应用', exact: true })
    .waitFor({ state: 'visible', timeout: 25_000 });
  const subject = (await page.locator('span.mr-1.text-sm').innerText()).trim();
  const appNames = (await page.locator('h3').allInnerTexts()).map((name) => name.trim());
  const existingFullName = appNames.find((name) => (
    name.startsWith(`${args.store}-`) && name.includes('SHEIN全托运营中台')
  ));
  if (existingFullName) {
    const existingCard = await readApplicationCard(page, existingFullName);
    if (!existingCard || existingCard.mode !== '全托管') {
      throw new Error(`Existing full-managed app readback failed for ${args.store}.`);
    }
    console.log(JSON.stringify({
      storeKey: args.store,
      port: args.port,
      action: 'existing',
      subject,
      ...existingCard,
      verifiedAt: new Date().toISOString(),
    }, null, 2));
    return;
  }

  const semiName = appNames.find((name) => (
    name.startsWith(`${args.store}-`) && name.includes('SHEIN运营中台')
  ));
  let shortName = args.shortName;
  let iconPath = args.iconPath;
  let iconBytes = 0;
  if (semiName) {
    const suffixIndex = semiName.indexOf('SHEIN运营中台');
    shortName ||= semiName.slice(args.store.length + 1, suffixIndex);
    if (!shortName) throw new Error(`Could not derive the Chinese short name for ${args.store}.`);
    const icon = await saveExistingAppIcon(page, args.store);
    iconPath ||= icon.iconPath;
    iconBytes = icon.iconBytes;
  } else if (!shortName || !iconPath) {
    throw new Error(`New Open Platform account ${args.store} requires --short-name and --icon-path.`);
  }
  const iconMetadata = await fs.stat(iconPath);
  if (!iconMetadata.isFile() || iconMetadata.size < 1 || iconMetadata.size >= 10 * 1024 * 1024) {
    throw new Error(`Application icon has an invalid size for ${args.store}.`);
  }
  iconBytes = iconMetadata.size;

  const appName = `${args.store}-${shortName}SHEIN全托运营中台`;
  const description = semiName
    ? `本应用由${subject}自研，计划服务同一公司主体旗下的全托管店铺，用于商品管理、商品合规、备货履约、库存管理、财务对账及内部BI经营分析。公司已有独立半托管应用；本应用仅用于全托管商家授权，按合作模式隔离数据和权限。所有写操作均执行权限校验、预检、人工确认、审计与结果回读。`
    : `本应用由${subject}自研，计划服务同一公司主体旗下的全托管店铺，用于商品管理、商品合规、备货履约、库存管理、财务对账及内部BI经营分析。本应用仅用于全托管商家授权，按合作模式隔离数据和权限。所有写操作均执行权限校验、预检、人工确认、审计与结果回读。`;

  await clickFirstVisible(page.getByRole('button', { name: '创建应用', exact: true }), 'create application button');
  await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === CHECK_PATH, { timeout: 30_000 });
  await page.locator('#appName').fill(appName);
  await selectFullManagedMode(page);
  await selectBusinessFunctions(page);
  await page.locator('#appDesc').fill(description);
  await page.locator('#iconUrl').setInputFiles(iconPath);
  await page.waitForFunction(() => (
    [...document.images].some((image) => (image.currentSrc || image.src).startsWith('data:image/'))
  ), null, { timeout: 30_000 });

  const prepared = await validatePreparedForm(page, { store: args.store, appName, description });
  if (!args.submit) {
    console.log(JSON.stringify({
      storeKey: args.store,
      port: args.port,
      action: 'prepared',
      subject,
      semiManagedApp: semiName || null,
      appName,
      cooperationMode: prepared.mode,
      businessFunctions: prepared.business,
      iconPath,
      iconBytes,
      descriptionLength: description.length,
      verifiedAt: new Date().toISOString(),
    }, null, 2));
    return;
  }

  await clickFirstVisible(page.getByRole('button', { name: '提交审核', exact: true }), 'submit for review button');
  await finishSuccessfulSubmission(page);
  await page.waitForFunction((targetName) => (
    [...document.querySelectorAll('h3')].some((heading) => heading.innerText.trim() === targetName)
  ), appName, { timeout: 30_000 });

  const readback = await readApplicationCard(page, appName);
  if (!readback || readback.mode !== '全托管' || !['审核中', '审核通过'].includes(readback.status)) {
    throw new Error(`Submission readback failed for ${args.store}.`);
  }

  console.log(JSON.stringify({
    storeKey: args.store,
    port: args.port,
    action: 'submitted',
    subject,
    semiManagedApp: semiName || null,
    appName,
    cooperationMode: readback.mode,
    status: readback.status,
    iconPath,
    iconBytes,
    descriptionLength: description.length,
    verifiedAt: new Date().toISOString(),
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  });
