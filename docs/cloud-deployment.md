# 全托 BI 云端部署手册

最后更新：2026-07-26

## 1. 生产拓扑与边界

`fm.dushengyi.cc` 的公网链路为：

```text
Cloudflare
  -> HAProxy 443
  -> Caddy 127.0.0.1:11443
  -> Nginx 127.0.0.1:8081
       -> Portal 127.0.0.1:8788
       -> Webhook Receiver 127.0.0.1:8793
       -> Authorization Broker 127.0.0.1:8789
```

PostgreSQL 独立监听 `127.0.0.1:54330`。全托与半托只共享服务器和边缘反代进程；发布目录、运行身份、数据库、端口、凭据、事实表和 systemd 单元全部隔离。

- 发布目录：`/opt/shein-fm/releases/<git-commit>`
- 当前版本：`/opt/shein-fm/current`
- 运行、日志和备份：`/srv/shein-fm/{runtime,logs,backups}`
- 私密配置：`/srv/shein-fm/secrets/<component>`
- 授权服务：`/opt/shein-fm-auth/current`、`/srv/shein-fm-auth`
- systemd 前缀：`shein-fm-*`

任何 SHEIN 写操作、平台 Webhook 订阅创建和自动化执行均不属于部署步骤，默认关闭。

## 2. 运行身份

不得再用一个 `sheinfm` 用户承载所有进程。创建以下不可登录系统用户和共享 Dashboard 只读组：

| 组件 | Unix 用户/组 | 数据库 LOGIN | 数据库能力组 |
| --- | --- | --- | --- |
| Portal | `sheinfm-portal` | 无 | 无 |
| Dashboard 物化 | `sheinfm-materializer` | `sheinfm_materializer_login` | `sheinfm_materializer_ro` |
| 销量同步 | `sheinfm-sales` | `sheinfm_sales_login` | `sheinfm_sales_loader` |
| 供应链同步 | `sheinfm-supply` | `sheinfm_supply_login` | `sheinfm_supply_loader` |
| Webhook Receiver | `sheinfm-webhook-ingress` | `sheinfm_webhook_ingress_login` | `sheinfm_webhook_ingress` |
| Webhook Worker | `sheinfm-webhook-worker` | `sheinfm_webhook_worker_login` | `sheinfm_webhook_worker` |
| 授权 Broker | `sheinfm-auth` | 无 | 无 |
| 数据库迁移/备份 | `root` | 容器 owner | owner |

示例创建方式：

```bash
sudo groupadd --system --force sheinfm-dashboard
for account in \
  sheinfm-portal sheinfm-materializer sheinfm-sales sheinfm-supply \
  sheinfm-webhook-ingress sheinfm-webhook-worker
do
  getent group "$account" >/dev/null || sudo groupadd --system "$account"
  id "$account" >/dev/null 2>&1 || sudo useradd \
    --system --no-create-home --shell /usr/sbin/nologin \
    --gid "$account" "$account"
done
sudo usermod -a -G sheinfm-dashboard sheinfm-portal
sudo usermod -a -G sheinfm-dashboard sheinfm-materializer
```

Portal 只能读取原子发布的 Dashboard JSON，不得获得数据库连接串或平台凭据。

## 3. 目录与权限清单

先验证 `/srv`、`/srv/shein-fm` 和 `/srv/shein-fm/secrets` 均为 root 所有，组和其他用户不可写。建议清单：

```bash
sudo install -d -o root -g root -m 0755 /srv/shein-fm
sudo install -d -o root -g root -m 0755 \
  /srv/shein-fm/runtime /srv/shein-fm/logs /srv/shein-fm/backups
sudo install -d -o root -g root -m 0711 /srv/shein-fm/secrets
sudo install -d -o sheinfm-materializer -g sheinfm-dashboard -m 0750 \
  /srv/shein-fm/runtime/dashboard

sudo install -d -o root -g sheinfm-portal -m 0750 \
  /srv/shein-fm/secrets/portal
sudo install -d -o root -g sheinfm-materializer -m 0750 \
  /srv/shein-fm/secrets/materializer
sudo install -d -o root -g sheinfm-sales -m 0750 \
  /srv/shein-fm/secrets/sales
sudo install -d -o root -g sheinfm-supply -m 0750 \
  /srv/shein-fm/secrets/supply
sudo install -d -o root -g sheinfm-webhook-ingress -m 0750 \
  /srv/shein-fm/secrets/webhook-ingress
sudo install -d -o root -g sheinfm-webhook-worker -m 0750 \
  /srv/shein-fm/secrets/webhook-worker
sudo install -d -o root -g root -m 0700 \
  /srv/shein-fm/secrets/db-migrate
```

