const numberFormatter = new Intl.NumberFormat('zh-CN');
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  hour12: false,
});

const ROUTES = Object.freeze({
  home: { title: '总控驾驶舱', code: 'CONTROL' },
  procurement: { title: '采购单中心', code: 'PO' },
  fulfilment: { title: '交付与入仓', code: 'INBOUND' },
  products: { title: '商品与货号', code: 'MDM' },
  sales: { title: '销量分析', code: 'SALES' },
  inventory: { title: '库存与供给', code: 'SUPPLY' },
  returns: { title: '采购退货', code: 'RETURNS' },
  compliance: { title: '合规与价格', code: 'COMPLIANCE' },
  finance: { title: '财务结算', code: 'FINANCE' },
  platform: { title: '平台动态', code: 'WEBHOOK' },
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

const SUPPLY_COVERAGE_META = Object.freeze({
  productCatalog: '商品目录',
  productDetails: '商品详情',
  inventory: '库存快照',
  stockAdvice: '备货建议',
  purchaseOrders: '采购单',
  deliveries: '交付单',
});

const state = {
  route: routeFromLocation(),
  range: 'today',
  query: '',
  owner: 'ALL',
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
  owner: document.querySelector('#owner-filter'),
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
  logoutButton: document.querySelector('#logout-button'),
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
  return ['complete', 'partial', 'pending', 'not_started', 'blocked'].includes(status)
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

function baseStores() {
  return Array.isArray(state.data?.storeRanking) ? state.data.storeRanking : [];
}

function ownerKeyForStore(store) {
  return String(store?.ownerKey || store?.owner?.key || '').trim();
}

function ownerNameForStore(store) {
  return String(store?.ownerName || store?.owner?.name || '').trim();
}

function allOwners() {
  const provided = Array.isArray(state.data?.owners) ? state.data.owners : [];
  const visibleStoreCodes = new Set(baseStores().map(({ code }) => String(code)));
  const byKey = new Map();

  provided.forEach((owner) => {
    const key = String(owner?.key || '').trim();
    if (!key) return;
    byKey.set(key, {
      key,
      name: String(owner?.name || key),
      storeCodes: new Set(
        Array.isArray(owner?.storeCodes)
          ? owner.storeCodes.map(String).filter((code) => visibleStoreCodes.has(code))
          : [],
      ),
      salesTrend: Array.isArray(owner?.salesTrend) ? owner.salesTrend : [],
    });
  });

  baseStores().forEach((store) => {
    const key = ownerKeyForStore(store);
    if (!key) return;
    const owner = byKey.get(key) || {
      key,
      name: ownerNameForStore(store) || key,
      storeCodes: new Set(),
      salesTrend: [],
    };
    owner.storeCodes.add(String(store.code));
    byKey.set(key, owner);
  });

  return [...byKey.values()]
    .filter((owner) => owner.storeCodes.size > 0)
    .map((owner) => ({
      ...owner,
      storeCodes: [...owner.storeCodes],
    }));
}

function selectedOwner() {
  return state.owner === 'ALL'
    ? null
    : allOwners().find((owner) => owner.key === state.owner) || null;
}

function storeMatchesOwner(store) {
  const owner = selectedOwner();
  if (!owner) return true;
  return ownerKeyForStore(store) === owner.key || owner.storeCodes.includes(String(store.code));
}

function allStores() {
  return baseStores().filter(storeMatchesOwner);
}

function allSkus() {
  return Array.isArray(state.data?.skuRanking) ? state.data.skuRanking : [];
}

function canonicalProducts() {
  return Array.isArray(state.data?.productRanking) ? state.data.productRanking : [];
}

function rankingProducts() {
  const products = canonicalProducts();
  if (products.length) {
    const confirmed = products.filter((item) => {
      const level = String(item.identityLevel || item.identityScope || '').toUpperCase();
      return level === 'CANONICAL_CONFIRMED' || level === 'CANONICAL';
    });
    if (confirmed.length) {
      return {
        rows: confirmed,
        canonical: true,
        unmappedCount: products.length - confirmed.length,
      };
    }
    return { rows: products, canonical: false, unmappedCount: products.length };
  }
  return { rows: allSkus(), canonical: false, unmappedCount: allSkus().length };
}

function selectedStore() {
  return state.store === 'ALL'
    ? null
    : baseStores().find((store) => store.code === state.store && storeMatchesOwner(store)) || null;
}

function matchingEntities(items) {
  const query = normalizedQuery();
  if (!query) return items;
  return items.filter((item) => {
    const haystack = [
      item.canonicalProductId,
      item.standardProductCode,
      item.standardProductName,
      item.productKey,
      item.supplierCode,
      item.supplierSku,
      item.skc,
      item.sku,
      item.name,
    ].filter(Boolean).join(' ')
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN');
    return haystack.includes(query);
  });
}

function matchingSkus() {
  return matchingEntities(allSkus());
}

function matchingProducts() {
  const source = rankingProducts();
  return { ...source, rows: matchingEntities(source.rows) };
}

function productCode(item, canonical = true) {
  if (canonical) {
    return item.standardProductCode || item.canonicalProductId || '标准商品待编号';
  }
  return item.productKey || item.supplierCode || item.skc || item.sku || '店内商品待确认';
}

function productName(item) {
  return item.name || item.standardProductName || item.sku || '商品名称待确认';
}

function productIdentityLabel(source = scopedProductRanking()) {
  return source.canonical ? '标准商品排行' : '店内商品排行（标准商品待归并）';
}

function storeSkuRows() {
  const visibleStoreCodes = new Set(baseStores().map(({ code }) => String(code)));
  return Array.isArray(state.data?.storeSkuRanking)
    ? state.data.storeSkuRanking.filter((row) => visibleStoreCodes.has(String(row?.storeCode || '')))
    : [];
}

function matchingStoreSkuRows() {
  const owner = selectedOwner();
  const store = selectedStore();
  const ownerStoreCodes = owner ? new Set(owner.storeCodes.map(String)) : null;
  return matchingEntities(storeSkuRows()).filter((row) => {
    const rowStoreCode = String(row?.storeCode || '');
    if (store && rowStoreCode !== String(store.code)) return false;
    if (!store && ownerStoreCodes && !ownerStoreCodes.has(rowStoreCode)) return false;
    return true;
  });
}

function unmappedStoreSkuRows() {
  return matchingStoreSkuRows().filter(
    (row) => String(row?.mappingStatus || '').toUpperCase() !== 'CONFIRMED',
  );
}

function mappingStatusLabel(value) {
  const status = String(value || '').toUpperCase();
  if (status === 'CONFIRMED') return '已确认归并';
  if (status === 'MISSING_SPU_ID') return '缺少平台 SPU，无法自动归并';
  return '等待证据归并';
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
  const owner = selectedOwner();
  const query = normalizedQuery();

  if (store && query) {
    const rows = matchingStoreSkuRows();
    return {
      units: {
        today: sumCompleteWindow(rows, 'today'),
        yesterday: sumCompleteWindow(rows, 'yesterday'),
        last7Days: sumCompleteWindow(rows, 'last7Days'),
        last30Days: sumCompleteWindow(rows, 'last30Days'),
      },
      title: rows.length ? `${store.name || store.code} · 当前货号筛选` : '店铺 × 货号事实未接入',
      note: rows.length
        ? '只汇总带店铺键的货号销量事实。'
        : '当前数据没有店铺到货号的交叉事实，不会用全局排行冒充店铺结果。',
    };
  }

  if (store) {
    return {
      units: store.unitsSold || {},
      title: `${store.name || store.code} 店铺汇总`,
      note: '来自带店铺键的销量快照；缺失窗口保持空白。',
    };
  }

  if (owner && query) {
    const rows = matchingStoreSkuRows();
    return {
      units: {
        today: sumCompleteWindow(rows, 'today'),
        yesterday: sumCompleteWindow(rows, 'yesterday'),
        last7Days: sumCompleteWindow(rows, 'last7Days'),
        last30Days: sumCompleteWindow(rows, 'last30Days'),
      },
      title: rows.length ? `${owner.name} · 当前货号筛选` : '负责人 × 货号事实未接入',
      note: rows.length
        ? '只汇总该负责人店铺范围内带店铺键的货号销量事实。'
        : '当前数据无法把全局货号排行安全拆到负责人范围。',
    };
  }

  if (query) {
    const products = matchingProducts();
    const rows = products.rows;
    return {
      units: {
        today: sumCompleteWindow(rows, 'today'),
        yesterday: sumCompleteWindow(rows, 'yesterday'),
        last7Days: sumCompleteWindow(rows, 'last7Days'),
        last30Days: sumCompleteWindow(rows, 'last30Days'),
      },
      title: products.canonical ? '当前标准商品筛选合计' : '当前可见 SKU 清单合计',
      note: rows.length
        ? (products.canonical
          ? '仅合计已完成标准商品归并且命中搜索的行。'
          : '标准商品尚未归并；仅合计命中搜索的原始 SKU 行。')
        : '当前商品清单中没有匹配项。',
    };
  }

  if (owner) {
    const stores = allStores();
    return {
      units: {
        today: sumCompleteWindow(stores, 'today'),
        yesterday: sumCompleteWindow(stores, 'yesterday'),
        last7Days: sumCompleteWindow(stores, 'last7Days'),
        last30Days: sumCompleteWindow(stores, 'last30Days'),
      },
      title: `${owner.name} 负责店铺汇总`,
      note: stores.length
        ? `仅汇总负责人归属表中的 ${stores.length} 家店铺。`
        : '当前负责人没有生效中的店铺归属。',
    };
  }

  return {
    units: state.data?.unitsSold || {},
    title: '全部店铺销量汇总',
    note: '来自只读 API 的预聚合销量数量。',
  };
}

function rowWindowSupported() {
  if (state.range !== 'yesterday') return true;
  return [...allStores(), ...scopedProductRanking().rows]
    .some((item) => isUnit(item?.unitsSold?.yesterday));
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

function aggregateCanonicalProducts(rows) {
  const windows = Object.keys(RANGE_META);
  const grouped = new Map();
  rows.forEach((row) => {
    const key = String(row.canonicalProductId || row.standardProductCode || '');
    if (!key) return;
    const item = grouped.get(key) || {
      canonicalProductId: row.canonicalProductId || key,
      standardProductCode: row.standardProductCode || key,
      name: row.standardProductName || row.name || key,
      storeCodes: new Set(),
      unitsSold: Object.fromEntries(windows.map((windowKey) => [windowKey, 0])),
      completeWindows: new Set(windows),
    };
    item.storeCodes.add(String(row.storeCode || ''));
    windows.forEach((windowKey) => {
      const value = row?.unitsSold?.[windowKey];
      if (!isUnit(value)) item.completeWindows.delete(windowKey);
      else {
        const total = item.unitsSold[windowKey] + value;
        if (!isUnit(total)) item.completeWindows.delete(windowKey);
        else item.unitsSold[windowKey] = total;
      }
    });
    grouped.set(key, item);
  });
  return [...grouped.values()].map((item) => ({
    ...item,
    storeCount: [...item.storeCodes].filter(Boolean).length,
    unitsSold: Object.fromEntries(windows.map((windowKey) => [
      windowKey,
      item.completeWindows.has(windowKey) ? item.unitsSold[windowKey] : null,
    ])),
  }));
}

function scopedProductRanking() {
  if (selectedStore() || selectedOwner()) {
    const rows = matchingStoreSkuRows();
    const canAggregate = rows.length > 0 && rows.every((row) => row.canonicalProductId || row.standardProductCode);
    return {
      rows: canAggregate ? aggregateCanonicalProducts(rows) : rows,
      canonical: canAggregate,
      scoped: true,
    };
  }
  return { ...matchingProducts(), scoped: false };
}

function skuRowsForView() {
  return sortBySelectedRange(scopedProductRanking().rows);
}

function storeRowsForTable() {
  if (normalizedQuery()) return [];
  const rows = selectedStore() ? [selectedStore()] : allStores();
  return rowWindowSupported() ? sortBySelectedRange(rows) : rows;
}

function skuRowsForTable() {
  const rows = scopedProductRanking().rows;
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
    return '店铺筛选已生效，但当前数据没有店铺到货号的交叉事实，因此商品排行暂停展示。';
  }
  if (kind === 'sku' && selectedOwner()) {
    return '负责人筛选已生效，但当前数据没有店铺到货号的交叉事实，因此商品排行暂停展示。';
  }
  return kind === 'store' ? '暂无符合筛选条件的店铺销量数据。' : '暂无符合筛选条件的 SKU 销量数据。';
}

function qualityState() {
  const store = selectedStore();
  const owner = selectedOwner();
  let scopedQuality = null;
  if (store?.qualityStatus) {
    scopedQuality = {
      status: store.qualityStatus,
      label: ({
        healthy: '店铺数据健康',
        legal_zero: '店铺合法零销量',
        partial: '店铺部分覆盖',
        stale: '店铺数据已过期',
        error: '店铺数据异常',
        unavailable: '店铺数据未接入',
      })[store.qualityStatus],
      reason: store.qualityReason,
    };
  } else if (owner) {
    const statuses = allStores().map(({ qualityStatus }) => qualityStatus).filter(Boolean);
    const priority = ['error', 'stale', 'partial', 'unavailable', 'legal_zero', 'healthy'];
    const status = priority.find((candidate) => statuses.includes(candidate));
    if (status) {
      scopedQuality = {
        status,
        label: `${owner.name} · ${({
          healthy: '数据健康',
          legal_zero: '合法零销量',
          partial: '部分覆盖',
          stale: '存在过期店铺',
          error: '存在异常店铺',
          unavailable: '存在未接入店铺',
        })[status]}`,
        reason: status === 'healthy'
          ? '负责店铺均返回健康销量观测'
          : '请下钻店铺排行查看具体质量原因',
      };
    }
  }
  const quality = scopedQuality || state.data?.quality || {};
  const coverage = state.data?.salesCoverage || {};
  const status = String(quality.status || coverage.status || 'unknown').toLowerCase();
  const known = ['healthy', 'complete', 'legal_zero', 'partial', 'stale', 'error', 'blocked', 'unavailable'];
  return {
    status: known.includes(status) ? status : 'unknown',
    label: quality.label || coverage.label || ({
      healthy: '数据健康',
      complete: '覆盖完整',
      legal_zero: '合法零销量',
      partial: '部分覆盖',
      stale: '数据已过期',
      error: '数据异常',
      blocked: '数据受阻',
      unavailable: '数据未接入',
    }[status] || '质量待确认'),
    reason: quality.reason || coverage.reason || '',
    impact: quality.impact || '',
    nextStep: quality.nextStep || '',
  };
}

function qualityTone(status = qualityState().status) {
  if (['healthy', 'complete', 'legal_zero'].includes(status)) return 'complete';
  if (['error', 'blocked'].includes(status)) return 'blocked';
  if (['partial', 'stale'].includes(status)) return 'pending';
  return 'unknown';
}

function businessDate() {
  return selectedStore()?.businessDate
    || state.data?.businessDate
    || state.data?.salesCoverage?.businessDate
    || state.data?.salesCoverage?.latestBusinessDate
    || null;
}

function coverageLabel() {
  const store = selectedStore();
  if (store) {
    return ['healthy', 'partial', 'legal_zero'].includes(store.qualityStatus)
      ? '1 / 1 家店'
      : '0 / 1 家店';
  }
  const owner = selectedOwner();
  if (owner) {
    const stores = allStores();
    const covered = stores.filter(({ qualityStatus }) => (
      ['healthy', 'partial', 'legal_zero'].includes(qualityStatus)
    )).length;
    return `${numberFormatter.format(covered)} / ${numberFormatter.format(stores.length)} 家店`;
  }
  const coverage = state.data?.salesCoverage || {};
  const covered = coverage.coveredStores;
  const total = coverage.totalStores;
  if (isUnit(covered) && isUnit(total)) return `${numberFormatter.format(covered)} / ${numberFormatter.format(total)} 家店`;
  return '覆盖范围待确认';
}

function trendSourceRows() {
  const rawRows = Array.isArray(state.data?.salesTrend) ? state.data.salesTrend : [];
  const explicitStoreRows = Array.isArray(state.data?.salesTrendByStore)
    ? state.data.salesTrendByStore
    : [];
  const visibleStoreCodes = new Set(baseStores().map(({ code }) => String(code)));
  const scopedRows = (explicitStoreRows.length
    ? explicitStoreRows
    : rawRows.filter((row) => row?.storeCode))
    .filter((row) => visibleStoreCodes.has(String(row?.storeCode || '')));
  const store = selectedStore();
  const owner = selectedOwner();

  if (normalizedQuery()) return [];

  if (!scopedRows.length) {
    if (store) {
      return Array.isArray(store.salesTrend) ? store.salesTrend : [];
    }
    if (owner) {
      return Array.isArray(owner.salesTrend) ? owner.salesTrend : [];
    }
    return rawRows;
  }

  const storeCodes = store
    ? new Set([String(store.code)])
    : owner
      ? new Set(owner.storeCodes.map(String))
      : null;
  const filtered = storeCodes
    ? scopedRows.filter((row) => storeCodes.has(String(row.storeCode)))
    : scopedRows;
  const byDate = new Map();
  filtered.forEach((row) => {
    if (!row?.date || !isUnit(row.unitsSold)) return;
    byDate.set(row.date, (byDate.get(row.date) || 0) + row.unitsSold);
  });
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, unitsSold]) => ({ date, unitsSold }));
}

