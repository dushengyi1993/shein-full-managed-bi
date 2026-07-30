#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  FULL_MANAGED_STORE_CODES,
  fullManagedProfileKey,
  normalizeFullManagedStoreCode,
} from '../src/config/full-managed-stores.mjs';

const HOST = process.env.FULL_FM_STORE_LOGIN_HOST || '127.0.0.1';
const PORT = Number(process.env.FULL_FM_STORE_LOGIN_PORT || 8794);
const PROFILE_ROOT = process.env.FULL_FM_PROFILE_ROOT || '/srv/shein-fm/webapi/profiles';
const STATE_FILE = process.env.FULL_FM_STORE_LOGIN_STATE_FILE
  || '/srv/shein-fm/runtime/store-login/state.json';
const BATCH_FILE = process.env.FULL_FM_STORE_LOGIN_BATCH_FILE
  || '/srv/shein-fm/secrets/store-login/batch.json';
const LOG_DIR = process.env.FULL_FM_STORE_LOGIN_LOG_DIR
  || '/srv/shein-fm/runtime/store-login/logs';
const TARGET_URL = 'https://sso.geiwohuo.com/#/gsp/home';
const NOVNC_ROOTS = ['/usr/share/novnc', '/usr/share/novnc-pkg'];
const RUNTIME = Object.freeze({
  display: ':220',
  vncPort: 5_920,
  websockifyPort: 16_220,
  debuggingPort: 39_700,
});
const SESSION_MINUTES = 60;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function timingSafeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(String(left)) || !/^[a-f0-9]{64}$/i.test(String(right))) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(temp, file);
}

function initialState() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    stores: Object.fromEntries(FULL_MANAGED_STORE_CODES.map((storeCode) => [
      storeCode,
      { status: 'pending', completedAt: null, verified: false, lastError: null },
    ])),
    active: null,
  };
}

function normalizeState(raw) {
  const state = initialState();
  for (const storeCode of FULL_MANAGED_STORE_CODES) {
    const source = raw?.stores?.[storeCode];
    if (!source) continue;
    state.stores[storeCode] = {
      status: ['pending', 'completed', 'needs_attention'].includes(source.status)
        ? source.status
        : 'pending',
      completedAt: source.completedAt || null,
      verified: source.verified === true,
      lastError: source.lastError ? String(source.lastError).slice(0, 160) : null,
    };
  }
  state.updatedAt = raw?.updatedAt || state.updatedAt;
  state.active = raw?.active && normalizeFullManagedStoreCode(raw.active.storeCode)
    ? raw.active
    : null;
  return state;
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopPid(pid) {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (!isPidAlive(pid)) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

async function stopActive(active) {
  if (!active?.pids) return;
  for (const name of ['chrome', 'websockify', 'x11vnc', 'xvfb']) {
    await stopPid(Number(active.pids[name]));
  }
}

function spawnDetached(command, args, { display, home, logFd } = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
    env: {
      ...process.env,
      ...(display ? { DISPLAY: display } : {}),
      ...(home ? { HOME: home } : {}),
    },
  });
  child.unref();
  return child.pid;
}

async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: 500 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('RUNTIME_PORT_NOT_READY');
}

function chromeBinary() {
  const candidates = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  const binary = candidates.find((candidate) => fssync.existsSync(candidate));
  if (!binary) throw new Error('CHROME_NOT_FOUND');
  return binary;
}

async function launchSession(storeCode) {
  const profileDirectory = path.join(PROFILE_ROOT, fullManagedProfileKey(storeCode));
  await fs.mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await fs.mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
  const id = `fm-login-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const sessionToken = crypto.randomBytes(24).toString('base64url');
  const logFile = path.join(LOG_DIR, `${id}.log`);
  const logFd = fssync.openSync(logFile, 'a', 0o600);
  const pids = {};
  try {
    pids.xvfb = spawnDetached('Xvfb', [
      RUNTIME.display,
      '-screen', '0', '1440x960x24',
      '-nolisten', 'tcp',
      '-ac',
    ], { logFd });
    await new Promise((resolve) => setTimeout(resolve, 800));
    pids.x11vnc = spawnDetached('x11vnc', [
      '-display', RUNTIME.display,
      '-localhost',
      '-nopw',
      '-forever',
      '-shared',
      '-rfbport', String(RUNTIME.vncPort),
      '-quiet',
    ], { logFd });
    await waitForPort(RUNTIME.vncPort, 15_000);
    pids.websockify = spawnDetached('websockify', [
      '127.0.0.1:' + RUNTIME.websockifyPort,
      '127.0.0.1:' + RUNTIME.vncPort,
    ], { logFd });
    await waitForPort(RUNTIME.websockifyPort, 15_000);
    pids.chrome = spawnDetached(chromeBinary(), [
      `--user-data-dir=${profileDirectory}`,
      `--disk-cache-dir=${path.join(profileDirectory, 'cache')}`,
      '--password-store=basic',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${RUNTIME.debuggingPort}`,
      '--profile-directory=Profile 1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1440,960',
      TARGET_URL,
    ], { display: RUNTIME.display, home: profileDirectory, logFd });
    await waitForPort(RUNTIME.debuggingPort, 30_000);
  } catch (error) {
    await stopActive({ pids });
    throw error;
  } finally {
    fssync.closeSync(logFd);
  }
  return {
    active: {
      id,
      storeCode,
      tokenHash: sha256(sessionToken),
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_MINUTES * 60_000).toISOString(),
      pids,
      runtime: RUNTIME,
    },
    sessionToken,
  };
}