`/srv/shein-fm/secrets` 的 `0711` 仅允许服务账号沿已知路径穿越父目录，不允许列出目录内容。各运行组件子目录仍以 `0750` 隔离，`db-migrate` 子目录保持 `0700`；实际密钥文件继续按下表使用 `0640` 或 `0600`，因此组件不能读取其他组件的私密配置。

文件清单：

| 路径 | 所有者/模式 | 用途 |
| --- | --- | --- |
| `portal/bi_users.json` | `root:sheinfm-portal 0640` | 登录账号散列 |
| `portal/session-secret` | `root:sheinfm-portal 0640` | 会话 HMAC |
| `store-login/internal.token` | `root:root 0600` | Portal 与回环登录维护服务的 systemd credential |
| `materializer/database.env` | `root:sheinfm-materializer 0640` | 只读物化连接 |
| `sales/database.env` | `root:sheinfm-sales 0640` | 销量 loader 连接 |
| `sales/openapi.json` | `root:sheinfm-sales 0640` | 25 店清单；仅已授权店启用只读凭据 |
| `supply/database.env` | `root:sheinfm-supply 0640` | 供应链 loader 连接 |
| `supply/openapi.json` | `root:sheinfm-supply 0640` | 25 店清单；仅已授权店启用只读凭据副本 |
| `webhook-ingress/database.env` | `root:sheinfm-webhook-ingress 0640` | 回执入仓连接 |
| `webhook-ingress/stores.json` | `root:sheinfm-webhook-ingress 0640` | 最小店铺路由身份 |
| `webhook-ingress/application.secret.json` | `root:sheinfm-webhook-ingress 0640` | 验签/密文接收应用凭据 |
| `webhook-worker/database.env` | `root:sheinfm-webhook-worker 0640` | Worker 连接 |
| `webhook-worker/stores.json` | `root:sheinfm-webhook-worker 0640` | 解密后的店铺映射 |
| `webhook-worker/application.secret.json` | `root:sheinfm-webhook-worker 0640` | 解密应用凭据 |
| `db-migrate/runtime-role-passwords.env` | `root:root 0600` | 迁移期间注入六个密码 |

不同组件使用独立普通文件；不得用指向更宽权限目录的符号链接。数据库 `database.env` 只包含该组件 LOGIN 的连接串。Webhook Worker 当前不会调用实际 OpenAPI 回查客户端，即使其配置中存在店铺映射。

Portal 会话默认有效期为 30 天。合法会话使用超过一半有效期后，任一正常访问会签发新的 `HttpOnly / Secure / SameSite=Lax` Cookie，把有效期再延长 30 天；长期完全不访问仍会自然过期。生产 unit 必须显式设置 `FULL_BI_SESSION_TTL_SECONDS=2592000`，修改会话时长后旧 Cookie 会失效并要求重新登录一次。

## 4. 数据库密码与兼容切换

复制模板：

```bash
sudo install -o root -g root -m 0600 \
  infra/systemd/shein-fm-db-migrate-secrets.env.example \
  /srv/shein-fm/secrets/db-migrate/runtime-role-passwords.env
```

重要：

- `SHEIN_FM_APP_DB_PASSWORD` 必须复用当前生产 `sheinfm_app` 密码。本次切换期间不得旋转它；
- 其余五个 LOGIN 密码应独立生成、至少 24 个 URL-safe 字符，彼此不得复用；
- 密码值不得出现在命令行、日志、Git 或 shell history；
- `scripts/migrate_full_managed_db.sh` 只把变量名通过 `docker exec --env NAME` 注入容器，值来自 root-private EnvironmentFile；
- 只有在五个新服务完成切换并确认没有旧进程使用 `sheinfm_app` 后，才可另行规划旧密码轮换。

