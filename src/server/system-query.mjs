const STORE_PATTERN = /^[A-Z0-9]{2,12}$/;
const OWNER_PATTERN = /^[\p{L}\p{N}._:-]{1,64}$/u;
const ALLOWED_PARAMS = new Set(['owner', 'store', 'q']);

const COVERAGE_LABELS = Object.freeze({
  productCatalog: '商品目录',
  productDetails: '商品详情',
  inventory: '库存快照',
  stockAdvice: '备货建议',
  purchaseOrders: '采购单',
  deliveries: '交付入仓',
});

const COVERAGE_ROUTES = Object.freeze({
  productCatalog: 'products',
  productDetails: 'products',
  inventory: 'inventory',
  stockAdvice: 'inventory',
  purchaseOrders: 'procurement',
  deliveries: 'fulfilment',
});

const ISSUE_PRIORITY = Object.freeze({
  P0: 4,
  P1: 3,
  P2: 2,
  P3: 1,
});

export class SystemQueryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SystemQueryError';
    this.code = code;
    this.statusCode = 400;
  }
}

function fail(code, message) {
  throw new SystemQueryError(code, message);
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function isUnit(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'zh-CN');
}

function compareInstantDesc(left, right) {
  const leftTime = Date.parse(left || '') || 0;
  const rightTime = Date.parse(right || '') || 0;
  return rightTime - leftTime;
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

function parseParams(params) {
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) fail('QUERY_PARAMETER_UNKNOWN', `参数 ${key} 不受支持`);
  }
  return Object.freeze({
    owner: textParam(params, 'owner', {
      maximum: 64,
      pattern: OWNER_PATTERN,
      fallback: 'ALL',
    }),
    store: textParam(params, 'store', {
      maximum: 12,
      pattern: STORE_PATTERN,
      fallback: 'ALL',
    }).toUpperCase(),
    q: textParam(params, 'q', { maximum: 120, fallback: '' }).toLowerCase(),
  });
}

function ownerRows(dashboard) {
  return rows(dashboard.owners).map((owner) => Object.freeze({
    key: String(owner.key || ''),
    name: String(owner.name || ''),
    shortName: String(owner.shortName || owner.name || ''),
    storeCodes: Object.freeze(rows(owner.storeCodes).map((code) => String(code).toUpperCase())),
  }));
}

function storeContext(dashboard, ownerKey, store) {
  const owners = ownerRows(dashboard);
  const allStoreCodes = new Set();
  const ownerByStore = new Map();
  for (const owner of owners) {
    for (const code of owner.storeCodes) {
      allStoreCodes.add(code);
      ownerByStore.set(code, owner);
    }
  }
  let selectedCodes = new Set(allStoreCodes);
  if (ownerKey !== 'ALL') {
    const owner = owners.find((item) => item.key === ownerKey);
    if (!owner) fail('OWNER_NOT_FOUND', '负责人范围不存在');
    selectedCodes = new Set(owner.storeCodes);
  }
  if (store !== 'ALL') {
    if (!allStoreCodes.has(store)) fail('STORE_NOT_FOUND', '店铺范围不存在');
    if (!selectedCodes.has(store)) fail('STORE_SCOPE_MISMATCH', '店铺不属于当前负责人范围');
    selectedCodes = new Set([store]);
  }
  return Object.freeze({
    owners: Object.freeze(owners),
    ownerByStore,
    universeStoreCodes: Object.freeze([...allStoreCodes].sort(compareText)),
    storeCodes: Object.freeze([...selectedCodes].sort(compareText)),
  });
}

function includesQuery(values, query) {
  if (!query) return true;
  return values.some((value) => String(value ?? '').toLowerCase().includes(query));
}

