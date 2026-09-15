# 全托云端边缘迁移：2026-09-08 现场记录

## 范围与当前结论

用户授权只迁全托的公网入口与 OpenAPI 固定出口。业务、数据库和采集继续在飞牛 VM `192.168.1.79`；不迁移或关闭半托及其他项目。

新边缘 `43.165.185.3`（VM-0-15-ubuntu）已承担全托入口和 OpenAPI 出口。**白名单、出口、自动证书、真实 Webhook 终态验收已完成；旧全托 relay、旧 Nginx 站点和旧反向隧道已停用。旧 nameserver 仍在部分解析器中缓存，只保留旧域名入口→新机的 HTTPS 兼容转发，不能把该兼容入口也报告为已撤除。**

## 初始部署验收（以下为生产出口切换前的状态）

- 新机原有 Caddy、其他项目端口保留；原有 6 条显式 Caddy 路由与迁移前 JSON 逐条相等。
- 新机 CONNECT relay：仅监听 `127.0.0.1:18090`，仅允许 `openapi.sheincorp.com:443`。旧 Node 二进制 SHA256 `81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90` 安装在全托独立目录，不修改系统 Node。
- 新机公网出口实测 `43.165.185.3`。
- 飞牛新增 `shein-fm-friend-edge-tunnel.service`：本地候选代理 `18090`，新机反向端口 `18788/18793/18794/18789` 均只监听回环。
- 原 `shein-fm-openapi-tunnel.service`、`shein-fm-authorization-tunnel.service` 保持 active，业务本地代理仍为 `18080`，仍走旧云。
- 新机 `shein-fm-edge-nginx.service` 使用固定镜像 ID `sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c`，非 root、只读、无 capabilities，监听回环 `8081`，Docker 日志限制 10MB × 3。
- 迁移旧机当前 Nginx 路由，保留授权 URL 日志脱敏、StoreLogin 日志关闭、Webhook 签名头透传、限流及 WebSocket 配置。
- 新机回环验证：Portal `/health`、StoreLogin `/store-login`、授权 `/authorize`、Webhook `/healthz` 均 200。
- 从旧云强制解析 `fm.dushengyi.cc:443` 到新机，对 `/health`、`/store-login`、`/authorize` HTTPS 检查均 200，证书校验正常；原公网 `/health` 仍 200。
- 经飞牛候选代理连接 SHEIN，TLS 成功，根路径未认证请求返回 401。这只证明链路可达，**不证明已通过白名单或应用认证**。

## 配置与回退边界

新机全托独立路径：

- `/opt/shein-fm-openapi-relay`
- `/opt/shein-fm-edge`
- `/etc/caddy/shein-fm-edge.caddy`
- `/etc/caddy/shein-fm-tls`
- `/etc/systemd/system/shein-fm-openapi-relay.service`
- `/etc/systemd/system/shein-fm-edge-nginx.service`

共享 Caddy 仅追加一个全托 import；修改前 SHA256：`346eb7be14b10247d466b5b3cc319511456337ee3532bd17b989f4d2467eea56`。原配置备份 `/etc/caddy/Caddyfile.pre-fm-20260908`。先验证候选配置并再次核对原文件哈希，再替换及 reload；不得无条件用备份覆盖其他人后续修改。

VM 新文件位于 `/srv/shein-fm/secrets/openapi-relay/friend_ssh_config` 和 `friend_known_hosts`。新机 SSH key 限制为明确的 permitopen/permitlisten，并禁止命令执行。临时迁移管理员 key 有独立标识及 2026-09-15 UTC 到期时间；完成迁移时应只撤销该精确条目，保留原有管理员 key 和 VM 隧道 key。认证材料不记入本记录。

初始部署曾使用 2026-10-18 到期的迁移证书；现已切换 Caddy 自动证书管理，并实际签发、提供新的证书，当前到期时间为 **2026-12-07 07:34:57 UTC**。长期续期由 Caddy 处理，尚未经历未来续期周期。

## 仍需执行

1. 旧 NS 缓存消退后，再删除旧机仅用于兼容的两个 `fm` Caddy site 和 HAProxy 的精确 fm SNI/backend。必须先验证其他路由未变，再校验配置和 reload；不能停共享服务。
2. 当前 Google 的 NS 为 `gannon/meilani.ns.cloudflare.com`；腾讯解析器仍看到 `arch/jean.ns.cloudflare.com`（NS TTL=43200），旧 A 仍为 `43.165.167.135`。用户若能同步修改旧区的 fm A，可缩短兼容期；否则等旧 NS 缓存自然失效。

