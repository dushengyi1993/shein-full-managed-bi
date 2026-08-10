const STORE_PATTERN = /^[A-Z0-9]{2,12}$/;
const OWNER_PATTERN = /^[\p{L}\p{N}._:-]{1,64}$/u;
const INTEGER_PATTERN = /^[1-9][0-9]*$/;
const QUERY_PARAMETERS = Object.freeze(new Set([
  'owner',
  'store',
  'q',
  'view',
  'severity',
  'domain',
  'quick',
  'sort',
  'page',
  'pageSize',
]));

const VIEWS = Object.freeze(['PRIORITY', 'ALL']);
const SEVERITIES = Object.freeze(['ALL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
const DOMAINS = Object.freeze([
  'ALL',
  'PROCUREMENT',
  'FULFILMENT',
  'INVENTORY',
  'SUPPLY',
  'PRODUCTS',
  'PLATFORM',
  'SYSTEM',
  'OTHER',
]);
const QUICK_FILTERS = Object.freeze([
  'ALL',
  'HIGH',
  'OVERDUE',
  'SHORTAGE',
  'URGENT',
  'SYNC',
]);
const SORTS = Object.freeze(['PRIORITY', 'LATEST', 'DEADLINE', 'STORE']);
const PAGE_SIZES = Object.freeze([25, 50, 100]);
const QUANTITY_FORMATTER = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 2,
});

const SEVERITY_RANK = Object.freeze({
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
});

const TRIAGE_LIMIT = 12;

const DOMAIN_META = Object.freeze({
  PROCUREMENT: Object.freeze({ label: '采购单', route: 'procurement' }),
  FULFILMENT: Object.freeze({ label: '交付入仓', route: 'fulfilment' }),
  INVENTORY: Object.freeze({ label: '库存与缺货', route: 'inventory' }),
  SUPPLY: Object.freeze({ label: '备货建议', route: 'inventory' }),
  PRODUCTS: Object.freeze({ label: '商品身份', route: 'products' }),
  PLATFORM: Object.freeze({ label: '平台动态', route: 'platform' }),
  SYSTEM: Object.freeze({ label: '数据质量', route: 'system' }),
  OTHER: Object.freeze({ label: '其他事项', route: 'ops' }),
});

const CANDIDATE_META = Object.freeze({
  PURCHASE_ORDER_OVERDUE: {
    title: '采购单逾期',
    domain: 'PROCUREMENT',
    nextStep: '核对采购单要求时间、当前节点和未完成数量',
  },
  DELIVERY_OVERDUE: {
    title: '交付单逾期',
    domain: 'FULFILMENT',
    nextStep: '核对交付里程碑、物流状态和预计收货时间',
  },
  SKU_SHORTAGE_REVIEW: {
    title: '缺货 SKU',
    domain: 'INVENTORY',
    nextStep: '核对缺货数量、可用库存与在途数量',
  },
  SKU_URGENT_SUPPLY_REVIEW: {
    title: 'SKU 急采复核',
    domain: 'SUPPLY',
    nextStep: '优先核对急采量、已下单量和待交付供给',
  },
  SKU_STOCK_WARNING_REVIEW: {
    title: 'SKU 库存预警',
    domain: 'SUPPLY',
    nextStep: '核对平台预警、可用库存与供给状态',
  },
  SKU_RESTOCK_ADVICE_REVIEW: {
    title: 'SKU 建议备货',
    domain: 'SUPPLY',
    nextStep: '核对平台建议量、已下单量和在途量',
  },
  SHORTAGE_REVIEW: {
    title: '缺货复核',
    domain: 'INVENTORY',
    nextStep: '核对缺货 SKU、可用库存与在途数量',
  },
  INVENTORY_RECONCILIATION: {
    title: '库存对账',
    domain: 'INVENTORY',
    nextStep: '核对库存汇总与仓库分项差异',
  },
  STOCK_WARNING_REVIEW: {
    title: '库存预警',
    domain: 'INVENTORY',
    nextStep: '按 SKU 复核平台预警与供给状态',
  },
  RESTOCK_ADVICE_REVIEW: {
    title: '建议备货',
    domain: 'SUPPLY',
    nextStep: '核对平台建议量、已下单量和在途量',
  },
  URGENT_SUPPLY_REVIEW: {
    title: '急采复核',
    domain: 'SUPPLY',
    nextStep: '优先核对计划急采量与待交付供给',
  },
  SUPPLY_SYNC_FAILURE_REVIEW: {
    title: '同步失败',
    domain: 'SYSTEM',
    nextStep: '定位失败店铺和数据域，等待成功回读后再判断业务数量',
  },
  SUPPLY_COVERAGE_REVIEW: {
    title: '覆盖缺口',
    domain: 'SYSTEM',
    nextStep: '补齐店铺数据覆盖并确认最新成功水位',
  },
  WEBHOOK_DEAD_LETTER: {
    title: 'Webhook 死信',
    domain: 'PLATFORM',
    nextStep: '检查死信原因并确认业务详情是否已补查',
  },
  AUTHORIZATION_GATE_REVIEW: {
    title: '授权封闸',
    domain: 'SYSTEM',
    nextStep: '复核授权变化及受影响店铺',
  },
});