async function cdpEvaluate(expression) {
  const pagesResponse = await fetch(`http://127.0.0.1:${RUNTIME.debuggingPort}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  });
  const pages = await pagesResponse.json();
  const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!page) throw new Error('CDP_PAGE_MISSING');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP_CONNECT_TIMEOUT')), 3_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP_CONNECT_FAILED')); }, { once: true });
  });
  try {
    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true },
    }));
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP_EVALUATE_TIMEOUT')), 5_000);
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        clearTimeout(timer);
        resolve(message.result?.result?.value);
      });
    });
  } finally {
    socket.close();
  }
}

async function proveLogin(storeCode) {
  const digits = storeCode.slice(-4);
  return cdpEvaluate(`(() => {
    const text = String(document.body && document.body.innerText || '');
    const href = String(location.href || '');
    return {
      sameOrigin: location.origin === 'https://sso.geiwohuo.com',
      onLogin: /login/i.test(href) || /登录|验证码/.test(text),
      aliasPresent: text.includes(${JSON.stringify(digits)})
    };
  })()`);
}

async function batchAuthorized(req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return false;
  const batch = await readJson(BATCH_FILE, null);
  if (
    !batch?.tokenHash
    || batch.revokedAt
    || !batch.expiresAt
    || Date.parse(batch.expiresAt) <= Date.now()
  ) return false;
  return timingSafeEqualHex(sha256(token), batch.tokenHash);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; frame-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' wss: ws:",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    ...headers,
  });
  res.end(body);
}

function json(res, status, body) {
  send(res, status, JSON.stringify(body), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function bodyJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 8_192) throw new Error('BODY_TOO_LARGE');
  }
  return text ? JSON.parse(text) : {};
}

function publicStatus(state) {
  const completed = FULL_MANAGED_STORE_CODES.filter(
    (storeCode) => state.stores[storeCode]?.status === 'completed',
  ).length;
  return {
    ok: true,
    total: FULL_MANAGED_STORE_CODES.length,
    completed,
    allCompleted: completed === FULL_MANAGED_STORE_CODES.length,
    active: state.active ? {
      id: state.active.id,
      storeCode: state.active.storeCode,
      startedAt: state.active.startedAt,
      expiresAt: state.active.expiresAt,
    } : null,
    stores: FULL_MANAGED_STORE_CODES.map((storeCode) => ({
      storeCode,
      ...state.stores[storeCode],
    })),
  };
}

function loginPage() {
  // A UTF-8 BOM is intentional. Standard browsers do not need it, but it
  // prevents embedded enterprise/IM webviews from guessing GBK before they
  // process the HTTP header or the early meta charset.
  return `\uFEFF<!doctype html><html lang="zh-CN"><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>&#x5168;&#x6258;&#x5e97;&#x94fa;&#x4e91;&#x7aef;&#x767b;&#x5f55;</title><style>
  :root{--bg:#f6f5f2;--card:#fff;--text:#171717;--muted:#737373;--line:#e7e5e4;--green:#176b4d;--black:#171717;--red:#b42318}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}header{padding:28px 32px;border-bottom:1px solid var(--line);background:#fff}h1{margin:0;font-size:25px}.sub{color:var(--muted);margin-top:6px}.wrap{max-width:1180px;margin:auto;padding:28px}.summary{display:flex;gap:14px;margin-bottom:18px}.pill{background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px 16px}.pill b{font-size:20px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.store{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}.row{display:flex;justify-content:space-between;gap:12px;align-items:center}.code{font-size:18px;font-weight:760}.status{font-size:12px;color:var(--muted)}button{border:0;border-radius:10px;padding:9px 13px;background:var(--black);color:#fff;font-weight:700;cursor:pointer}button[disabled]{opacity:.35;cursor:not-allowed}.done{color:var(--green)}.bad{color:var(--red)}#message{position:sticky;top:10px;z-index:3;background:#171717;color:#fff;border-radius:13px;padding:12px 16px;margin-bottom:16px;display:none}@media(max-width:800px){.grid{grid-template-columns:1fr}.wrap{padding:18px}}
  </style></head><body><header><h1>&#x5168;&#x6258; 24 &#x5e97;&#x4e91;&#x7aef;&#x767b;&#x5f55;</h1><div class="sub">&#x9010;&#x5e97;&#x6253;&#x5f00;&#x4e91;&#x7aef; Chrome&#xff0c;&#x767b;&#x5f55;&#x5e76;&#x5141;&#x8bb8;&#x4fdd;&#x5b58;&#x5bc6;&#x7801;&#x3002;&#x5b8c;&#x6210;&#x4e00;&#x5bb6;&#x540e;&#x5173;&#x95ed;&#x7a97;&#x53e3;&#xff0c;&#x518d;&#x5904;&#x7406;&#x4e0b;&#x4e00;&#x5bb6;&#x3002;</div></header><main class="wrap"><div id="message"></div><div id="summary" class="summary"></div><div id="grid" class="grid"></div></main><script>
  const fragment = new URLSearchParams(location.hash.slice(1)); const incoming = fragment.get('token'); if(incoming){sessionStorage.setItem('fmStoreLoginToken',incoming);history.replaceState(null,'',location.pathname)}
  const TOKEN=sessionStorage.getItem('fmStoreLoginToken')||''; const $=id=>document.getElementById(id); const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function msg(s){$('message').textContent=s;$('message').style.display='block'} async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json',...(opts.headers||{})}});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'HTTP '+r.status);return j}
  async function refresh(){const s=await api('/api/store-login/status');$('summary').innerHTML='<div class="pill"><b>'+s.completed+'</b> / '+s.total+' &#x5df2;&#x5b8c;&#x6210;</div><div class="pill">'+(s.active?'&#x6b63;&#x5728;&#x5904;&#x7406; <b>'+esc(s.active.storeCode)+'</b>':'&#x5f53;&#x524d;&#x6ca1;&#x6709;&#x6253;&#x5f00;&#x7684;&#x4e91;&#x7aef;&#x7a97;&#x53e3;')+'</div>';$('grid').innerHTML=s.stores.map(x=>{const active=s.active&&s.active.storeCode===x.storeCode;const done=x.status==='completed';return '<section class="store"><div class="row"><div><div class="code">'+esc(x.storeCode)+'</div><div class="status '+(done?'done':x.status==='needs_attention'?'bad':'')+'">'+(done?'&#x5df2;&#x9a8c;&#x8bc1;&#x767b;&#x5f55;':x.status==='needs_attention'?'&#x9700;&#x8981;&#x91cd;&#x65b0;&#x5904;&#x7406;':'&#x5f85;&#x767b;&#x5f55;')+'</div></div><button '+((s.active&&!active)||done?'disabled':'')+' data-start="'+esc(x.storeCode)+'">'+(active?'&#x91cd;&#x65b0;&#x8fdb;&#x5165;':done?'&#x5df2;&#x5b8c;&#x6210;':'&#x6253;&#x5f00;&#x767b;&#x5f55;')+'</button></div>'+(active?'<div class="row" style="margin-top:13px"><button data-open="'+esc(x.storeCode)+'">&#x8fdb;&#x5165;&#x7a97;&#x53e3;</button><button data-finish="'+esc(x.storeCode)+'">&#x767b;&#x5f55;&#x5b8c;&#x6210;&#x5e76;&#x9a8c;&#x8bc1;</button><button data-close="'+esc(x.storeCode)+'">&#x5173;&#x95ed;&#x91cd;&#x6765;</button></div>':'')+'</section>'}).join('');document.querySelectorAll('[data-start]').forEach(b=>b.onclick=()=>start(b.dataset.start));document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openActive());document.querySelectorAll('[data-finish]').forEach(b=>b.onclick=()=>finish(b.dataset.finish));document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>closeActive())}
  let activeUrl=sessionStorage.getItem('fmStoreLoginActiveUrl')||'';function openActive(){if(activeUrl)window.open(activeUrl,'_blank','noopener,noreferrer');else msg('Close the current session and open it again.')}
  async function start(storeCode){try{const j=await api('/api/store-login/start',{method:'POST',body:JSON.stringify({storeCode})});activeUrl=j.openUrl;sessionStorage.setItem('fmStoreLoginActiveUrl',activeUrl);window.open(activeUrl,'_blank','noopener,noreferrer');await refresh()}catch(e){msg('Open failed: '+e.message)}}
  async function finish(storeCode){try{const j=await api('/api/store-login/finish',{method:'POST',body:JSON.stringify({storeCode})});activeUrl='';sessionStorage.removeItem('fmStoreLoginActiveUrl');msg(j.verified?'Login verified. Continue with the next store.':'Store identity was not verified. Please try this store again.');await refresh()}catch(e){msg('Verification failed: '+e.message);await refresh()}}
  async function closeActive(){try{await api('/api/store-login/close',{method:'POST',body:'{}'});activeUrl='';sessionStorage.removeItem('fmStoreLoginActiveUrl');await refresh()}catch(e){msg('Close failed: '+e.message)}}
  if(!TOKEN)msg('Invalid link: one-time token is missing.');else refresh().catch(e=>msg('Status failed: '+e.message));
  </script></body></html>`;
}

function sessionPage(id) {
  return `\uFEFF<!doctype html><html lang="zh-CN"><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>&#x4e91;&#x7aef; Chrome</title><style>body{margin:0;background:#111;color:#fff;font:14px system-ui}.bar{height:48px;padding:0 16px;display:flex;align-items:center;justify-content:space-between;background:#171717}iframe{display:block;width:100vw;height:calc(100vh - 48px);border:0}</style></head><body><div class="bar"><b>&#x5168;&#x6258;&#x5e97;&#x94fa;&#x4e91;&#x7aef; Chrome</b><span>&#x767b;&#x5f55;&#x5e76;&#x4fdd;&#x5b58;&#x5bc6;&#x7801;&#x540e;&#xff0c;&#x56de;&#x5230;&#x5e97;&#x94fa;&#x5217;&#x8868;&#x70b9;&#x767b;&#x5f55;&#x5b8c;&#x6210;&#x5e76;&#x9a8c;&#x8bc1;</span></div><iframe id="frame" allow="clipboard-read; clipboard-write"></iframe><script>const t=new URLSearchParams(location.hash.slice(1)).get('token')||'';history.replaceState(null,'',location.pathname);document.getElementById('frame').src='/store-login/novnc/vnc.html?autoconnect=1&resize=scale&path='+encodeURIComponent('api/store-login/ws/${encodeURIComponent(id)}/'+encodeURIComponent(t));</script></body></html>`;
}

