#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const siblingRoot = path.resolve(projectRoot, '..', 'Shein销售统计');
const profileRoot = path.join(siblingRoot, 'profiles');
const entityFile = path.join(projectRoot, 'config', 'full-managed-legal-entities.json');
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(projectRoot, 'node_modules', 'playwright'));

const LIST_URL = 'https://open.sheincorp.com/backstage/mange-applictions';
const LIST_PATH = '/backstage/mange-applictions';
const DETAIL_PATH = `${LIST_PATH}/detail`;
const CALLBACK_URL = 'https://fm.dushengyi.cc/api/shein/webhook/v1/events';

function parseArgs(argv) {
  const args = { inspect: false, submit: false, headed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (['--inspect', '--submit', '--headed'].includes(token)) {
      args[token.slice(2)] = true;
      continue;
    }
    if (token === '--entity') {
      args.entity = String(argv[index + 1] || '').trim().toUpperCase();
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!/^[A-Z]{2}$/.test(args.entity || '')) {
    throw new Error('Missing or invalid --entity.');
  }
  if (args.submit && args.inspect) throw new Error('Use either --inspect or --submit.');
  return args;
}

async function clickFirstVisible(locator, description) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      return candidate;
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
  await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === LIST_PATH, {
    timeout: 45_000,
  });
}

async function openApplication(page, entityKey) {
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForFunction(() => (
    location.pathname.includes('/login')
    || Boolean(document.querySelector('span.mr-1.text-sm'))
  ), null, { timeout: 25_000 });
  await loginIfNeeded(page);
  await page.locator('h3').first().waitFor({ state: 'visible', timeout: 25_000 });
  const headings = page.locator('h3');
  const names = (await headings.allInnerTexts()).map((value) => value.trim());
  const appName = names.find((value) => (
    value.startsWith(`${entityKey}-`) && value.includes('SHEIN全托运营中台')
  ));
  if (!appName) throw new Error(`Full-managed app is missing for ${entityKey}.`);
  const heading = headings.filter({ hasText: appName }).first();
  const card = heading.locator('xpath=../../..');
  const cardText = await card.innerText();
  if (!cardText.includes('全托管') || !cardText.includes('审核通过')) {
    throw new Error(`Full-managed app is not approved for ${entityKey}.`);
  }
  await clickFirstVisible(
    card.getByRole('button', { name: '查看详情', exact: true }),
    'full-managed app details button',
  );
  await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === DETAIL_PATH, {
    timeout: 30_000,
  });
  return appName;
}

function redactedText(value) {
  return String(value || '')
    .replace(/[A-Fa-f0-9]{24,}/g, '[REDACTED]')
    .replace(/(APP_Secretkey\s*[:：]?\s*)\S+/gi, '$1[REDACTED]')
    .slice(0, 12_000);
}

