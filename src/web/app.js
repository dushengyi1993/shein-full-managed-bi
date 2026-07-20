const numberFormatter = new Intl.NumberFormat('zh-CN');
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  hour12: false,
});

const ROUTES = Object.freeze({
  home: { title: '总控驾驶舱', code: 'CONTROL' },
  sales: { title: '销量分析', code: 'SALES' },
  products: { title: '商品中心', code: 'PRODUCTS' },
  compliance: { title: '合规中心', code: 'COMPLIANCE' },
  supply: { title: '备货履约', code: 'SUPPLY' },
  inventory: { title: '库存管理', code: 'INVENTORY' },
  finance: { title: '财务对账', code: 'FINANCE' },
  ops: { title: '自动化运营', code: 'AUTOMATION' },
  system: { title: '系统健康', code: 'SYSTEM' },
});

const RANGE_META = Object.freeze({
  today: { label: '今日', note: '当日累计' },
  yesterday: { label: '昨日', note: '完整自然日' },
  last7Days: { label: '近 7 日', note: '预聚合滚动窗口' },
  last30Days: { label: '近 30 日', note: '预聚合滚动窗口' },
});

const EXPECTED_READINESS = Object.freeze([
  { key: 'applications', label: '全托应用审核', note: '需要逐店应用列表回读证据' },
  { key: 'sales_permission', label: '销量权限包', note: '需要逐店权限包审批结果' },
  { key: 'store_authorization', label: '店铺授权', note: '需要店铺授权与凭证交换证据' },
  { key: 'sales_probe', label: '接口探针', note: '以真实销量接口业务成功为准' },
  { key: 'fact_load', label: '事实入仓', note: '探针和字段对账通过后开始' },
]);

const state = {
  route: routeFromLocation(),
  range: 'today',
  query: '',
  store: 'ALL',
  data: null,
  health: null,
  healthError: '',
  loading: true,
  error: '',
};

const elements = {
  view: document.querySelector('#view'),
  navLinks: [...document.querySelectorAll('[data-route]')],
  search: document.querySelector('#global-search'),
  store: document.querySelector('#store-filter'),
  rangeButtons: [...document.querySelectorAll('[data-range]')],
  clearFilters: document.querySelector('#clear-filters'),
  datasetBadge: document.querySelector('#dataset-badge'),
  updatedAt: document.querySelector('#updated-at'),
  sidebarDataset: document.querySelector('#sidebar-dataset'),
  sidebarPermission: document.querySelector('#sidebar-permission'),
  sidebarSampleNote: document.querySelector('#sidebar-sample-note'),
  mobilePageTitle: document.querySelector('#mobile-page-title'),
  errorPanel: document.querySelector('#error-panel'),
  errorMessage: document.querySelector('#error-message'),
  retryButton: document.querySelector('#retry-button'),
};

function routeFromLocation() {
  const candidate = String(window.location.hash || '').replace(/^#/, '');
  return Object.prototype.hasOwnProperty.call(ROUTES, candidate) ? candidate : 'home';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]);
}