## 2026-09-08 白名单与生产出口切换完成

- 本任务用本地持久 Profile 完成 17 个主体白名单添加，覆盖 25 家店；全部刷新回读，旧 IP 全保留。证据：`tmp/ip-whitelist-20260908/verified-summary.json`。此前的 Profile 启动拒绝记录属于历史，不能继续作为当前阻塞。
- 用户明确授权先做新出口认证和生产出口切换，DNS 等朋友处理。本次未修改 DNS、证书或退役旧服务。
- 从飞牛现有生产 release `9ba4a533c08e4a96689af1ae1b759c73d32532fc`，以 `sheinfm-sales` 用户经过现有 `api-light` 资源门禁，使用原有 OpenAPI 客户端逐店只读调用 `number-list` 和 `query-sku-sales`；不持久化业务数据。14:49:11（北京时间）候选出口认证 25/25、17 个主体通过。
- 14:50:06 切换 `/srv/shein-fm/secrets/openapi-proxy.env` 为 `http://127.0.0.1:18090`，保留 `SHEIN_FM_OPENAPI_PROXY_REQUIRED=1`。7 个定时服务读取该共享文件；切换时均无运行进程，后续按原排班加载新配置，没有新增调度。
- 新增授权服务专属 drop-in `/etc/systemd/system/shein-fm-authorization.service.d/60-openapi-egress.conf`，统一读取同一出口文件。配置校验、daemon-reload 后仅重启授权服务；进程环境实读新代理和必经代理标记，`/authorize` 返回 200。
- 14:52:05 按正式出口文件重做全店认证，25/25 再次通过，配置指纹未变化。销售与供应链的凭据配置 SHA256 相同。飞牛 Node→127.0.0.1:18090→SSH→43.165.185.3:22 的活动连接已现场核验，新机公网出口实测为 43.165.185.3。
- 旧 OpenAPI 隧道与旧授权反向隧道继续 active；旧 IP 的 HTTPS `/health`、`/authorize` 均返回 200。新隧道 enabled/active；授权服务及新隧道 NRestarts=0。
- 验收只证明认证和新出口成功：销量探针的数据质量标记仍为 `DEGRADED`；切换前首页实时任务已于 14:11:15 以状态 2 失败，本次未重跑或将该旧问题记为修复。真实新授权换票和完整业务采集轮次不属于本次只读探针。
- 不可变计划 SHA256：`86e187929b98d0e43e3eaed3c193e0e3cd8f223ab0d28551ced9e033e058e1ae`。飞牛 root 私有回滚目录：`/srv/shein-fm/runtime/migration-evidence/friend-egress-20260908-cutover`；本地逐店回读：`tmp/friend-edge-20260908/candidate-probe.jsonl`、`production-probe.jsonl`、`switch-verify.json`。
- 回滚必须先匹配计划中的当前文件哈希，再恢复 `proxy.before` 的原内容、权限和属主，移除本次精确 drop-in，并 daemon-reload、重启授权服务和回读；不得覆盖其他任务后续修改。

## 用户完成 DNS 修改后的只读核验

- 用户报告域名已转入自己账户且 A 记录已修改。本任务只核验公开 DNS 与服务，不将公开 DNS 当作域名账户归属证明。
- Google DNS 与 Cloudflare DNS-over-HTTPS 均返回唯一 A `43.165.185.3`，TTL=300。
- 新机本地解析仍返回旧 `43.165.167.135`，`/etc/hosts` 未见该域名覆盖条目；因此普通请求当时仍到旧机。显式解析到新 IP 后，HTTPS `/health`、`/store-login`、`/authorize` 均返回 200，并实读 remote_ip=43.165.185.3，证书校验成功。
- 新机 Caddy、隔离 Nginx 和 OpenAPI relay 均 active。Caddy 仍显式使用手工证书，2026-10-18 12:25:42 UTC 到期，自动续期尚未配置。本轮未修改服务器配置、证书或退役旧服务。

## 2026-09-08 收尾验收与旧边缘退役