async function inspectPage(page, entity, appName, requestUrls, responseBodies) {
  const apiPermissionTab = page.getByRole('tab', { name: /API权限(?:设置|包)/ });
  let salesPermission = Object.freeze({ status: 'unavailable', rowText: null });
  if (await apiPermissionTab.isVisible().catch(() => false)) {
    await apiPermissionTab.click();
    await page.waitForTimeout(1_200);
    const salesRow = page.locator('tr').filter({ hasText: /^销量查询/ }).first();
    if (await salesRow.isVisible().catch(() => false)) {
      const rowText = (await salesRow.innerText()).trim();
      salesPermission = Object.freeze({
        status: rowText.includes('已订阅')
          ? 'approved'
          : rowText.includes('审核中')
            ? 'pending-review'
            : rowText.includes('申请权限包')
              ? 'not-applied'
              : 'unknown',
        rowText: redactedText(rowText),
      });
    }
  }
  const webhookTab = page.getByRole('tab', { name: 'Webhook设置', exact: true });
  if (await webhookTab.isVisible().catch(() => false)) {
    await webhookTab.click();
    await page.waitForTimeout(1_500);
  }
  const tabs = await page.getByRole('tab').allInnerTexts().catch(() => []);
  const links = await page.getByRole('link').allInnerTexts().catch(() => []);
  const buttons = await page.getByRole('button').allInnerTexts().catch(() => []);
  const controls = await page.locator('input,button,[role="switch"]').evaluateAll((nodes) => (
    nodes.map((node, index) => ({
      index,
      tag: node.tagName,
      type: node.getAttribute('type'),
      role: node.getAttribute('role'),
      text: node.textContent?.trim(),
      value: 'value' in node ? node.value : null,
      placeholder: node.getAttribute('placeholder'),
      checked: 'checked' in node ? node.checked : null,
      disabled: 'disabled' in node ? node.disabled : null,
      ariaChecked: node.getAttribute('aria-checked'),
      className: node.className,
    }))
  )).catch(() => []);
  const body = redactedText(await page.locator('body').innerText());
  console.log(JSON.stringify({
    ok: true,
    action: 'inspected',
    entity: entity.entityKey,
    appName,
    url: page.url().replace(/([?&]appid=)[^&]+/i, '$1[REDACTED]'),
    tabs,
    links,
    buttons,
    controls,
    salesPermission,
    callbackUrl: CALLBACK_URL,
    requestUrls: [...requestUrls].filter((url) => (
      /event|message|subscribe|callback|webhook/i.test(url)
    )).slice(-100),
    responseBodies,
    body,
    inspectedAt: new Date().toISOString(),
  }, null, 2));
}

