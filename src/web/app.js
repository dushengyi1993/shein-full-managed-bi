const numberFormatter = new Intl.NumberFormat('zh-CN');
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  hour12: false,
});

const elements = {
  datasetBadge: document.querySelector('#dataset-badge'),
  updatedAt: document.querySelector('#updated-at'),
  permissionDot: document.querySelector('#permission-dot'),
  permissionLabel: document.querySelector('#permission-label'),
  permissionCount: document.querySelector('#permission-count'),
  metricToday: document.querySelector('#metric-today'),
  metricYesterday: document.querySelector('#metric-yesterday'),
  metric7d: document.querySelector('#metric-7d'),
  metric30d: document.querySelector('#metric-30d'),
  storeRanking: document.querySelector('#store-ranking'),
  storeEmpty: document.querySelector('#store-empty'),
  skuRanking: document.querySelector('#sku-ranking'),
  skuEmpty: document.querySelector('#sku-empty'),
  errorPanel: document.querySelector('#error-panel'),
  errorMessage: document.querySelector('#error-message'),
  retryButton: document.querySelector('#retry-button'),
};

function formatUnits(value) {
  return Number.isSafeInteger(value) ? numberFormatter.format(value) : '—';
}

function setText(element, value) {
  element.textContent = value;
}

function createCell(value, className) {
  const cell = document.createElement('td');
  cell.textContent = value;
  if (className) cell.className = className;
  return cell;
}

function renderStoreRanking(items) {
  elements.storeRanking.replaceChildren();
  elements.storeEmpty.hidden = items.length !== 0;

  items.forEach((item, index) => {
    const row = document.createElement('tr');
    const storeCell = document.createElement('td');
    const name = document.createElement('strong');
    const code = document.createElement('span');

    name.textContent = item.name;
    code.textContent = item.code;
    storeCell.className = 'entity-cell';
    storeCell.append(name, code);

    row.append(
      createCell(String(index + 1), 'rank-cell'),
      storeCell,
      createCell(formatUnits(item.unitsSold.today), 'number-cell'),
      createCell(formatUnits(item.unitsSold.last7Days), 'number-cell'),
      createCell(formatUnits(item.unitsSold.last30Days), 'number-cell'),
    );
    elements.storeRanking.append(row);
  });
}

function renderSkuRanking(items) {
  elements.skuRanking.replaceChildren();
  elements.skuEmpty.hidden = items.length !== 0;

  items.forEach((item, index) => {
    const row = document.createElement('tr');
    const skuCell = document.createElement('td');
    const sku = document.createElement('strong');
    const name = document.createElement('span');

    sku.textContent = item.sku;
    name.textContent = item.name;
    skuCell.className = 'entity-cell';
    skuCell.append(sku, name);

    row.append(
      createCell(String(index + 1), 'rank-cell'),
      skuCell,
      createCell(formatUnits(item.unitsSold.today), 'number-cell'),
      createCell(formatUnits(item.unitsSold.last7Days), 'number-cell'),
      createCell(formatUnits(item.unitsSold.last30Days), 'number-cell'),
    );
    elements.skuRanking.append(row);
  });
}

function renderDashboard(data) {
  setText(elements.datasetBadge, data.dataset.label);
  elements.datasetBadge.className = `badge badge-${data.dataset.status}`;
  if (data.updatedAt) {
    setText(
      elements.updatedAt,
      `更新时间：${dateTimeFormatter.format(new Date(data.updatedAt))}`,
    );
  } else {
    setText(elements.updatedAt, '更新时间：暂无有效销量快照');
  }
  setText(elements.permissionLabel, data.permission.label);
  setText(
    elements.permissionCount,
    `${data.permission.authorizedStores} / ${data.permission.totalStores} 家店铺`,
  );
  elements.permissionDot.dataset.status = data.permission.status;

  setText(elements.metricToday, formatUnits(data.unitsSold.today));
  setText(elements.metricYesterday, formatUnits(data.unitsSold.yesterday));
  setText(elements.metric7d, formatUnits(data.unitsSold.last7Days));
  setText(elements.metric30d, formatUnits(data.unitsSold.last30Days));

  renderStoreRanking(data.storeRanking);
  renderSkuRanking(data.skuRanking);
  elements.errorPanel.hidden = true;
}

async function loadDashboard() {
  elements.retryButton.disabled = true;

  try {
    const response = await fetch('/api/dashboard', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('本地数据服务暂不可用');
    renderDashboard(await response.json());
  } catch (error) {
    elements.errorMessage.textContent = error instanceof Error
      ? error.message
      : '请检查本地数据文件后重试。';
    elements.errorPanel.hidden = false;
  } finally {
    elements.retryButton.disabled = false;
  }
}

elements.retryButton.addEventListener('click', loadDashboard);
loadDashboard();