- 用户授权完成剩余迁移工作。新机 TLS 于 16:33:25 开启自动管理，16:33:30 日志确认 `certificate obtained successfully`。TLS 实际握手校验成功，证书 SHA256 `aa273085ae20baff99707b897b2db8a5616a4a8685b536529a2d93fba30d49b1`，到期 2026-12-07 07:34:57 UTC。只移除 fm 的手工证书绑定；其他 HTTP 路由、代理和 TLS 配置结构未变。不可变计划 `375004a40c216832a479c4c900f5f5b4b49eac2c449495eaa1ac329a73c51bc4`。
- 因旧 NS 缓存仍在接真实回调，16:40:34 将旧 fm Caddy HTTPS upstream 改为 `https://43.165.185.3`，明确 `tls_server_name fm.dushengyi.cc`，正常验证证书；没有关闭证书校验，也不依赖旧 DNS 解析 upstream。除该 fm route 外的 Caddy 配置结构保持一致。兼容转发计划 `b848d196445db89ad79dfb33d526fa2989529b902e60d70629309ed367b90057`。
- 新机 16:41:39 的两条真实 POST 均返回 200。数据库 receipt `703241/703242` 分别为 APP_ONLY/STORE，job 均 SUCCEEDED、attempt=1、operational_event 完整；未人为注入业务事件或触发平台写入。运行态 receiver/repository 源码与本地 SHA 一致，签名验证位于落库前且无跳过分支。
- 16:45 停用旧云 relay、移除旧 Nginx 站点 symlink，停用飞牛两条旧隧道。停止旧 OpenAPI 隧道曾因授权服务遗留 Requires 依赖使授权服务联动停止；现场恢复后已修复完整 unit 的 Requires/After，改依赖新隧道。systemd 依赖不能通过 drop-in 空赋值删除，本次无效的 50-drop-in 已移除。
- 16:49:12 再次停止旧隧道，授权 PID `859290` 保持不变，`/authorize`=200。新 auth unit SHA256 `e869c4aa589396ab91add62fa775c713351dff710f08a9220948035df2c0eee8`。旧服务均 inactive/disabled，旧机 8081/18080/18788/18789/18793/18794 监听均消失，飞牛仅保留新本地代理 18090。
- 16:49:14 退役后又收到真实回调：receipt `703258/703260` 均 SUCCEEDED，包含 STORE 事件，4 次重复投递均收敛到既有 receipt，missing_job/missing_event/unfinished 均为 0。新机回调日志对应 200，证明签名、持久化、去重和 worker 链路通过。
- 16:52 最终回读：新机三项边缘服务、飞牛新隧道/授权/receiver/worker 均 active/enabled；新机 `/health`、`/store-login`、`/authorize`=200。旧共享 Caddy/Nginx/HAProxy 保持 active/enabled，半托入口与变更前一样返回登录跳转 302。参见 `tmp/friend-edge-20260908/finish-readback.json`、`webhook-db-after-retire.json`、`webhook-edge-audit.json`。
- 回滚材料：新机 `/opt/shein-fm-edge/tls-cutover-20260908`，旧机 `/var/backups/shein-fm-edge-retire-20260908`，飞牛 `/srv/shein-fm/runtime/migration-evidence/old-edge-retire-20260908`。所有恢复先比对当前哈希，保留其他任务的后续改动。旧机业务源码、数据备份和共享服务没有删除。
- 16:54:52 撤销新机本次临时迁移管理员 key 的唯一匹配条目，保留其余 2 条原管理员/飞牛隧道 key。新 SSH 连接实测 `Permission denied`，证明撤销生效；飞牛新隧道和授权服务仍 active，通过新公网 IP 访问 `/authorize` 仍为 200。只撤销本次凭据，未删除其他登录方式。

- 部署模板同步完成：授权服务依赖新隧道并读取共享代理文件，代理示例为 18090；新增新隧道 unit 和 SSH 示例，保留旧模板作为回滚材料。定向测试 `node --test tests/infra/fnos-edge-tunnel.test.mjs tests/infra/openapi-proxy-runtime-wiring.test.mjs` 结果为 12 passed、0 failed。主代理已检查文件差异和新模板。
- 收尾证据清单：本地 `tmp/friend-edge-20260908/closeout-evidence.json`，飞牛私有不可变副本 `/srv/shein-fm/runtime/migration-evidence/friend-edge-closeout-20260908/closeout-evidence.json`，SHA256 `df04e4abd33e6c75b0268596e216e08d1ecc92538dd65b7aa45f3e301b78e079`。状态明确保留旧 DNS 兼容转发，不代表旧入口已全部删除。

未创建 heartbeat、业务调度或新 goal；未提交、推送或发布版本。原有 `scripts/__pycache__/` 未动。