function isUnit(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function formatUnits(value) {
  return isUnit(value) ? numberFormatter.format(value) : '—';
}

function formatDateTime(value) {
  if (!value) return '暂无有效销量快照';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '更新时间待确认' : dateTimeFormatter.format(date);
}

function datasetStatus() {
  const status = state.data?.dataset?.status;
  return ['live', 'sample', 'empty'].includes(status) ? status : 'neutral';
}

function datasetLabel() {
  return state.data?.dataset?.label || '数据状态待确认';
}

function sourceLabel() {
  return datasetStatus() === 'sample' ? '示例数据' : datasetLabel();
}

function sourceChip() {
  return `<span class="source-chip ${escapeHtml(datasetStatus())}">${escapeHtml(sourceLabel())}</span>`;
}

function sampleNotice() {
  if (datasetStatus() !== 'sample') return '';
  return `
    <aside class="dataset-notice" aria-label="示例数据提示">
      <strong>示例数据环境</strong>
      <span>本页销量数字仅用于验证界面、筛选和接入流程，不代表任何店铺的真实经营结果。</span>
    </aside>`;
}

function readinessStages() {
  const incoming = Array.isArray(state.data?.readiness) ? state.data.readiness : [];
  const byKey = new Map(incoming.map((stage) => [stage.key, stage]));
  const knownKeys = new Set(EXPECTED_READINESS.map((stage) => stage.key));
  const expected = EXPECTED_READINESS.map((stage) => {
    const provided = byKey.get(stage.key);
    return provided || {
      ...stage,
      status: 'unknown',
      statusLabel: '待确认',
      completed: null,
      total: null,
    };
  });
  const extra = incoming.filter((stage) => !knownKeys.has(stage.key));
  return [...expected, ...extra];
}

function readinessClass(status) {
  return ['complete', 'pending', 'not_started', 'blocked'].includes(status)
    ? status.replace('_', '-')
    : 'unknown';
}

function readinessCount(stage) {
  return isUnit(stage?.completed) && isUnit(stage?.total)
    ? `${numberFormatter.format(stage.completed)} / ${numberFormatter.format(stage.total)}`
    : '证据待接入';
}

function activeReadinessStage() {
  const stages = readinessStages();
  return stages.find((stage) => stage.status !== 'complete') || stages.at(-1);
}

function normalizedQuery() {
  return state.query.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function allStores() {
  return Array.isArray(state.data?.storeRanking) ? state.data.storeRanking : [];
}

function allSkus() {
  return Array.isArray(state.data?.skuRanking) ? state.data.skuRanking : [];
}

function selectedStore() {
  return state.store === 'ALL'
    ? null
    : allStores().find((store) => store.code === state.store) || null;
}

function matchingSkus() {
  const query = normalizedQuery();
  if (!query) return allSkus();
  return allSkus().filter((item) => {
    const haystack = `${item.sku || ''} ${item.name || ''}`
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN');
    return haystack.includes(query);
  });
}

function sumCompleteWindow(items, key) {
  if (!items.length) return null;
  const values = items.map((item) => item?.unitsSold?.[key]);
  if (values.some((value) => !isUnit(value))) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function scopedUnits() {
  const store = selectedStore();
  const query = normalizedQuery();

  if (store && query) {
    return {
      units: {},
      title: '店铺 × SKU 交叉维度未接入',
      note: '当前接口分别提供店铺汇总和 SKU 汇总，不能拼接成组合事实。',
    };
  }

  if (store) {
    return {
      units: store.unitsSold || {},
      title: `${store.name || store.code} 店铺汇总`,
      note: '分店快照不含昨日字段；缺失值保持空白。',
    };
  }

  if (query) {
    const rows = matchingSkus();
    return {
      units: {
        today: sumCompleteWindow(rows, 'today'),
        last7Days: sumCompleteWindow(rows, 'last7Days'),
        last30Days: sumCompleteWindow(rows, 'last30Days'),
      },
      title: '当前可见 SKU 清单合计',
      note: rows.length
        ? '仅合计接口返回且命中搜索的 SKU 行，不扩展为完整商品盘。'
        : '当前接口返回的 SKU 清单中没有匹配项。',
    };
  }

  return {
    units: state.data?.unitsSold || {},
    title: '全部店铺销量汇总',
    note: '来自只读 API 的预聚合销量数量。',
  };
}

function rowWindowSupported() {
  return state.range !== 'yesterday';
}

function sortBySelectedRange(items) {
  if (!rowWindowSupported()) return [];
  return [...items].sort((left, right) => {
    const leftValue = left?.unitsSold?.[state.range];
    const rightValue = right?.unitsSold?.[state.range];
    const normalizedLeft = isUnit(leftValue) ? leftValue : -1;
    const normalizedRight = isUnit(rightValue) ? rightValue : -1;
    return normalizedRight - normalizedLeft;
  });
}

function storeRowsForView() {
  if (normalizedQuery()) return [];
  const rows = selectedStore() ? [selectedStore()] : allStores();
  return sortBySelectedRange(rows);
}

function skuRowsForView() {
  if (selectedStore()) return [];
  return sortBySelectedRange(matchingSkus());
}

function storeRowsForTable() {
  if (normalizedQuery()) return [];
  const rows = selectedStore() ? [selectedStore()] : allStores();
  return rowWindowSupported() ? sortBySelectedRange(rows) : rows;
}

function skuRowsForTable() {
  if (selectedStore()) return [];
  const rows = matchingSkus();
  return rowWindowSupported() ? sortBySelectedRange(rows) : rows;
}

function dimensionBoundary(kind) {
  if (!rowWindowSupported()) {
    return `当前 API 未提供分${kind === 'store' ? '店' : ' SKU'}昨日销量；不会用其他窗口替代。`;
  }
  if (kind === 'store' && normalizedQuery()) {
    return 'SKU 搜索已生效，但当前 API 没有 SKU 到店铺的交叉事实，因此店铺视图暂停展示。';
  }
  if (kind === 'sku' && selectedStore()) {
    return '店铺筛选已生效，但当前 API 没有店铺到 SKU 的交叉事实，因此 SKU 视图暂停展示。';
  }
  return kind === 'store' ? '暂无符合筛选条件的店铺销量数据。' : '暂无符合筛选条件的 SKU 销量数据。';
}

function trendRowsForRange() {
  const rows = Array.isArray(state.data?.salesTrend) ? state.data.salesTrend : [];
  if (selectedStore() || normalizedQuery()) return [];
  if (state.range === 'today') return rows.slice(-1);
  if (state.range === 'yesterday') return rows.slice(-2, -1);
  if (state.range === 'last7Days') return rows.slice(-7);
  return rows.slice(-30);
}

function trendEmptyMessage() {
  if (selectedStore() || normalizedQuery()) {
    return '日趋势当前只有全局序列，不能按店铺或 SKU 切片；已停止展示，避免把全局走势冒充筛选结果。';
  }
  const rows = trendRowsForRange();
  if (rows.length < 2) {
    return `${RANGE_META[state.range].label}口径不足两个日粒度点，无法形成趋势。`;
  }
  return 'API 尚未提供可用的日粒度销量序列。';
}

function renderTrendChart() {
  const rows = trendRowsForRange();
  if (rows.length < 2 || rows.some((row) => !isUnit(row.unitsSold))) {
    return emptyEvidence('销量趋势暂不可画', trendEmptyMessage());
  }

  const width = 720;
  const height = 250;
  const left = 42;
  const right = 22;
  const top = 24;
  const bottom = 42;
  const values = rows.map((row) => row.unitsSold);
  const maximum = Math.max(...values, 1);
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const points = rows.map((row, index) => {
    const x = left + (innerWidth * index) / (rows.length - 1);
    const y = top + innerHeight - (row.unitsSold / maximum) * innerHeight;
    return { ...row, x, y };
  });
  const pointString = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const areaPoints = `${left},${top + innerHeight} ${pointString} ${left + innerWidth},${top + innerHeight}`;
  const lastPoint = points.at(-1);
  const ariaLabel = `${RANGE_META[state.range].label}销量趋势，${rows[0].date} 至 ${lastPoint.date}`;

  return `
    <div class="trend-chart">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(ariaLabel)}">
        <title>${escapeHtml(ariaLabel)}</title>
        <line class="chart-grid" x1="${left}" y1="${top}" x2="${left + innerWidth}" y2="${top}"></line>
        <line class="chart-grid" x1="${left}" y1="${top + innerHeight / 2}" x2="${left + innerWidth}" y2="${top + innerHeight / 2}"></line>
        <line class="chart-grid" x1="${left}" y1="${top + innerHeight}" x2="${left + innerWidth}" y2="${top + innerHeight}"></line>
        <polygon class="chart-area" points="${areaPoints}"></polygon>
        <polyline class="chart-line" points="${pointString}"></polyline>
        <circle class="chart-point" cx="${lastPoint.x}" cy="${lastPoint.y}" r="5"></circle>
        <text class="chart-axis" x="${left}" y="${height - 12}">${escapeHtml(rows[0].date.slice(5))}</text>
        <text class="chart-axis chart-axis-end" x="${left + innerWidth}" y="${height - 12}">${escapeHtml(lastPoint.date.slice(5))}</text>
        <text class="chart-axis" x="${left}" y="${top - 8}">${escapeHtml(numberFormatter.format(maximum))} 件</text>
        <text class="chart-value" x="${lastPoint.x - 8}" y="${Math.max(lastPoint.y - 13, 15)}">${escapeHtml(numberFormatter.format(lastPoint.unitsSold))}</text>
      </svg>
    </div>`;
}

function emptyEvidence(title, message, action = '') {
  return `
    <div class="evidence-empty">
      <span class="empty-mark" aria-hidden="true">—</span>
      <div>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(message)}</p>
        ${action ? `<span>${escapeHtml(action)}</span>` : ''}
      </div>
    </div>`;
}

function pageIntro(kicker, title, description, aside = '') {
  return `
    <header class="page-intro">
      <div>
        <span class="eyebrow">${escapeHtml(kicker)}</span>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(description)}</p>
      </div>
      ${aside ? `<div class="intro-aside">${aside}</div>` : ''}
    </header>`;
}

function panelHeading(kicker, title, note = '') {
  return `
    <header class="panel-heading">
      <div><span>${escapeHtml(kicker)}</span><h2>${escapeHtml(title)}</h2></div>
      ${note ? `<p>${escapeHtml(note)}</p>` : ''}
    </header>`;
}

function filterSummary() {
  const store = selectedStore();
  const query = state.query.trim();
  return [
    RANGE_META[state.range].label,
    store ? `店铺：${store.name || store.code}` : '全部店铺',
    query ? `搜索：${query}` : '全部 SKU',
  ].join(' · ');
}

function metricStrip() {
  const scope = scopedUnits();
  const cards = Object.entries(RANGE_META).map(([key, meta]) => `
    <article class="metric-item ${state.range === key ? 'active' : ''}">
      <div><span>${escapeHtml(meta.label)}销量</span>${sourceChip()}</div>
      <strong>${formatUnits(scope.units[key])}</strong>
      <p>${escapeHtml(meta.note)} · 单位：件</p>
    </article>`).join('');
  return `
    <section class="metric-panel" aria-label="销量数量指标">
      <header>
        <div><span>销量规模</span><strong>${escapeHtml(scope.title)}</strong></div>
        <p>${escapeHtml(scope.note)}</p>
      </header>
      <div class="metric-grid">${cards}</div>
    </section>`;
}

function readinessStrip() {
  return `
    <section class="readiness-panel">
      ${panelHeading('ACCESS READINESS', '接入阶段', '五个阶段分别取证，不把应用审核等同于销量可读')}
      <ol class="readiness-list">
        ${readinessStages().map((stage, index) => `
          <li class="${readinessClass(stage.status)}">
            <span class="stage-index">${String(index + 1).padStart(2, '0')}</span>
            <div><strong>${escapeHtml(stage.label)}</strong><p>${escapeHtml(stage.note || '当前阶段暂无说明')}</p></div>
            <div class="stage-state"><span>${escapeHtml(stage.statusLabel || '待确认')}</span><small>${escapeHtml(readinessCount(stage))}</small></div>
          </li>`).join('')}
      </ol>
    </section>`;
}

function topEntity(items, kind) {
  if (!items.length) return null;
  const first = items[0];
  const value = first?.unitsSold?.[state.range];
  if (!isUnit(value)) return null;
  return {
    name: kind === 'store' ? (first.name || first.code) : first.sku,
    detail: kind === 'store' ? first.code : first.name,
    value,
  };
}

function attentionSummary() {
  const store = topEntity(storeRowsForView(), 'store');
  const sku = topEntity(skuRowsForView(), 'sku');
  const stage = activeReadinessStage();
  const cards = [
    {
      label: `店铺关注 · ${RANGE_META[state.range].label}`,
      value: store ? store.name : '暂无可比结果',
      detail: store ? `${formatUnits(store.value)} 件 · ${store.detail}` : dimensionBoundary('store'),
      tone: 'accent',
    },
    {
      label: `SKU 关注 · ${RANGE_META[state.range].label}`,
      value: sku ? sku.name : '暂无可比结果',
      detail: sku ? `${formatUnits(sku.value)} 件 · ${sku.detail}` : dimensionBoundary('sku'),
      tone: '',
    },
    {
      label: '当前接入关注',
      value: stage?.label || '接入阶段待确认',
      detail: stage ? `${stage.statusLabel || '待确认'} · ${stage.note || '等待运行证据'}` : 'readiness 字段尚未接入',
      tone: stage?.status === 'blocked' ? 'danger' : 'warning',
    },
  ];
  return `
    <section>
      ${panelHeading('ATTENTION', '今天先看什么', '只列当前筛选可证明的销量与阻断点')}
      <div class="attention-grid">
        ${cards.map((card) => `
          <article class="attention-card ${card.tone}">
            <span>${escapeHtml(card.label)}</span>
            <strong>${escapeHtml(card.value)}</strong>
            <p>${escapeHtml(card.detail)}</p>
          </article>`).join('')}
      </div>
    </section>`;
}

function compactRanking(items, kind) {
  if (!items.length) return emptyEvidence(
    kind === 'store' ? '店铺排行不可用' : 'SKU 排行不可用',
    dimensionBoundary(kind),
  );
  return `
    <ol class="compact-ranking">
      ${items.slice(0, 5).map((item, index) => `
        <li>
          <span>${String(index + 1).padStart(2, '0')}</span>
          <div><strong>${escapeHtml(kind === 'store' ? (item.name || item.code) : item.sku)}</strong><small>${escapeHtml(kind === 'store' ? item.code : item.name)}</small></div>
          <b>${formatUnits(item?.unitsSold?.[state.range])}<small>件</small></b>
        </li>`).join('')}
    </ol>`;
}

function businessMap() {
  const domains = [
    ['sales', '销量分析', '销量数量已接入', 'available'],
    ['products', '商品中心', 'SKU 销量清单可读；商品主数据待探针', 'partial'],
    ['compliance', '合规中心', '等待合规列表、证书与风险事实', 'pending'],
    ['supply', '备货履约', '等待采购单、备货单与到货事实', 'pending'],
    ['inventory', '库存管理', '等待实际库存与仓库口径', 'pending'],
    ['finance', '财务对账', '等待结算、费用与回款事实', 'pending'],
    ['ops', '自动化运营', '只读建议；写动作保持关闭', 'locked'],
  ];
  return `
    <section class="domain-section">
      ${panelHeading('BUSINESS MAP', '业务入口', '明细和接入条件下沉到各业务页')}
      <div class="domain-grid">
        ${domains.map(([route, title, detail, status]) => `
          <a href="#${route}" class="domain-card ${status}">
            <span>${escapeHtml(ROUTES[route].code)}</span>
            <strong>${escapeHtml(title)}</strong>
            <p>${escapeHtml(detail)}</p>
            <b>进入业务页 <span aria-hidden="true">→</span></b>
          </a>`).join('')}
      </div>
    </section>`;
}

function renderHome() {
  const activeStage = activeReadinessStage();
  const heroStatus = activeStage
    ? `${activeStage.label} · ${activeStage.statusLabel || '待确认'}`
    : '接入状态待确认';
  return `
    ${sampleNotice()}
    ${pageIntro(
      'FULL-MANAGED CONTROL',
      '全托运营总控',
      '先判断数据能不能看、接入卡在哪里，再进入业务域处理明细。首页只放总控信号。',
      `<span>当前接入关注</span><strong>${escapeHtml(heroStatus)}</strong><small>${escapeHtml(filterSummary())}</small>`,
    )}
    ${readinessStrip()}
    ${metricStrip()}
    ${attentionSummary()}
    <section class="home-analysis-grid">
      <article class="panel trend-panel">
        ${panelHeading('SALES TREND', '销量趋势', `${RANGE_META[state.range].label} · 全局日粒度`)}
        ${renderTrendChart()}
      </article>
      <article class="panel">
        ${panelHeading('STORE TOP', '店铺销量 Top', RANGE_META[state.range].label)}
        ${compactRanking(storeRowsForView(), 'store')}
        <a class="text-link" href="#sales">查看完整店铺表 →</a>
      </article>
      <article class="panel">
        ${panelHeading('SKU TOP', 'SKU 销量 Top', RANGE_META[state.range].label)}
        ${compactRanking(skuRowsForView(), 'sku')}
        <a class="text-link" href="#sales">查看完整 SKU 表 →</a>
      </article>
    </section>
    ${businessMap()}`;
}

function permissionBadge(permission) {
  const status = permission?.status || 'unknown';
  return `<span class="row-status ${escapeHtml(status)}">${escapeHtml(permission?.label || '权限待确认')}</span>`;
}

function salesTable(kind) {
  const isStore = kind === 'store';
  const rows = isStore ? storeRowsForTable() : skuRowsForTable();
  if (!rows.length) return emptyEvidence(
    isStore ? '店铺销量表暂无可用行' : 'SKU 销量表暂无可用行',
    dimensionBoundary(kind),
  );

  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th scope="col">序号</th>
            <th scope="col">${isStore ? '店铺' : 'SKU / 商品'}</th>
            ${isStore ? '<th scope="col">销量权限</th>' : '<th scope="col">数据边界</th>'}
            <th scope="col" class="number-column ${state.range === 'today' ? 'selected-column' : ''}">今日</th>
            <th scope="col" class="number-column ${state.range === 'yesterday' ? 'selected-column' : ''}">昨日*</th>
            <th scope="col" class="number-column ${state.range === 'last7Days' ? 'selected-column' : ''}">近 7 日</th>
            <th scope="col" class="number-column ${state.range === 'last30Days' ? 'selected-column' : ''}">近 30 日</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((item, index) => `
            <tr>
              <td class="row-index">${String(index + 1).padStart(2, '0')}</td>
              <td class="entity-column"><strong>${escapeHtml(isStore ? (item.name || item.code) : item.sku)}</strong><span>${escapeHtml(isStore ? item.code : item.name)}</span></td>
              <td>${isStore ? permissionBadge(item.permission) : '<span class="row-status partial">销量数量清单</span>'}</td>
              <td class="number-column ${state.range === 'today' ? 'selected-column' : ''}">${formatUnits(item?.unitsSold?.today)}</td>
              <td class="number-column missing-value ${state.range === 'yesterday' ? 'selected-column' : ''}">—</td>
              <td class="number-column ${state.range === 'last7Days' ? 'selected-column' : ''}">${formatUnits(item?.unitsSold?.last7Days)}</td>
              <td class="number-column ${state.range === 'last30Days' ? 'selected-column' : ''}">${formatUnits(item?.unitsSold?.last30Days)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="table-note">* 当前店铺与 SKU 行没有昨日字段；破折号表示未知，不表示销量为 0。排行按当前选择窗口重排。</p>`;
}

function renderSales() {
  const scope = scopedUnits();
  const focusValue = scope.units[state.range];
  return `
    ${sampleNotice()}
    ${pageIntro(
      'SALES ANALYSIS',
      '销量分析',
      '比较当前预聚合窗口内的店铺和 SKU 销量数量。筛选只作用于 API 能证明的维度。',
      `<span>当前口径</span><strong>${escapeHtml(RANGE_META[state.range].label)}</strong><small>${escapeHtml(filterSummary())}</small>`,
    )}
    <section class="focus-strip">
      <div><span>当前筛选销量</span><strong>${formatUnits(focusValue)} <small>件</small></strong></div>
      <p><b>${escapeHtml(scope.title)}</b>${escapeHtml(scope.note)}</p>
      ${sourceChip()}
    </section>
    <section class="table-section">
      ${panelHeading('STORE DETAIL', '完整店铺销量表', '当前筛选可用的全部店铺行')}
      ${salesTable('store')}
    </section>
    <section class="table-section">
      ${panelHeading('SKU DETAIL', '完整 SKU 销量表', '当前接口返回且命中筛选的全部 SKU 行')}
      ${salesTable('sku')}
    </section>`;
}

function productRows() {
  if (selectedStore()) return [];
  return matchingSkus();
}

function renderProducts() {
  const rows = productRows();
  return `
    ${sampleNotice()}
    ${pageIntro(
      'PRODUCT IDENTITY',
      '商品中心',
      '先看哪些 SKU 已出现在销量清单，再补齐全托商品身份、标准货号和销量键映射。',
      '<span>商品主数据</span><strong>等待 number-list 探针</strong><small>当前仅有 SKU 销量清单</small>',
    )}
    <section class="process-panel">
      ${panelHeading('MAPPING FLOW', '商品身份映射流程', '每一步都需要可回读证据')}
      <ol class="process-flow four-steps">
        <li><span>01</span><div><strong>商品列表探针</strong><p>读取全托 number-list 或等价商品清单。</p></div><b>待接入</b></li>
        <li><span>02</span><div><strong>标准身份归一</strong><p>分离 SKU、SKC、标准货号与商品名，不靠字符串猜测。</p></div><b>待接入</b></li>
        <li><span>03</span><div><strong>销量键映射</strong><p>把销量接口键与商品主数据逐项对账。</p></div><b>待接入</b></li>
        <li><span>04</span><div><strong>入仓与回读</strong><p>记录来源、快照时间和无法映射的原因。</p></div><b>待接入</b></li>
      </ol>
    </section>
    <section class="table-section">
      ${panelHeading('SKU REGISTER', 'SKU 销量清单', `${RANGE_META[state.range].label} · 商品映射状态不伪造`)}
      ${rows.length ? `
        <div class="table-wrap">
          <table class="data-table product-table">
            <thead><tr><th scope="col">SKU</th><th scope="col">商品名</th><th scope="col">当前窗口销量</th><th scope="col">商品身份</th><th scope="col">下一步</th></tr></thead>
            <tbody>${rows.map((item) => `
              <tr>
                <td class="entity-column"><strong>${escapeHtml(item.sku)}</strong></td>
                <td>${escapeHtml(item.name)}</td>
                <td class="number-column">${formatUnits(item?.unitsSold?.[state.range])}</td>
                <td><span class="row-status pending">尚未验证</span></td>
                <td class="boundary-cell">完成商品列表探针后映射</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        <p class="table-note">当前窗口销量仅来自销量清单；“尚未验证”不是缺失商品，也不等于映射失败。</p>` : emptyEvidence(
          'SKU 清单暂无可用行',
          selectedStore()
            ? '当前接口没有店铺到 SKU 的交叉事实；清除店铺筛选后可查看全局 SKU 清单。'
            : '当前 API 没有返回命中搜索的 SKU。',
        )}
    </section>`;
}

function integrationGate({ kicker, title, description, evidence, boundary, futureFields }) {
  return `
    <section class="integration-gate">
      <div class="gate-state">
        <span>${escapeHtml(kicker)}</span>
        <strong>事实未接入</strong>
        <p>${escapeHtml(description)}</p>
      </div>
      <div class="gate-detail">
        <h2>${escapeHtml(title)}</h2>
        <ol>
          ${evidence.map((item) => `<li><span aria-hidden="true"></span><p>${escapeHtml(item)}</p><b>待证据</b></li>`).join('')}
        </ol>
      </div>
      <aside class="boundary-note">
        <strong>当前展示边界</strong>
        <p>${escapeHtml(boundary)}</p>
        <span>接入后字段：${escapeHtml(futureFields)}</span>
      </aside>
    </section>`;
}

function renderCompliance() {
  return `
    ${sampleNotice()}
    ${pageIntro(
      'PRODUCT COMPLIANCE',
      '合规中心',
      '查看商品资料、证书和平台审核风险的入口已就位，但当前没有合规事实。',
      '<span>写动作</span><strong>保持关闭</strong><small>无合规事实、无预演、无确认</small>',
    )}
    ${integrationGate({
      kicker: 'COMPLIANCE DATA',
      title: '合规域接入条件',
      description: '不把“没有数据”显示成零风险，也不根据商品名猜证书状态。',
      evidence: [
        '逐店回读“商品合规”业务权限与店铺授权状态',
        '真实探针合规列表、合规详情和证书资料接口',
        '确认商品键、证书类型、审核状态、原因与更新时间字段',
        '隔离入仓并对照平台页面完成样本回读',
        '写操作另行通过权限、dry-run、确认、审计和结果回读',
      ],
      boundary: '当前页面只说明接入路径。风险商品数、缺证数、审核通过率均未知，因此不展示任何数值。',
      futureFields: '商品身份、资料类型、审核状态、原因、有效期、更新时间',
    })}`;
}

function demandSignal(kind) {
  const rows = skuRowsForView();
  if (!rows.length) {
    return emptyEvidence('销量需求信号不可用', dimensionBoundary('sku'));
  }
  return `
    <ol class="signal-list">
      ${rows.slice(0, 6).map((item, index) => `
        <li><span>${String(index + 1).padStart(2, '0')}</span><div><strong>${escapeHtml(item.sku)}</strong><small>${escapeHtml(item.name)}</small></div><b>${formatUnits(item?.unitsSold?.[state.range])}<small> 件</small></b></li>`).join('')}
    </ol>
    <p class="table-note">这是${escapeHtml(RANGE_META[state.range].label)}销量信号，不是${kind === 'inventory' ? '实际库存、可售天数或补货量' : '采购建议、备货单或到货承诺'}。</p>`;
}

function renderSupply() {
  return `
    ${sampleNotice()}
    ${pageIntro(
      'FULFILMENT',
      '备货履约',
      '销量可作为需求信号，但采购、备货、到货和异常必须来自真实单据事实。',
      '<span>履约事实</span><strong>尚未接入</strong><small>不从销量反推采购单状态</small>',
    )}
    <div class="split-grid">
      <section class="panel">
        ${panelHeading('DEMAND SIGNAL', '销量需求信号', RANGE_META[state.range].label)}
        ${demandSignal('supply')}
      </section>
      <section class="panel condition-panel">
        ${panelHeading('REQUIRED EVIDENCE', '履约接入条件', '全部满足后才展示任务')}
        <ul class="condition-list">
          <li><strong>权限与授权</strong><span>备货管理业务权限、店铺凭证可用</span></li>
          <li><strong>采购单探针</strong><span>列表、详情、状态和平台单号可回读</span></li>
          <li><strong>备货与到货</strong><span>数量、节点时间、异常原因有明确来源</span></li>
          <li><strong>商品映射</strong><span>单据商品键与标准 SKU / SKC 对账</span></li>
        </ul>
      </section>
    </div>
    <section class="wide-empty-section">
      ${emptyEvidence('暂无备货履约任务', '采购单、备货单和到货事实尚未接入；未知状态不会显示为 0 或“已完成”。', '接入后在此展示待备货、运输中、已到货和异常单据。')}
    </section>`;
}

function renderInventory() {
  return `
    ${sampleNotice()}
    ${pageIntro(
      'INVENTORY',
      '库存管理',
      '把销量速度与平台实际库存并列核对；在库存事实接入前，不计算可售天数和补货量。',
      '<span>库存事实</span><strong>尚未接入</strong><small>未知不等于零库存</small>',
    )}
    <div class="split-grid">
      <section class="panel">
        ${panelHeading('SALES VELOCITY', '销量速度信号', RANGE_META[state.range].label)}
        ${demandSignal('inventory')}
      </section>
      <section class="panel condition-panel">
        ${panelHeading('INVENTORY GATE', '库存接入条件', '读权限和写权限分开验证')}
        <ul class="condition-list">
          <li><strong>库存查询探针</strong><span>店铺、仓库、SKU、库存类型和快照时间</span></li>
          <li><strong>口径核对</strong><span>实际、可用、锁定、在途数量不能混用</span></li>
          <li><strong>商品与仓库映射</strong><span>仓库编码和商品键需要平台回读</span></li>
          <li><strong>更新能力隔离</strong><span>库存写权限不因读接口成功自动开启</span></li>
        </ul>
      </section>
    </div>
    <section class="wide-empty-section">
      ${emptyEvidence('暂无库存明细', '当前没有实际库存、可用库存、锁定库存或在途库存事实，因此不展示库存数和可售天数。', '完成库存查询探针、字段对账与入仓后开放明细。')}
    </section>`;
}

function renderFinance() {
  return `
    ${sampleNotice()}
    ${pageIntro(
      'RECONCILIATION',
      '财务对账',
      '平台结算、费用、回款、成本和利润必须来自可追溯的财务事实与会计期间。',
      '<span>金额事实</span><strong>完全未接入</strong><small>本页不显示示例金额</small>',
    )}
    ${integrationGate({
      kicker: 'FINANCE DATA',
      title: '财务域接入条件',
      description: '只有销量件数不能推导收入、结算、费用或利润。',
      evidence: [
        '回读财务管理业务权限、店铺授权与只读接口范围',
        '探针报账单、结算单、费用明细与回款记录',
        '确认会计期间、币种、税费、调整项和平台单号口径',
        '建立逐单对账键并保留原始凭证与快照时间',
        '与平台页面抽样核验后才开放差异和汇总视图',
      ],
      boundary: '当前没有金额、订单、结算、成本、费用、回款或利润事实。本页不会显示 0、占位金额或由销量推导的估算值。',
      futureFields: '会计期间、结算单号、币种、应收、费用、调整、实收、差异、凭证',
    })}`;
}

function renderOps() {
  const lifecycle = [
    ['识别对象与建议', '读取销量信号，锁定店铺、SKU 和动作意图。'],
    ['权限与资料检查', '核验业务权限、店铺授权、字段和必备资料。'],
    ['dry-run 预演', '生成不可变的预演结果和 payload 摘要，不提交。'],
    ['明确确认', '由有权限的人确认对象、影响范围和预演哈希。'],
    ['受控提交', '仅允许白名单写接口、最小范围和幂等保护。'],
    ['审计与回读', '保存响应、逐项回读平台结果并标记差异。'],
  ];
  return `
    ${sampleNotice()}
    ${pageIntro(
      'CONTROLLED AUTOMATION',
      '自动化运营',
      '首版只展示建议与受控生命周期。写动作没有满足门禁，全部保持禁用。',
      '<span>执行能力</span><strong>只读建议</strong><small>没有可用写 API</small>',
    )}
    <section class="automation-panel">
      ${panelHeading('SIX-STEP CONTROL', '六步受控生命周期', '权限、预演、确认、审计、回读缺一不可')}
      <ol class="automation-flow">
        ${lifecycle.map(([title, note], index) => `
          <li class="${index === 0 ? 'current' : 'locked'}">
            <span>${String(index + 1).padStart(2, '0')}</span>
            <div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(note)}</p></div>
            <b>${index === 0 ? '只读可用' : '未开放'}</b>
          </li>`).join('')}
      </ol>
    </section>
    <div class="split-grid ops-gates">
      <section class="panel condition-panel">
        ${panelHeading('CAPABILITY GATES', '能力门禁', '当前运行态')}
        <ul class="condition-list">
          <li><strong>销量读取</strong><span class="state-text available">只读可用</span></li>
          <li><strong>商品 / 合规 / 备货 / 库存 / 财务事实</strong><span class="state-text pending">待接入</span></li>
          <li><strong>写权限</strong><span class="state-text locked">未验证</span></li>
          <li><strong>dry-run 与审计执行器</strong><span class="state-text locked">未接入</span></li>
        </ul>
      </section>
      <section class="panel action-lock">
        <span>WRITE ACTIONS</span>
        <strong>写动作已关闭</strong>
        <p>当前页面不会发出提交请求。只有服务端提供白名单执行器并通过六步门禁后，才会逐项开放。</p>
        <div><button type="button" disabled>生成预演</button><button type="button" disabled>确认并提交</button></div>
      </section>
    </div>`;
}

function datasetOverview() {
  const permission = state.data?.permission || {};
  const permissionCount = isUnit(permission.authorizedStores) && isUnit(permission.totalStores)
    ? `${numberFormatter.format(permission.authorizedStores)} / ${numberFormatter.format(permission.totalStores)} 家店铺`
    : '店铺范围待确认';
  const healthOk = state.health?.status === 'ok';
  const runtimeLabel = healthOk ? '本地服务响应正常' : '未取得 /health 运行态';
  const runtimeNote = healthOk
    ? `${state.health.service || 'full-managed-bi-local'} · ${state.health.readOnly === true ? '只读' : '模式待确认'}`
    : (state.healthError || '运行态接口尚未返回');
  const dataTone = datasetStatus() === 'live' ? 'complete' : datasetStatus() === 'sample' ? 'pending' : 'unknown';
  const permissionTone = permission.status === 'granted'
    ? 'complete'
    : permission.status === 'denied'
      ? 'blocked'
      : permission.status || 'unknown';
  const cards = [
    ['销量数据集', datasetLabel(), state.data?.updatedAt ? `快照：${formatDateTime(state.data.updatedAt)}` : '暂无有效快照', dataTone],
    ['销量权限', permission.label || '权限待确认', permissionCount, permissionTone],
    ['接口模式', state.data?.readOnly === true ? '只读白名单' : '模式待确认', `schema v${isUnit(state.data?.schemaVersion) ? state.data.schemaVersion : '—'}`, state.data?.readOnly === true ? 'complete' : 'unknown'],
    ['本地运行态', runtimeLabel, runtimeNote, healthOk ? 'complete' : 'unknown'],
  ];
  return `
    <div class="system-overview">
      ${cards.map(([label, value, note, status]) => `
        <article class="system-card ${readinessClass(status)}">
          <span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p>${escapeHtml(note)}</p>
        </article>`).join('')}
    </div>`;
}

function readinessTable() {
  return `
    <div class="table-wrap">
      <table class="data-table readiness-table">
        <thead><tr><th scope="col">阶段</th><th scope="col">运行态</th><th scope="col">证据范围</th><th scope="col">说明</th></tr></thead>
        <tbody>${readinessStages().map((stage) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(stage.label)}</strong><span>${escapeHtml(stage.key)}</span></td>
            <td><span class="row-status ${readinessClass(stage.status)}">${escapeHtml(stage.statusLabel || '待确认')}</span></td>
            <td>${escapeHtml(readinessCount(stage))}</td>
            <td class="boundary-cell">${escapeHtml(stage.note || '暂无运行证据')}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function renderSystem() {
  return `
    ${sampleNotice()}
    ${pageIntro(
      'SYSTEM HEALTH',
      '系统健康',
      '把数据集、权限、接口探针、事实入仓和本地运行态分开判断。',
      `<span>API schema</span><strong>v${isUnit(state.data?.schemaVersion) ? state.data.schemaVersion : '—'}</strong><small>/api/dashboard · GET only</small>`,
    )}
    ${datasetOverview()}
    <section class="table-section">
      ${panelHeading('READINESS LEDGER', '五阶段接入台账', '数量未知时显示“证据待接入”，不补零')}
      ${readinessTable()}
    </section>
    <section class="capability-section">
      ${panelHeading('DATA CAPABILITIES', '数据与动作能力', '以当前页面实际消费的字段为准')}
      <div class="capability-grid">
        <article class="available"><span>销量数量</span><strong>可读取</strong><p>总量、店铺排行、SKU 排行；可选日趋势。</p></article>
        <article class="partial"><span>商品身份</span><strong>部分可见</strong><p>SKU 销量清单可读，完整商品主数据待探针。</p></article>
        <article class="pending"><span>合规 / 履约 / 库存</span><strong>未接入</strong><p>没有业务事实，不显示风险数、任务数或库存数。</p></article>
        <article class="pending"><span>财务事实</span><strong>未接入</strong><p>没有金额、订单、结算、成本或利润字段。</p></article>
        <article class="locked"><span>自动化写动作</span><strong>关闭</strong><p>当前服务仅允许 GET / HEAD，只读边界保持生效。</p></article>
      </div>
    </section>`;
}

function renderRoute() {
  const renderers = {
    home: renderHome,
    sales: renderSales,
    products: renderProducts,
    compliance: renderCompliance,
    supply: renderSupply,
    inventory: renderInventory,
    finance: renderFinance,
    ops: renderOps,
    system: renderSystem,
  };
  return renderers[state.route]();
}

function renderLoading() {
  return `
    <section class="loading-shell" role="status">
      <span class="loading-line wide"></span>
      <span class="loading-line"></span>
      <div class="loading-grid"><span></span><span></span><span></span><span></span></div>
      <p>正在读取全托销量与接入状态…</p>
    </section>`;
}

function renderUnavailable() {
  return `
    <section class="page-intro unavailable-page">
      <div><span class="eyebrow">DATA UNAVAILABLE</span><h1>暂时无法读取运营数据</h1><p>错误已显示在首屏。修复本地数据服务后重新加载，不会使用旧快照或占位数冒充结果。</p></div>
    </section>`;
}

function updateNavigation() {
  elements.navLinks.forEach((link) => {
    const active = link.dataset.route === state.route;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  const route = ROUTES[state.route];
  elements.mobilePageTitle.textContent = route.title;
  document.title = `${route.title} · SHEIN 全托运营工作台`;
}

function updateFilters() {
  elements.search.value = state.query;
  elements.store.value = state.store;
  elements.rangeButtons.forEach((button) => {
    const active = button.dataset.range === state.range;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const hasFilters = Boolean(state.query.trim()) || state.store !== 'ALL' || state.range !== 'today';
  elements.clearFilters.disabled = !hasFilters;
}

function updateDatasetChrome() {
  if (!state.data) {
    elements.datasetBadge.textContent = state.loading ? '正在读取' : '数据不可用';
    elements.datasetBadge.className = `status-badge ${state.loading ? 'neutral' : 'error'}`;
    elements.updatedAt.textContent = state.loading ? '更新时间：--' : '更新时间：读取失败';
    elements.sidebarDataset.textContent = state.loading ? '正在读取' : '数据不可用';
    elements.sidebarPermission.textContent = '销量权限待确认';
    elements.sidebarSampleNote.hidden = true;
    delete document.body.dataset.dataset;
    return;
  }

  const status = datasetStatus();
  elements.datasetBadge.textContent = datasetLabel();
  elements.datasetBadge.className = `status-badge ${status}`;
  elements.updatedAt.textContent = `更新时间：${formatDateTime(state.data.updatedAt)}`;
  elements.sidebarDataset.textContent = datasetLabel();
  elements.sidebarPermission.textContent = state.data.permission?.label || '销量权限待确认';
  elements.sidebarSampleNote.hidden = status !== 'sample';
  document.body.dataset.dataset = status;
}

function updateErrorPanel() {
  elements.errorPanel.hidden = !state.error;
  elements.errorMessage.textContent = state.error || '';
  elements.retryButton.disabled = state.loading;
  elements.retryButton.textContent = state.loading ? '重新加载中…' : '重新加载';
}

function populateStoreOptions() {
  const previous = state.store;
  const fragment = document.createDocumentFragment();
  const allOption = document.createElement('option');
  allOption.value = 'ALL';
  allOption.textContent = '全部店铺';
  fragment.append(allOption);

  allStores().forEach((store) => {
    const option = document.createElement('option');
    option.value = store.code;
    option.textContent = store.name && store.name !== store.code
      ? `${store.code} · ${store.name}`
      : store.code;
    fragment.append(option);
  });
  elements.store.replaceChildren(fragment);
  state.store = allStores().some((store) => store.code === previous) ? previous : 'ALL';
  elements.store.value = state.store;
}

function render() {
  updateNavigation();
  updateFilters();
  updateDatasetChrome();
  updateErrorPanel();

  if (state.loading && !state.data) {
    elements.view.innerHTML = renderLoading();
    elements.view.setAttribute('aria-busy', 'true');
    return;
  }
  elements.view.setAttribute('aria-busy', 'false');
  elements.view.innerHTML = state.data ? renderRoute() : renderUnavailable();
}

async function fetchJson(path) {
  const response = await fetch(path, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) {
    let message = '';
    try {
      const payload = await response.json();
      message = payload?.error?.message || '';
    } catch {
      message = '';
    }
    throw new Error(message || `本地数据服务返回 HTTP ${response.status}`);
  }
  return response.json();
}

async function loadDashboard() {
  state.loading = true;
  state.error = '';
  state.healthError = '';
  render();

  const healthPromise = fetchJson('/health')
    .then((health) => ({ ok: true, health }))
    .catch((error) => ({ ok: false, error }));

  try {
    const dashboard = await fetchJson('/api/dashboard');
    if (!dashboard || typeof dashboard !== 'object' || !dashboard.dataset) {
      throw new Error('销量数据结构无效');
    }
    state.data = dashboard;
    populateStoreOptions();
  } catch (error) {
    state.data = null;
    state.error = error instanceof Error ? error.message : '本地只读数据服务暂不可用。';
  }

  const healthResult = await healthPromise;
  if (healthResult.ok) state.health = healthResult.health;
  else {
    state.health = null;
    state.healthError = healthResult.error instanceof Error
      ? healthResult.error.message
      : '运行态接口不可用';
  }

  state.loading = false;
  render();
}

function syncRouteFromLocation() {
  const candidate = String(window.location.hash || '').replace(/^#/, '');
  const nextRoute = Object.prototype.hasOwnProperty.call(ROUTES, candidate) ? candidate : 'home';
  if (candidate !== nextRoute) {
    window.history.replaceState(null, '', `#${nextRoute}`);
  }
  const routeChanged = state.route !== nextRoute;
  state.route = nextRoute;
  render();
  if (routeChanged && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

elements.search.addEventListener('input', (event) => {
  state.query = event.currentTarget.value;
  render();
});

elements.store.addEventListener('change', (event) => {
  state.store = event.currentTarget.value;
  render();
});

elements.rangeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (!Object.prototype.hasOwnProperty.call(RANGE_META, button.dataset.range)) return;
    state.range = button.dataset.range;
    render();
  });
});

elements.clearFilters.addEventListener('click', () => {
  state.query = '';
  state.store = 'ALL';
  state.range = 'today';
  render();
  elements.search.focus();
});

elements.retryButton.addEventListener('click', loadDashboard);
window.addEventListener('hashchange', syncRouteFromLocation);

const initialHashRoute = String(window.location.hash || '').replace(/^#/, '');
if (!Object.prototype.hasOwnProperty.call(ROUTES, initialHashRoute)) {
  window.history.replaceState(null, '', '#home');
}
render();
loadDashboard();
