# SHEIN 全托运营自动驾驶舱

这是一个独立部署的 SHEIN 全托管 BI 与自动运营项目。生产入口为 `https://fm.dushengyi.cc`；它与半托系统隔离运行，只消费全托应用和店铺授权取得的 OpenAPI 数据，不复用半托凭据或事实表。

## 当前进度

- DL 单应用已归集 24 家全托店铺授权；内部店铺代码统一使用“公司简称 + 店铺账号后四位”，例如 `CX4412`。
- 已建立 `/open-api/goods/query-sku-sales` 的可信销量链路：逐店权限探针、稳定 SKU 清单、每批最多 100 条、日期锚定、合法零销量、缺失 SKU 禁止补零、原始证据与幂等回读。
- 已接入全托只读商品、库存（PI / VI / JI）、缺货建议、采购单、交付入仓与 Webhook 接收/标准化链路；未知数量始终保留为未知。
- 已建立 PostgreSQL `raw / dim / fact / mart / ops` 五层仓库、商品标准化身份、员工—店铺写权限骨架和 12 个一级业务视图。
- 门户首页包含今日、昨日、近 7 日、近 30 日销量件数、逐日趋势、店铺排行和标准商品排行，并显示业务日期、店铺覆盖与数据质量。
- 员工登录后可查看全部店铺；未来写动作只有在全局写开关、能力许可和本人 `PRIMARY / SUPPORT` 店铺分配同时满足时才可执行。当前 HTTP 与 SHEIN 写操作全部关闭。
- 生产运行拆分为 Portal、Dashboard 物化、销量同步、供应链同步、Webhook 接收、Webhook Worker 六类最小权限身份；同步、订阅与写入均使用显式门禁。
- 独立远程授权 Broker 保留为人工授权工具；回调换证后先进入 `REVIEW_REQUIRED`，不会自动启用。

应用审核通过或权限包提交成功，不等于店铺授权、OpenAPI 探针成功或生产数据可用。权限获批后仍要完成店铺级授权、凭证交换、首店只读探针和字段对账。

## 能力边界

当前只读事实域可以展示：

- 今日销量
- 昨日销量
- 近 7 日销量
- 近 30 日销量
- 逐日销量趋势、店铺排行与标准商品排行
- 店铺内 SKU、SKC、供应商货号及跨店标准商品归并状态
- 采购单状态、交付里程碑、PI / VI / JI 库存与缺货建议
- Webhook 队列、运行心跳、订阅回读和脱敏事件时间线
- 数据更新时间、业务日期、店铺覆盖、字段覆盖和具体质量原因

`query-sku-sales` 返回的是 SKU 销量数量快照，不是订单事实。首版明确不展示销售额、成交价、消费者订单数、成本、利润、退款率或 COD。财务报账、消费者订单和消费者售后仍须作为独立事实域重新验证后接入。

Webhook Worker 当前只做验签后密文入仓、异步解密、标准化事件和“需要只读回查”的指令记录，不会自行调用 SHEIN OpenAPI 完成回查；平台订阅创建也是写操作，默认关闭。页面不会把空队列、未订阅或未接入字段显示成业务零值。

详见：

- [系统架构](docs/architecture.md)
- [门户信息架构与页面规划](docs/portal-information-architecture.md)
- [数据模型](docs/data-model.md)
- [能力边界](docs/capability-boundary.md)
- [数据库迁移](db/README.md)
- [权限申请状态](docs/permission-application-status.md)
- [远程店铺授权流程](docs/remote-authorization.md)

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

门户使用与半托 BI 同一设计家族的固定导航与顶部筛选，但业务域按全托重新组织。页面通过 URL hash 切换，例如：

```text
http://127.0.0.1:3100/#home
http://127.0.0.1:3100/#sales
http://127.0.0.1:3100/#products
http://127.0.0.1:3100/#purchase-orders
http://127.0.0.1:3100/#inventory
http://127.0.0.1:3100/#platform
http://127.0.0.1:3100/#automation
http://127.0.0.1:3100/#system
```

## 目录

```text
config/         无密钥配置示例
db/             PostgreSQL 迁移与契约验证
docs/           架构、模型与能力边界
scripts/        应用与权限管理脚本
src/domain/     全托销量领域规则与投影
src/server/     本地与云端共用的只读 HTTP 服务
src/web/        驾驶舱前端
tests/          脱敏 fixture 与自动测试
```

## 管理脚本安全边界

`scripts/apply_full_managed_openapi_app.mjs` 和 `scripts/apply_full_managed_sales_permission.mjs` 会在带登录态的独立浏览器 Profile 上操作真实 SHEIN 开放平台。它们是人工授权的管理工具，不属于 BI 定时任务调用链；真实提交必须显式传入 `--submit`，提交后必须回读平台状态。

浏览器 Profile、Cookie、token、密钥、`.local.json`、日志、输出数据和数据库文件均被排除在版本库外。

## 云端运行

生产使用 `/opt/shein-fm`、`/srv/shein-fm` 和独立 PostgreSQL；Portal 监听 `127.0.0.1:8788`，Webhook Receiver 监听 `127.0.0.1:8793`，Nginx 监听 `127.0.0.1:8081`，PostgreSQL 监听 `127.0.0.1:54330`。公网链路为 Cloudflare → HAProxy → Caddy → Nginx，不改变半托服务的端口与数据库。

每个运行组件使用独立 Unix 用户、独立数据库 LOGIN 角色和独立私密目录。Portal 只读原子发布的 Dashboard JSON，不持有数据库或平台凭据；物化器只读仓库；销量、供应链、Webhook 接收与 Worker 只获得各自最小权限。生产凭据只保存在 `/srv/shein-fm/secrets/<component>`，不进入 Git。

销量定时任务只有在 24 店真实权限探针和首轮对账通过后才启用；供应链定时任务还需要历史回填与增量回读门禁；Webhook 服务需要独立心跳和回调验收，但创建平台订阅仍保持关闭。生产空库或合法零销量使用真实空数据契约，不会回退到测试 fixture。

部署、回滚、服务名和验收命令见 [云端部署手册](docs/cloud-deployment.md)。
