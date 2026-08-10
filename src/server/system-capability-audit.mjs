import { createHash } from 'node:crypto';

/*
 * Sanitized capability evidence captured from one authenticated full-managed
 * browser session. This is a versioned interface audit, not portfolio data
 * coverage and not a credential store. Raw responses, keys, secrets, user
 * identities, contacts, addresses and order identifiers are deliberately
 * excluded.
 */
const AUDIT = Object.freeze({
  schemaVersion: 1,
  auditVersion: '2026-08-11.1',
  observedDate: '2026-08-11',
  observedTimePrecision: 'DATE',
  evidenceScope: 'ONE_LIVE_STORE',
  portfolioCoverageStatus: 'UNKNOWN',
  items: Object.freeze([
    Object.freeze({
      key: 'third-party-applications',
      label: '第三方应用',
      placement: '授权与服务',
      capabilityStatus: 'AUDITED',
      portfolioCoverageStatus: 'UNKNOWN',
      readModel: '应用列表、授权状态、授权期、最后操作时间',
      excluded: '授权、取消授权、重置密钥、凭据字段',
      sourceClass: 'WEBAPI_INTERNAL',
    }),
    Object.freeze({
      key: 'material-applications',
      label: '物料申领',
      placement: '授权与服务',
      capabilityStatus: 'AUDITED',
      portfolioCoverageStatus: 'UNKNOWN',
      readModel: '申领/退回记录、状态、数量与业务时间',
      excluded: '申领、退回、导出、打印、地址与联系人',
      sourceClass: 'WEBAPI_INTERNAL',
    }),
    Object.freeze({
      key: 'store-decoration',
      label: '店铺装修',
      placement: '店铺配置',
      capabilityStatus: 'PARTIAL_AUDIT',
      portfolioCoverageStatus: 'UNKNOWN',
      readModel: '站点、主页装修、提交记录、预览与编辑入口',
      excluded: '编辑、同步站点、提交发布；部分资源方法仍待确认',
      sourceClass: 'WEBAPI_EXTERNAL',
    }),
    Object.freeze({
      key: 'service-market',
      label: '服务市场',
      placement: '授权与服务',
      capabilityStatus: 'AUDITED',
      portfolioCoverageStatus: 'UNKNOWN',
      readModel: '服务订单、履约轨迹、状态与运营关注',
      excluded: '订购、验收、评价、公司/联系人明细与订单标识',
      sourceClass: 'WEBAPI_EXTERNAL',
    }),
    Object.freeze({
      key: 'certificate-testing',
      label: '证书检测申请',
      placement: '外部检测流程',
      capabilityStatus: 'AUDITED',
      portfolioCoverageStatus: 'UNKNOWN',
      readModel: '面料/材质检测记录、机构、结果与节点时间',
      excluded: '新建、取消、打印、导出；未建立商品/SKC 确定性绑定前不进商品质量',
      sourceClass: 'WEBAPI_EXTERNAL',
    }),
  ]),
});

const auditHash = createHash('sha256').update(JSON.stringify(AUDIT)).digest('hex');

export const SYSTEM_CAPABILITY_AUDIT = Object.freeze({
  ...AUDIT,
  auditHash,
});
