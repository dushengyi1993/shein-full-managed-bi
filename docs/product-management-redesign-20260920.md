# 商品管理页重新设计（调研 + 方案）

日期：2026-09-20。状态：**待确认，未开始实现**。

## 1. 调研方法

三条一手证据：

1. 用 CDP 连接用户已登录的本机 Chrome，只读探查 SHEIN 后台两个页面（`sso.geiwohuo.com/#/spmp/commdities/list`、`#/idms/stockup`）：读取表格表头、筛选控件、导航、以及页面实际调用的接口与其响应结构。
2. 只读读取半托 BI 商品页（`http://192.168.1.200/#products`）的渲染结果与源码（子代理完成）。
3. 读取全托仓库现有 OpenAPI/WebAPI 契约与数据模型。

全程只读，未修改任何后台数据，未提交任何表单。

## 2. 结论摘要

需求 1–6 全部可行，但**字段来源分成能力差异很大的三类**，其中「商品层次」「平台标签」「价格/供货价/预测日销」「上架时间/天数/状态」「站点覆盖」**OpenAPI 拿不到**，必须走 SHEIN 后台的 WebAPI（Session HTTP）。

这是本次设计唯一的关键决策点：是否把商品域也纳入 WebAPI 契约。

## 3. 三个数据源的能力边界

### 3.1 OpenAPI（已授权、已投产、稳定）

| 能拿到 | 接口 |
| --- | --- |
| SPU / SKC / SKU 身份、货号(sellerSku)、商品名、类目、品牌、主图、尺寸重量、停购标记 | `product/query`、`product/full-detail` |
| 销售属性、条码、包装 | `goods/spu-info` |
| PI / JI 库存（全托仓） | `stock/stock-query` |
| 缺货建议 | `stock-goods-list` |
| 销量：当天 / 近 7 天 / 近 30 天 | `goods/number-list` + `goods/query-sku-sales` |

**拿不到**：价格、供货价、商品层次、平台标签、上架时间/天数/状态、站点覆盖、预测日销。

### 3.2 SHEIN 后台 WebAPI（Session HTTP，`sso.geiwohuo.com`）

本次探查确认存在、且返回真实数据的接口：

| 需求字段 | 接口 | 关键字段 |
| --- | --- | --- |
| 商品列表 + 上架状态 | `POST /spmp-api-prefix/spmp/product/list` | `shelf_status`、`create_time`、`publish_time`、`first_shelf_time`、`tag_info_list`、`skc_info_list[].supplier_code`(货号) |
| 上架状态枚举 | 同上 `info.meta.customObj` | `ON_SHELF`/`WAIT_SHELF`/`OUT_SHELF`/`SOLD_OUT`/`ALL` |
| **商品层次** | `GET /idms/common/goodsLevel` | 20 个层次（见 §5.2） |
| **平台标签** | `GET /idms/goods-skc/get-goods-label-list` | 14 个标签（见 §5.3） |
| **价格/供货价/预测日销/库存/上架天数** | `POST /idms/goods-skc/list` | `price`、`purchasePrice`、`predictDaySales`、`shelfDays`、`shelfDate`、`c7dSaleCnt`、`c30dSaleCnt`、`stock`、`stayDeliver`、`transit`、`preemptionNum`、`overseasStockList`、`stockSaleDays` |
| **站点覆盖（含德/沙/日）** | `POST /spmp-api-prefix/spmp/shelf/get_skc_site_status` | 每个 SKC 返回 58 个站点的 `{site_abbr, shelf_status, sell_ban_status}` |
| 站点清单与分组 | `POST .../supplier/query_site_list`、`.../site/query_merge_site_list` | 58 站点 + 12 个合并组（欧洲/中东/亚洲/北美/拉美…） |
| 枚举字典 | `GET /idms/common/enum` | AddedStatus/SupplyStatus/AdviceStatus |

### 3.3 现有全托事实库

`dim.full_sku`、`dim.canonical_product/variant`（标准商品身份）、`fact.full_sku_sales_snapshot`、`fact.inventory_snapshot`、`dim.reporting_goods`。已有销量与库存事实，**没有**价格/层次/标签/站点事实。

## 4. 关键决策（需要你确认）

**选项 A：只用 OpenAPI** —— 能满足需求 1 的一部分、需求 2 无法满足（无上架状态）、需求 3/4/6 全部无法满足。**不建议**。

**选项 B：商品域纳入 WebAPI 契约（推荐）** —— 新增 `product/list`、`idms/goods-skc/list`、`shelf/get_skc_site_status` 等只读接口，与现有 order-management 用同一套 Session 机制（同一 `sso.geiwohuo.com`、同店 Profile、AES-GCM 加密会话、字段白名单、只读断言）。需求 1–6 全部可满足。

**选项 C：混合** —— 身份/库存/销量用 OpenAPI（稳定），价格/层次/标签/站点用 WebAPI。字段口径可能不一致，需要额外对账。

