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

## 外部登录页与系统内维护中心

1. `/srv/shein-fm/secrets/store-login` 的生产 owner/mode 是
   `root:sheinfm 0750`，其中既有 `batch.json` 必须是 regular、非 symlink、
   `root:sheinfm 0640`。`shein-fm-store-login.service` 以 `sheinfm:sheinfm`
   运行并通过 `ReadOnlyPaths` 只读该文件；不得把 batch 改成 `0600` 或改由
   `sheinfm` 拥有。
2. 生成工具只允许由 root 替换 schema 有效且已经过期或已经撤销的旧 batch；
   仍未到期且未撤销的活动 batch、文件缺失、父目录与文件 gid 不一致或
   metadata/schema 异常都会 fail closed。
   生成 24 小时 batch：

   ```bash
   sudo node scripts/create_full_managed_store_login_batch.mjs --expires-hours=24
   ```

   工具先独占备份旧文件，再通过同目录独占临时文件、保留 uid/gid、`fchmod 0640`、
   fsync、rename 前二次漂移检查、原子 rename 和最终读回安装新 batch。成功后以
   `stat` 和 SHA-256 确认当前文件为 `root:sheinfm 640`；备份使用更严格的 `600`，
   成功输出只暴露其 basename。

   ```bash
   sudo sh -c 'cd /srv/shein-fm/secrets/store-login && stat -c "%U:%G %a" batch.json && sha256sum batch.json'
   ```
3. 把成功输出的 `https://fm.dushengyi.cc/store-login#token=...` 只通过私密渠道
   交给全托同事，不重定向或记录该 stdout。`#token` 是 URL fragment，不会随 HTTP
   请求发送给 Nginx 或 upstream。页面只从 `location.hash` 读取 batch bearer，写入
   `sessionStorage` 后立即用 `replaceState` 清除地址栏；旧 query 链接明确不兼容。
   Nginx 对 `/store-login`、`/store-login/` 和 `/api/store-login/` 全部关闭访问日志，
   页面同时启用 `Referrer-Policy: no-referrer`。
4. 同事逐店打开云端 Chrome，登录并允许 Chrome 保存密码，然后点击
   “登录完成并验证”。同一时间只允许一个 Profile 打开。
5. batch bearer 在到期或撤销前可复用。服务只保存店铺、进度、进程号和令牌哈希，
   不读取或输出密码、Cookie、
   Local Storage、IndexedDB 或请求头。
6. 25 店完成后使用 `scripts/revoke_full_managed_store_login_batch.mjs` 的
   fresh dry-run → exact-plan apply 流程撤销外部 batch，不手工编辑或删除文件。
   apply 后读回当前 SHA-256、`root:sheinfm 640` 和独占 `600` 备份，再让撤销前
   已打开的外部页面用 `sessionStorage` 中的已知 bearer 重试 API，必须返回 401；
   页面本身不要求 404。详细命令与证据口径见 `fnos-store-login-staging.md`。
   不要停止
   `shein-fm-store-login.service`：系统管理中的登录维护中心仍通过该本机服务工作。
   创建 `/srv/shein-fm/runtime/store-login/renewal.enabled` 启用续期。

25 店完成后还要以状态文件回读为证据，创建两个不含秘密的门禁：

- `/srv/shein-fm/runtime/store-login/all-25-completed`
- `/srv/shein-fm/runtime/webapi-history.enabled`

随后先为 25 店各执行一次 `shein-fm-session-bootstrap@<店铺>.service`。建档过程只在
该店已通过页面身份回读后，从 CDP 读取 SHEIN 官方域的 Cookie 与 User-Agent，使用
systemd credential 提供的 AES-256-GCM 密钥按店加密保存，再以相同请求分别做页面内
读取和直接 HTTP 读取；只有响应体 SHA-256 完全一致才接受该会话。Cookie、密码、请求头
和明文响应都不进入日志、数据库或 Git。

通过双读门禁后启动 `shein-fm-home-webapi-backfill.service`。它默认只读取加密会话，
以 `credentials: include` 的同源 HTTP 语义从平台最早支持日期起回补首页店铺日指标、
货号日指标、交易概览和主销地区，正常运行不打开 Profile。每个成功自然日都有审计断点，
中断后只补尚未成功的日期；成功后通过事件队列触发 Dashboard 物化。任意店铺返回登录页、
鉴权业务码或 Cookie 过期时，只把该店写入恢复队列，不能借用其他店会话或把其他店数据
归入本店。

每日续期服务改为纯 HTTP 探测：逐店调用轻量的 `get_update_time`，接收平台返回的
`Set-Cookie` 后立即合并并重新加密落盘，因此不会为了“续期”逐店打开 Chrome。只有
失败或缺少加密会话的店铺进入 `/srv/shein-fm/runtime/store-login/session-recovery.json`；
小时级恢复任务每次最多处理 3 店，才会打开对应 Profile、使用已保存密码恢复，并重新执行
页面/HTTP 双读验真。未进入恢复队列的店铺不会启动浏览器。