function profileRows(runtime, context) {
  const profiles = record(runtime?.profiles);
  const login = record(profiles.login);
  const renewal = record(profiles.renewal);
  const loginByStore = new Map(rows(login.rows).map((row) => [row.storeCode, row]));
  const renewalByStore = new Map(rows(renewal.rows).map((row) => [row.storeCode, row]));
  return context.storeCodes.map((storeCode) => {
    const loginRow = record(loginByStore.get(storeCode));
    const renewalRow = record(renewalByStore.get(storeCode));
    const owner = context.ownerByStore.get(storeCode);
    let state = 'unknown';
    let stateLabel = '尚未验真';
    let actionRequired = true;
    if (renewalRow.state === 'ACTIVE') {
      state = 'active';
      stateLabel = '续期有效';
      actionRequired = false;
    } else if (renewalRow.state === 'EXPIRED') {
      state = 'expired';
      stateLabel = '登录态失效';
    } else if (renewalRow.state === 'BLOCKED') {
      state = 'blocked';
      stateLabel = '身份校验阻断';
    } else if (renewalRow.state === 'UNKNOWN') {
      state = 'unknown';
      stateLabel = '续期结果未知';
    } else if (loginRow.status === 'pending') {
      state = 'pending';
      stateLabel = '尚未完成登录';
    } else if (loginRow.status === 'needs_attention') {
      state = 'attention';
      stateLabel = '登录登记需处理';
    } else if (loginRow.status === 'completed') {
      state = 'unverified';
      stateLabel = '已登记 · 待续期验真';
    }
    return Object.freeze({
      storeCode,
      ownerKey: owner?.key || null,
      ownerName: owner?.shortName || owner?.name || null,
      state,
      stateLabel,
      actionRequired,
      loginStatus: loginRow.status || 'unknown',
      loginVerified: loginRow.verified === true,
      completedAt: loginRow.completedAt || null,
      renewalState: renewalRow.state || null,
      renewed: renewalRow.renewed === true,
      errorCode: renewalRow.errorCode || null,
      evidenceAt: renewalRow.state ? (renewal.generatedAt || null) : (login.updatedAt || null),
    });
  });
}

function profileSummary(inputRows, renewalGeneratedAt) {
  const count = (states) => inputRows.filter((row) => states.includes(row.state)).length;
  const verifiedRows = inputRows.filter((row) => row.renewalState);
  return Object.freeze({
    total: inputRows.length,
    active: count(['active']),
    expired: count(['expired']),
    blocked: count(['blocked']),
    pendingLogin: count(['pending']),
    needsAttention: count(['attention']),
    awaitingVerification: count(['unverified', 'unknown']),
    verified: verifiedRows.length,
    actionRequired: inputRows.filter((row) => row.actionRequired).length,
    renewalGeneratedAt: renewalGeneratedAt || null,
  });
}

function compareProfiles(left, right) {
  return Number(right.actionRequired) - Number(left.actionRequired)
    || compareText(left.state, right.state)
    || compareText(left.storeCode, right.storeCode);
}

function coveragePartitionProvesSuccessComplement(coverage, universeStoreCodes) {
  const universe = new Set(universeStoreCodes);
  const counts = {
    complete: coverage.succeededStores,
    failed: coverage.failedStores,
    missing: coverage.missingStores,
    stale: coverage.staleStores,
    running: coverage.inProgressStores,
    total: coverage.totalStores,
  };
  if (!Object.values(counts).every(isUnit)) return false;
  if (counts.total !== universe.size) return false;
  if (
    counts.complete
    + counts.failed
    + counts.missing
    + counts.stale
    + counts.running
    !== counts.total
  ) return false;
  const exceptionGroups = [
    [coverage.failedStoreCodes, counts.failed],
    [coverage.missingStoreCodes, counts.missing],
    [coverage.staleStoreCodes, counts.stale],
    [coverage.inProgressStoreCodes, counts.running],
  ];
  const exceptions = new Set();
  for (const [inputCodes, expectedCount] of exceptionGroups) {
    const codes = rows(inputCodes);
    if (codes.length !== expectedCount) return false;
    for (const code of codes) {
      if (!universe.has(code) || exceptions.has(code)) return false;
      exceptions.add(code);
    }
  }
  return exceptions.size === counts.total - counts.complete;
}

function coverageStateForStore(coverage, storeCode, successComplementProven = false) {
  const code = String(storeCode || '').toUpperCase();
  const sets = [
    ['failed', new Set(rows(coverage.failedStoreCodes))],
    ['stale', new Set(rows(coverage.staleStoreCodes))],
    ['missing', new Set(rows(coverage.missingStoreCodes))],
    ['running', new Set(rows(coverage.inProgressStoreCodes))],
    ['complete', new Set(rows(coverage.succeededStoreCodes))],
  ];
  return sets.find(([, values]) => values.has(code))?.[0]
    || (successComplementProven ? 'complete' : 'unknown');
}

