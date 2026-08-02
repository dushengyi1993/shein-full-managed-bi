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