function novncRoot() {
  return NOVNC_ROOTS.find((root) => fssync.existsSync(path.join(root, 'vnc.html')));
}

async function serveNovnc(res, pathname) {
  const root = novncRoot();
  if (!root) return send(res, 503, 'noVNC unavailable', { 'Content-Type': 'text/plain' });
  const relative = decodeURIComponent(pathname.replace(/^\/store-login\/novnc\/?/, '')) || 'vnc.html';
  const file = path.resolve(root, relative);
  if (file !== path.resolve(root) && !file.startsWith(`${path.resolve(root)}${path.sep}`)) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  }
  try {
    const data = await fs.readFile(file);
    const ext = path.extname(file);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
    return send(res, 200, data, { 'Content-Type': types[ext] || 'application/octet-stream' });
  } catch {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }
}

let queue = Promise.resolve();

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/store-login') {
    return send(res, 200, loginPage(), { 'Content-Type': 'text/html; charset=utf-8' });
  }
  const sessionMatch = /^\/store-login\/session\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && sessionMatch) {
    return send(res, 200, sessionPage(decodeURIComponent(sessionMatch[1])), { 'Content-Type': 'text/html; charset=utf-8' });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/store-login/novnc/')) {
    return serveNovnc(res, url.pathname);
  }
  if (!url.pathname.startsWith('/api/store-login/')) return json(res, 404, { ok: false, error: 'NOT_FOUND' });
  if (!(await batchAuthorized(req))) return json(res, 401, { ok: false, error: 'LINK_EXPIRED_OR_INVALID' });
  let state = normalizeState(await readJson(STATE_FILE, null));
  if (state.active && (!isPidAlive(Number(state.active.pids?.chrome)) || Date.parse(state.active.expiresAt) <= Date.now())) {
    await stopActive(state.active);
    state.stores[state.active.storeCode].status = 'needs_attention';
    state.stores[state.active.storeCode].lastError = 'session expired before verification';
    state.active = null;
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(STATE_FILE, state);
  }
  if (req.method === 'GET' && url.pathname === '/api/store-login/status') {
    return json(res, 200, publicStatus(state));
  }
  if (req.method === 'POST' && url.pathname === '/api/store-login/start') {
    const body = await bodyJson(req);
    const storeCode = normalizeFullManagedStoreCode(body.storeCode);
    if (!storeCode) return json(res, 400, { ok: false, error: 'STORE_INVALID' });
    if (state.active) return json(res, 409, { ok: false, error: `FINISH_ACTIVE_STORE_${state.active.storeCode}` });
    const launched = await launchSession(storeCode);
    state.active = launched.active;
    state.stores[storeCode] = { status: 'pending', completedAt: null, verified: false, lastError: null };
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(STATE_FILE, state);
    return json(res, 200, {
      ok: true,
      storeCode,
      openUrl: `/store-login/session/${encodeURIComponent(launched.active.id)}#token=${launched.sessionToken}`,
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/store-login/finish') {
    const body = await bodyJson(req);
    const storeCode = normalizeFullManagedStoreCode(body.storeCode);
    if (!storeCode || state.active?.storeCode !== storeCode) {
      return json(res, 409, { ok: false, error: 'ACTIVE_STORE_MISMATCH' });
    }
    let proof = null;
    try { proof = await proveLogin(storeCode); } catch {}
    const verified = proof?.sameOrigin === true && proof?.onLogin === false && proof?.aliasPresent === true;
    await stopActive(state.active);
    state.stores[storeCode] = {
      status: verified ? 'completed' : 'needs_attention',
      completedAt: verified ? new Date().toISOString() : null,
      verified,
      lastError: verified ? null : 'store identity was not visible after login',
    };
    state.active = null;
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(STATE_FILE, state);
    return json(res, 200, { ok: true, storeCode, verified });
  }
  if (req.method === 'POST' && url.pathname === '/api/store-login/close') {
    if (state.active) {
      const storeCode = state.active.storeCode;
      await stopActive(state.active);
      state.stores[storeCode].status = 'needs_attention';
      state.stores[storeCode].lastError = 'manual session closed without verification';
      state.active = null;
      state.updatedAt = new Date().toISOString();
      await writeJsonAtomic(STATE_FILE, state);
    }
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
}

async function handleUpgrade(req, socket) {
  const fail = (status, message) => {
    try { socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`); } catch {}
    try { socket.destroy(); } catch {}
  };
  const url = new URL(req.url || '/', 'http://localhost');
  const match = /^\/api\/store-login\/ws\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!match) return fail(404, 'Not Found');
  const state = normalizeState(await readJson(STATE_FILE, null));
  const active = state.active;
  const id = decodeURIComponent(match[1]);
  const token = decodeURIComponent(match[2]);
  if (
    !active
    || active.id !== id
    || Date.parse(active.expiresAt) <= Date.now()
    || !timingSafeEqualHex(sha256(token), active.tokenHash)
  ) return fail(403, 'Forbidden');
  const upstream = net.createConnection({ host: '127.0.0.1', port: RUNTIME.websockifyPort }, () => {
    const lines = ['GET /websockify HTTP/1.1'];
    for (const [key, value] of Object.entries({ ...req.headers, host: `127.0.0.1:${RUNTIME.websockifyPort}` })) {
      if (Array.isArray(value)) value.forEach((item) => lines.push(`${key}: ${item}`));
      else if (value !== undefined) lines.push(`${key}: ${value}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => fail(502, 'Bad Gateway'));
  socket.on('error', () => { try { upstream.destroy(); } catch {} });
}

export function createStoreLoginServer() {
  const server = http.createServer((req, res) => {
    queue = queue.then(() => handle(req, res)).catch((error) => {
      if (!res.headersSent) json(res, 500, { ok: false, error: String(error?.message || 'INTERNAL_ERROR').slice(0, 160) });
      else res.destroy();
    });
  });
  server.on('upgrade', (req, socket) => {
    handleUpgrade(req, socket).catch(() => { try { socket.destroy(); } catch {} });
  });
  return server;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/serve_full_managed_store_login.mjs')) {
  const server = createStoreLoginServer();
  server.listen(PORT, HOST, () => {
    console.log(JSON.stringify({ ok: true, host: HOST, port: PORT }));
  });
}