function trendRowsForRange() {
  const rows = trendSourceRows();
  if (state.range === 'last30Days') return rows.slice(-30);
  return rows.slice(-7);
}

function trendWindowLabel() {
  return state.range === 'last30Days' ? '最近 30 个可用业务日' : '最近 7 个可用业务日';
}

function trendEmptyMessage() {
  if (normalizedQuery()) {
    return '当前日趋势没有标准商品或货号维度，已停止展示，避免把全局走势冒充搜索结果。';
  }
  if (selectedStore() || selectedOwner()) {
    return '当前日趋势只有全局序列，不能按负责人或店铺切片；已停止展示，避免冒充筛选结果。';
  }
  const rows = trendRowsForRange();
  if (rows.length < 2) {
    return `${trendWindowLabel()}不足两个日粒度点，暂时无法形成趋势。`;
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
  const ariaLabel = `${trendWindowLabel()}销量趋势，${rows[0].date} 至 ${lastPoint.date}`;

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
  const owner = selectedOwner();
  const query = state.query.trim();
  return [
    RANGE_META[state.range].label,
    owner ? `负责人：${owner.name}` : '全部负责人',
    store ? `店铺：${store.name || store.code}` : '全部店铺',
    query ? `搜索：${query}` : '全部商品',
  ].join(' · ');
}

function salesTruthStrip() {
  const quality = qualityState();
  const coverage = state.data?.salesCoverage || {};
  const qualityReason = [quality.reason, quality.impact, quality.nextStep].filter(Boolean).join(' · ');
  let rowCoverage = isUnit(coverage.datedRows) && isUnit(coverage.totalRows)
    ? `${numberFormatter.format(coverage.datedRows)} / ${numberFormatter.format(coverage.totalRows)} 行带统计日`
    : '行级日期覆盖待确认';
  if (selectedStore()) rowCoverage = selectedStore().qualityReason || '店铺质量说明待确认';
  else if (selectedOwner()) rowCoverage = '按负责人归属店铺逐店判断，不跨业务日混算';
  const items = [
    ['业务日期', businessDate() || '待确认', '不使用抓取时间冒充业务日期', 'date'],
    ['店铺覆盖', coverageLabel(), rowCoverage, 'coverage'],
    ['数据质量', quality.label, qualityReason || '暂无更具体的质量说明', qualityTone(quality.status)],
    ['数据生成', formatDateTime(state.data?.updatedAt), datasetLabel(), 'updated'],
  ];
  return `
    <section class="truth-strip" aria-label="销量数据口径与质量">
      ${items.map(([label, value, note, tone]) => `
        <article class="${escapeHtml(tone)}">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <small>${escapeHtml(note)}</small>
        </article>`).join('')}
    </section>`;
}

function dataQualityNotice() {
  const quality = qualityState();
  if (['healthy', 'complete'].includes(quality.status)) return '';
  if (quality.status === 'legal_zero') {
    return `
      <aside class="quality-notice complete">
        <strong>当前销量合法为 0</strong>
        <span>${escapeHtml(quality.reason || '接口已返回有效覆盖与零销量事实；0 不作为系统错误。')}</span>
      </aside>`;
  }
  if (quality.status === 'unknown') {
    return `
      <aside class="quality-notice unknown">
        <strong>销量质量仍待确认</strong>
        <span>${escapeHtml(quality.reason || '当前数据没有提供覆盖与统计日质量说明，数字只能按现有快照解读。')}</span>
      </aside>`;
  }
  return `
    <aside class="quality-notice ${escapeHtml(qualityTone(quality.status))}">
      <strong>${escapeHtml(quality.label)}</strong>
      <span>${escapeHtml([quality.reason, quality.impact, quality.nextStep].filter(Boolean).join(' · ') || '请先处理数据质量问题，再据此做经营判断。')}</span>
    </aside>`;
}

function metricState(value) {
  const quality = qualityState();
  if (!isUnit(value)) return { label: '未接入', tone: 'unknown' };
  if (quality.status === 'stale') return { label: '数据已过期', tone: 'pending' };
  if (value === 0 && quality.status === 'legal_zero') return { label: '合法为 0', tone: 'complete' };
  if (['error', 'blocked'].includes(quality.status)) return { label: '质量异常', tone: 'blocked' };
  return { label: value === 0 ? '销量为 0' : '销量事实', tone: qualityTone(quality.status) };
}

function metricStrip() {
  const scope = scopedUnits();
  const cards = Object.entries(RANGE_META).map(([key, meta]) => {
    const valueState = metricState(scope.units[key]);
    return `
      <article class="metric-item ${state.range === key ? 'active' : ''}">
        <div><span>${escapeHtml(meta.label)}销量</span><span class="metric-state ${escapeHtml(valueState.tone)}">${escapeHtml(valueState.label)}</span></div>
        <strong>${formatUnits(scope.units[key])}</strong>
        <p>${escapeHtml(meta.note)} · 单位：件</p>
      </article>`;
  }).join('');
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
    name: kind === 'store'
      ? (first.name || first.code)
      : productCode(first, scopedProductRanking().canonical),
    detail: kind === 'store'
      ? [first.code, ownerNameForStore(first)].filter(Boolean).join(' · ')
      : [productName(first), first.storeCode].filter(Boolean).join(' · '),
    value,
  };
}

