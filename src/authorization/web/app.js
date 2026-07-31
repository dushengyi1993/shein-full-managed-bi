const STATUS_META = Object.freeze({
  NOT_STARTED: { label: '未开始', tone: '', action: '开始授权', detail: '请登录对应全托账号。' },
  AUTHORIZING: { label: '授权进行中', tone: 'warn', action: '重新进入', detail: '如果原页面未完成，可重新发起。' },
  REVIEW_REQUIRED: { label: '已收到 · 待核验', tone: 'ok', action: '', detail: '管理员将核验商户身份和只读权限。' },
  APPROVED: { label: '已完成', tone: 'ok', action: '', detail: '身份核验已通过。' },
  REJECTED: { label: '需重新授权', tone: 'error', action: '重新授权', detail: '上次账号不匹配，请核对后重试。' },
  ERROR: { label: '未完成', tone: 'error', action: '重试授权', detail: '上次处理未完成，请重新发起。' },
});

function byId(id) {
  return document.getElementById(id);
}

function text(element, value) {
  if (element) element.textContent = String(value ?? '');
}

function safeToken(value) {
  const token = String(value || '').replace(/^#/, '').trim();
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error?.message || '请求失败，请稍后重试。');
    error.code = body?.error?.code || 'REQUEST_FAILED';
    throw error;
  }
  return body;
}

function dateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
  }).format(date);
}

function storeDetail(store, meta) {
  if (store.status === 'REVIEW_REQUIRED' || store.status === 'APPROVED') {
    const parts = [];
    if (store.supplierId) parts.push(`商户 ID ${store.supplierId}`);
    if (store.platformStoreName) parts.push(store.platformStoreName);
    return parts.join(' · ') || meta.detail;
  }
  if (store.status === 'ERROR' && store.lastErrorCode) return `${meta.detail} 错误码 ${store.lastErrorCode}`;
  return meta.detail;
}

function validAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'openapi-sem.sheincorp.com'
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}

async function beginAuthorization(storeCode, button) {
  const workspaceError = byId('workspace-error');
  text(workspaceError, '');
  button.disabled = true;
  const popup = window.open('/authorize/opening', `shein-full-${storeCode}-${Date.now()}`);
  if (!popup) {
    text(workspaceError, '浏览器拦截了新窗口，请允许本站弹出窗口后重试。');
    button.disabled = false;
    return;
  }
  try {
    const result = await jsonRequest(`/authorize/start/${encodeURIComponent(storeCode)}`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const destination = validAuthorizationUrl(result.authorizationUrl);
    if (!destination) throw new Error('服务器返回了无效的 SHEIN 授权地址。');
    popup.location.replace(destination);
    window.setTimeout(loadBatch, 1_000);
  } catch (error) {
    popup.close();
    text(workspaceError, error.message);
    button.disabled = false;
  }
}

function renderBatch(batch) {
  byId('access-panel').hidden = true;
  byId('workspace').hidden = false;
  text(byId('batch-heading'), batch.label || '全托店铺授权');
  text(byId('batch-expiry'), `链接有效期至 ${dateTime(batch.expiresAt)}`);

  const received = batch.stores.filter(
    (store) => ['REVIEW_REQUIRED', 'APPROVED'].includes(store.status),
  ).length;
  text(byId('progress-value'), `${received} / ${batch.stores.length}`);
  byId('progress-bar').style.width = `${batch.stores.length ? received / batch.stores.length * 100 : 0}%`;

  const expired = batch.status === 'EXPIRED' || batch.status === 'REVOKED';
  const list = byId('store-list');
  list.replaceChildren();
  for (const store of batch.stores) {
    const meta = STATUS_META[store.status] || STATUS_META.ERROR;
    const row = document.createElement('article');
    row.className = 'store-row';

    const code = document.createElement('span');
    code.className = 'store-code';
    code.textContent = store.storeCode;

    const application = document.createElement('span');
    application.className = 'application-code';
    application.textContent = `${store.applicationStoreCode || 'DL'} 主体应用`;

    const content = document.createElement('div');
    content.className = 'store-content';

    const status = document.createElement('span');
    status.className = `status ${meta.tone}`.trim();
    status.textContent = meta.label;

    const detail = document.createElement('div');
    detail.className = 'store-detail';
    detail.textContent = storeDetail(store, meta);

    const action = document.createElement('button');
    action.className = 'store-action';
    action.type = 'button';
    action.textContent = expired ? '链接已过期' : meta.action || '无需操作';
    action.disabled = expired || !meta.action;
    if (!action.disabled) {
      action.addEventListener('click', () => beginAuthorization(store.storeCode, action));
    }

    content.append(application, status, detail, action);
    row.append(code, content);
    list.append(row);
  }
}

async function loadBatch() {
  try {
    const result = await jsonRequest('/authorize/batch');
    renderBatch(result.batch);
    text(byId('workspace-error'), '');
    return true;
  } catch (error) {
    byId('workspace').hidden = true;
    byId('access-panel').hidden = false;
    text(byId('access-error'), error.message);
    return false;
  }
}

async function createSession(token) {
  const result = await jsonRequest('/authorize/session', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token }),
  });
  renderBatch(result.batch);
}