function coverageRows(dashboard, context) {
  const domains = record(record(dashboard.supply).coverage).domains;
  return Object.entries(COVERAGE_LABELS).map(([key, label]) => {
    const source = record(record(domains)[key]);
    const successComplementProven = coveragePartitionProvesSuccessComplement(
      source,
      context.universeStoreCodes,
    );
    const states = context.storeCodes.map((storeCode) => Object.freeze({
      storeCode,
      state: coverageStateForStore(source, storeCode, successComplementProven),
    }));
    const count = (state) => states.filter((row) => row.state === state).length;
    const failed = count('failed');
    const stale = count('stale');
    const missing = count('missing');
    const running = count('running');
    const complete = count('complete');
    const unknown = count('unknown');
    let status = 'unknown';
    if (failed + stale + missing > 0) status = 'attention';
    else if (running > 0) status = 'running';
    else if (complete === context.storeCodes.length && complete > 0) status = 'complete';
    return Object.freeze({
      key,
      label,
      route: COVERAGE_ROUTES[key],
      status,
      total: context.storeCodes.length,
      complete,
      failed,
      missing,
      stale,
      running,
      unknown,
      affectedStoreCodes: Object.freeze(states
        .filter((row) => !['complete'].includes(row.state))
        .map((row) => row.storeCode)),
      latestFetchedAt: source.latestFetchedAt || null,
      evaluatedAt: source.evaluatedAt || null,
      freshnessMaxAgeSeconds: isUnit(source.freshnessMaxAgeSeconds)
        ? source.freshnessMaxAgeSeconds
        : null,
      mode: source.mode || null,
      watermarkStart: source.watermarkStart || null,
      watermarkEnd: source.watermarkEnd || null,
      reason: source.reason || null,
    });
  });
}

function serviceSummary(units) {
  const healthy = units.filter((unit) => ['healthy', 'running', 'scheduled'].includes(unit.state));
  const attention = units.filter((unit) => unit.state === 'attention');
  const unknown = units.filter((unit) => unit.state === 'unknown');
  return Object.freeze({
    total: units.length,
    healthy: healthy.length,
    attention: attention.length,
    unknown: unknown.length,
    running: units.filter((unit) => unit.state === 'running').length,
  });
}

function coverageSummary(inputRows) {
  return Object.freeze({
    total: inputRows.length,
    complete: inputRows.filter((row) => row.status === 'complete').length,
    running: inputRows.filter((row) => row.status === 'running').length,
    attention: inputRows.filter((row) => row.status === 'attention').length,
    unknown: inputRows.filter((row) => row.status === 'unknown').length,
  });
}

function issue({
  key,
  severity,
  domain,
  title,
  detail,
  evidenceAt,
  affectedStoreCodes = [],
  href = '#system',
}) {
  return Object.freeze({
    key,
    severity,
    domain,
    title,
    detail,
    evidenceAt: evidenceAt || null,
    affectedStoreCodes: Object.freeze([...new Set(affectedStoreCodes)].sort(compareText)),
    href,
  });
}