function attentionSummary() {
  const store = topEntity(storeRowsForView(), 'store');
  const product = topEntity(skuRowsForView(), 'product');
  const productSource = scopedProductRanking();
  const stage = activeReadinessStage();
  const cards = [
    {
      label: `店铺关注 · ${RANGE_META[state.range].label}`,
      value: store ? store.name : '暂无可比结果',
      detail: store ? `${formatUnits(store.value)} 件 · ${store.detail}` : dimensionBoundary('store'),
      tone: 'accent',
    },
    {
      label: `${productIdentityLabel(productSource)} · ${RANGE_META[state.range].label}`,
      value: product ? product.name : '暂无可比结果',
      detail: product ? `${formatUnits(product.value)} 件 · ${product.detail}` : dimensionBoundary('sku'),
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
    kind === 'store' ? '店铺排行不可用' : '商品排行不可用',
    dimensionBoundary(kind),
  );
  const source = scopedProductRanking();
  return `
    <ol class="compact-ranking">
      ${items.slice(0, 5).map((item, index) => `
        <li>
          <span>${String(index + 1).padStart(2, '0')}</span>
          <div>
            <strong>${escapeHtml(kind === 'store' ? (item.name || item.code) : productCode(item, source.canonical))}</strong>
            <small>${escapeHtml(kind === 'store'
              ? [item.code, ownerNameForStore(item)].filter(Boolean).join(' · ')
              : [productName(item), item.storeCode].filter(Boolean).join(' · '))}</small>
          </div>
          <b>${formatUnits(item?.unitsSold?.[state.range])}<small>件</small></b>
        </li>`).join('')}
    </ol>`;
}

function supplyDomain() {
  const supply = state.data?.supply;
  return supply && typeof supply === 'object' ? supply : {};
}

function platformDomain() {
  const platform = state.data?.platform;
  return platform && typeof platform === 'object' ? platform : {};
}

function actionPoolDomain() {
  const actionPool = state.data?.actionPool;
  return actionPool && typeof actionPool === 'object' ? actionPool : {};
}

function domainRows(domain, key) {
  return Array.isArray(domain?.[key]) ? domain[key] : [];
}

function storeScopedRows(rows) {
  const store = selectedStore();
  const owner = selectedOwner();
  const ownerStores = owner ? new Set(owner.storeCodes.map(String)) : null;
  return rows.filter((row) => {
    const storeCode = String(row?.storeCode || '');
    if (store && storeCode !== String(store.code)) return false;
    if (!store && ownerStores && !ownerStores.has(storeCode)) return false;
    return true;
  });
}

function searchableOperationRows(rows) {
  const query = normalizedQuery();
  if (!query) return rows;
  return rows.filter((row) => {
    let safeProjection = '';
    if (row?.safeProjection && typeof row.safeProjection === 'object') {
      try {
        safeProjection = JSON.stringify(row.safeProjection);
      } catch {
        safeProjection = '';
      }
    }
    return [
      row?.storeCode,
      row?.storeName,
      row?.statusCode,
      row?.statusName,
      row?.milestoneCode,
      row?.inventoryTypeCode,
      row?.eventCode,
      row?.eventPath,
      row?.eventFamily,
      row?.businessType,
      row?.businessKey,
      row?.action,
      row?.severity,
      row?.type,
      row?.title,
      row?.reason,
      row?.entityCode,
      safeProjection,
    ].filter(Boolean).join(' ')
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN')
      .includes(query);
  });
}

function scopedOperationRows(rows) {
  return searchableOperationRows(storeScopedRows(rows));
}

function hasRows(domain, keys) {
  return keys.some((key) => domainRows(domain, key).length > 0);
}

function supplyCoverageDomain(key) {
  const value = supplyDomain()?.coverage?.domains?.[key];
  return value && typeof value === 'object' ? value : null;
}

function coverageHasEvidence(coverage) {
  if (!coverage) return false;
  return [
    coverage.observedStores,
    coverage.succeededStores,
    coverage.failedStores,
    coverage.missingStores,
    coverage.inProgressStores,
    coverage.staleStores,
    coverage.totalStores,
  ].some(isUnit) || Boolean(
    coverage.latestFetchedAt
    || coverage.watermarkStart
    || coverage.watermarkEnd
    || coverage.evaluatedAt
    || coverage.reason,
  );
}

function domainConnectionState(domain, keys, coverageKeys = []) {
  if (hasRows(domain, keys)) return 'available';
  const coverage = coverageKeys.map(supplyCoverageDomain).filter(Boolean);
  if (coverage.length === coverageKeys.length && coverage.length > 0) {
    if (coverage.some((item) => item.status === 'blocked')) return 'blocked';
    if (coverage.every((item) => item.status === 'complete')) return 'available';
    if (coverage.some((item) => item.status === 'partial' || coverageHasEvidence(item))) {
      return 'partial';
    }
  }
  return domain?.status === 'available' ? 'partial' : 'pending';
}

function nullableUnits(value, unknownLabel = '—') {
  return isUnit(value) ? numberFormatter.format(value) : unknownLabel;
}

function coverageParts(coverage, variants = []) {
  for (const [knownKey, totalKey, noun] of variants) {
    if (isUnit(coverage?.[knownKey]) && isUnit(coverage?.[totalKey])) {
      return {
        known: coverage[knownKey],
        total: coverage[totalKey],
        noun,
      };
    }
  }
  return null;
}

function fieldCoverageLabel(coverage, variants) {
  const parts = coverageParts(coverage, variants);
  if (!parts) return '覆盖待确认';
  return `已知 ${numberFormatter.format(parts.known)} / ${numberFormatter.format(parts.total)} ${parts.noun}`;
}

function completeNullableSum(rows, key) {
  if (!rows.length) return null;
  const values = rows.map((row) => row?.[key]);
  if (values.some((value) => !isUnit(value))) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function completeCoveredNullableSum(rows, key, coverageKey, variants) {
  if (!rows.length) return null;
  const complete = rows.every((row) => {
    const coverage = coverageParts(row?.[coverageKey], variants);
    return coverage !== null && coverage.known === coverage.total;
  });
  if (!complete) return null;
  return completeNullableSum(rows, key);
}

function operationScopeNote(rows, noun) {
  const filterActive = Boolean(selectedStore() || selectedOwner() || normalizedQuery());
  if (!rows.length) {
    return filterActive
      ? `当前筛选没有命中${noun}事实；这不代表业务数量为 0`
      : `${noun}事实尚无可展示行；不补成业务 0`;
  }
  if (!filterActive) return `共 ${numberFormatter.format(rows.length)} 条${noun}事实`;
  return `当前筛选命中 ${numberFormatter.format(rows.length)} 条${noun}事实`;
}

function sourceTime(value) {
  return value ? formatDateTime(value) : '来源时间未知';
}

function sourceStatusTone(status) {
  const normalized = String(status || '').toLocaleLowerCase('zh-CN');
  if (/(complete|success|received|inbound|active|enabled|granted|processed|healthy|ok)/.test(normalized)) return 'complete';
  if (/(failed|error|blocked|dead|expired|disabled|denied|cancel)/.test(normalized)) return 'blocked';
  return 'partial';
}

function supplyAvailable() {
  if (hasRows(supplyDomain(), [
    'purchaseOrderStatus',
    'deliveryMilestones',
    'inventory',
    'stockAdvice',
  ])) return true;
  return Object.keys(SUPPLY_COVERAGE_META)
    .some((key) => coverageHasEvidence(supplyCoverageDomain(key)));
}

function platformAvailable() {
  const platform = platformDomain();
  return domainRows(platform, 'events').length > 0
    || domainRows(platform, 'subscriptions').length > 0
    || queueHasEvidence(platform.queue)
    || platform.health?.warehouseReady === true
    || Boolean(platform.health?.receiver || platform.health?.worker);
}

function actionPoolAvailable() {
  return domainRows(actionPoolDomain(), 'candidates').length > 0;
}

function businessMap() {
  const supply = supplyDomain();
  const platform = platformDomain();
  const procurementState = domainConnectionState(
    supply,
    ['purchaseOrderStatus'],
    ['purchaseOrders'],
  );
  const fulfilmentState = domainConnectionState(
    supply,
    ['deliveryMilestones'],
    ['deliveries'],
  );
  const inventoryState = domainConnectionState(
    supply,
    ['inventory', 'stockAdvice'],
    ['inventory', 'stockAdvice'],
  );
  const platformState = platformAvailable()
    ? 'available'
    : platform?.status === 'available' ? 'partial' : 'pending';
  const actionState = actionPoolAvailable() ? 'partial' : 'locked';
  const domains = [
    ['procurement', '采购单中心', procurementState === 'available' ? '采购单状态事实已接入' : '等待采购单、采购数量与状态事实', procurementState],
    ['fulfilment', '交付与入仓', fulfilmentState === 'available' ? '交付与入仓里程碑已接入' : '等待发货、收货、查验与入库节点', fulfilmentState],
    ['products', '商品与货号', '标准商品归并与店内货号映射', canonicalProducts().length ? 'partial' : 'pending'],
    ['sales', '销量分析', '销量数量已接入', 'available'],
    ['inventory', '库存与供给', inventoryState === 'available' ? '库存与备货建议事实已接入' : '等待库存、缺货需求和供给风险事实', inventoryState],
    ['returns', '采购退货', '等待退货申请、退货单与报废单事实', 'pending'],
    ['compliance', '合规与价格', '等待证书、审核、供货价与议价事实', 'pending'],
    ['finance', '财务结算', '等待报账、销售款、补扣款与付款事实', 'pending'],
    ['platform', '平台动态', platformState === 'available' ? 'Webhook 队列、订阅回读与事件可见' : 'Webhook 订阅、处理与补查链路待接入', platformState],
    ['ops', '自动化运营', actionState === 'partial' ? '只读候选池已接入；写动作保持关闭' : '只读建议；写动作保持关闭', actionState],
    ['system', '系统健康', '授权、同步、覆盖、备份与运行态', 'available'],
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
  return `
    ${sampleNotice()}
    ${pageIntro(
      'FULL-MANAGED CONTROL',
      '全托运营总控',
      '先看今日、昨日与滚动销量，再看真实趋势、负责人店铺排行和商品排行；所有数字同时带业务日期、覆盖与质量边界。',
      `<span>当前数据关注</span><strong>${escapeHtml(qualityState().label)}</strong><small>${escapeHtml(filterSummary())}</small>`,
    )}
    ${salesTruthStrip()}
    ${dataQualityNotice()}
    ${metricStrip()}
    <section class="home-analysis-grid">
      <article class="panel trend-panel">
        ${panelHeading('SALES TREND', '真实销量趋势', `${trendWindowLabel()} · 日粒度 · ${selectedOwner()?.name || selectedStore()?.code || '全部店铺'}`)}
        ${renderTrendChart()}
      </article>
      <article class="panel">
        ${panelHeading('STORE TOP', '店铺销量 Top', RANGE_META[state.range].label)}
        ${compactRanking(storeRowsForView(), 'store')}
        <a class="text-link" href="#sales">查看完整店铺表 →</a>
      </article>
      <article class="panel">
        ${panelHeading('PRODUCT TOP', productIdentityLabel(), RANGE_META[state.range].label)}
        ${compactRanking(skuRowsForView(), 'sku')}
        <a class="text-link" href="#products">查看商品身份与完整排行 →</a>
      </article>
    </section>
    ${attentionSummary()}
    ${readinessStrip()}
    ${businessMap()}`;
}

function permissionBadge(permission) {
  const status = permission?.status || 'unknown';
  return `<span class="row-status ${escapeHtml(status)}">${escapeHtml(permission?.label || '权限待确认')}</span>`;
}

function salesTable(kind) {
  const isStore = kind === 'store';
  const rows = isStore ? storeRowsForTable() : skuRowsForTable();
  const productSource = scopedProductRanking();
  if (!rows.length) return emptyEvidence(
    isStore ? '店铺销量表暂无可用行' : '商品销量表暂无可用行',
    dimensionBoundary(kind),
  );

  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th scope="col">序号</th>
            <th scope="col">${isStore ? '店铺 / 负责人' : (productSource.canonical ? '标准商品' : '店内商品 / 货号')}</th>
            ${isStore ? '<th scope="col">销量权限</th>' : '<th scope="col">身份范围</th>'}
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
              <td class="entity-column">
                <strong>${escapeHtml(isStore ? (item.name || item.code) : productCode(item, productSource.canonical))}</strong>
                <span>${escapeHtml(isStore
                  ? [item.code, ownerNameForStore(item) || '负责人未分配'].join(' · ')
                  : [productName(item), item.storeCode].filter(Boolean).join(' · '))}</span>
              </td>
              <td>${isStore
                ? permissionBadge(item.permission)
                : `<span class="row-status ${productSource.canonical ? 'complete' : 'partial'}">${productSource.canonical ? '标准商品' : '店内身份待归并'}</span>`}</td>
              <td class="number-column ${state.range === 'today' ? 'selected-column' : ''}">${formatUnits(item?.unitsSold?.today)}</td>
              <td class="number-column ${isUnit(item?.unitsSold?.yesterday) ? '' : 'missing-value'} ${state.range === 'yesterday' ? 'selected-column' : ''}">${formatUnits(item?.unitsSold?.yesterday)}</td>
              <td class="number-column ${state.range === 'last7Days' ? 'selected-column' : ''}">${formatUnits(item?.unitsSold?.last7Days)}</td>
              <td class="number-column ${state.range === 'last30Days' ? 'selected-column' : ''}">${formatUnits(item?.unitsSold?.last30Days)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="table-note">* 破折号表示该窗口未接入或不完整，不表示销量为 0。店内商品身份不会跨店按裸 SKU 合并；排行按当前选择窗口重排。</p>`;
}

function renderSales() {
  const scope = scopedUnits();
  const focusValue = scope.units[state.range];
  return `
    ${sampleNotice()}
    ${pageIntro(
      'SALES ANALYSIS',
      '销量分析',
      '比较当前窗口内的负责人、店铺和商品销量数量。店内身份与标准商品身份分开表达。',
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
      ${panelHeading('PRODUCT DETAIL', productIdentityLabel(), '当前数据返回且命中筛选的全部商品销量行')}
      ${salesTable('sku')}
    </section>`;
}

function productRows() {
  return scopedProductRanking().rows;
}

function pendingProductMappingTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有待归并货号',
      '这里只说明没有命中当前筛选的未确认身份；不会据此推断全部货号都已归并。',
    );
  }
  return `
    <div class="table-wrap">
      <table class="data-table product-table pending-mapping-table">
        <thead><tr><th scope="col">店铺</th><th scope="col">原始货号 / SKC</th><th scope="col">平台 SKU</th><th scope="col">商品名称</th><th scope="col">归并状态</th></tr></thead>
        <tbody>${rows.map((item) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(item.storeCode || '店铺待确认')}</strong><span>店内身份隔离</span></td>
            <td class="entity-column"><strong>${escapeHtml(item.supplierCode || item.supplierSku || item.productKey || '原始货号待确认')}</strong><span>${escapeHtml(item.skc || 'SKC 待确认')}</span></td>
            <td class="entity-column"><strong>${escapeHtml(item.sku || 'SKU 待确认')}</strong><span>${escapeHtml(item.productKey || '')}</span></td>
            <td>${escapeHtml(productName(item))}</td>
            <td><span class="row-status partial">${escapeHtml(mappingStatusLabel(item.mappingStatus))}</span></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">这些行始终保留“店铺 + 原始货号/SKC/SKU”身份，不参与跨店标准商品合计；完成有证据的归并后才会进入标准商品排行。</p>`;
}

function renderProducts() {
  const rows = productRows();
  const source = scopedProductRanking();
  const pendingRows = unmappedStoreSkuRows();
  const missingSpuSkus = Number.isSafeInteger(state.data?.productIdentityCoverage?.missingSpuSkus)
    ? state.data.productIdentityCoverage.missingSpuSkus
    : null;
  const identityStatus = source.canonical ? '标准商品身份已接入' : '店内商品身份待归并';
  return `
    ${sampleNotice()}
    ${pageIntro(
      'PRODUCT IDENTITY',
      '商品与货号',
      '原始店铺货号、SKC、SKU 与标准商品分层保存；只有通过身份归并的商品才能跨店聚合。',
      `<span>当前身份范围</span><strong>${escapeHtml(identityStatus)}</strong><small>${escapeHtml(source.canonical ? 'CANONICAL_CONFIRMED' : 'STORE_LOCAL_UNVERIFIED')}${missingSpuSkus === null ? '' : ` · 缺少平台 SPU ${numberFormatter.format(missingSpuSkus)} 个`}</small>`,
    )}
    <section class="process-panel">
      ${panelHeading('IDENTITY RESOLUTION', '货号科学归并', '原始值永不覆盖，合并与拆分均保留版本和审核记录')}
      <ol class="process-flow four-steps">
        <li><span>01</span><div><strong>原始身份留存</strong><p>按店铺保存 supplierCode、supplierSku、SKC、SKU、标题与属性。</p></div><b>平台事实</b></li>
        <li><span>02</span><div><strong>候选归并</strong><p>用型号、品类、关键属性、条码和图片生成候选，不靠单一字符串。</p></div><b>待接入</b></li>
        <li><span>03</span><div><strong>冲突与置信度</strong><p>电压、插头、容量等冲突禁止自动合并；中置信度进入人工审核。</p></div><b>待接入</b></li>
        <li><span>04</span><div><strong>标准商品版本</strong><p>确认后生成标准商品与变体，事实仍引用原始平台 SKU。</p></div><b>${source.canonical ? '部分可用' : '待接入'}</b></li>
      </ol>
    </section>
    <section class="table-section">
      ${panelHeading('PRODUCT RANKING', productIdentityLabel(source), `${RANGE_META[state.range].label} · 身份范围不伪造`)}
      ${rows.length ? `
        <div class="table-wrap">
          <table class="data-table product-table">
            <thead><tr><th scope="col">${source.canonical ? '标准商品' : '店内商品键'}</th><th scope="col">商品名 / 店铺</th><th scope="col">当前窗口销量</th><th scope="col">身份范围</th><th scope="col">映射状态</th></tr></thead>
            <tbody>${rows.map((item) => `
              <tr>
                <td class="entity-column"><strong>${escapeHtml(productCode(item, source.canonical))}</strong><span>${escapeHtml(item.canonicalProductId || item.skc || item.sku || '')}</span></td>
                <td class="entity-column"><strong>${escapeHtml(productName(item))}</strong><span>${escapeHtml(item.storeCode ? `店铺 ${item.storeCode}` : `${item.storeCount || '—'} 家店铺`)}</span></td>
                <td class="number-column">${formatUnits(item?.unitsSold?.[state.range])}</td>
                <td><span class="row-status ${source.canonical ? 'complete' : 'partial'}">${source.canonical ? '标准商品' : '店内未验证'}</span></td>
                <td class="boundary-cell">${escapeHtml(mappingStatusLabel(item.mappingStatus || (source.canonical ? 'CONFIRMED' : 'UNMAPPED')))}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        <p class="table-note">${source.canonical
          ? `仅标准商品身份允许跨店聚合；原始货号与平台 SKU 仍保留在明细层。${pendingRows.length ? ` 另有 ${pendingRows.length} 个店内商品待归并，未混入本排行。` : ''}`
          : '当前排行只在店内身份范围成立；不会把不同店铺相同的裸 SKU 当成同一标准商品。'}</p>` : emptyEvidence(
          '商品排行暂无可用行',
          selectedStore() || selectedOwner()
            ? '当前数据没有带店铺键的货号销量事实，无法安全生成筛选范围内的商品排行。'
            : '当前 API 没有返回命中搜索的商品销量行。',
        )}
    </section>
    <section class="table-section">
      ${panelHeading('UNMAPPED IDENTITY QUEUE', '待归并货号明细', `${pendingRows.length ? `${numberFormatter.format(pendingRows.length)} 条未确认店内身份` : '当前筛选无未确认店内身份'} · 只读观察`)}
      ${pendingProductMappingTable(pendingRows)}
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
      'COMPLIANCE & PRICE',
      '合规与价格',
      '商品资料、证书、审核、供货价、议价与建议零售价分层管理；价格事实不推导消费者成交额。',
      '<span>合规与价格事实</span><strong>尚未接入</strong><small>写动作保持关闭</small>',
    )}
    ${integrationGate({
      kicker: 'COMPLIANCE DATA',
      title: '合规与价格接入条件',
      description: '不把“没有数据”显示成零风险，也不根据商品名猜证书或价格状态。',
      evidence: [
        '逐店回读“商品合规”业务权限与店铺授权状态',
        '真实探针合规列表、证书资料、供货价、议价与建议零售价接口',
        '确认商品键、证书类型、审核状态、价格类型、原因与更新时间字段',
        '隔离入仓并对照平台页面完成样本回读',
        '写操作另行通过权限、dry-run、确认、审计和结果回读',
      ],
      boundary: '当前页面只说明接入路径。风险商品数、缺证数、供货价和议价状态均未知，因此不展示任何数值或金额。',
      futureFields: '商品身份、资料类型、审核状态、原因、有效期、供货价、议价、建议零售价、更新时间',
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

function latestTimestamp(rows, key = 'latestSourceFetchedAt') {
  const values = rows
    .map((row) => row?.[key])
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.valueOf()));
  if (!values.length) return null;
  return new Date(Math.max(...values.map((value) => value.valueOf()))).toISOString();
}

function operationSummaryCards(cards) {
  return `
    <div class="operation-summary-grid">
      ${cards.map(({ label, value, note, tone = '' }) => `
        <article class="operation-summary-card ${escapeHtml(tone)}">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <p>${escapeHtml(note)}</p>
        </article>`).join('')}
    </div>`;
}

function procurementTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有采购单状态行',
      '这只表示当前负责人、店铺或搜索条件没有命中；不把空结果解释为 0 张采购单。',
    );
  }
  return `
    <div class="table-wrap">
      <table class="data-table operational-table">
        <thead><tr><th scope="col">店铺</th><th scope="col">采购单状态</th><th scope="col" class="number-column">采购单数</th><th scope="col">来源快照</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.storeName || row.storeCode || '店铺待确认')}</strong><span>${escapeHtml(row.storeCode || '店铺编码未知')}</span></td>
            <td><span class="row-status ${sourceStatusTone(row.statusCode || row.statusName)}">${escapeHtml(row.statusName || row.statusCode || '状态未知')}</span></td>
            <td class="number-column ${isUnit(row.orderCount) ? '' : 'missing-value'}">${nullableUnits(row.orderCount)}</td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.latestSourceFetchedAt))}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">“—”表示平台字段未知或当前快照未覆盖，不表示采购单数为 0；只有明确返回的 0 才展示为 0。</p>`;
}

function renderProcurement() {
  const supply = supplyDomain();
  const allRows = domainRows(supply, 'purchaseOrderStatus');
  const rows = scopedOperationRows(allRows);
  const totalOrders = completeNullableSum(rows, 'orderCount');
  const statusCount = new Set(rows.map((row) => row.statusCode || row.statusName).filter(Boolean)).size;
  const connectionState = domainConnectionState(
    supply,
    ['purchaseOrderStatus'],
    ['purchaseOrders'],
  );
  const connected = connectionState === 'available';
  const connectedLabel = allRows.length
    ? '真实状态已接入'
    : connected ? '接口覆盖完整 · 当前窗口无事实行' : '尚未完成可信接入';
  return `
    ${sampleNotice()}
    ${pageIntro(
      'PURCHASE ORDERS',
      '采购单中心',
      '采购单是 SHEIN 向商家下达的供货单据，不是消费者订单；销量只作为需求参照。',
      `<span>采购单事实</span><strong>${escapeHtml(connectedLabel)}</strong><small>${escapeHtml(connected ? operationScopeNote(rows, '采购单状态') : '不展示订单数或伪造状态')}</small>`,
    )}
    ${connected ? `
      ${operationSummaryCards([
        {
          label: '当前范围采购单',
          value: totalOrders === null ? '未知' : `${numberFormatter.format(totalOrders)} 张`,
          note: totalOrders === null ? '存在数量未知的状态行，拒绝补零后合计' : '各状态明确数量的完整合计',
          tone: totalOrders === null ? 'partial' : 'available',
        },
        {
          label: '状态种类',
          value: statusCount ? `${numberFormatter.format(statusCount)} 类` : '未知',
          note: '按平台状态码去重，不推导业务完成率',
        },
        {
          label: '店铺覆盖',
          value: rows.length ? `${new Set(rows.map((row) => row.storeCode).filter(Boolean)).size} 家` : '当前筛选无行',
          note: operationScopeNote(rows, '采购单状态'),
        },
        {
          label: '最新来源快照',
          value: latestTimestamp(rows) ? formatDateTime(latestTimestamp(rows)) : '未知',
          note: '展示源接口抓取时间，不冒充采购单业务时间',
        },
      ])}
      <section class="table-section">
        ${panelHeading('PURCHASE ORDER STATUS', '采购单状态分布', '数量未知保留为空；负责人、店铺和搜索筛选已应用')}
        ${procurementTable(rows)}
      </section>
      <div class="split-grid">
        <section class="panel">
          ${panelHeading('DEMAND SIGNAL', '销量需求信号', RANGE_META[state.range].label)}
          ${demandSignal('procurement')}
        </section>
        <section class="panel condition-panel">
          ${panelHeading('DATA BOUNDARY', '采购单数据边界', '事实接入不等于写能力开放')}
          <ul class="condition-list">
            <li><strong>单据口径</strong><span>SHEIN 向商家下达的采购单，不是消费者订单</span></li>
            <li><strong>数量口径</strong><span>采购、交付、收货和入库数量保持独立</span></li>
            <li><strong>来源时间</strong><span>接口快照时间与平台业务时间分开保存</span></li>
            <li><strong>写操作</strong><span>当前页面与服务仍为只读，不提交任何采购单动作</span></li>
          </ul>
        </section>
      </div>` : `
      <div class="split-grid">
        <section class="panel">
          ${panelHeading('DEMAND SIGNAL', '销量需求信号', RANGE_META[state.range].label)}
          ${demandSignal('procurement')}
        </section>
        <section class="panel condition-panel">
          ${panelHeading('PURCHASE ORDER GATE', '采购单接入条件', '主动增量、Webhook 与日终补漏共同取证')}
          <ul class="condition-list">
            <li><strong>采购单列表与详情</strong><span>采购单号、类型、状态、仓库、平台业务时间</span></li>
            <li><strong>数量链路</strong><span>采购、交付、收货、入库、残次数量分别保存</span></li>
            <li><strong>商品键</strong><span>SKC、SKU、supplierCode、supplierSku 与店铺身份对账</span></li>
            <li><strong>增量与补漏</strong><span>更新时间增量、采购单事件、日终全量对账</span></li>
          </ul>
        </section>
      </div>
      <section class="wide-empty-section">
        ${emptyEvidence('采购单事实未接入', '当前没有采购单列表、状态或采购数量事实；不会把销量排行换算成采购单或待交付数量。', '接入后展示急采、备货、JIT母子单、状态与数量进度。')}
      </section>`}`;
}

function fulfilmentTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有交付里程碑行',
      '这不代表没有发货或入仓；请调整负责人、店铺或搜索条件。',
    );
  }
  return `
    <div class="table-wrap">
      <table class="data-table operational-table">
        <thead><tr><th scope="col">店铺</th><th scope="col">履约里程碑</th><th scope="col" class="number-column">交付单数</th><th scope="col" class="number-column">交付数量</th><th scope="col">数量覆盖</th><th scope="col">来源快照</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.storeName || row.storeCode || '店铺待确认')}</strong><span>${escapeHtml(row.storeCode || '店铺编码未知')}</span></td>
            <td><span class="row-status ${sourceStatusTone(row.milestoneCode)}">${escapeHtml(row.milestoneCode || '里程碑未知')}</span></td>
            <td class="number-column ${isUnit(row.deliveryCount) ? '' : 'missing-value'}">${nullableUnits(row.deliveryCount)}</td>
            <td class="number-column ${isUnit(row.deliveryQuantity) ? '' : 'missing-value'}">${nullableUnits(row.deliveryQuantity)}</td>
            <td class="boundary-cell">${escapeHtml(fieldCoverageLabel(row.deliveryQuantityCoverage, [['knownLineCount', 'totalLineCount', '行']]))}</td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.latestSourceFetchedAt))}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">交付单数与交付数量是两个口径。数量为“—”时同时展示已知行覆盖率，绝不按 0 参与合计。</p>`;
}

function renderFulfilment() {
  const supply = supplyDomain();
  const allRows = domainRows(supply, 'deliveryMilestones');
  const rows = scopedOperationRows(allRows);
  const connected = domainConnectionState(
    supply,
    ['deliveryMilestones'],
    ['deliveries'],
  ) === 'available';
  const connectionLabel = allRows.length
    ? '真实里程碑已接入'
    : connected ? '接口覆盖完整 · 当前窗口无事实行' : '尚未完成可信接入';
  const deliveryCount = completeNullableSum(rows, 'deliveryCount');
  const deliveryQuantity = completeCoveredNullableSum(
    rows,
    'deliveryQuantity',
    'deliveryQuantityCoverage',
    [['knownLineCount', 'totalLineCount', '行']],
  );
  return `
    ${sampleNotice()}
    ${pageIntro(
      'DELIVERY & INBOUND',
      '交付与入仓',
      '跟踪发货、物流预报、送达、收货、查验、入库和残次节点；每个节点只认平台单据事实。',
      `<span>交付事实</span><strong>${escapeHtml(connectionLabel)}</strong><small>${escapeHtml(connected ? operationScopeNote(rows, '交付里程碑') : '未知不等于未发货')}</small>`,
    )}
    ${connected ? `
      ${operationSummaryCards([
        {
          label: '里程碑计数合计',
          value: deliveryCount === null ? '未知' : `${numberFormatter.format(deliveryCount)} 次`,
          note: deliveryCount === null ? '存在交付单数未知的行' : '按里程碑状态行合计',
          tone: deliveryCount === null ? 'partial' : 'available',
        },
        {
          label: '当前范围交付数量',
          value: deliveryQuantity === null ? '未知' : `${numberFormatter.format(deliveryQuantity)} 件`,
          note: deliveryQuantity === null ? '至少一行数量未覆盖，拒绝补零合计' : '全部行数量明确',
          tone: deliveryQuantity === null ? 'partial' : 'available',
        },
        {
          label: '里程碑种类',
          value: rows.length ? `${new Set(rows.map((row) => row.milestoneCode).filter(Boolean)).size} 类` : '当前筛选无行',
          note: operationScopeNote(rows, '交付里程碑'),
        },
        {
          label: '最新来源快照',
          value: latestTimestamp(rows) ? formatDateTime(latestTimestamp(rows)) : '未知',
          note: '来源抓取时间与物流节点业务时间分开',
        },
      ])}
      <section class="table-section">
        ${panelHeading('FULFILMENT MILESTONES', '交付与入仓里程碑', '交付数量按行显示覆盖率；未知不等于 0')}
        ${fulfilmentTable(rows)}
      </section>` : integrationGate({
      kicker: 'FULFILMENT DATA',
      title: '交付与入仓接入条件',
      description: '采购数量、交付数量、收货数量和入库数量不能混成一个“完成量”。',
      evidence: [
        '回读发货单、包裹、物流预报和平台业务状态',
        '分别保存分配、交付、送达、收货、查验与入库时间',
        '逐行对账交付、收货、入库、残次与退回数量',
        '按采购单号、发货单号和包裹号建立可追溯关联',
        'Webhook 只做变化通知，Worker 补查详情并由定时任务补漏',
      ],
      boundary: '当前没有真实发货单、物流、收货、查验或入库事实，因此不展示履约率、准时率和异常数。',
      futureFields: '采购单、发货单、包裹、仓库、节点时间、各阶段数量、异常原因',
    })}`;
}

function inventoryTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有库存快照行',
      '这不代表库存为 0；请调整负责人、店铺或搜索条件。',
    );
  }
  return `
    <div class="table-wrap">
      <table class="data-table operational-table inventory-table">
        <thead><tr><th scope="col">店铺 / 类型</th><th scope="col" class="number-column">SKU 数</th><th scope="col" class="number-column">库存数量</th><th scope="col" class="number-column">可用库存</th><th scope="col" class="number-column">在途数量</th><th scope="col">在途覆盖</th><th scope="col" class="number-column">缺货 SKU</th><th scope="col" class="number-column">缺货数量</th><th scope="col">缺货覆盖</th><th scope="col" class="number-column">对账差异</th><th scope="col">来源快照</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.storeName || row.storeCode || '店铺待确认')}</strong><span>${escapeHtml([row.storeCode, row.inventoryTypeCode].filter(Boolean).join(' · ') || '库存类型未知')}</span></td>
            <td class="number-column ${isUnit(row.skuCount) ? '' : 'missing-value'}">${nullableUnits(row.skuCount)}</td>
            <td class="number-column ${isUnit(row.inventoryQuantity) ? '' : 'missing-value'}">${nullableUnits(row.inventoryQuantity)}</td>
            <td class="number-column ${isUnit(row.usableInventory) ? '' : 'missing-value'}">${nullableUnits(row.usableInventory)}</td>
            <td class="number-column ${isUnit(row.transitQuantity) ? '' : 'missing-value'}">${nullableUnits(row.transitQuantity)}</td>
            <td class="boundary-cell">${escapeHtml(fieldCoverageLabel(row.transitCoverage, [['knownSkuCount', 'totalSkuCount', 'SKU']]))}</td>
            <td class="number-column ${isUnit(row.shortageSkuCount) ? '' : 'missing-value'}">${nullableUnits(row.shortageSkuCount)}</td>
            <td class="number-column ${isUnit(row.shortageQuantity) ? '' : 'missing-value'}">${nullableUnits(row.shortageQuantity)}</td>
            <td class="boundary-cell">${escapeHtml(fieldCoverageLabel(row.shortageCoverage, [['knownSkuCount', 'totalSkuCount', 'SKU']]))}</td>
            <td class="number-column ${isUnit(row.reconciliationMismatchCount) ? '' : 'missing-value'}">${nullableUnits(row.reconciliationMismatchCount)}</td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.latestSourceFetchedAt))}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">库存、可用、在途和缺货是不同口径。“—”表示未知并同时展示覆盖率；明确 0 才展示为 0。</p>`;
}

function stockAdviceTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有备货建议行',
      '没有建议快照不等于建议补货量为 0；不会根据销量自行推导平台建议。',
    );
  }
  return `
    <div class="table-wrap">
      <table class="data-table operational-table advice-table">
        <thead><tr><th scope="col">店铺</th><th scope="col" class="number-column">SKU 总数</th><th scope="col" class="number-column">建议 SKU</th><th scope="col" class="number-column">建议下单量</th><th scope="col">下单量覆盖</th><th scope="col" class="number-column">计划紧急量</th><th scope="col">紧急量覆盖</th><th scope="col" class="number-column">预警 SKU</th><th scope="col">预警覆盖</th><th scope="col">来源快照</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.storeName || row.storeCode || '店铺待确认')}</strong><span>${escapeHtml(row.storeCode || '店铺编码未知')}</span></td>
            <td class="number-column ${isUnit(row.totalSkuCount) ? '' : 'missing-value'}">${nullableUnits(row.totalSkuCount)}</td>
            <td class="number-column ${isUnit(row.advisedSkuCount) ? '' : 'missing-value'}">${nullableUnits(row.advisedSkuCount)}</td>
            <td class="number-column ${isUnit(row.advisedOrderQuantity) ? '' : 'missing-value'}">${nullableUnits(row.advisedOrderQuantity)}</td>
            <td class="boundary-cell">${escapeHtml(fieldCoverageLabel(row.advisedOrderCoverage, [['knownSkuCount', 'totalSkuCount', 'SKU']]))}</td>
            <td class="number-column ${isUnit(row.plannedUrgentQuantity) ? '' : 'missing-value'}">${nullableUnits(row.plannedUrgentQuantity)}</td>
            <td class="boundary-cell">${escapeHtml(fieldCoverageLabel(row.plannedUrgentCoverage, [['knownSkuCount', 'totalSkuCount', 'SKU']]))}</td>
            <td class="number-column ${isUnit(row.warningSkuCount) ? '' : 'missing-value'}">${nullableUnits(row.warningSkuCount)}</td>
            <td class="boundary-cell">${escapeHtml(fieldCoverageLabel(row.warningCoverage, [['knownSkuCount', 'totalSkuCount', 'SKU']]))}</td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.latestSourceFetchedAt))}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">备货建议是平台只读事实，不是系统自动生成的采购动作；所有写入和提交能力保持关闭。</p>`;
}