async function setupBatchPage() {
  const fragmentToken = safeToken(window.location.hash);
  if (window.location.hash) window.history.replaceState({}, '', '/authorize');
  if (fragmentToken) {
    try {
      await createSession(fragmentToken);
    } catch (error) {
      byId('access-panel').hidden = false;
      text(byId('access-error'), error.message);
    }
  } else {
    await loadBatch();
  }

  byId('token-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    text(byId('access-error'), '');
    const token = safeToken(byId('token-input').value);
    byId('token-input').value = '';
    if (!token) {
      text(byId('access-error'), '授权口令格式不正确，请复制完整链接重新打开。');
      return;
    }
    try {
      await createSession(token);
    } catch (error) {
      text(byId('access-error'), error.message);
    }
  });
  byId('refresh-button').addEventListener('click', loadBatch);
  byId('leave-button').addEventListener('click', async () => {
    await jsonRequest('/authorize/logout', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    }).catch(() => {});
    window.location.replace('/authorize');
  });
  window.setInterval(() => {
    if (!document.hidden && !byId('workspace').hidden) loadBatch();
  }, 15_000);
}

function setupResultPage() {
  const parameters = new URLSearchParams(window.location.search);
  const status = parameters.get('status') || 'invalid';
  const store = /^[A-Z0-9_-]{1,24}$/.test(parameters.get('store') || '')
    ? parameters.get('store')
    : '';
  const outcomes = {
    received: {
      kicker: store ? `${store} · 授权已收到` : '授权已收到',
      title: '等待管理员核验',
      message: '服务器已完成换证和商户 ID 双重核对，凭据暂未启用。管理员还会核验店铺映射与只读权限。',
    },
    already_received: {
      kicker: '重复回跳',
      title: '这次回跳已经处理',
      message: '系统没有重复交换或覆盖凭据。回到原清单刷新状态即可。',
    },
    expired: {
      kicker: '授权超时',
      title: '请从原清单重新开始',
      message: '本次 SHEIN 授权会话已过期，旧页面不会再被接受。',
    },
    identity_check_failed: {
      kicker: '身份核验未通过',
      title: '没有启用任何凭据',
      message: '登录账号与回传商户身份存在冲突。请停止操作并联系管理员核对账号。',
    },
    retry: {
      kicker: '本次未完成',
      title: '请稍后重新授权',
      message: '服务器未能证明换证和身份回读完整成功，因此没有启用该店铺。',
    },
    busy: {
      kicker: '服务繁忙',
      title: '请从原清单稍后重试',
      message: '当前正在处理其他授权回跳。本次没有交换或启用任何凭据。',
    },
    invalid: {
      kicker: '无效回跳',
      title: '没有处理任何凭据',
      message: '回跳参数缺失、被修改或已失效。请从原清单重新进入。',
    },
  };
  const outcome = outcomes[status] || outcomes.invalid;
  text(byId('result-kicker'), outcome.kicker);
  text(byId('result-title'), outcome.title);
  text(byId('result-message'), outcome.message);
  window.history.replaceState({}, '', '/authorize/result');
}

if (document.body.dataset.page === 'result') setupResultPage();
if (document.body.dataset.page === 'batch') setupBatchPage();
