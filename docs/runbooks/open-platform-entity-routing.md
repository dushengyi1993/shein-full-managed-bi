# 全托 OpenAPI 主体路由

## 固定口径

- 25 家全托店归属于 17 个公司主体；`NM7418` 与另外 4 家 NM 店共用 NM 主体应用。
- 一个公司主体只维护一个开放平台账户、一个持久 Chrome Profile 和一个全托应用。
- 同一主体的多家店授权给同一个应用；不同主体不得继续共用 DL 应用。
- 生产配置仍按店保存独立的 `openKeyId / secretKey`，调度器按 `appId` 分组限流。

主体与店铺的唯一映射见
`config/full-managed-legal-entities.json`。

## 现有账户复用

CX、XL、QY、DX、NM、LQ、TS、DL、FY、QH、JY、ZL、MZ、YJ
复用运营电脑本地已有的同主体开放平台 Profile。只复用账号登录态和应用主体，
不复用半托业务数据口径。

GJ、RH、WY 当前没有同主体的既有开放平台账户，独立 Profile 创建在运营电脑本地：

- `E:\Codex WorkSpace\Shein销售统计\profiles\persistent-gj-profile`
- `E:\Codex WorkSpace\Shein销售统计\profiles\persistent-rh-profile`
- `E:\Codex WorkSpace\Shein销售统计\profiles\persistent-wy-profile`

Chrome 根目录与内部 Profile 目录是两个不同层级，启动时必须同时按
`config/full-managed-legal-entities.json` 读取 `profileKey` 和
`chromeProfileDirectory`。现有复用主体使用 `Profile 1`；GJ、RH、WY
使用 `Default`。不得把内部目录写死为 `Profile 1`，否则会打开一个没有
这些新主体密码和登录态的空 Profile。

Profile 必须保留 Cookie、Local Storage、IndexedDB 和密码库。只允许在没有
Chrome 进程、没有租约时清理可再生缓存。

开放平台开发者 Profile 不放云服务器或云盘。云端
`/srv/shein-fm/webapi/profiles` 仅保存全托店铺后台 WebAPI Profile。

## 换绑顺序

1. 在目标主体 Profile 中确认开放平台实名主体。
2. 确认或创建该主体的全托应用并申请所需权限包。
3. 在“开发套件 → IP白名单”中加入生产云服务器出口 IP，并回读精确条目；
   2026-08-02 当前生产出口为 `43.165.167.135`。发送授权链接前必须再次
   与实际云端出口核对，不能仅沿用文档中的历史值。
4. 同主体店铺逐家授权，凭据先进入 `REVIEW_REQUIRED` 收件箱。
5. 用官方店铺身份接口核验 `supplierId`，再原子替换该店的生产凭据。
6. 对该主体全部店执行销量、订单、供应链和 webhook 只读探针。
7. 探针通过后才把该主体从 DL 应用调度组移出；DL 旧授权暂留作回滚，不立即撤销。

`/open-api/auth/get-by-token` 返回 HTTP 401 时，先检查该主体应用的 IP
白名单和 APP_ID/APP_Secretkey，不得让店铺反复消耗授权尝试次数。GJ、RH、
WY 在 2026-08-02 首次授权失败的根因是新主体白名单为空。

任何一步失败只回滚当前主体，不影响其他主体。

## Webhook 回调与订阅

Webhook 必须按主体应用配置，不能只部署接收器后就视为已经接入：

1. 先确认 `https://fm.dushengyi.cc/api/shein/webhook/v1/events` 的 GET
   健康探针和签名 POST 入口均可达，Receiver / Worker 均为 active。
2. 使用该主体在
   `config/full-managed-legal-entities.json` 中登记的本地 Chrome Profile，
   提交正式回调地址并回读平台审核状态。
3. 正式回调审核通过后，订阅平台对全托应用实际开放且
   `src/webhook/event-registry.mjs` 已支持的 15 类经营事件；不订阅
   `product_video_conversion_completed`。
4. 每次开关后必须重新调用平台 `queryEventConfigList`，只有回读为已订阅
   才写入 `ops.webhook_subscription_state`。未审核、未回读或回调验证失败
   均不得在 BI 中显示为已订阅。
5. 用平台“消息测试”验证一条技术回调：公网返回 2xx，receipt 入仓，
   Worker 成功处理，并保持 `APP_ONLY` 隔离，不得改变店铺门禁或业务事实。

本地管理命令：

```powershell
npm run webhook:configure-subscriptions -- --entity DL --inspect
npm run webhook:configure-subscriptions -- --entity DL --submit
```

命令默认不提交；`--submit` 是真实平台写入，须逐主体执行并保存回读结果。