迁移若在 `0002` 之后失败，旧 Portal 仍只读 JSON；旧数据库客户端依赖复用的 `sheinfm_app` 密码继续工作。不要在迁移失败后删除或重建现有数据库卷。

## 5. 发布前本地门禁

```bash
npm ci --ignore-scripts
npm test
npm run check
npm audit --omit=dev
git diff --check
```

必须满足：

- 测试 0 失败；平台相关跳过项要在 Linux/云端补跑；
- 仓库秘密扫描无数据库密码、OpenAPI secret、token、cookie 或签名；
- 当前提交已推送到 GitHub，发布包来源于该精确提交；
- Nginx 和所有 systemd 单元先做静态验证。

## 6. PostgreSQL 临时库演练

生产迁移前，必须在同一 PostgreSQL 版本创建名称明确的临时数据库，完整执行全部 migration 与 verify。不要只测试 `9999`。

1. 记录生产容器、镜像版本和目标提交；
2. 创建唯一临时库，例如 `shein_fm_rehearsal_20260726_<suffix>`；
3. 以同一组迁移密码执行 `0001` 到 `9999`；
4. 执行 `db/verify/` 全部脚本；
5. 使用五个 LOGIN 分别做允许/拒绝的最小权限探针；
6. 重跑全部 migration/verify，确认幂等；
7. 只在精确核对临时库名后删除该临时库。

任何脚本失败都禁止进入生产。

## 7. 生产发布顺序

1. 仅当本次包含数据库迁移、高风险数据变更或用户明确要求时，创建一份 deploy 备份并
   校验；普通代码、前端和 systemd 发布不创建数据库备份，周备份仍按独立定时器执行；
2. 将目标 Git 提交安装到新的 `/opt/shein-fm/releases/<commit>`，执行 `npm ci --omit=dev --ignore-scripts`；
3. 不切换 `current`，先在 release 内跑静态检查；
4. 安装 root-private 迁移 EnvironmentFile；
5. 运行 `shein-fm-db-migrate.service`，确认全部 migration 与 verify 成功；
6. 为五个组件写入独立 `database.env`，LOGIN 与能力组必须一一对应；
7. 安装 systemd 单元，执行 `systemd-analyze verify` 和 `systemctl daemon-reload`；
8. 手工运行一次 Dashboard 物化，检查 staging 原子替换、文件所有权和 JSON 契约；
9. 首次引入运行态投影时，先用目标 release 的绝对路径手工运行
   `materialize_full_managed_system_health.mjs`，确认脱敏快照已经原子生成且不含凭据；
10. 切换 `/opt/shein-fm/current`；
11. 手工启动一次 `shein-fm-system-health.service` 并回读成功，再启用其 timer；只创建
    `portal.enabled` 与 `materializer.enabled` 门禁，启动 Portal 和物化 timer；
12. 安装 Nginx 和 logrotate，执行 `nginx -t` 成功后只 reload；
13. 从 loopback 和公网验证登录墙、Dashboard API、`/api/system`、12 个路由和退出登录；
14. 再按下节逐域开启数据服务。

共享 HAProxy 同时承载 443 SSH，严禁 restart；只允许在保留现有 SSH 会话时执行 `haproxy -c` 后 reload。

## 8. 销量、供应链与 Webhook 分阶段开启

### 销量

1. 使用新 `sheinfm-sales` 身份对一个已知店铺运行权限探针；
2. 对一个有销量日期的店铺完成同步与仓库回读；
3. 对一个完整零销量、无 `dt` 的店铺验证 `LEGAL_ZERO_UNANCHORED`，不得告警为失败；
4. 扩大到当前已授权店并核对权限、SKU 数、业务日期、四窗口总量和店铺覆盖；新增店逐店通过后扩至 25 店；
5. 物化并回读 Portal；
6. 只有全部门禁通过后创建 `sales-sync.enabled` 并启用 timer。