BI 的 `#system` 页面为系统管理员提供同一套 25 店登录维护动作。浏览器只调用
Portal 的 `/api/system/store-login/*`；Portal 使用 systemd credential 在回环地址
代理到登录服务，不把内部令牌、Cookie 或 Profile 文件返回浏览器。普通员工仍可查看
脱敏登录、HTTP 会话健康与恢复状态，但不能读取会话密文、Cookie 或 Profile 文件。

## Store Login 状态重置工具

当 UI 状态文件沿用了迁移前的登录进度（例如显示 24 completed / 1
needs_attention），而续期报告和恢复队列证明 25 店会话实际全部过期时，
可用受控重置工具把登录状态恢复为可操作：

1. 先运行默认 dry-run：

   ```bash
   node scripts/reset_full_managed_store_login_state.mjs
   ```

   确认店码和计数后，完整保留输出中的 `plannedUpdatedAt`、
   `plannedStateSha256`，以及 `inputSha256.state`、
   `inputSha256.renewalReport`、`inputSha256.recoveryQueue`。计划时间已经写入
   待落盘字节，因此五个值共同构成不可变计划门禁。
2. 把 dry-run 的五个值原样代入 apply；不要重新生成时间或哈希：

   ```bash
   node scripts/reset_full_managed_store_login_state.mjs --apply \
     --planned-updated-at '<plannedUpdatedAt>' \
     --expected-planned-state-sha256 '<plannedStateSha256>' \
     --expected-state-sha256 '<inputSha256.state>' \
     --expected-renewal-report-sha256 '<inputSha256.renewalReport>' \
     --expected-recovery-queue-sha256 '<inputSha256.recoveryQueue>'
   ```

   apply 必须用该时间生成与 dry-run 完全相同的状态字节，并同时匹配计划哈希和
   三个输入哈希；任一值缺失、变化或存在 active session 都会在替换状态前失败。
3. 工具只重写 `/srv/shein-fm/runtime/store-login/state.json`。apply 会先读取原
   state 的 uid、gid 和权限，使用独占创建的随机临时文件，先 `chown`、后
   `chmod` 为原值，再执行原子 rename。因此即使由 root 调用，最终文件仍保持
   `sheinfm:sheinfm 0600`，不会阻断 `shein-fm-store-login.service` 后续写入。
4. 原 state 会以独占创建方式备份为同目录 0600 权限的时间戳 `.bak`，已有文件
   绝不会被覆盖；成功输出只返回备份 basename。写后哈希或 owner/mode 不匹配时，
   工具会尽力自动恢复原 state 字节及元数据，并以失败状态退出。
5. 会话未 ACTIVE 或在恢复队列中的店会被置为 pending 并带非敏感的
   `SESSION_RELOGIN_REQUIRED` 标记；ACTIVE 且不在队列的店保持原状。工具不触碰
   Profile、加密会话、续期报告、恢复队列、凭证或 token，也不启动浏览器或服务。
   校验兼容续期生产者的真实形状：ACTIVE 项可只有四个基础字段（也接受显式
   `recoveryQueued:false`、`errorCode:null`）；非 ACTIVE 项必须带
   `recoveryQueued:true` 和安全 errorCode，并与恢复队列集合完全一致。
6. 输出只包含计数、店码、计划时间、哈希和备份 basename，不包含 Cookie、token
   或 Profile 内容。状态重置后逐店人工重新登录，完成后以状态文件回读作为证据。

## OpenAPI 历史回补

首页财务历史由 `shein-fm-home-finance-backfill.service` 从官方允许的最早日期
`2024-01-01` 起按 7 天窗口回补。平台的合法空窗口返回 `code=0/info={}`，
按“成功且无报表”记断点，但不生成业务事实行；平台错误仍保持为失败证据，
不改写为零，开店后的失败窗口必须单独复核。

采购单是当前除财务外唯一已验证可按更新时间完整重放的 OpenAPI 历史域。
`shein-fm-purchase-order-history-backfill.service` 使用固定清单
`e2b5adf1f6f1690e4d4f12255484b87e06890050fe732f23f1a6fb06df95cd50`，
覆盖 25 店、2024-01-01 至 2026-07-29，共 21 个受控计划和 23,525 个一天窗口。
历史任务只抓已经完整结束的自然日；当天数据由日常同步与 Webhook 增量链路负责，
禁止把当天生成的半开区间当作完整历史窗口。
每个计划最多 4 店、1,600 个窗口，执行时最多 2 店并发；成功窗口写入控制面并在
重启后跳过。库存、
销量滚动快照和 Webhook 订阅前事件均不可重建，不得伪装成历史回补成功。
