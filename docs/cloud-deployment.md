# 全托 BI 云端部署手册

## 生产拓扑

`fm.dushengyi.cc` 通过 Cloudflare 回源到共享 HAProxy 443 入口，再依次进入全托专用、仅 loopback 监听的 Caddy TLS `127.0.0.1:11443`、Nginx `127.0.0.1:8081` 和 Node `127.0.0.1:8788`。全托 PostgreSQL 独立监听 `127.0.0.1:54330`。

全托与半托共享的只有服务器和边缘反代进程；应用用户、发布目录、运行目录、数据库、端口、systemd 单元和凭据全部隔离：

- 运行用户：`sheinfm`
- 发布目录：`/opt/shein-fm/releases/<git-commit>`
- 当前版本：`/opt/shein-fm/current`
- 运行与备份：`/srv/shein-fm/{runtime,logs,backups}`
- 私密配置：`/srv/shein-fm/secrets`
- systemd 前缀：`shein-fm-*`

远程店铺授权使用独立服务和 Linux 账号，不改变 BI 门户的只读声明：

- 运行用户：`sheinfm-auth`
- 发布目录：`/opt/shein-fm-auth/releases/<git-commit>`
- 当前版本：`/opt/shein-fm-auth/current`
- Node 监听：`127.0.0.1:8789`
- 状态目录：`/srv/shein-fm-auth/runtime`
- 应用凭据与待核验收件箱：`/srv/shein-fm-auth/secrets`
- systemd 单元：`shein-fm-authorization.service`

## 私密配置

以下文件必须为 `root:sheinfm` 且不得允许 other 访问：

- `bi_users.json`：应用登录账号的密码散列；
- `session-secret`：独立 HMAC 会话密钥；
- `postgres.env`：容器数据库初始化凭据；
- `warehouse.env`：Node 到 PostgreSQL 的连接串；
- `openapi.json`：逐店全托应用与授权凭据。

`openapi.json` 中未授权店铺保持 `enabled: false`。不得复制半托的 `openKeyId / secretKey`，也不得把应用审核通过或权限包提交当成店铺授权成功。

生成首个授权批次前，先对生产 `openapi.json` 执行
`npm run openapi:migrate-store-inventory` 的默认 dry-run；核对输出后再带显式确认词执行。
随后必须回读确认店铺代码与仓库清单精确同序、总数为 24，且全部仍为
`enabled: false`、没有店铺凭据。旧的 18 店清单或任何已有凭据都会使迁移失败关闭。

授权 Broker 只读
`/srv/shein-fm-auth/secrets/application.secret.json` 中的 DL 全托应用凭据，并只写
`/srv/shein-fm-auth/secrets/receipts`。待核验 receipt 不会被销量同步读取；只有管理员核对
`supplierId` 后，受控晋级脚本才可原子更新正式 `openapi.json`。

授权专用文件权限：

- `application.secret.json`：`root:sheinfm-auth 0640`，Broker 只读；
- `runtime` 与 `receipts`：`sheinfm-auth:sheinfm-auth 0700`；
- `/srv/shein-fm/secrets/store-identity-map.secret.json`：`root:root 0600`，只保存从独立来源核验的 `storeCode → platformSupplierId`，Broker 不可读写；
- 正式晋级必须设置 `SHEIN_FM_CLOUD_EXECUTION=1`，并在写配置前用 receipt 凭据实时回读 `query-store-info`。

## 发布顺序

1. 运行 `npm test`、`npm run check`、`npm audit --omit=dev` 和 `git diff --check`。
2. 将确定的 Git 提交解压到新的 release 目录，并执行 `npm ci --omit=dev --ignore-scripts`。
3. 启动独立数据库，按编号执行 `db/migrations/`，再执行 `db/verify/`。
4. 从生产库物化 `/srv/shein-fm/runtime/dashboard.json`；空库必须生成 `empty + null`，不得复制 fixture。
5. 切换 `current` 软链接，安装并启动 Portal、备份与数据同步单元。
6. 安装 Nginx 站点；对共享 Caddy、HAProxy 配置先备份和验证，再只执行 reload。
7. 从公网验证 TLS、登录墙、会话登录、Dashboard API、九个路由和退出登录。
8. 创建 `sheinfm-auth` 系统用户和专用目录，安装授权服务；验证端口仅 loopback 监听。
9. 确认 Nginx 对 `/authorize` 与 `/openapi/authorize/callback` 只写不含查询参数的安全日志，
   安装 `infra/logrotate/shein-fm-auth`。
10. 完成生产店铺清单的 dry-run、显式确认迁移和 `24 店 / 0 enabled / 0 凭据` 回读后，
    再生成一次性授权批次。交接文件写入 broker 无法读取的 root 管控临时位置，安全传输后立即删除服务器副本。

HAProxy 同时承载 443 SSH，严禁 restart；只能在保留现有 SSH 会话的前提下执行 `haproxy -c` 后 reload。

## 服务与验收

```bash
systemctl status shein-fm-db.service shein-fm-portal.service
systemctl list-timers 'shein-fm-*'
curl -fsS http://127.0.0.1:8788/health
curl -fsS http://127.0.0.1:8789/health
curl -I https://fm.dushengyi.cc/
docker exec shein-fm-db pg_isready -U sheinfm -d shein_fm
```

未登录访问 `/api/dashboard` 必须返回 `401`，页面访问必须跳转 `/login`。销量定时任务只有在真实全托凭据写入并完成首店只读探针后启用；权限待审期间，生产页面应显示 24 店待授权和空销量。

授权入口 `/authorize` 必须可以在不登录 BI 的情况下打开，但没有 URL 片段口令或授权会话时不得读取批次。交接链接口令及 callback 查询参数不得出现在 Nginx 日志；安全日志只能包含
`method + uri + status + request_time`。SHEIN callback 完成后必须立即跳转到无查询参数结果页。

## 回滚

代码回滚只把 `/opt/shein-fm/current` 原子切换到上一个已验证 release，然后重启 `shein-fm-portal.service`。数据库 schema 采用向前迁移，不通过覆盖旧迁移回滚。边缘配置回滚使用部署前保存在 `/srv/shein-fm/backups/edge-*` 的精确副本，并在 reload 前重新验证。