const DETAILED_CANDIDATE_SOURCE = Object.freeze({
  PURCHASE_ORDER_OVERDUE: 'purchaseOrders',
  DELIVERY_OVERDUE: 'deliveries',
  SKU_SHORTAGE_REVIEW: 'inventoryRisks',
  SHORTAGE_REVIEW: 'inventoryRisks',
  INVENTORY_RECONCILIATION: 'inventoryRisks',
  SKU_URGENT_SUPPLY_REVIEW: 'stockAdviceRisks',
  SKU_STOCK_WARNING_REVIEW: 'stockAdviceRisks',
  SKU_RESTOCK_ADVICE_REVIEW: 'stockAdviceRisks',
  STOCK_WARNING_REVIEW: 'stockAdviceRisks',
  RESTOCK_ADVICE_REVIEW: 'stockAdviceRisks',
  URGENT_SUPPLY_REVIEW: 'stockAdviceRisks',
});

const DETAIL_ARRAY_BY_SOURCE = Object.freeze({
  purchaseOrders: 'purchaseOrderAttention',
  deliveries: 'deliveryAttention',
  inventoryRisks: 'inventoryRisks',
  stockAdviceRisks: 'stockAdviceRisks',
});

export class OpsQueryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OpsQueryError';
    this.code = code;
    this.statusCode = 400;
  }
}