我建议 **B**，理由是需求 3/4/6 是本次重设计的核心，而它们**只存在于 WebAPI**；同时 B 能复用已有的 Session 安全模型，不引入新的凭据体系。

需要你确认：**是否授权把商品域 WebAPI 纳入契约**（这是新增只读接口，不是新权限申请）。

## 5. 页面设计

### 5.1 布局

沿用全托现有骨架（左侧固定导航 + 顶部全局筛选），商品管理页分四段：

1. **KPI 带**：标准货号数、有已上架覆盖的店铺×货号格数、已上架/链接总数、缺价格数。
2. **层次分布带**：新款、新款A、备货款A、保证在售款、备货款B 的**链接数量**（需求 4），点击即筛选。
3. **两个矩阵**（可切换）：店铺 × 标准货号覆盖矩阵（需求 5）；站点覆盖矩阵（需求 6，德/沙/日三列高亮置顶）。
4. **明细表**：商品主信息 + 全部字段，支持排序、分页、按上架状态筛选。

### 5.2 明细表列（需求 1）

| 列 | 字段 | 来源 |
| --- | --- | --- |
| 货号 | `supplier_code` / `sellerSku` | WebAPI + OpenAPI |
| SKC / SPU | `skc` / `spu` | 两者 |
| 价格 | `price` | WebAPI |
| 供货价 | `purchasePrice` | WebAPI |
| 销量：当天 / 7 天 / 30 天 | `totalSaleVolume` / `c7dSaleCnt` / `c30dSaleCnt` | WebAPI（OpenAPI 可交叉校验） |
| SHEIN 仓库存 | `stock` | WebAPI（OpenAPI `stock-query` 交叉校验） |
| 创建 / 发布 / 首次上架时间 | `create_time` / `publish_time` / `first_shelf_time` | WebAPI |
| 上架天数 | `shelfDays` | WebAPI |
| 上架状态 | `shelf_status` | WebAPI |
| 商品层次 | `goodsLevel.name` | WebAPI |
| 预测日销 | `predictDaySales` | WebAPI |
| 平台标签 | `goodsLabelList` | WebAPI |

### 5.3 商品层次枚举（需求 4）

后台实际 20 个层次，按备货语义归为 5 组用于统计与筛选：

- **新款组**：新款、新款A、新款未上架、加码
- **备货组**：备货款A、备货款B（含备货款C/C1）
- **保证在售组**：保证在售款（含回流款/过渡款）
- **淘汰组**：售完下架、清仓款、退供款、重复款、自主下架、自主停产
- **异常组**：问题款、暂不下架、待处理议价、QQK、热销断码款、春夏款、特殊-赠品

页面按你点名的五个（新款、新款A、备货款A、保证在售款、备货款B）单列计数，其余折叠。

### 5.4 平台标签（需求 3）

后台固定 14 个标签：宰牲节元素款、圣诞常规款、斋月元素款、反季高销款、大库存活动、万圣节元素款、降价可抢流量、跟卖品、大体积-通用、欧洲高销款、南沙退税圈品、中东高销款、圣诞节元素款、计划打压款。按标签多选筛选。

### 5.5 上架状态筛选（需求 2）

`ALL` / `ON_SHELF`(已上架) / `WAIT_SHELF`(待上架) / `SOLD_OUT`(已售罄) / `OUT_SHELF`(已下架)，与后台计数一致（当前该店 253 / 87 / 85 / 15 / 66）。

### 5.6 站点覆盖矩阵（需求 6）

列 = 站点（德 `shein-de`、沙 `shein-sa`、日 `shein-jp` 置顶高亮，其余可折叠），行 = 标准货号/SKC，格 = 上架/未上架。数据来自 `shelf/get_skc_site_status` 的 58 站点。

## 6. 实施分期（确认后）

- **一期**：WebAPI 商品域契约（3 个只读接口 + 字段白名单 + 测试）→ 采集落库 → 明细表 + 上架状态筛选 + 层次/标签计数。
- **二期**：店铺×标准货号矩阵 + 站点覆盖矩阵。
- **三期**：与 OpenAPI 事实交叉校验、口径对账。

## 7. 风险与边界

1. **WebAPI 是后台内部接口，非官方开放平台**，字段可能无预警变更；沿用现有「字段白名单 + 漂移即留在 raw 并报警」的既有做法，不静默补零。
2. 质检接口在 9-6 曾出现 `ORDER_MANAGEMENT_AUTH_EXPIRED`，说明部分后台子系统有独立认证；商品域接口本次探查**全部返回 code 0 正常**，但上线前需按店逐一验证 25 店覆盖。
3. `predictDaySales` 等预测值是平台口径，BI 只展示不重算。
4. 站点覆盖的 `shelf_status` 本次观察到取值 0/1，语义需在实现前用后台页面交叉确认（不凭推测标注）。
5. 价格字段为 CNY 原币口径，与半托的 SAR 口径不同，不能混算。