### 供应链

1. 先完成销量稳定 SKU 成员关系；
2. 对一店一域探针商品、库存、缺货建议、采购和交付字段；
3. 显式运行历史回填；回填失败、部分覆盖或未知字段均不可视为完成；
4. 执行一次正常增量并回读同步尝试账本、投影批次和 Dashboard；
5. 只有历史回填与增量均通过后，才创建 `supply-backfill.verified` 和 `supply-sync.enabled`；
6. 供应链 timer 默认保持禁用，部署脚本不得自动创建两个门禁。

库存请求集合必须来自最新可接受的销量稳定清单。最新销量运行失败或清单证据缺失时，库存同步要显示部分/阻断，不能回退到商品接口清单。

### Webhook

1. 配置独立 ingress/worker secrets 和数据库 LOGIN；
2. 安装 Nginx 精确路由 `/api/shein/webhook/v1/events`，执行 `nginx -t`；
3. 创建 `webhook-ingress.enabled` 与 `webhook-worker.enabled` 后启动两个进程；
4. 回读 Receiver 和 Worker 新鲜心跳；空队列本身不算健康；
5. 对错误签名请求验证安全 `401`，日志不得出现签名、查询参数或密文；
6. 用受控测试事件验证 receipt、job、标准化事件和 Dashboard；
7. 所有事件采用 10 分钟签名投递窗口的至少一次语义：同窗口同密文重试去重，跨窗口同载荷形成新事件；窗口边界可能重复，所有下游处理必须幂等。

本次不创建 SHEIN 平台订阅。订阅属于外部写操作，须另行实时读回、dry-run、明确确认和结果回读。

## 9. 服务与验收

```bash
systemctl status \
  shein-fm-db.service \
  shein-fm-portal.service \
  shein-fm-dashboard-materialize.timer \
  shein-fm-dashboard-materialize-retry.timer \
  shein-fm-db-restore-test.timer \
  shein-fm-system-health.timer \
  shein-fm-webhook-receiver.service \
  shein-fm-webhook-worker.service

systemctl list-timers 'shein-fm-*'
curl -fsS http://127.0.0.1:8788/health
curl -I https://fm.dushengyi.cc/
docker exec shein-fm-db pg_isready -U sheinfm -d shein_fm
```

验收要求：

- 未登录 `/api/dashboard` 返回 `401`，登录后只读；
- 未登录 `/api/system` 返回 `401`，登录后只返回脱敏运行态；
- Portal 进程环境无数据库与平台凭据；
- 首页显示真实今日/昨日/7日/30日、逐日趋势、店铺和标准商品排行；
- 页面明确业务日期、25 店规范范围、实际覆盖和具体质量原因；
- 合法零销量不报错，缺数/部分覆盖不显示为零；
- 员工可读全部店铺，负责人/店铺仅用于筛选；
- 所有 mutation 和 SHEIN 写开关保持关闭；
- Webhook Receiver/Worker 心跳分别新鲜；
- Nginx、systemd、数据库角色和文件权限均通过实机验证。

## 10. 回滚

代码回滚只将 `/opt/shein-fm/current` 原子切回上一个已验证 release，并重启受影响的 Portal/worker。数据库 schema 使用向前迁移，不覆盖旧 migration，也不删除新角色或事实表。

如果新数据服务失败：

1. 删除对应 `*.enabled` 门禁并停止该组件；
2. 保留旧 Dashboard JSON，Portal 继续只读；
3. 切回旧 release；
4. 保留追加式 raw/ops 证据用于诊断；
5. 不删除数据库卷、不回滚已提交事实、不旋转旧 `sheinfm_app` 密码；
6. 修复后重新走临时库、迁移、逐域探针与回读。

边缘配置回滚使用部署前保存在 `/srv/shein-fm/backups/edge-*` 的精确副本，并在 reload 前重新验证。删除任何门禁或旧 release 前必须先精确解析目标路径。

## 11. 磁盘与历史治理

完整规则、清单格式与维护窗口顺序见
[docs/runbooks/disk-and-history-governance.md](runbooks/disk-and-history-governance.md)。
以下只列部署相关要点。

