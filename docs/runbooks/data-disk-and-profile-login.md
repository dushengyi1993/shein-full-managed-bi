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
Profile，从平台最早支持日期起串行回补首页店铺日指标、地区和货号日指标；
成功后独立触发 Dashboard 物化。任意店铺登录失效时任务失败关闭该浏览器，
不会借用其他 Profile 或把其他店数据归入本店。

续期服务每天两次逐店打开同一 Profile。只有当 Chrome 已自动填好账号和密码时
才点击登录按钮；脚本只接收“字段是否有值”的布尔值，不接收字段内容。任何店铺
身份无法确认时均记录为失败，禁止把其他店铺数据归到该店。