function buildIssues({
  dashboard,
  runtime,
  units,
  profiles,
  profileTotals,
  coverage,
  disks,
}) {
  const issues = [];
  if (!runtime) {
    issues.push(issue({
      key: 'runtime-missing',
      severity: 'P0',
      domain: '运行态',
      title: '系统运行态快照不可用',
      detail: '当前只能读取经营快照，无法判断 Profile、systemd 任务和磁盘。',
      evidenceAt: dashboard.updatedAt,
    }));
  }
  for (const unit of units) {
    if (unit.state !== 'attention') continue;
    issues.push(issue({
      key: `unit:${unit.key}`,
      severity: unit.critical ? 'P0' : 'P1',
      domain: '任务运行',
      title: `${unit.label}需要处理`,
      detail: `状态 ${unit.activeState}/${unit.subState} · 结果 ${unit.result}${unit.exitStatus === null ? '' : ` · exit ${unit.exitStatus}`}`,
      evidenceAt: unit.lastRunAt || runtime?.generatedAt,
      href: `#${unit.route || 'system'}`,
    }));
  }
  if (profileTotals.actionRequired > 0) {
    const affected = profiles.filter((row) => row.actionRequired).map((row) => row.storeCode);
    issues.push(issue({
      key: 'profiles:attention',
      severity: profileTotals.expired + profileTotals.blocked > 0 ? 'P1' : 'P2',
      domain: 'Profile',
      title: `${profileTotals.actionRequired} 家店的登录或续期需处理`,
      detail: [
        profileTotals.expired ? `失效 ${profileTotals.expired}` : null,
        profileTotals.blocked ? `阻断 ${profileTotals.blocked}` : null,
        profileTotals.pendingLogin ? `未登录 ${profileTotals.pendingLogin}` : null,
        profileTotals.needsAttention ? `登记异常 ${profileTotals.needsAttention}` : null,
        profileTotals.awaitingVerification ? `待验真 ${profileTotals.awaitingVerification}` : null,
      ].filter(Boolean).join(' · ') || '登录状态证据不足',
      evidenceAt: profileTotals.renewalGeneratedAt
        || runtime?.profiles?.login?.updatedAt
        || runtime?.generatedAt,
      affectedStoreCodes: affected,
    }));
  }
  for (const row of coverage) {
    if (row.status !== 'attention') continue;
    issues.push(issue({
      key: `coverage:${row.key}`,
      severity: row.failed > 0 ? 'P1' : 'P2',
      domain: '数据同步',
      title: `${row.label}覆盖不完整`,
      detail: `成功 ${row.complete}/${row.total} · 失败 ${row.failed} · 缺失 ${row.missing} · 过期 ${row.stale}`,
      evidenceAt: row.evaluatedAt || row.latestFetchedAt || dashboard.updatedAt,
      affectedStoreCodes: row.affectedStoreCodes,
      href: `#${row.route}`,
    }));
  }
  for (const disk of disks) {
    if (!['warning', 'critical'].includes(disk.severity)) continue;
    issues.push(issue({
      key: `disk:${disk.filesystem}`,
      severity: disk.severity === 'critical' ? 'P0' : 'P1',
      domain: '磁盘',
      title: `${disk.filesystem} 磁盘使用率偏高`,
      detail: `${disk.usedPercent ?? '—'}% 已使用 · 告警 ${disk.warningPercent ?? '—'}% · 紧急 ${disk.criticalPercent ?? '—'}%`,
      evidenceAt: disk.checkedAt || runtime?.generatedAt,
    }));
  }
  const platform = record(dashboard.platform);
  if (record(platform.health).ok === false) {
    issues.push(issue({
      key: 'webhook:runtime',
      severity: 'P0',
      domain: 'Webhook',
      title: 'Webhook 运行链路需要处理',
      detail: 'Receiver 或 Worker 心跳不新鲜，空队列不能证明运行正常。',
      evidenceAt: platform.health.evaluatedAt || dashboard.updatedAt,
      href: '#platform',
    }));
  }
  if (record(dashboard.actionPool).writeEnabled === true) {
    issues.push(issue({
      key: 'write-gate:open',
      severity: 'P0',
      domain: '安全边界',
      title: '写动作总闸意外开启',
      detail: '当前阶段要求只读观察，必须立即核对服务端配置。',
      evidenceAt: runtime?.generatedAt || dashboard.updatedAt,
    }));
  }
  return Object.freeze(issues.sort((left, right) => (
    (ISSUE_PRIORITY[right.severity] || 0) - (ISSUE_PRIORITY[left.severity] || 0)
    || compareInstantDesc(left.evidenceAt, right.evidenceAt)
    || compareText(left.title, right.title)
  )));
}

function scopedReadiness(dashboard) {
  return Object.freeze(rows(dashboard.readiness).map((row) => Object.freeze({
    key: String(row.key || ''),
    label: String(row.label || row.key || ''),
    status: String(row.status || 'unknown'),
    completed: isUnit(row.completed) ? row.completed : null,
    total: isUnit(row.total) ? row.total : null,
    note: String(row.note || ''),
  })));
}