### 11.1 备份模式

`scripts/backup_full_managed_db.sh` 必须带 `--mode`：

- `--mode weekly` 由 `shein-fm-db-backup.timer` 调用，每个上海 ISO 周最多一次成功备份；
- `--mode deploy` 仅用于数据库迁移、高风险数据变更或人工明确要求，并按 SHA-256 去重。

两者共用 IO 重车道，部署备份与定时器不会互相打断。保留集合为“最近 2 份周备份 +
最近 1 份 deploy”；全部位于挂载云硬盘。日常不再自动归档
COS，每月用临时数据库做一次完整恢复演练。

### 11.2 部署成功后清理发布目录

清理**不自动执行**。健康检查与回读通过后显式运行：

```bash
scripts/post_deploy_prune_releases.sh            # 只计划
scripts/post_deploy_prune_releases.sh --apply    # 确认后执行
```

保护 `current`、`previous`、最新 5 个，以及**任何被存活进程 cwd 引用的发布**。
Webhook receiver/worker 常运行在较旧的发布上，仅按“最新 5 个”清理会删掉正在运行的
代码目录。

### 11.3 新增 systemd 单元

| 单元 | 节奏 | 说明 |
| --- | --- | --- |
| `shein-fm-db-backup.timer` | 每周日 00:15 | 传 `--mode weekly`；进入 IO 重车道 |
| `shein-fm-db-restore-test.timer` | 每月首个周日 01:15 | 完整恢复到临时库并核对关键表 |
| `shein-fm-session-renewal.timer` | 每日一次 | 25 店纯 HTTP 轻探测并接受 Cookie 轮换，不开 Chrome |
| `shein-fm-session-recovery.timer` | 每小时 `:18` | 仅恢复队列非空时最多打开 3 个对应 Profile |
| `shein-fm-disk-guard.timer` | 每 15 分钟 | 只观测，`>=85%` 时 unit failed |
| `shein-fm-profile-cache-prune.timer` | 每周日 12:20 | Profile 占用时 fail closed |
| `shein-fm-system-health.timer` | 每 5 分钟 | root 读取固定白名单并原子发布脱敏运行态 |

系统管理页的数据边界、Profile 双证据语义和生产验收见
[docs/system-management.md](system-management.md)。

历史维护**故意没有定时器**：每一步破坏性操作都要先出计划、再带 `--plan-hash` 执行。
`VACUUM FULL` 只能通过显式 `--reclaim` 在维护窗口人工触发，任何定时器都不会调度它。

### 11.4 对账表迁移窗口

迁移 0013 会重建并交换 `ops.reconciliation_result`（原 3,007,452 行 / ~1.78GB，
真实粒度仅 93,702 个）。必须按“停供应链同步 → 迁移前全量备份 → 迁移 → verify 0013
与 9999 → 恢复服务”的顺序执行，详见运维手册第 7 节。旧的 3M 行只保留于有界迁移
备份中，刻意不保留第二份 1.7GB 在线影子表。

## 12. 共享服务器资源协调

部署任何定时批任务前，必须先安装主机级 `shein-host-heavy.slice`、全托子级
`shein-host-heavy-fm.slice`、轻量全托 `shein-fm-heavy.slice` 和
`infra/tmpfiles.d/shein-fm-scheduler.conf`，创建主机排他锁、两个浏览器读槽、API
轻量槽、数据库只读槽以及各组件共享运行目录，再安装 service/timer。复用共享运行目录的
oneshot 必须保留该目录，不能在结束时删除。锁顺序必须是主机车道在外、项目锁在内，
压力检查在持锁后执行。高频 timer 禁止
`Persistent=true`；Dashboard 物化禁止设置开机触发。完整阈值、验收和回滚见
[全托共享服务器资源协调](runbooks/resource-coordination.md)。

部署时只停止全托 timer，不中断正在运行的任务，不改动半托 unit 或仓库。切换 release
后先执行 `systemd-analyze verify` 和压力门禁探针，再只启动 timer；不得追补重启期间
错过的批次。