function renderInventory() {
  const supply = supplyDomain();
  const allInventory = domainRows(supply, 'inventory');
  const allAdvice = domainRows(supply, 'stockAdvice');
  const inventoryRows = scopedOperationRows(allInventory);
  const adviceRows = scopedOperationRows(allAdvice);
  const connected = domainConnectionState(
    supply,
    ['inventory', 'stockAdvice'],
    ['inventory', 'stockAdvice'],
  ) === 'available';
  const factLabel = allInventory.length || allAdvice.length
    ? '真实快照已接入'
    : connected ? '接口覆盖完整 · 当前窗口无事实行' : '尚未完成可信接入';
  const totalInventory = completeNullableSum(inventoryRows, 'inventoryQuantity');
  const totalShortage = completeCoveredNullableSum(
    inventoryRows,
    'shortageQuantity',
    'shortageCoverage',
    [['knownSkuCount', 'totalSkuCount', 'SKU']],
  );
  const totalAdvice = completeCoveredNullableSum(
    adviceRows,
    'advisedOrderQuantity',
    'advisedOrderCoverage',
    [['knownSkuCount', 'totalSkuCount', 'SKU']],
  );
  return `
    ${sampleNotice()}
    ${pageIntro(
      'INVENTORY',
      '库存与供给',
      '库存、缺货需求、待交付、在途与已入库数量分开表达；销量只能作为供给速度参考。',
      `<span>供给事实</span><strong>${escapeHtml(factLabel)}</strong><small>${escapeHtml(connected ? `库存 ${inventoryRows.length} 行 · 建议 ${adviceRows.length} 行；空行不等于业务 0` : '未知不等于零库存')}</small>`,
    )}
    ${connected ? `
      ${operationSummaryCards([
        {
          label: '当前范围库存数量',
          value: totalInventory === null ? '未知' : `${numberFormatter.format(totalInventory)} 件`,
          note: totalInventory === null ? '至少一行库存数量未知，拒绝补零合计' : '全部可见库存行数量明确',
          tone: totalInventory === null ? 'partial' : 'available',
        },
        {
          label: '当前范围缺货数量',
          value: totalShortage === null ? '未知' : `${numberFormatter.format(totalShortage)} 件`,
          note: totalShortage === null ? '缺货覆盖不完整，不能当 0' : '全部可见缺货行数量明确',
          tone: totalShortage === null ? 'partial' : 'available',
        },
        {
          label: '平台建议下单量',
          value: totalAdvice === null ? '未知' : `${numberFormatter.format(totalAdvice)} 件`,
          note: totalAdvice === null ? '建议覆盖不完整，不能自动推导' : '只读建议合计，不代表已下单',
          tone: totalAdvice === null ? 'partial' : 'available',
        },
        {
          label: '最新来源快照',
          value: latestTimestamp([...inventoryRows, ...adviceRows]) ? formatDateTime(latestTimestamp([...inventoryRows, ...adviceRows])) : '未知',
          note: '来源抓取时间，不冒充库存业务时点',
        },
      ])}
      <section class="table-section">
        ${panelHeading('INVENTORY SNAPSHOT', '库存与缺货快照', operationScopeNote(inventoryRows, '库存'))}
        ${inventoryTable(inventoryRows)}
      </section>
      <section class="table-section">
        ${panelHeading('STOCK ADVICE', '平台备货建议', operationScopeNote(adviceRows, '备货建议'))}
        ${stockAdviceTable(adviceRows)}
      </section>
      <div class="split-grid">
        <section class="panel">
          ${panelHeading('SALES VELOCITY', '销量速度信号', RANGE_META[state.range].label)}
          ${demandSignal('inventory')}
        </section>
        <section class="panel condition-panel">
          ${panelHeading('READ-ONLY BOUNDARY', '只读能力边界', '供给事实可读，库存写操作仍关闭')}
          <ul class="condition-list">
            <li><strong>库存事实</strong><span>实际、可用、在途与缺货按来源字段分开</span></li>
            <li><strong>未知值</strong><span>以 null 和覆盖率表达，不参与合计</span></li>
            <li><strong>建议事实</strong><span>平台备货建议不自动转换成采购或库存写入</span></li>
            <li><strong>执行能力</strong><span>任何提交按钮和写接口仍保持禁用</span></li>
          </ul>
        </section>
      </div>` : `
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
      </section>
    `}`;
}