function fail(code, message) {
  throw new OpsQueryError(code, message);
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function assertKnownParameters(params) {
  for (const name of params.keys()) {
    if (!QUERY_PARAMETERS.has(name)) {
      fail('QUERY_PARAMETER_UNKNOWN', `不支持参数 ${name}`);
    }
  }
}

function textParam(params, name, { maximum, pattern, fallback = '' } = {}) {
  const values = params.getAll(name);
  if (values.length > 1) fail('QUERY_PARAMETER_DUPLICATED', `参数 ${name} 不能重复`);
  if (values.length === 0) return fallback;
  const value = values[0].trim();
  if (value.length > maximum) fail('QUERY_PARAMETER_TOO_LONG', `参数 ${name} 过长`);
  if (pattern && value !== '' && !pattern.test(value)) {
    fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
  }
  return value;
}

function enumParam(params, name, allowed, fallback) {
  const value = textParam(params, name, { maximum: 40, fallback }).toUpperCase();
  if (!allowed.includes(value)) fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
  return value;
}

function integerParam(params, name, { fallback, minimum, maximum }) {
  const value = textParam(params, name, { maximum: 8, fallback: String(fallback) });
  if (!INTEGER_PATTERN.test(value)) fail('QUERY_PARAMETER_INVALID', `参数 ${name} 必须是整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('QUERY_PARAMETER_OUT_OF_RANGE', `参数 ${name} 超出范围`);
  }
  return parsed;
}

function pageSizeParam(params) {
  const value = integerParam(params, 'pageSize', {
    fallback: 25,
    minimum: 1,
    maximum: 100,
  });
  if (!PAGE_SIZES.includes(value)) {
    fail('QUERY_PARAMETER_OUT_OF_RANGE', '参数 pageSize 只能是 25、50 或 100');
  }
  return value;
}

function searchable(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function severityRank(value) {
  return SEVERITY_RANK[String(value ?? '').toUpperCase()] ?? 0;
}

function normalizedSeverity(value) {
  const normalized = String(value ?? '').toUpperCase();
  return Object.hasOwn(SEVERITY_RANK, normalized) ? normalized : 'UNKNOWN';
}

function comparableInstant(value, fallback = 0) {
  const parsed = new Date(value ?? '').valueOf();
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compactQuantity(parts) {
  return parts
    .filter(([, value]) => finiteNumber(value) !== null && value >= 0)
    .map(([label, value]) => `${label} ${QUANTITY_FORMATTER.format(value)} 件`)
    .join(' · ');
}

function ownerStoreSet(dashboard, ownerKey) {
  if (ownerKey === 'ALL') return null;
  const owner = rows(dashboard.owners).find((item) => item.key === ownerKey);
  if (!owner) fail('QUERY_OWNER_UNKNOWN', '负责人不在当前数据范围内');
  return new Set(rows(owner.storeCodes).map((code) => String(code).toUpperCase()));
}

function matchesScope(item, { store, ownerStores }) {
  const storeCode = String(item.storeCode ?? '').toUpperCase();
  if (store !== 'ALL') return storeCode === store;
  if (ownerStores) return ownerStores.has(storeCode);
  return true;
}

function domainLabel(domain) {
  return DOMAIN_META[domain]?.label ?? DOMAIN_META.OTHER.label;
}

function domainRoute(domain) {
  return DOMAIN_META[domain]?.route ?? DOMAIN_META.OTHER.route;
}

function procurementRows(supply) {
  return rows(supply.purchaseOrderAttention).map((row) => {
    const title = row.attentionLabel
      || (!row.deliveredAt ? '待交付'
        : !row.receivedAt ? '待收货'
          : !row.storedAt ? '待入库'
            : row.statusName || row.statusCode || '采购单待复核');
    const dueAt = row.requestedDeliveryAt || row.requestedReceiptAt || null;
    const type = row.attentionCode || 'PURCHASE_ORDER_ATTENTION';
    return {
      domain: 'PROCUREMENT',
      sourceLabel: domainLabel('PROCUREMENT'),
      type,
      severity: normalizedSeverity(row.severity),
      storeCode: row.storeCode ?? null,
      storeName: row.storeName ?? null,
      objectCode: row.orderNo ?? null,
      objectName: row.orderTypeName || row.statusName || null,
      title,
      impact: compactQuantity([
        ['订购', row.orderQuantity],
        ['交付', row.deliveryQuantity],
        ['收货', row.receiptQuantity],
        ['入库', row.storageQuantity],
        ['残次', row.defectiveQuantity],
      ]) || (dueAt ? `要求时间 ${dueAt}` : '单据数量影响待回读'),
      nextStep: title.includes('交付')
        ? '核对要求交期、订购量与尚未交付数量'
        : title.includes('收货')
          ? '核对已交付数量、要求收货时间与仓库状态'
          : '核对收货、入库和残次数量',
      route: domainRoute('PROCUREMENT'),
      focusDomain: 'procurement',
      focusCode: row.orderNo ?? null,
      evidenceAt: row.latestSourceFetchedAt ?? null,
      dueAt,
      overdue: /OVERDUE|逾期|超时/i.test(`${type} ${title}`),
    };
  });
}

function fulfilmentRows(supply) {
  return rows(supply.deliveryAttention).map((row) => {
    const title = row.attentionLabel
      || (!row.takenAt ? '待揽收'
        : !row.receivedAt ? '运输中 / 待收货'
          : row.milestoneCode || '交付单待复核');
    const type = row.attentionCode || 'DELIVERY_ATTENTION';
    return {
      domain: 'FULFILMENT',
      sourceLabel: domainLabel('FULFILMENT'),
      type,
      severity: normalizedSeverity(row.severity),
      storeCode: row.storeCode ?? null,
      storeName: row.storeName ?? null,
      objectCode: row.deliveryCode ?? null,
      objectName: row.warehouseName || row.expressCompanyName || null,
      title,
      impact: [
        compactQuantity([['交付', row.deliveryQuantity]]),
        row.expectedReceiptAt ? `预计收货 ${row.expectedReceiptAt}` : '',
      ].filter(Boolean).join(' · ') || '交付影响待回读',
      nextStep: title.includes('揽收')
        ? '核对预约揽收和物流交接'
        : title.includes('收货') || title.includes('运输')
          ? '核对预计收货时间、物流状态和交付数量'
          : '核对收货结果与关联采购单',
      route: domainRoute('FULFILMENT'),
      focusDomain: 'fulfilment',
      focusCode: row.deliveryCode ?? null,
      evidenceAt: row.latestSourceFetchedAt ?? null,
      dueAt: row.expectedReceiptAt ?? null,
      overdue: /OVERDUE|逾期|超时/i.test(`${type} ${title}`),
    };
  });
}

function inventoryRows(supply) {
  return rows(supply.inventoryRisks).map((row) => {
    const shortage = finiteNumber(row.shortageQuantity) !== null && row.shortageQuantity > 0;
    const mismatch = String(row.reconciliationStatus || '').toUpperCase() === 'MISMATCH';
    return {
      domain: 'INVENTORY',
      sourceLabel: domainLabel('INVENTORY'),
      type: shortage
        ? 'SHORTAGE_REVIEW'
        : mismatch ? 'INVENTORY_RECONCILIATION' : 'INVENTORY_RISK',
      severity: normalizedSeverity(row.severity),
      storeCode: row.storeCode ?? null,
      storeName: row.storeName ?? null,
      objectCode: row.skuCode ?? null,
      objectName: row.skcName || row.spuName || null,
      title: shortage ? '缺货 SKU' : mismatch ? '库存对账异常' : '库存风险',
      impact: compactQuantity([
        ['缺货', row.shortageQuantity],
        ['可用', row.usableInventory],
        ['在途', row.transitQuantity],
      ]) || '库存数量影响待回读',
      nextStep: shortage
        ? '核对可用库存、在途和平台备货建议'
        : '核对库存汇总与仓库分项',
      route: domainRoute('INVENTORY'),
      focusDomain: 'inventory',
      focusCode: row.skuCode ?? null,
      evidenceAt: row.latestSourceFetchedAt ?? null,
      dueAt: null,
      overdue: false,
    };
  });
}

function supplyRows(supply) {
  return rows(supply.stockAdviceRisks).map((row) => {
    const urgent = finiteNumber(row.plannedUrgentQuantity) !== null
      && row.plannedUrgentQuantity > 0;
    const advised = finiteNumber(row.advisedOrderQuantity) !== null
      && row.advisedOrderQuantity > 0;
    const warning = row.stockWarningIsWarning === true;
    return {
      domain: 'SUPPLY',
      sourceLabel: domainLabel('SUPPLY'),
      type: urgent
        ? 'URGENT_SUPPLY_REVIEW'
        : warning ? 'STOCK_WARNING_REVIEW'
          : advised ? 'RESTOCK_ADVICE_REVIEW' : 'SUPPLY_RISK',
      severity: normalizedSeverity(row.severity),
      storeCode: row.storeCode ?? null,
      storeName: row.storeName ?? null,
      objectCode: row.skuCode ?? null,
      objectName: row.skcName || row.spuName || row.supplierCode || null,
      title: urgent ? '急采复核' : warning ? '库存预警' : advised ? '建议备货' : '供给风险',
      impact: compactQuantity([
        ['预测日销', row.predictedDailySales],
        ['建议', row.advisedOrderQuantity],
        ['急采', row.plannedUrgentQuantity],
        ['库存', row.stockQuantity],
        ['在途', row.transitQuantity],
      ]) || '供给数量影响待回读',
      nextStep: urgent
        ? '核对急采量、已下单量、待交付和在途'
        : advised
          ? '核对平台建议量与当前供给链路'
          : '核对平台预警和供给状态',
      route: domainRoute('SUPPLY'),
      focusDomain: 'advice',
      focusCode: row.skuCode ?? null,
      evidenceAt: row.latestSourceFetchedAt ?? null,
      dueAt: null,
      overdue: false,
    };
  });
}

function detailedSourceHasEvidence(supply, sourceKey) {
  const arrayKey = DETAIL_ARRAY_BY_SOURCE[sourceKey];
  if (arrayKey && rows(supply[arrayKey]).length > 0) return true;
  const meta = record(record(supply.attentionMeta)[sourceKey]);
  return ['returned', 'total', 'truncated', 'available']
    .some((key) => Object.hasOwn(meta, key));
}

function fallbackCandidateRows(dashboard) {
  const supply = record(dashboard.supply);
  return rows(record(dashboard.actionPool).candidates)
    .filter((candidate) => {
      const type = String(candidate.type || '').toUpperCase();
      const detailedSource = DETAILED_CANDIDATE_SOURCE[type];
      return !detailedSource || !detailedSourceHasEvidence(supply, detailedSource);
    })
    .map((candidate) => {
      const type = String(candidate.type || 'OPERATIONS_REVIEW').toUpperCase();
      const meta = CANDIDATE_META[type] || {
        title: candidate.title || '运营复核',
        domain: 'OTHER',
        nextStep: '打开对应业务页核对事实与影响范围',
      };
      return {
        domain: meta.domain,
        sourceLabel: domainLabel(meta.domain),
        type,
        severity: normalizedSeverity(candidate.severity),
        storeCode: candidate.storeCode ?? null,
        storeName: candidate.storeName ?? null,
        objectCode: candidate.entityCode ?? null,
        objectName: null,
        title: meta.title,
        impact: candidate.reason || '影响范围待回读',
        nextStep: meta.nextStep,
        route: domainRoute(meta.domain),
        focusDomain: null,
        focusCode: candidate.entityCode ?? null,
        evidenceAt: candidate.evidenceAt ?? null,
        dueAt: null,
        overdue: /OVERDUE|逾期|超时/i.test(`${type} ${meta.title}`),
      };
    });
}

function aggregateRows(dashboard) {
  const result = [];
  const coverage = record(dashboard.productIdentityCoverage);
  if (
    finiteNumber(coverage.unconfirmedSkus) !== null
    && coverage.unconfirmedSkus > 0
  ) {
    const total = finiteNumber(coverage.totalSkus);
    const share = total && total > 0 ? coverage.unconfirmedSkus / total : null;
    result.push({
      domain: 'PRODUCTS',
      sourceLabel: domainLabel('PRODUCTS'),
      type: 'PRODUCT_IDENTITY_PENDING',
      severity: share !== null && share >= 0.5 ? 'HIGH' : 'MEDIUM',
      storeCode: null,
      storeName: '跨店商品身份',
      objectCode: `${coverage.unconfirmedSkus} 个待归并 SKU`,
      objectName: coverage.note || null,
      title: '标准商品归并待确认',
      impact: total === null
        ? '商品身份总量待确认'
        : `已确认 ${coverage.confirmedSkus ?? '—'} / ${total} 个 SKU`,
      nextStep: '在商品中心按销量影响优先归并；未确认身份不参与跨店合计',
      route: domainRoute('PRODUCTS'),
      focusDomain: null,
      focusCode: null,
      evidenceAt: record(dashboard.productIdentityPipeline).updatedAt || dashboard.updatedAt || null,
      dueAt: null,
      overdue: false,
    });
  }

  const quality = record(dashboard.quality);
  if (!['healthy', 'complete', 'legal_zero'].includes(String(quality.status || '').toLowerCase())) {
    const status = String(quality.status || '').toLowerCase();
    result.push({
      domain: 'SYSTEM',
      sourceLabel: domainLabel('SYSTEM'),
      type: 'SALES_QUALITY_REVIEW',
      severity: ['error', 'blocked'].includes(status)
        ? 'CRITICAL'
        : status === 'stale' ? 'HIGH' : 'MEDIUM',
      storeCode: null,
      storeName: '当前销量范围',
      objectCode: quality.label || '销量质量待确认',
      objectName: null,
      title: `销量质量：${quality.label || '待确认'}`,
      impact: [quality.reason, quality.impact].filter(Boolean).join(' · ')
        || '缺失窗口不会补零，请按现有覆盖解读数字',
      nextStep: quality.nextStep || '在系统健康页核对覆盖水位、统计日与同步失败',
      route: domainRoute('SYSTEM'),
      focusDomain: null,
      focusCode: null,
      evidenceAt: dashboard.updatedAt || null,
      dueAt: null,
      overdue: false,
    });
  }

  const platform = record(dashboard.platform);
  const queue = record(platform.queue);
  if (finiteNumber(queue.deadLetter) !== null && queue.deadLetter > 0) {
    result.push({
      domain: 'PLATFORM',
      sourceLabel: domainLabel('PLATFORM'),
      type: 'WEBHOOK_DEAD_LETTER',
      severity: 'HIGH',
      storeCode: null,
      storeName: '跨店事件链路',
      objectCode: `死信 ${queue.deadLetter} 条`,
      objectName: finiteNumber(queue.expiredLeases) === null
        ? '过期租约未知'
        : `过期租约 ${queue.expiredLeases} 条`,
      title: 'Webhook 死信待处理',
      impact: `未处理事件可能导致采购、交付与库存事实延迟；待补查 ${
        finiteNumber(queue.hydrationPending) === null ? '未知' : queue.hydrationPending
      } 条`,
      nextStep: '在平台动态页核对死信原因、受阻店铺与补查指令',
      route: domainRoute('PLATFORM'),
      focusDomain: null,
      focusCode: null,
      evidenceAt: queue.lastProcessedAt || queue.lastReceivedAt || null,
      dueAt: null,
      overdue: false,
    });
  }
  if (platform.health?.ok === false) {
    result.push({
      domain: 'PLATFORM',
      sourceLabel: domainLabel('PLATFORM'),
      type: 'WEBHOOK_RUNTIME_REVIEW',
      severity: 'HIGH',
      storeCode: null,
      storeName: '跨店事件链路',
      objectCode: 'Receiver / Worker',
      objectName: '心跳失效',
      title: 'Webhook 运行态需关注',
      impact: 'Receiver 或 Worker 健康检查未通过',
      nextStep: '在平台动态页核对进程心跳、队列积压与订阅回读',
      route: domainRoute('PLATFORM'),
      focusDomain: null,
      focusCode: null,
      evidenceAt: platform.health.evaluatedAt || null,
      dueAt: null,
      overdue: false,
    });
  }
  return result;
}

function buildRows(dashboard) {
  const supply = record(dashboard.supply);
  const combined = [
    ...procurementRows(supply),
    ...fulfilmentRows(supply),
    ...inventoryRows(supply),
    ...supplyRows(supply),
    ...fallbackCandidateRows(dashboard),
    ...aggregateRows(dashboard),
  ];
  const deduplicated = new Map();
  for (const item of combined) {
    const key = [
      item.domain,
      item.storeCode,
      item.objectCode || item.type,
    ].join('\u001f');
    if (!deduplicated.has(key)) deduplicated.set(key, item);
  }
  return [...deduplicated.values()];
}

function containsQuery(item, query) {
  if (query === '') return true;
  return [
    item.domain,
    item.sourceLabel,
    item.type,
    item.severity,
    item.storeCode,
    item.storeName,
    item.objectCode,
    item.objectName,
    item.title,
    item.impact,
    item.nextStep,
  ].some((value) => searchable(value).includes(query));
}

function matchesView(item, view) {
  if (view === 'ALL') return true;
  return severityRank(item.severity) >= 3
    || item.overdue === true
    || ['SYSTEM', 'PLATFORM'].includes(item.domain);
}

function matchesQuick(item, quick) {
  if (quick === 'ALL') return true;
  if (quick === 'HIGH') return severityRank(item.severity) >= 3;
  const haystack = [
    item.type,
    item.title,
    item.impact,
    item.domain,
  ].filter(Boolean).join(' ').toUpperCase();
  if (quick === 'OVERDUE') return item.overdue === true;
  if (quick === 'SHORTAGE') return /SHORTAGE|缺货/.test(haystack);
  if (quick === 'URGENT') return /URGENT|急采/.test(haystack);
  if (quick === 'SYNC') return /SYNC|COVERAGE|QUALITY|RUNTIME|同步|覆盖|质量/.test(haystack);
  return true;
}

function compareRows(sort) {
  return (left, right) => {
    if (sort === 'PRIORITY') {
      const severityDelta = severityRank(right.severity) - severityRank(left.severity);
      if (severityDelta) return severityDelta;
      const overdueDelta = Number(right.overdue === true) - Number(left.overdue === true);
      if (overdueDelta) return overdueDelta;
    }
    if (sort === 'DEADLINE') {
      const leftDue = comparableInstant(left.dueAt, Number.POSITIVE_INFINITY);
      const rightDue = comparableInstant(right.dueAt, Number.POSITIVE_INFINITY);
      if (leftDue !== rightDue) return leftDue - rightDue;
    }
    if (sort === 'STORE') {
      const storeDelta = String(left.storeCode || '\uffff').localeCompare(
        String(right.storeCode || '\uffff'),
      );
      if (storeDelta) return storeDelta;
    }
    const timeDelta = comparableInstant(right.evidenceAt) - comparableInstant(left.evidenceAt);
    if (timeDelta) return timeDelta;
    return String(left.objectCode || left.type).localeCompare(
      String(right.objectCode || right.type),
    );
  };
}

function shanghaiDate(value) {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.valueOf())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day
    ? `${values.year}-${values.month}-${values.day}`
    : null;
}

function triageRows(inputRows, businessDate, evidenceComplete) {
  const lanes = { now: [], today: [], watch: [] };
  for (const item of inputRows) {
    if (item.overdue === true || severityRank(item.severity) >= 3) {
      lanes.now.push(item);
    } else if (businessDate && shanghaiDate(item.dueAt) === businessDate) {
      lanes.today.push(item);
    } else {
      lanes.watch.push(item);
    }
  }
  const project = (rowsIn) => {
    const sorted = rowsIn.slice().sort(compareRows('PRIORITY'));
    return Object.freeze({
      total: evidenceComplete ? sorted.length : null,
      returned: Math.min(sorted.length, TRIAGE_LIMIT),
      truncated: evidenceComplete !== true || sorted.length > TRIAGE_LIMIT,
      completeness: evidenceComplete ? 'COMPLETE' : 'PARTIAL',
      rows: Object.freeze(sorted.slice(0, TRIAGE_LIMIT)),
    });
  };
  return Object.freeze({
    businessDate: businessDate || null,
    now: project(lanes.now),
    today: project(lanes.today),
    watch: project(lanes.watch),
  });
}

function countBy(inputRows, keyOf, labelOf = null) {
  const grouped = new Map();
  for (const item of inputRows) {
    const key = String(keyOf(item) ?? '').trim();
    if (!key) continue;
    const current = grouped.get(key) ?? {
      key,
      label: labelOf ? labelOf(item) : key,
      count: 0,
      criticalCount: 0,
      highCount: 0,
      highOrAboveCount: 0,
      latestAt: null,
    };
    current.count += 1;
    if (item.severity === 'CRITICAL') current.criticalCount += 1;
    if (item.severity === 'HIGH') current.highCount += 1;
    if (severityRank(item.severity) >= 3) current.highOrAboveCount += 1;
    if (comparableInstant(item.evidenceAt) > comparableInstant(current.latestAt)) {
      current.latestAt = item.evidenceAt;
    }
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) => (
    right.criticalCount - left.criticalCount
    || right.highCount - left.highCount
    || right.count - left.count
    || comparableInstant(right.latestAt) - comparableInstant(left.latestAt)
    || left.key.localeCompare(right.key)
  ));
}

function sourceWindow(supply, key, fallbackRows) {
  const meta = record(record(supply.attentionMeta)[key]);
  const available = meta.available === true || (
    meta.available === undefined
    && ['returned', 'total', 'truncated'].some((field) => Object.hasOwn(meta, field))
  );
  const returned = Number.isSafeInteger(meta.returned) && meta.returned >= 0
    ? meta.returned
    : fallbackRows.length;
  const total = Number.isSafeInteger(meta.total) && meta.total >= returned
    ? meta.total
    : returned;
  return Object.freeze({
    available,
    returned,
    total,
    truncated: meta.truncated === true || total > returned,
  });
}

export function queryOpsDashboard(dashboardValue, paramsValue = new URLSearchParams()) {
  const dashboard = record(dashboardValue);
  const params = paramsValue instanceof URLSearchParams
    ? paramsValue
    : new URLSearchParams(paramsValue);
  assertKnownParameters(params);

  const owner = textParam(params, 'owner', {
    maximum: 64,
    pattern: OWNER_PATTERN,
    fallback: 'ALL',
  }) || 'ALL';
  const store = (textParam(params, 'store', {
    maximum: 12,
    pattern: STORE_PATTERN,
    fallback: 'ALL',
  }) || 'ALL').toUpperCase();
  const rawQuery = textParam(params, 'q', { maximum: 120, fallback: '' });
  const query = searchable(rawQuery);
  const view = enumParam(params, 'view', VIEWS, 'PRIORITY');
  const severity = enumParam(params, 'severity', SEVERITIES, 'ALL');
  const domain = enumParam(params, 'domain', DOMAINS, 'ALL');
  const quick = enumParam(params, 'quick', QUICK_FILTERS, 'ALL');
  const sort = enumParam(params, 'sort', SORTS, 'PRIORITY');
  const page = integerParam(params, 'page', { fallback: 1, minimum: 1, maximum: 10_000 });
  const pageSize = pageSizeParam(params);

  const ownerStores = ownerStoreSet(dashboard, owner);
  const allRows = buildRows(dashboard);
  const scopedRows = allRows.filter((item) => matchesScope(item, { store, ownerStores }));
  const matchedRows = scopedRows
    .filter((item) => (
      matchesView(item, view)
      && (severity === 'ALL' || item.severity === severity)
      && (domain === 'ALL' || item.domain === domain)
      && matchesQuick(item, quick)
      && containsQuery(item, query)
    ))
    .sort(compareRows(sort));
  const offset = (page - 1) * pageSize;
  const pageRows = matchedRows.slice(offset, offset + pageSize);
  const pageCount = matchedRows.length ? Math.ceil(matchedRows.length / pageSize) : 0;
  const highRows = scopedRows.filter((item) => severityRank(item.severity) >= 3);
  const priorityRows = scopedRows.filter((item) => matchesView(item, 'PRIORITY'));
  const supply = record(dashboard.supply);
  const windows = Object.freeze({
    purchaseOrders: sourceWindow(
      supply,
      'purchaseOrders',
      rows(supply.purchaseOrderAttention),
    ),
    deliveries: sourceWindow(
      supply,
      'deliveries',
      rows(supply.deliveryAttention),
    ),
    inventoryRisks: sourceWindow(
      supply,
      'inventoryRisks',
      rows(supply.inventoryRisks),
    ),
    stockAdviceRisks: sourceWindow(
      supply,
      'stockAdviceRisks',
      rows(supply.stockAdviceRisks),
    ),
  });
  const sourceTruncated = Object.values(windows).some((window) => window.truncated);
  const sourceUnavailable = Object.values(windows).some((window) => window.available !== true);
  const actionMeta = record(record(dashboard.actionPool).meta);
  const candidateAvailable = actionMeta.available === true || (
    actionMeta.available === undefined
    && ['returned', 'total', 'truncated'].some((field) => Object.hasOwn(actionMeta, field))
  );
  const triage = triageRows(
    matchedRows,
    dashboard.businessDate,
    sourceUnavailable !== true
      && sourceTruncated !== true
      && candidateAvailable === true
      && actionMeta.truncated !== true,
  );

  return Object.freeze({
    schemaVersion: 1,
    readOnly: true,
    source: Object.freeze({
      dashboardUpdatedAt: dashboard.updatedAt ?? null,
      businessDate: dashboard.businessDate ?? null,
      supplyStatus: supply.status ?? 'pending',
      businessWindows: windows,
      businessWindowTruncated: sourceTruncated,
      businessWindowUnavailable: sourceUnavailable,
      candidateWindow: Object.freeze({
        available: candidateAvailable,
        returned: Number.isSafeInteger(actionMeta.returned)
          ? actionMeta.returned
          : rows(record(dashboard.actionPool).candidates).length,
        total: Number.isSafeInteger(actionMeta.total) ? actionMeta.total : null,
        truncated: actionMeta.truncated === true,
        note: '候选池只作补充；采购、交付、库存和备货以独立业务明细为准。',
      }),
    }),
    automation: Object.freeze({
      mode: record(dashboard.actionPool).mode ?? 'observe_only',
      writeEnabled: record(dashboard.actionPool).writeEnabled === true,
      interface: 'read_only_worklist',
    }),
    summary: Object.freeze({
      scopedCount: scopedRows.length,
      priorityCount: priorityRows.length,
      criticalCount: scopedRows.filter((item) => item.severity === 'CRITICAL').length,
      highPriorityCount: scopedRows.filter((item) => item.severity === 'HIGH').length,
      highOrAboveCount: highRows.length,
      overdueCount: scopedRows.filter((item) => item.overdue === true).length,
      shortageCount: scopedRows.filter((item) => matchesQuick(item, 'SHORTAGE')).length,
      urgentCount: scopedRows.filter((item) => matchesQuick(item, 'URGENT')).length,
      syncCount: scopedRows.filter((item) => matchesQuick(item, 'SYNC')).length,
      impactedStoreCount: new Set(scopedRows.map((item) => item.storeCode).filter(Boolean)).size,
      attentionByStore: Object.freeze(countBy(
        priorityRows,
        (item) => item.storeCode,
      )),
      attentionByDomain: Object.freeze(countBy(
        priorityRows,
        (item) => item.domain,
        (item) => item.sourceLabel,
      )),
    }),
    worklist: Object.freeze({
      rows: Object.freeze(pageRows),
      pagination: Object.freeze({
        page,
        pageSize,
        pageCount,
        matchedRows: matchedRows.length,
        scopedRows: scopedRows.length,
        hasPrevious: page > 1 && pageCount > 0,
        hasNext: page < pageCount,
      }),
    }),
    triage,
    filters: Object.freeze({
      views: VIEWS,
      severities: SEVERITIES,
      domains: Object.freeze(
        DOMAINS.filter((value) => value === 'ALL' || scopedRows.some((item) => item.domain === value))
          .map((value) => ({
            code: value,
            name: value === 'ALL' ? '全部业务类型' : domainLabel(value),
          })),
      ),
      quick: QUICK_FILTERS,
      sorts: SORTS,
      pageSizes: PAGE_SIZES,
    }),
    query: Object.freeze({
      owner,
      store,
      q: rawQuery,
      view,
      severity,
      domain,
      quick,
      sort,
      page,
      pageSize,
    }),
  });
}