async function configureCallback(page, editIndex, label) {
  const editButtons = page.getByRole('button', { name: '编 辑', exact: true });
  const edit = editButtons.nth(editIndex);
  if (!(await edit.isVisible().catch(() => false))) {
    throw new Error(`${label} edit button is unavailable.`);
  }
  const before = await edit.locator('xpath=../..').innerText().catch(() => '');
  if (before.includes(CALLBACK_URL)) {
    return { label, action: 'already-configured', status: 'configured' };
  }
  await edit.click();
  const input = page.locator('input.ant-input:visible').last();
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  await input.fill(CALLBACK_URL.replace(/^https:\/\//, ''));
  await clickFirstVisible(
    page.getByRole('button', { name: '提 交', exact: true }),
    `${label} submit button`,
  );
  const dialog = page.getByRole('dialog').last();
  await dialog.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
  let dialogText = '';
  if (await dialog.isVisible().catch(() => false)) {
    dialogText = redactedText(await dialog.innerText());
    const primary = dialog.locator('button.ant-btn-primary');
    if (await primary.last().isVisible().catch(() => false)) {
      await primary.last().click();
    } else {
      const confirmation = dialog.getByRole('button', { name: /确\s*认|提\s*交|知\s*道/ });
      await clickFirstVisible(confirmation, `${label} confirmation button`);
    }
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
  }
  await page.waitForTimeout(2_000);
  const after = await page.locator('body').innerText();
  const status = /审核中|待审核/.test(after)
    ? 'pending-review'
    : after.includes(CALLBACK_URL)
      ? 'configured'
      : 'submitted';
  return { label, action: 'submitted', status, dialogText };
}

function eventCodeFromRowText(value) {
  return String(value || '').split(/\s+/).find((token) => (
    /^[a-z][a-z0-9_]{3,120}$/.test(token)
    && (token.includes('_notice') || token.startsWith('product_'))
  )) || '';
}

async function configureSubscriptions(page, entity, appName, responseBodies) {
  const webhookTab = page.getByRole('tab', { name: 'Webhook设置', exact: true });
  await webhookTab.click();
  await page.waitForTimeout(1_200);
  const callback = await configureCallback(page, 0, '正式回调');
  const testCallback = {
    label: '测试回调',
    action: 'deferred',
    status: 'waiting-for-formal-callback-review',
  };
  const switches = page.getByRole('switch');
  const switchCount = await switches.count();
  const enabled = [];
  const blocked = [];
  const requested = [];
  for (let index = 0; index < switchCount; index += 1) {
    const item = switches.nth(index);
    const row = item.locator('xpath=ancestor::tr[1]');
    const text = (await row.innerText().catch(() => '')).trim();
    const eventCode = eventCodeFromRowText(text);
    const isVideo = eventCode === 'product_video_conversion_completed';
    if (isVideo) continue;
    if (await item.isDisabled()) {
      blocked.push({ eventCode: eventCode || `row-${index + 1}`, reason: 'disabled' });
      continue;
    }
    if ((await item.getAttribute('aria-checked')) !== 'true') {
      const responsePromise = page.waitForResponse(
        (response) => response.url().includes('/event/config/subscribeEventConfig'),
        { timeout: 10_000 },
      ).catch(() => null);
      await item.click();
      const confirmation = page.getByRole('dialog').last();
      if (await confirmation.isVisible().catch(() => false)) {
        const button = confirmation.getByRole('button', { name: /确\s*认|订\s*阅/ });
        if (await button.first().isVisible().catch(() => false)) {
          await clickFirstVisible(button, `${eventCode} subscription confirmation`);
        }
      }
      const response = await responsePromise;
      let responseBody = null;
      if (response) {
        responseBody = await response.json().catch(() => null);
      }
      await page.waitForTimeout(500);
      if (String(responseBody?.code ?? '') === '0') {
        requested.push(eventCode);
        continue;
      }
      if ((await item.getAttribute('aria-checked')) !== 'true') {
        blocked.push({
          eventCode: eventCode || `row-${index + 1}`,
          reason: String(responseBody?.code || 'readback-failed'),
          message: redactedText(responseBody?.msg || ''),
        });
        continue;
      }
    }
    const checked = (await item.getAttribute('aria-checked')) === 'true';
    if (!checked) {
      blocked.push({ eventCode: eventCode || `row-${index + 1}`, reason: 'readback-failed' });
      continue;
    }
    enabled.push(eventCode);
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.getByRole('tab', { name: 'Webhook设置', exact: true }).click();
  await page.waitForTimeout(1_500);
  const verified = [];
  const verifiedSwitches = page.getByRole('switch');
  for (let index = 0; index < await verifiedSwitches.count(); index += 1) {
    const item = verifiedSwitches.nth(index);
    if ((await item.getAttribute('aria-checked')) !== 'true') continue;
    const eventCode = eventCodeFromRowText(
      await item.locator('xpath=ancestor::tr[1]').innerText().catch(() => ''),
    );
    if (eventCode) verified.push(eventCode);
  }
  for (const eventCode of requested) {
    if (!verified.includes(eventCode)) {
      blocked.push({ eventCode, reason: 'final-readback-failed' });
    }
  }
  const subscribedEvents = [...new Set([...enabled, ...verified])];
  return {
    ok: blocked.length === 0,
    action: blocked.length === 0 ? 'subscribed' : 'callback-submitted',
    entity: entity.entityKey,
    stores: entity.stores,
    appName,
    callback,
    testCallback,
    subscribedEvents,
    blockedEvents: blocked,
    verifiedAt: new Date().toISOString(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await fs.readFile(entityFile, 'utf8'));
  const entity = manifest.entities.find(({ entityKey }) => entityKey === args.entity);
  if (!entity) throw new Error(`Unknown legal entity ${args.entity}.`);
  const userDataDir = path.join(profileRoot, entity.profileKey);
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: !args.headed,
    locale: 'zh-CN',
    args: [
      `--profile-directory=${entity.chromeProfileDirectory}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
    ],
  });
  const requestUrls = new Set();
  const responseBodies = [];
  context.on('request', (request) => requestUrls.add(request.url()));
  context.on('response', async (response) => {
    if (
      !/event|message|subscribe|callback|webhook/i.test(response.url())
      && response.request().method() === 'GET'
    ) return;
    const contentType = response.headers()['content-type'] || '';
    if (!contentType.includes('json')) return;
    const body = await response.text().catch(() => '');
    responseBodies.push({
      url: response.url(),
      method: response.request().method(),
      status: response.status(),
      body: redactedText(body),
    });
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    const appName = await openApplication(page, entity.entityKey);
    if (args.inspect || !args.submit) {
      await inspectPage(page, entity, appName, requestUrls, responseBodies);
      return;
    }
    const result = await configureSubscriptions(page, entity, appName, responseBodies);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
