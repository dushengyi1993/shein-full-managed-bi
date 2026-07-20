# SHEIN 全托运营自动驾驶舱

这是一个本地优先的 SHEIN 全托管 BI 与自动运营项目。当前阶段先建立可信的销量数量链路和只读驾驶舱；云端服务器扩容完成前，不部署、不迁移半托生产事实源，也不在本地保存真实凭证。

## 当前进度

- 18 家非 HL 全托应用均已审核通过。
- 18 家应用的“销量查询”权限包已于 2026-07-20 提交，平台回读均为“审核中”。
- 已建立 `/open-api/goods/query-sku-sales` 的领域模型：SKU 去重、每批最多 100 条、严格响应校验、缺失 SKU 禁止补零。
- 已建立 PostgreSQL `raw / dim / fact / mart / ops` 五层首版 Schema。
- 已提供本地只读驾驶舱、健康检查和 Dashboard API。

应用审核通过或权限包提交成功，不等于店铺授权、OpenAPI 探针成功或生产数据可用。权限获批后仍要完成店铺级授权、凭证交换、首店只读探针和字段对账。

## 能力边界

首版只展示：

- 今日销量
- 昨日销量
- 近 7 日销量
- 近 30 日销量
- 店铺与 SKU 排行
- 数据更新时间与权限状态

`query-sku-sales` 返回的是 SKU 销量数量快照，不是订单事实。首版明确不展示销售额、成交价、订单数、成本、利润、退款率或 COD。财务报账、采购履约与库存会在后续作为独立事实域接入。

详见：

- [系统架构](docs/architecture.md)
- [数据模型](docs/data-model.md)
- [能力边界](docs/capability-boundary.md)
- [数据库迁移](db/README.md)
- [权限申请状态](docs/permission-application-status.md)

## 本地运行

要求 Node.js 22 或更高版本。

```powershell
npm install --ignore-scripts
npm test
npm run dev
```

默认访问：<http://127.0.0.1:3100>

未配置真实数据文件时，页面使用 `tests/fixtures/dashboard.json`，并明确标记为“本地示例数据”。可通过环境变量指定本地生成的 Dashboard JSON：

```powershell
$env:FULL_BI_DATA_FILE='C:\path\to\dashboard.json'
npm run dev
```

已有标准化销量快照和店铺权限 JSON 时，可生成门户输入：

```powershell
npm run build:dashboard -- `
  --snapshots .\path\sales-snapshots.json `
  --permissions .\path\store-permissions.json `
  --out .\outputs\dashboard.json
```

同一店铺、同一 SKU 的历史记录会先按统计日和抓取时间取最新值，再做汇总，避免重复累加。

## 目录

```text
config/         无密钥配置示例
db/             PostgreSQL 迁移与契约验证
docs/           架构、模型与能力边界
scripts/        应用与权限管理脚本
src/domain/     全托销量领域规则与投影
src/server/     本地只读 HTTP 服务
src/web/        驾驶舱前端
tests/          脱敏 fixture 与自动测试
```

## 管理脚本安全边界

`scripts/apply_full_managed_openapi_app.mjs` 和 `scripts/apply_full_managed_sales_permission.mjs` 会在带登录态的独立浏览器 Profile 上操作真实 SHEIN 开放平台。它们是人工授权的管理工具，不属于 BI 定时任务调用链；真实提交必须显式传入 `--submit`，提交后必须回读平台状态。

浏览器 Profile、Cookie、token、密钥、`.local.json`、日志、输出数据和数据库文件均被排除在版本库外。

## 云端状态

当前只在本地开发并使用私有 GitHub 仓库做版本管理。云端服务器扩容完成前，不配置部署工作流，不写入服务器，也不切换任何生产事实源。