/**
 * Build the read-only System workspace from two independent sources:
 * materialized business facts and the root-owned sanitized runtime snapshot.
 */
export function querySystemDashboard(dashboardInput, runtimeInput, params = new URLSearchParams()) {
  const dashboard = record(dashboardInput);
  const runtime = runtimeInput && typeof runtimeInput === 'object' ? runtimeInput : null;
  const query = parseParams(params);
  const context = storeContext(dashboard, query.owner, query.store);
  const allProfiles = profileRows(runtime, context);
  const profileTotals = profileSummary(allProfiles, runtime?.profiles?.renewal?.generatedAt);
  const coverage = coverageRows(dashboard, context);
  const units = Object.freeze(rows(runtime?.units));
  const disks = Object.freeze(rows(runtime?.disks));
  const allIssues = buildIssues({
    dashboard,
    runtime,
    units,
    profiles: allProfiles,
    profileTotals,
    coverage,
    disks,
  });
  const filteredProfiles = allProfiles
    .filter((row) => includesQuery([
      row.storeCode,
      row.ownerName,
      row.stateLabel,
      row.errorCode,
    ], query.q))
    .sort(compareProfiles);
  const filteredIssues = allIssues.filter((row) => includesQuery([
    row.title,
    row.detail,
    row.domain,
    ...row.affectedStoreCodes,
  ], query.q));

  return Object.freeze({
    schemaVersion: 1,
    readOnly: true,
    generatedAt: new Date().toISOString(),
    scope: Object.freeze({
      owner: query.owner,
      store: query.store,
      query: query.q,
      storeCodes: context.storeCodes,
      storeCount: context.storeCodes.length,
      owners: context.owners,
    }),
    verdict: Object.freeze({
      level: allIssues.some((row) => row.severity === 'P0')
        ? 'critical'
        : allIssues.length > 0
          ? 'attention'
          : 'healthy',
      issueCount: allIssues.length,
      matchedIssueCount: filteredIssues.length,
      headline: allIssues.some((row) => row.severity === 'P0')
        ? '存在需要立即处理的系统问题'
        : allIssues.length > 0
          ? '系统可用，但有运行或数据问题待处理'
          : '核心运行与数据链路正常',
    }),
    summary: Object.freeze({
      services: serviceSummary(units),
      profiles: profileTotals,
      coverage: coverageSummary(coverage),
      disks,
    }),
    issues: Object.freeze({
      total: allIssues.length,
      matched: filteredIssues.length,
      rows: Object.freeze(filteredIssues),
    }),
    services: Object.freeze({
      rows: units,
    }),
    profiles: Object.freeze({
      loginUpdatedAt: runtime?.profiles?.login?.updatedAt || null,
      renewalGeneratedAt: runtime?.profiles?.renewal?.generatedAt || null,
      total: allProfiles.length,
      matched: filteredProfiles.length,
      rows: Object.freeze(filteredProfiles),
    }),
    coverage: Object.freeze({
      rows: Object.freeze(coverage),
    }),
    readiness: scopedReadiness(dashboard),
    boundaries: Object.freeze({
      schemaReadiness: record(dashboard.system).schemaReadiness || {},
      writeActionsEnabled: record(dashboard.system).writeActionsEnabled === true,
      actionMode: record(dashboard.actionPool).mode || 'unknown',
      actionWriteEnabled: record(dashboard.actionPool).writeEnabled === true,
      platformWarehouseReady: record(record(dashboard.platform).health).warehouseReady === true,
      salesPermission: record(dashboard.permission),
      releases: runtime?.releases || { current: null, previous: null },
    }),
    source: Object.freeze({
      runtimeAvailable: runtime !== null,
      runtimeGeneratedAt: runtime?.generatedAt || null,
      dashboardUpdatedAt: dashboard.updatedAt || null,
      supplyEvaluatedAt: coverage
        .map((row) => row.evaluatedAt)
        .filter(Boolean)
        .sort()
        .at(-1) || null,
      renewalGeneratedAt: runtime?.profiles?.renewal?.generatedAt || null,
    }),
  });
}