function renderReturns() {
  return `
    ${sampleNotice()}
    ${pageIntro(
      'PURCHASE RETURNS',
      '采购退货',
      '这里只处理 SHEIN 采购退货申请、退货单与报废单，不展示消费者退货或消费者退款。',
      '<span>采购退货事实</span><strong>尚未接入</strong><small>与消费者售后严格分离</small>',
    )}
    ${integrationGate({
      kicker: 'RETURN DATA',
      title: '采购退货接入条件',
      description: '采购退货是供应链逆向单据，不能套用半托消费者退货口径。',
      evidence: [
        '回读采购退货申请、退货单、报废单和商品详情',
        '保存申请、确认、出库、收货等平台业务时间与状态',
        '按采购单、退货单、包裹与商品键建立可追溯关联',
        '对账申请数量、退货数量、报废数量及异常原因',
        'Webhook 变化通知与主动补查、日终补漏形成闭环',
      ],
      boundary: '当前没有采购退货事实，因此不展示退货数、退货率、退款金额或待确认任务。',
      futureFields: '采购单号、退货申请、退货/报废单、包裹、商品、数量、原因、状态、节点时间',
    })}`;
}

function renderFinance() {
  return `
    ${sampleNotice()}
    ${pageIntro(
      'RECONCILIATION',
      '财务结算',
      '报账单、预计收入、销售款、客退款、补扣款与付款状态必须来自可追溯的财务事实。',
      '<span>金额事实</span><strong>完全未接入</strong><small>本页不显示示例金额</small>',
    )}
    ${integrationGate({
      kicker: 'FINANCE DATA',
      title: '财务域接入条件',
      description: '只有销量件数不能推导销售款、补扣款、付款或利润。',
      evidence: [
        '回读财务管理业务权限、店铺授权与只读接口范围',
        '探针报账单、报账明细、付款状态与补扣款记录',
        '确认报账期间、币种、销售款、客退款与调整项口径',
        '建立报账单和明细级对账键并保留原始凭证与快照时间',
        '与平台页面抽样核验后才开放差异和汇总视图',
      ],
      boundary: '当前没有报账、销售款、客退款、补扣款或付款事实。本页不会显示 0、占位金额、GMV 或由销量推导的估算值。',
      futureFields: '报账期间、报账单号、币种、预计收入、销售款、客退款、补扣款、付款状态、凭证',
    })}`;
}

function queueHasEvidence(queue) {
  if (!queue || typeof queue !== 'object') return false;
  return [
    'queued',
    'running',
    'retry',
    'deadLetter',
    'expiredLeases',
    'oldestReadyAt',
    'lastReceivedAt',
    'lastProcessedAt',
    'hydrationPending',
    'blockedStores',
  ].some((key) => queue[key] !== undefined && queue[key] !== null);
}

function queueMetric(queue, key) {
  return nullableUnits(queue?.[key]);
}

function safeProjectionSummary(value) {
  if (value === null || value === undefined) return '安全投影为空';
  if (typeof value !== 'object') return String(value);
  const entries = Object.entries(value).slice(0, 4);
  if (!entries.length) return '安全投影为空';
  return entries.map(([key, item]) => {
    if (Array.isArray(item)) return `${key}: ${item.slice(0, 3).join('、')}`;
    if (item && typeof item === 'object') return `${key}: [结构化数据]`;
    return `${key}: ${String(item ?? '—')}`;
  }).join(' · ');
}

function webhookQueueView(queue) {
  if (!queueHasEvidence(queue)) {
    return emptyEvidence(
      'Webhook 队列运行态未接入',
      '没有队列快照时不显示等待数、重试数或死信数为 0。',
      '接入后展示排队、处理中、重试、死信、租约和最近收发时间。',
    );
  }
  return `
    ${operationSummaryCards([
      {
        label: '等待处理',
        value: queueMetric(queue, 'queued'),
        note: '明确返回的排队任务数',
        tone: isUnit(queue.queued) && queue.queued === 0 ? 'available' : 'partial',
      },
      {
        label: '处理中 / 重试',
        value: `${queueMetric(queue, 'running')} / ${queueMetric(queue, 'retry')}`,
        note: '运行中与待重试分开统计',
      },
      {
        label: '死信 / 过期租约',
        value: `${queueMetric(queue, 'deadLetter')} / ${queueMetric(queue, 'expiredLeases')}`,
        note: '只显示真实队列快照；— 表示未知',
        tone: (isUnit(queue.deadLetter) && queue.deadLetter > 0) || (isUnit(queue.expiredLeases) && queue.expiredLeases > 0)
          ? 'blocked'
          : '',
      },
      {
        label: '待补查 / 受阻店铺',
        value: `${queueMetric(queue, 'hydrationPending')} / ${queueMetric(queue, 'blockedStores')}`,
        note: '事件收件与业务详情补查分开',
      },
    ])}
    <div class="queue-time-strip">
      <div><span>最早待处理</span><strong>${escapeHtml(sourceTime(queue.oldestReadyAt))}</strong></div>
      <div><span>最近收件</span><strong>${escapeHtml(sourceTime(queue.lastReceivedAt))}</strong></div>
      <div><span>最近处理</span><strong>${escapeHtml(sourceTime(queue.lastProcessedAt))}</strong></div>
    </div>`;
}

function webhookRuntimeLabel(component, label) {
  if (!component) return `${label} 运行态未知`;
  if (component.fresh === true && component.status === 'RUNNING') {
    return `${label} 在线 · ${sourceTime(component.lastSeenAt)}`;
  }
  return `${label} 心跳失效 · ${sourceTime(component.lastSeenAt)}`;
}

function webhookSubscriptionTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '订阅回读尚无事实行',
      '没有订阅回读时不把任何事件类型标记为已订阅或未订阅。',
    );
  }
  return `
    <div class="table-wrap">
      <table class="data-table webhook-table">
        <thead><tr><th scope="col">应用 / 事件</th><th scope="col">期望状态</th><th scope="col">回读状态</th><th scope="col">回调校验</th><th scope="col">检查时间</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.eventCode || '事件编码未知')}</strong><span>${escapeHtml(row.appFingerprint || '应用指纹未知')}</span></td>
            <td><span class="row-status ${sourceStatusTone(row.desiredState)}">${escapeHtml(row.desiredState || '未知')}</span></td>
            <td><span class="row-status ${sourceStatusTone(row.observedState)}">${escapeHtml(row.observedState || '未知')}</span></td>
            <td>${row.callbackValidated === true
              ? '<span class="row-status complete">已校验</span>'
              : row.callbackValidated === false
                ? '<span class="row-status blocked">未通过</span>'
                : '<span class="row-status unknown">未知</span>'}</td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.checkedAt || row.updatedAt))}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function webhookEventTimeline(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有可归属的平台事件',
      '这不代表平台没有动态；事件可能尚未接入、无法归属店铺，或未命中当前筛选。',
    );
  }
  const sorted = [...rows].sort((left, right) => {
    const leftTime = new Date(left.occurredAt || left.createdAt || 0).valueOf();
    const rightTime = new Date(right.occurredAt || right.createdAt || 0).valueOf();
    return rightTime - leftTime;
  });
  return `
    <ol class="event-timeline">
      ${sorted.slice(0, 60).map((event) => `
        <li class="${sourceStatusTone(event.severity || event.status)}">
          <div class="event-marker" aria-hidden="true"></div>
          <article>
            <header>
              <div>
                <span>${escapeHtml([event.eventFamily, event.eventCode].filter(Boolean).join(' · ') || '平台事件')}</span>
                <strong>${escapeHtml(event.eventPath || event.businessType || '事件路径待确认')}</strong>
              </div>
              <time>${escapeHtml(sourceTime(event.occurredAt || event.createdAt))}</time>
            </header>
            <p>${escapeHtml(safeProjectionSummary(event.safeProjection))}</p>
            <footer>
              <span>${escapeHtml([event.storeCode, event.businessKey].filter(Boolean).join(' · ') || '技术级事件')}</span>
              <span class="row-status ${sourceStatusTone(event.status)}">${escapeHtml(event.status || event.action || '状态未知')}</span>
              ${event.severity ? `<span class="severity-label ${sourceStatusTone(event.severity)}">${escapeHtml(event.severity)}</span>` : ''}
            </footer>
          </article>
        </li>`).join('')}
    </ol>
    ${sorted.length > 60 ? `<p class="table-note">当前显示最近 60 条，共命中 ${numberFormatter.format(sorted.length)} 条；请继续使用筛选缩小范围。</p>` : ''}`;
}

function renderPlatform() {
  const platform = platformDomain();
  const queue = platform.queue && typeof platform.queue === 'object' ? platform.queue : null;
  const subscriptions = domainRows(platform, 'subscriptions');
  const allEvents = domainRows(platform, 'events');
  const events = scopedOperationRows(allEvents);
  const runtimeHealthy = platform.health?.ok === true;
  const runtimeDegraded = platform.health?.ok === false;
  const receiverReady = platform.health?.receiver?.fresh === true;
  const workerReady = platform.health?.worker?.fresh === true;
  const connected = platformAvailable();
  const evidenceLabels = [
    allEvents.length ? `${numberFormatter.format(allEvents.length)} 条事件` : null,
    subscriptions.length ? `${numberFormatter.format(subscriptions.length)} 条订阅回读` : null,
    queueHasEvidence(queue) ? '队列仓库快照可见' : null,
    platform.health?.receiver ? webhookRuntimeLabel(platform.health.receiver, 'Receiver') : null,
    platform.health?.worker ? webhookRuntimeLabel(platform.health.worker, 'Worker') : null,
  ].filter(Boolean);
  const eventGroups = [
    ['商品与合规', '商品接收、审核、删除、额度、建议零售价、合规失效'],
    ['采购与履约', '采购单、发货单、物流预报、缺货需求'],
    ['采购退货', '退货申请、退货单、报废单'],
    ['授权关系', '店铺授权关系变化'],
  ];
  return `
    ${sampleNotice()}
    ${pageIntro(
      'WEBHOOK EVENTS',
      '平台动态',
      'Webhook 负责及时通知“发生变化”；Worker 只解密并生成白名单事件和补查指令，详情由独立只读同步器补齐。',
      `<span>事件链路</span><strong>${runtimeHealthy ? 'Receiver / Worker 在线' : runtimeDegraded ? '已接入 · 运行态需关注' : connected ? '仓库证据已接入 · Runtime 待回读' : '尚未接入'}</strong><small>${escapeHtml(connected ? (evidenceLabels.join(' · ') || '已有仓库证据，业务数量仍未知') : '没有事件统计时不显示 0')}</small>`,
    )}
    <section class="process-panel">
      ${panelHeading('EVENT PIPELINE', '事件处理链路', '快速回执，业务处理不阻塞回调')}
      <ol class="process-flow four-steps">
        <li class="${receiverReady ? 'pipeline-ready' : ''}"><span>01</span><div><strong>验签与快速回执</strong><p>Receiver 校验应用身份、时间戳和签名，只保存加密 eventData。</p></div><b>${receiverReady ? 'Receiver 在线' : platform.health?.receiver ? '心跳失效' : '待心跳'}</b></li>
        <li class="${queueHasEvidence(queue) ? 'pipeline-ready' : ''}"><span>02</span><div><strong>Receipt 与队列</strong><p>原始回执、幂等键与队列消息同事务保存并快速返回 2xx。</p></div><b>${queueHasEvidence(queue) ? '运行态可见' : '待证据'}</b></li>
        <li class="${workerReady ? 'pipeline-ready' : ''}"><span>03</span><div><strong>解密与规范化</strong><p>Worker 解密后只写白名单事件；需要详情时生成待补查指令，不直接调用 OpenAPI。</p></div><b>${workerReady ? 'Worker 在线' : platform.health?.worker ? '心跳失效' : '待心跳'}</b></li>
        <li class="${events.length || subscriptions.length ? 'pipeline-ready' : ''}"><span>04</span><div><strong>回读与独立补漏</strong><p>订阅状态必须回读；定时同步器独立补齐事实，事件本身不等于详情已入仓。</p></div><b>${events.length || subscriptions.length ? '证据可见' : '待证据'}</b></li>
      </ol>
    </section>
    <section class="table-section">
      ${panelHeading('QUEUE HEALTH', 'Webhook 队列健康', runtimeHealthy ? 'Receiver / Worker 心跳均在有效期内' : runtimeDegraded ? '至少一个运行进程心跳失效，请检查服务、死信与受阻店铺' : '仅有仓库/队列证据；Receiver / Worker 运行态未知，不补充健康结论')}
      ${webhookQueueView(queue)}
    </section>
    <div class="split-grid">
      <section class="panel">
        ${panelHeading('SUBSCRIPTION READBACK', '订阅回读', subscriptions.length ? `${subscriptions.length} 条真实回读` : '最终以 DL 应用后台可订阅清单为准')}
        ${subscriptions.length
          ? webhookSubscriptionTable(subscriptions)
          : `<ul class="condition-list">${eventGroups.map(([title, detail]) => `<li><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></li>`).join('')}</ul>`}
      </section>
      <section class="panel">
        ${panelHeading('EVENT DIRECTORY', '全托重点事件目录', '目录不是订阅成功证据')}
        <ul class="condition-list">
          ${eventGroups.map(([title, detail]) => `<li><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></li>`).join('')}
        </ul>
      </section>
    </div>
    <section class="table-section event-section">
      ${panelHeading('EVENT TIMELINE', '平台事件时间线', operationScopeNote(events, '平台事件'))}
      ${webhookEventTimeline(events)}
    </section>`;
}

function actionCandidateTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '只读候选池尚无事实行',
      '没有候选池快照时不展示“0 个建议”，也不会根据销量自动生成提交动作。',
      '供给、缺货和平台事件形成可追溯证据后，仅生成 observe-only 候选。',
    );
  }
  return `
    <div class="table-wrap">
      <table class="data-table action-table">
        <thead><tr><th scope="col">店铺 / 对象</th><th scope="col">候选类型</th><th scope="col">严重度</th><th scope="col">建议标题</th><th scope="col">证据原因</th><th scope="col">证据时间</th><th scope="col">动作</th></tr></thead>
        <tbody>${rows.map((candidate) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(candidate.storeCode || '店铺待确认')}</strong><span>${escapeHtml(candidate.entityCode || candidate.candidateKey || '对象待确认')}</span></td>
            <td><span class="row-status partial">${escapeHtml(candidate.type || '类型未知')}</span></td>
            <td><span class="severity-label ${sourceStatusTone(candidate.severity)}">${escapeHtml(candidate.severity || '未知')}</span></td>
            <td class="entity-column"><strong>${escapeHtml(candidate.title || '运营建议')}</strong><span>${escapeHtml(candidate.candidateKey || '')}</span></td>
            <td class="boundary-cell">${escapeHtml(candidate.reason || '证据原因待确认')}</td>
            <td class="boundary-cell">${escapeHtml(sourceTime(candidate.evidenceAt))}</td>
            <td><button class="inline-disabled-action" type="button" disabled>仅观察</button></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">候选池仅用于观察、筛选和人工判断。当前页面不会生成 dry-run，也不会发出任何 SHEIN 写请求。</p>`;
}

