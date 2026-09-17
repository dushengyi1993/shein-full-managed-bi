# 全托审查后续修复（2026-09-18）

## 范围

承接 2026-09-15 全面审查。用户授权处理除「sdb SMART 轮询与备份另存 sda」和「收敛 sheinops sudo」以外的全部项目，两项明确跳过。

## 一、授权服务被钉死在旧 release（真实缺陷）

症状：`shein-fm-authorization.service` 的进程 cwd 指向 `/opt/shein-fm/releases/9ba4a533...`，已连续运行 20 小时 40 分；`/opt/shein-fm/current` 早已指向更新的 release，即 9-15 至 9-18 期间发布的多个版本对该服务从未生效。

取证：

- `readlink /proc/<MainPID>/cwd` 解析到 `releases/9ba4a533...`。
- `systemctl cat` 显示 `WorkingDirectory=/opt/shein-fm/releases/9ba4a533...`，仓库模板 `infra/systemd/shein-fm-authorization-fnos.service` 里同样是硬编码 commit。
- 其余 29 个单元均为 `WorkingDirectory=/opt/shein-fm/current`，仅此一个例外。
- 副作用：`prune_full_managed_releases` 把「活跃进程 cwd 所在 release」列为强制保护，因此该钉死让 `9ba4a533` 永远无法回收。

注意：该单元同时有 drop-in `60-openapi-egress.conf` 提供 `EnvironmentFile`，`systemd show` 的静态 `Environment=` 显示 18080 是未合并 drop-in 的视图，进程实际环境为 18090（已用 `sudo cat /proc/<pid>/environ` 核对），因此**不存在线上故障**。

修复：

- 模板改为 `WorkingDirectory=/opt/shein-fm/current`；部署单元同步 sed 替换。
- 新增回归断言：模板必须等于 `current` 且不得出现 `releases/`，防止再次被钉死。
- 重启前先确认 `src/authorization` 与 `src/openapi` 自 `9ba4a533` 以来无差异（仅 `src/openapi/connect-relay.mjs` 变更），重启安全。
- 复核：进程 cwd 解析到新 release、环境仍为 18090、`/authorize` 200、NRestarts=0。

## 二、迁移遗留数据库与残留 schema

删除对象（均 `datallowconn=true`、无活动连接）：

- `shein_fm_rehearsal_20260902_095034`（7846 MB）
- `shein_fm_golden_20260902_095034`（7840 MB）
- `shein_fm_empty_before_pilot_20260902`（7.5 MB）
- `shein_fm` 库内 `fnos_cutover_20260902` schema（6 张迁移影子表：`receipt_new`/`receipt_mutable`/`job_new`/`event_new`/`directive_new`/`heartbeat_new`）

删除前核对：

- 仓库与 `docs/` 无任何真实引用（唯一命中是文档里的命名示例 `shein_fm_rehearsal_20260726_<suffix>`）。
- 影子表名在仓库中零引用。
- 跨 schema 依赖仅 5 处 TOAST 内部依赖（`deptype=i`），非真实依赖。
- 可重建性：源快照 `shein-fm-weekly-20260902T151520Z.dump`（1.28 GB）在本地与 NAS 均存在，此前完整恢复测试已通过。

结果：释放约 15 GB，生产库仅剩 `shein_fm`，schema 恢复为 `dim/fact/mart/ops/public/raw`。

## 三、统计信息陈旧（曾被误读为「空表」）

审查时 `fact.inventory_snapshot`（1143 MB）、`supply_projection_member`（872 MB）、`warehouse_inventory_snapshot`（541 MB）、`stock_advice_snapshot`（516 MB）、`raw.identifier_observation`（316 MB）的 `n_live_tup` 均为 0 且 `last_autovacuum/autoanalyze` 为 NULL。

实际并非空表：`ANALYZE` 后行数为 236 万 / 344 万 / 207 万 / 110 万 / 36 万。此前是规划器无统计信息，存在劣化执行计划的风险。已对这 5 张表加 `fact.full_home_finance_detail_observation` 执行 `ANALYZE`，并复核 `last_analyze` 已更新。

## 四、release 目录回收

授权服务解钉后，`prune_full_managed_releases` 的候选从 2 个变为 3 个。以 `--apply` 执行，移除 `9ba4a533`、`afcb8e8c`、`15530499` 三个旧 release；`current`、`previous`、5 个最新以及所有活跃进程 cwd 所在 release 均保留。目录 270M → 182M。

注意：该工具的 plan-first 与人工核对是**有意设计**（`--execute-safe` 被显式移除），因此「未排班」不是缺口，不应为其新建 timer。

## 五、webhook 503 可诊断性

背景：9-17 有 21 次 `WEBHOOK_STORAGE_UNAVAILABLE`（01:47、20:16、20:19 三簇）。核查发现 48 小时内 PostgreSQL 日志只有 5 条错误且全部来自诊断探针的错误 SQL——数据库侧零真实错误、零语句超时、零重启、非 OOM，因此**不是数据库原因**。

但 receiver 记录拒绝时只保留错误码、丢弃了包裹的底层 `cause`，导致无法归因。

修复：`safeLogError` 增加 `causeCode`，仅投影经过 `^[A-Z0-9_]{1,80}$` 校验的错误码，不记录 message（message 可能含连接细节）。新增 HTTP 级测试，断言 `causeCode` 出现且日志中不含连接串与用户名。

## 六、明确未做

- sdb SMART 轮询与备份另存 sda：用户明确跳过。
- 收敛 `sheinops` 的全量免密 sudo：用户明确跳过。
- 订单读模型：`order-management.json` 停留在 2026-08-09，候选 `promotable=false`，原因是六个域均为 `SESSION_SNAPSHOT_ABSENT`，且 `sync_full_managed_order_management_sessions.mjs` 不被任何协调器任务或 timer 引用（属纯手工操作）。质检/异常权限在 9-6 记录中已被用户明确延期，且当时质检接口认证根因未解决；本次不伪造修复。
- 保留类工具排班：见第四节，属有意的人工流程。

## 七、观察到的非故障现象

- `shein-fm-home-realtime.service` 与 `shein-fm-session-renewal.service` 在夜间以 `WAITING_PLATFORM` 退出并被标记 failed（exit code 2）。这是等待平台日结锚点的既有形态，非登录失效：同一时段 24 小时内首页采集 22 次 COMPLETE、2 次 WAITING，且重启后 01:05 已完成。
- `webhook-hydration` 频率已从约 30 秒回落到约 3 分钟，且确有 `claimed>0` 的实际工作。

## 八、本次发布

- `2026.09.18.1`（commit `99db0d1`）：授权服务改为跟随 release 指针 + 回归断言。
- `2026.09.18.2`（commit `00e272f`）：webhook `causeCode` 诊断。
- 生产 `current` → `00e272f`；`9 个 timer` 正常、公网 `/health` 200、receiver 预算仍为 8000/4000。

