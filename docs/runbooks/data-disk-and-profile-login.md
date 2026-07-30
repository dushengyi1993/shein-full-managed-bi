# 全托数据盘与云端 Profile 登录

## 磁盘边界

100GB 高性能云盘挂载在 `/data`。全托沿用半托已验证的分层：

- `/data/shein-fm/backups` 绑定到 `/srv/shein-fm/backups`
- `/data/shein-fm/runtime` 绑定到 `/srv/shein-fm/runtime`
- `/data/shein-fm/profiles` 绑定到 `/srv/shein-fm/webapi/profiles`
- PostgreSQL 数据卷与 `/opt/shein-fm/releases` 保留在系统盘

数据库与发布版本保留在系统盘，是因为顺序实测中系统盘约为数据盘的两倍，
而数据库查询、迁移和发布切换比备份、运行时报告及浏览器 Profile 更受时延影响。

`/etc/fstab` 必须先挂载 `/data`，再建立三个 bind mount。相关服务安装
`20-shein-fm-data-disk.conf`，在挂载缺失时拒绝启动，禁止意外把数据写回系统盘。

容量阈值：

- 系统盘达到 70% 或可用空间低于 20GB：告警并检查数据库增长
- 数据盘达到 70%：先清理无租约 Profile 缓存，再检查备份归档
- 任一磁盘达到 85%：停止新的历史回补，保留在线查询与 Webhook

只有当数据库在完成有界历史治理后仍持续超过 1GB/日增长，或系统盘再次达到
70%，才评估数据库迁盘；迁盘需单独停机窗口、完整备份和回读，不与日常发布合并。

## 一次性登录页

1. 以 `sheinfm` 可读写的方式创建 `/srv/shein-fm/secrets/store-login/batch.json`。
2. 运行 `node scripts/create_full_managed_store_login_batch.mjs`，把输出的
   `https://fm.dushengyi.cc/store-login#token=...` 交给全托同事。
3. 同事逐店打开云端 Chrome，登录并允许 Chrome 保存密码，然后点击
   “登录完成并验证”。同一时间只允许一个 Profile 打开。
4. 服务只保存店铺、进度、进程号和令牌哈希，不读取或输出密码、Cookie、
   Local Storage、IndexedDB 或请求头。
5. 24 店完成后撤销批次文件或停止 `shein-fm-store-login.service`，并创建
   `/srv/shein-fm/runtime/store-login/renewal.enabled` 启用续期。

24 店完成后还要以状态文件回读为证据，创建两个不含秘密的门禁：

- `/srv/shein-fm/runtime/store-login/all-24-completed`
- `/srv/shein-fm/runtime/webapi-history.enabled`

随后启动 `shein-fm-home-webapi-backfill.service`。它只读取 24 个已验证
Profile，从平台最早支持日期起串行回补首页店铺日指标、货号日指标，并按自然日
回补交易概览和主销地区。交易概览、地区排行每个成功自然日都有审计断点，中断后
只补尚未成功的日期，不会从头重复请求数万次；
成功后独立触发 Dashboard 物化。任意店铺登录失效时任务失败关闭该浏览器，
不会借用其他 Profile 或把其他店数据归入本店。

续期服务每天两次逐店打开同一 Profile。只有当 Chrome 已自动填好账号和密码时
才点击登录按钮；脚本只接收“字段是否有值”的布尔值，不接收字段内容。任何店铺
身份无法确认时均记录为失败，禁止把其他店铺数据归到该店。

## OpenAPI 历史回补

首页财务历史由 `shein-fm-home-finance-backfill.service` 按 7 天窗口回补。
平台开店前返回的错误保持为失败证据，不改写为零；开店后的失败窗口必须单独复核。

采购单是当前除财务外唯一已验证可按更新时间完整重放的 OpenAPI 历史域。
`shein-fm-purchase-order-history-backfill.service` 使用固定清单
`4f7700f03220014c8611787b362a02c3f576d35b87ceadf776e866a981f64ec9`，
覆盖 24 店、2024-01-01 至 2026-07-29，共 18 个受控计划和 22,584 个一天窗口。
历史任务只抓已经完整结束的自然日；当天数据由日常同步与 Webhook 增量链路负责，
禁止把当天生成的半开区间当作完整历史窗口。
每个计划最多 4 店、1,600 个窗口，执行时最多 2 店并发；成功窗口写入控制面并在
重启后跳过。库存、
销量滚动快照和 Webhook 订阅前事件均不可重建，不得伪装成历史回补成功。