function renderOps() {
  const actionPool = actionPoolDomain();
  const allCandidates = domainRows(actionPool, 'candidates');
  const candidates = scopedOperationRows(allCandidates);
  const poolConnected = allCandidates.length > 0;
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
      `<span>执行能力</span><strong>${poolConnected ? '只读候选池' : '只读建议'}</strong><small>${escapeHtml(actionPool.writeEnabled === false ? '服务端写开关已关闭' : '没有可用写 API')}</small>`,
    )}
    <section class="table-section">
      ${panelHeading('OBSERVE-ONLY POOL', '只读运营候选池', poolConnected ? operationScopeNote(candidates, '候选') : '没有真实候选行时不显示伪 0')}
      ${actionCandidateTable(candidates)}
    </section>
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
          <li><strong>供给 / 履约事实</strong><span class="state-text ${supplyAvailable() ? 'available' : 'pending'}">${supplyAvailable() ? '只读可用' : '待接入'}</span></li>
          <li><strong>运营候选池</strong><span class="state-text ${poolConnected ? 'available' : 'pending'}">${poolConnected ? '观察模式可用' : '待接入'}</span></li>
          <li><strong>写权限</strong><span class="state-text locked">明确关闭</span></li>
          <li><strong>dry-run 与审计执行器</strong><span class="state-text locked">未接入</span></li>
        </ul>
      </section>
      <section class="panel action-lock">
        <span>WRITE ACTIONS</span>
        <strong>写动作已关闭</strong>
        <p>当前候选池 mode=${escapeHtml(actionPool.mode || 'observe_only')}，writeEnabled=${actionPool.writeEnabled === true ? 'true' : 'false'}。本页所有动作按钮均禁用，不会发出提交请求。</p>
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
  const runtimeLabel = healthOk ? '云端服务响应正常' : '未取得 /health 运行态';
  const runtimeNote = healthOk
    ? `${state.health.service || 'shein-full-managed-bi'} · ${state.health.readOnly === true ? '只读' : '模式待确认'}`
    : (state.healthError || '运行态接口尚未返回');
  const dataTone = datasetStatus() === 'live' ? 'complete' : datasetStatus() === 'sample' ? 'pending' : 'unknown';
  const permissionTone = permission.status === 'granted'
    ? 'complete'
    : permission.status === 'denied'
      ? 'blocked'
      : permission.status || 'unknown';
  const supply = supplyDomain();
  const platform = platformDomain();
  const actionPool = actionPoolDomain();
  const supplyFacts = [
    ...domainRows(supply, 'purchaseOrderStatus'),
    ...domainRows(supply, 'deliveryMilestones'),
    ...domainRows(supply, 'inventory'),
    ...domainRows(supply, 'stockAdvice'),
  ];
  const platformFacts = domainRows(platform, 'events');
  const subscriptionFacts = domainRows(platform, 'subscriptions');
  const actionFacts = domainRows(actionPool, 'candidates');
  const supplyCoverageStates = Object.keys(SUPPLY_COVERAGE_META)
    .map(supplyCoverageDomain)
    .filter(coverageHasEvidence);
  const supplyCoverageBlocked = supplyCoverageStates.some((coverage) => coverage.status === 'blocked');
  const supplyLabel = supplyFacts.length
    ? '供应链事实可读'
    : supplyCoverageStates.length
      ? '同步覆盖证据可读 · 暂无事实行'
      : supply.status === 'available' ? '连接可用 · 覆盖未知' : '供应链待接入';
  const platformLabel = platformAvailable()
    ? (platform.health?.ok === true
      ? 'Webhook Receiver / Worker 在线'
      : platform.health?.ok === false
        ? 'Webhook 运行态需关注'
        : 'Webhook 仓库证据可读 · Runtime 未知')
    : platform.status === 'available' ? '连接可用 · 运行态未知' : 'Webhook 待接入';
  const actionLabel = actionFacts.length
    ? '只读候选池可用'
    : actionPool.mode === 'observe_only' ? '观察模式 · 暂无候选行' : '候选池待接入';
  const cards = [
    ['销量数据集', datasetLabel(), state.data?.updatedAt ? `快照：${formatDateTime(state.data.updatedAt)}` : '暂无有效快照', dataTone],
    ['销量权限', permission.label || '权限待确认', permissionCount, permissionTone],
    ['接口模式', state.data?.readOnly === true ? '只读白名单' : '模式待确认', `schema v${isUnit(state.data?.schemaVersion) ? state.data.schemaVersion : '—'}`, state.data?.readOnly === true ? 'complete' : 'unknown'],
    ['云端运行态', runtimeLabel, runtimeNote, healthOk ? 'complete' : 'unknown'],
    ['供应链只读链路', supplyLabel, supplyFacts.length
      ? `${numberFormatter.format(supplyFacts.length)} 条聚合事实行`
      : supplyCoverageStates.length
        ? `${numberFormatter.format(supplyCoverageStates.length)} 个域有同步证据；空数组不补成业务 0`
        : '空数组不补成业务 0', supplyCoverageBlocked ? 'blocked' : supplyFacts.length ? 'complete' : supplyCoverageStates.length ? 'partial' : supply.status === 'available' ? 'pending' : 'unknown'],
    ['Webhook 链路', platformLabel, platformAvailable()
      ? ([
        platformFacts.length ? `${numberFormatter.format(platformFacts.length)} 条事件` : null,
        subscriptionFacts.length ? `${numberFormatter.format(subscriptionFacts.length)} 条订阅回读` : null,
        queueHasEvidence(platform.queue) ? '队列运行态可见' : null,
      ].filter(Boolean).join(' · ') || '仅健康探针已回读，业务数量未知')
      : '队列、订阅与事件均无证据', platform.health?.ok === false ? 'blocked' : platform.health?.ok === true ? 'complete' : platformAvailable() ? 'partial' : 'unknown'],
    ['自动化运营', actionLabel, actionFacts.length ? `${numberFormatter.format(actionFacts.length)} 条 observe-only 候选` : '所有写按钮持续禁用', actionFacts.length ? 'pending' : 'unknown'],
    ['写动作总闸', actionPool.writeEnabled === true ? '配置异常：写开关开启' : '关闭', actionPool.writeEnabled === true ? '首版要求 writeEnabled=false，请立即检查' : '前端无可用提交入口', actionPool.writeEnabled === true ? 'blocked' : 'complete'],
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

function supplyCoverageTable() {
  const rows = Object.entries(SUPPLY_COVERAGE_META).map(([key, label]) => {
    const coverage = supplyCoverageDomain(key) || {};
    const succeeded = isUnit(coverage.succeededStores)
      ? numberFormatter.format(coverage.succeededStores)
      : '—';
    const total = isUnit(coverage.totalStores)
      ? numberFormatter.format(coverage.totalStores)
      : '—';
    const failed = isUnit(coverage.failedStores)
      ? numberFormatter.format(coverage.failedStores)
      : '—';
    const missing = Array.isArray(coverage.missingStoreCodes)
      ? coverage.missingStoreCodes.length
      : coverage.missingStores;
    const stale = isUnit(coverage.staleStores)
      ? numberFormatter.format(coverage.staleStores)
      : '—';
    const inProgress = isUnit(coverage.inProgressStores)
      ? numberFormatter.format(coverage.inProgressStores)
      : '—';
    const windowLabel = coverage.watermarkStart || coverage.watermarkEnd
      ? `${coverage.watermarkStart ? sourceTime(coverage.watermarkStart) : '起点未知'} → ${coverage.watermarkEnd ? sourceTime(coverage.watermarkEnd) : '终点未知'}`
      : '业务窗口未知';
    return {
      key,
      label,
      coverage,
      succeeded,
      total,
      failed,
      missing: isUnit(missing) ? numberFormatter.format(missing) : '—',
      stale,
      inProgress,
      windowLabel,
    };
  });
  return `
    <div class="table-wrap">
      <table class="data-table supply-coverage-table">
        <thead><tr><th scope="col">只读域</th><th scope="col">最新状态</th><th scope="col">成功覆盖</th><th scope="col">失败 / 缺失 / 过期 / 同步中</th><th scope="col">模式与业务窗口</th><th scope="col">证据与下一步</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.key)}</span></td>
            <td><span class="row-status ${readinessClass(row.coverage.status)}">${escapeHtml(row.coverage.status || 'unknown')}</span></td>
            <td>${escapeHtml(`${row.succeeded} / ${row.total} 家`)}</td>
            <td>${escapeHtml(`${row.failed} / ${row.missing} / ${row.stale} / ${row.inProgress}`)}</td>
            <td class="boundary-cell"><strong>${escapeHtml(row.coverage.mode || '模式未知')}</strong><span>${escapeHtml(row.windowLabel)}</span><small>${escapeHtml(isUnit(row.coverage.freshnessMaxAgeSeconds) ? `时效门槛 ${Math.round(row.coverage.freshnessMaxAgeSeconds / 3600)} 小时` : '时效门槛未知')}</small></td>
            <td class="boundary-cell"><strong>${escapeHtml(row.coverage.latestFetchedAt ? sourceTime(row.coverage.latestFetchedAt) : '尚无最新成功/失败尝试时间')}</strong><span>${escapeHtml(row.coverage.reason || '同步尝试、时效与覆盖证据待接入')}</span></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">这里展示最新同步尝试、覆盖和时效证据；历史成功不能掩盖当前失败，完整空结果也不会被解释成业务数量为 0。</p>`;
}

function renderSystem() {
  const supply = supplyDomain();
  const platform = platformDomain();
  const actionPool = actionPoolDomain();
  const procurementState = domainConnectionState(
    supply,
    ['purchaseOrderStatus'],
    ['purchaseOrders'],
  );
  const fulfilmentState = domainConnectionState(
    supply,
    ['deliveryMilestones'],
    ['deliveries'],
  );
  const inventoryState = domainConnectionState(
    supply,
    ['inventory', 'stockAdvice'],
    ['inventory', 'stockAdvice'],
  );
  const procurementConnected = procurementState === 'available';
  const fulfilmentConnected = fulfilmentState === 'available';
  const inventoryConnected = inventoryState === 'available';
  const webhookConnected = platformAvailable();
  const candidateConnected = domainRows(actionPool, 'candidates').length > 0;
  return `
    ${sampleNotice()}
    ${pageIntro(
      'SYSTEM HEALTH',
      '系统健康',
      '把数据集、权限、接口探针、事实入仓和云端运行态分开判断。',
      `<span>API schema</span><strong>v${isUnit(state.data?.schemaVersion) ? state.data.schemaVersion : '—'}</strong><small>/api/dashboard · GET only</small>`,
    )}
    ${datasetOverview()}
    <section class="table-section">
      ${panelHeading('READINESS LEDGER', '五阶段接入台账', '数量未知时显示“证据待接入”，不补零')}
      ${readinessTable()}
    </section>
    <section class="table-section">
      ${panelHeading('SUPPLY COVERAGE', '供应链同步覆盖水位', '按店铺 × 域读取最新尝试；失败、缺失、时效和业务窗口分开展示')}
      ${supplyCoverageTable()}
    </section>
    <section class="capability-section">
      ${panelHeading('DATA CAPABILITIES', '数据与动作能力', '以当前页面实际消费的字段为准')}
      <div class="capability-grid">
        <article class="available"><span>销量数量</span><strong>可读取</strong><p>总量、店铺排行、SKU 排行；可选日趋势。</p></article>
        <article class="partial"><span>商品身份</span><strong>部分可见</strong><p>SKU 销量清单可读，完整商品主数据待探针。</p></article>
        <article class="${procurementConnected ? 'available' : 'pending'}"><span>采购单</span><strong>${procurementConnected ? '状态事实可读' : '未接入'}</strong><p>${procurementConnected ? '按店铺和平台状态显示真实采购单数。' : '没有事实行时不显示采购单数为 0。'}</p></article>
        <article class="${fulfilmentConnected ? 'available' : 'pending'}"><span>交付与入仓</span><strong>${fulfilmentConnected ? '里程碑可读' : '未接入'}</strong><p>${fulfilmentConnected ? '交付单数、数量和覆盖率分开显示。' : '没有事实行时不推导履约率或异常数。'}</p></article>
        <article class="${inventoryConnected ? 'available' : 'pending'}"><span>库存与供给</span><strong>${inventoryConnected ? '只读快照可见' : '未接入'}</strong><p>${inventoryConnected ? '库存、在途、缺货和备货建议保留未知值。' : '没有快照时不显示库存或建议为 0。'}</p></article>
        <article class="${webhookConnected ? (platform.health?.ok === false ? 'locked' : platform.health?.ok === true ? 'available' : 'partial') : 'pending'}"><span>平台动态</span><strong>${webhookConnected ? (platform.health?.ok === false ? '已接入 · 需关注' : platform.health?.ok === true ? 'Receiver / Worker 在线' : '仓库可读 · Runtime 未知') : '未接入'}</strong><p>${webhookConnected ? '队列、订阅回读、进程心跳和事件时间线分开取证。' : '没有运行态时不显示事件数或队列数为 0。'}</p></article>
        <article class="${candidateConnected ? 'partial' : 'pending'}"><span>运营候选池</span><strong>${candidateConnected ? '观察模式可用' : '未接入'}</strong><p>${candidateConnected ? '候选可筛选，所有执行入口仍禁用。' : '没有候选快照时不展示伪 0。'}</p></article>
        <article class="pending"><span>财务事实</span><strong>未接入</strong><p>没有金额、订单、结算、成本或利润字段。</p></article>
        <article class="${actionPool.writeEnabled === true ? 'locked' : 'available'}"><span>自动化写动作</span><strong>${actionPool.writeEnabled === true ? '配置异常' : '关闭'}</strong><p>${actionPool.writeEnabled === true ? '服务端写开关不符合首版安全要求。' : '所有已登录员工可读全店数据；任何写操作仍保持关闭。'}</p></article>
      </div>
    </section>`;
}

function renderRoute() {
  const renderers = {
    home: renderHome,
    procurement: renderProcurement,
    fulfilment: renderFulfilment,
    products: renderProducts,
    sales: renderSales,
    inventory: renderInventory,
    returns: renderReturns,
    compliance: renderCompliance,
    finance: renderFinance,
    platform: renderPlatform,
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
      <div><span class="eyebrow">DATA UNAVAILABLE</span><h1>暂时无法读取运营数据</h1><p>错误已显示在首屏。修复云端数据服务后重新加载，不会使用旧快照或占位数冒充结果。</p></div>
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
  elements.owner.value = state.owner;
  elements.store.value = state.store;
  elements.rangeButtons.forEach((button) => {
    const active = button.dataset.range === state.range;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const hasFilters = Boolean(state.query.trim())
    || state.owner !== 'ALL'
    || state.store !== 'ALL'
    || state.range !== 'today';
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

function populateOwnerOptions() {
  const previous = state.owner;
  const owners = allOwners();
  const fragment = document.createDocumentFragment();
  const allOption = document.createElement('option');
  allOption.value = 'ALL';
  allOption.textContent = owners.length ? '全部负责人' : '负责人未接入';
  fragment.append(allOption);

  owners.forEach((owner) => {
    const option = document.createElement('option');
    option.value = owner.key;
    option.textContent = `${owner.name} · ${owner.storeCodes.length} 家店`;
    fragment.append(option);
  });
  elements.owner.replaceChildren(fragment);
  state.owner = owners.some((owner) => owner.key === previous) ? previous : 'ALL';
  elements.owner.value = state.owner;
  elements.owner.disabled = owners.length === 0;
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
    throw new Error(message || `云端数据服务返回 HTTP ${response.status}`);
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
    populateOwnerOptions();
    populateStoreOptions();
  } catch (error) {
    state.data = null;
    state.error = error instanceof Error ? error.message : '云端只读数据服务暂不可用。';
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

elements.owner.addEventListener('change', (event) => {
  state.owner = event.currentTarget.value;
  state.store = 'ALL';
  populateStoreOptions();
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
  state.owner = 'ALL';
  state.store = 'ALL';
  state.range = 'today';
  populateOwnerOptions();
  populateStoreOptions();
  render();
  elements.search.focus();
});

elements.retryButton.addEventListener('click', loadDashboard);
elements.logoutButton.addEventListener('click', async () => {
  elements.logoutButton.disabled = true;
  try {
    await fetch('/api/logout', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
  } finally {
    window.location.assign('/login');
  }
});
window.addEventListener('hashchange', syncRouteFromLocation);

const initialHashRoute = String(window.location.hash || '').replace(/^#/, '');
if (!Object.prototype.hasOwnProperty.call(ROUTES, initialHashRoute)) {
  window.history.replaceState(null, '', '#home');
}
render();
loadDashboard();
