const DEFINITIONS = [
  {
    eventCode: '3000910',
    eventPath: '/product_document_receive_status_notice',
    family: 'product_receive',
    label: '商品接收',
    businessType: 'PRODUCT',
    hydrationType: 'PRODUCT_READBACK',
  },
  {
    eventCode: '3001449',
    eventPath: '/product_document_audit_status_notice_all_channels',
    family: 'product_audit_all_channels',
    label: '全渠道商品审核',
    businessType: 'PRODUCT',
    hydrationType: 'PRODUCT_READBACK',
  },
  {
    eventCode: '3001450',
    eventPath: '/product_document_audit_status_notice',
    family: 'product_audit',
    label: '商品审核',
    businessType: 'PRODUCT',
    hydrationType: 'PRODUCT_READBACK',
  },
  {
    eventCode: '3001903',
    eventPath: '/product_delete_audit',
    family: 'product_delete_audit',
    label: '商品删除审核',
    businessType: 'PRODUCT',
    hydrationType: 'PRODUCT_READBACK',
  },
  {
    eventCode: '3001061',
    eventPath: '/product_quota_change_notice',
    family: 'product_quota',
    label: '商品额度变更',
    businessType: 'STORE',
    hydrationType: 'QUOTA_READBACK',
  },
  {
    eventCode: '3001792',
    eventPath: '/product_rrp_review_status_changed',
    family: 'rrp_review',
    label: '建议零售价审核',
    businessType: 'PRODUCT',
    hydrationType: 'RRP_READBACK',
  },
  {
    eventCode: '3001793',
    eventPath: '/product_rrp_validity_changed',
    family: 'rrp_validity',
    label: '建议零售价有效期',
    businessType: 'PRODUCT',
    hydrationType: 'RRP_READBACK',
  },
  {
    eventCode: '3001104',
    eventPath: '/product_compliance_change_notice',
    family: 'product_compliance',
    label: '商品合规变更',
    businessType: 'PRODUCT',
    hydrationType: 'COMPLIANCE_READBACK',
  },
  {
    eventCode: '3001435',
    eventPath: '/purchase_order_notice',
    family: 'purchase_order',
    label: '采购单',
    businessType: 'PURCHASE_ORDER',
    hydrationType: 'PURCHASE_ORDER_READBACK',
  },
  {
    eventCode: '3001441',
    eventPath: '/delivery_modify_notice',
    family: 'delivery',
    label: '发货单变更',
    businessType: 'DELIVERY',
    hydrationType: 'DELIVERY_READBACK',
  },
  {
    eventCode: '3001765',
    eventPath: '/logistics_forecast_result_notice',
    family: 'logistics_forecast',
    label: '采购物流预报',
    businessType: 'LOGISTICS_FORECAST',
    hydrationType: 'LOGISTICS_FORECAST_READBACK',
  },
  {
    eventCode: '3001744',
    eventPath: '/purchase_order_return_application_notice',
    family: 'purchase_return_application',
    label: '采购退货申请',
    businessType: 'PURCHASE_RETURN_APPLICATION',
    hydrationType: 'PURCHASE_RETURN_APPLICATION_READBACK',
  },
  {
    eventCode: '3001801',
    eventPath: '/purchase_order_return_notice',
    family: 'purchase_return',
    label: '采购退货单',
    businessType: 'PURCHASE_RETURN',
    hydrationType: 'PURCHASE_RETURN_READBACK',
  },
  {
    eventCode: '3001048',
    eventPath: '/out_of_stock_notice',
    family: 'shortage',
    label: '缺货需求',
    businessType: 'SHORTAGE',
    hydrationType: 'SHORTAGE_READBACK',
  },
  {
    eventCode: '3001503',
    eventPath: '/authorization_change_notice',
    family: 'authorization_change',
    label: '授权关系变更',
    businessType: 'STORE',
    hydrationType: 'AUTHORIZATION_PROBE',
  },
];

export const FULL_MANAGED_WEBHOOK_EVENTS = Object.freeze(
  DEFINITIONS.map((definition) => Object.freeze({ ...definition })),
);

const BY_CODE = new Map(FULL_MANAGED_WEBHOOK_EVENTS.map((definition) => [
  definition.eventCode,
  definition,
]));
const BY_PATH = new Map(FULL_MANAGED_WEBHOOK_EVENTS.map((definition) => [
  definition.eventPath,
  definition,
]));

function incomingText(value) {
  return String(value ?? '').trim();
}

function safeUnknownValue(value) {
  const result = incomingText(value);
  if (!result || result.length > 160 || /[\u0000-\u001f\u007f]/.test(result)) return '';
  return /^[A-Za-z0-9_./-]+$/.test(result) ? result : '';
}

/**
 * Resolve SHEIN's x-lt-eventCode, which can be either the numeric document code
 * or its route name. Only the 15 full-managed definitions above are business
 * events. Everything else remains an audit-only unknown.
 */
export function resolveFullManagedWebhookEvent(value) {
  const raw = safeUnknownValue(value);
  const asPath = raw && !/^\d+$/.test(raw)
    ? `/${raw.replace(/^\/+/, '')}`
    : '';
  const known = BY_CODE.get(raw) ?? BY_PATH.get(asPath);
  if (known) return known;
  return Object.freeze({
    eventCode: /^\d{1,20}$/.test(raw) ? raw : '',
    eventPath: asPath || '/unknown',
    family: 'unknown',
    label: '未知事件',
    businessType: 'UNKNOWN',
    hydrationType: null,
    known: false,
  });
}

export function isKnownFullManagedWebhookEvent(event) {
  return Boolean(event && BY_CODE.get(String(event.eventCode ?? '')) === event);
}
